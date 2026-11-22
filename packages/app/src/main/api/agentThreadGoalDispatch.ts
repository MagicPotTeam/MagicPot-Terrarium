import type { AgentGoalDispatchView, AgentGoalScope } from '@shared/api/agentThreadGoal'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getConfig, onConfigCommitted } from '../config/config'
import { getProviderDispatchOwner, type ProviderDispatchOwner } from '../llmProxy/providerDispatchOwner'
import { DISPATCH_LEDGER_LIMITS } from '../llmProxy/providerDispatchLedgerPolicy'
import { captureAgentGoalScope } from './agentThreadGoalScope'
import { agentThreadInteractions } from './agentThreadInteractions'

/** Explicit user-only accounting DATA inspection. Never starts a run/provider,
 * returns capability/receipt hashes, mutates a goal, or clears an unknown fence.
 * Initialization may acquire fixed local storage ownership, not execution consent. */
export class AgentThreadGoalDispatch {
  private readonly loading = new Set<number>()
  constructor(private readonly owner: () => Promise<Pick<ProviderDispatchOwner, 'readCurrentData'>> = getProviderDispatchOwner) {}
  async list(req: AgentGoalScope, invocation?: ServiceInvocationContext): Promise<AgentGoalDispatchView> {
    const input = structuredClone(req), access = captureAgentGoalScope(input, invocation, 'listAgentGoalDispatches')
    if (Object.keys(input).some(key => !['route', 'conversationId', 'documentToken'].includes(key))) throw new Error('Invalid dispatch accounting list request.')
    if (this.loading.has(invocation!.senderId!) || this.loading.size >= 32) throw new Error('Dispatch accounting inspection is busy; no new I/O started.')
    const lease = agentThreadInteractions.createScoped(input, invocation!)
    if (!lease) throw new Error('Dispatch accounting requires a trusted live document.')
    let changed = false, stop: (() => void) | undefined
    this.loading.add(invocation!.senderId!)
    const check = () => { access(); lease.assertLive(); if (changed || getConfig().use_remote_llm) throw new Error('Dispatch accounting requires unchanged local desktop routing.') }
    try {
      stop = onConfigCommitted(() => { changed = true })
      check(); const owner = await this.owner(); check()
      const value = owner.readCurrentData(input); check()
      const doc = value.document, legacy = doc.version === 1 ? doc : doc.legacy
      const runs: AgentGoalDispatchView['runs'] = legacy.runs.map(run => ({
        id: run.id, goalId: run.binding.goalId, generation: run.binding.generation, status: run.status,
        startedAt: run.startedAt, updatedAt: run.updatedAt, deadlineAt: run.deadlineAt,
        maxProviderDispatches: run.maxProviderDispatches, chargedProviderDispatches: run.chargedProviderDispatches,
        attempts: run.attempts.map(attempt => ({ id: attempt.id, reservedAt: attempt.reservedAt, ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }), state: attempt.outcome?.state ?? 'pending', ...(attempt.outcome?.state === 'response-complete' ? { status: attempt.outcome.status, responseBytes: attempt.outcome.responseBytes } : {}) }))
      }))
      if (doc.version === 2) for (const run of doc.runs) runs.push({
        id: run.id, goalId: run.binding.goalId, generation: run.binding.generation, status: run.status,
        startedAt: run.startedAt, updatedAt: run.updatedAt, deadlineAt: run.deadlineAt,
        maxProviderDispatches: run.limits.maxProviderDispatches, chargedProviderDispatches: run.charged.providerDispatch,
        unitAccounting: {
          maxModelSteps: run.limits.maxModelSteps, chargedModelSteps: run.charged.modelStep, maxToolInvocations: run.limits.maxToolInvocations, chargedToolInvocations: run.charged.toolInvocation,
          units: run.units.map(unit => ({ id: unit.id, unit: unit.unit, ...(unit.parentId ? { parentId: unit.parentId } : {}), reservedAt: unit.reservedAt, ...(unit.settledAt === undefined ? {} : { settledAt: unit.settledAt }), state: unit.outcome?.state ?? 'pending' }))
        },
        attempts: run.units.filter(unit => unit.unit === 'providerDispatch').map(unit => {
          const outcome = unit.outcome
          if (outcome && !['not-dispatched', 'response-complete', 'unknown'].includes(outcome.state)) throw new Error('Invalid v2 dispatch outcome projection.')
          return { id: unit.id, reservedAt: unit.reservedAt, ...(unit.settledAt === undefined ? {} : { settledAt: unit.settledAt }), state: (outcome?.state ?? 'pending') as AgentGoalDispatchView['runs'][number]['attempts'][number]['state'], ...(outcome?.state === 'response-complete' ? { status: outcome.status, responseBytes: outcome.responseBytes } : {}) }
        })
      })
      check()
      return {
        revision: doc.revision, orphaned: value.orphaned, mutationBlocked: value.mutationBlocked,
        payloadVersion: doc.version, ...(doc.version === 2 ? { v1ExecutionUnsupported: true } : {}),
        capacityReached: runs.length >= DISPATCH_LEDGER_LIMITS.runs || doc.revision >= DISPATCH_LEDGER_LIMITS.receipts,
        scopeBlocked: doc.version === 2 || value.mutationBlocked || value.orphaned || runs.some(run => run.status === 'unknown' || run.status === 'active'),
        mode: 'data-only', budgetsEnforced: false, grantsPermission: false,
        limits: { runs: DISPATCH_LEDGER_LIMITS.runs, attemptsPerRun: DISPATCH_LEDGER_LIMITS.attempts, retainedReceipts: DISPATCH_LEDGER_LIMITS.receipts }, runs
      }
    } finally { stop?.(); this.loading.delete(invocation!.senderId!); lease.dispose() }
  }
}
export const agentThreadGoalDispatch = new AgentThreadGoalDispatch()
