import path from 'node:path'
import { realpathSync } from 'node:fs'
import type { AgentGoalCollection, AgentGoalMutation, AgentGoalMutationReq, AgentGoalMutationResult, AgentGoalScope, AgentGoalView } from '@shared/api/agentThreadGoal'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getConfig } from '../config/config'
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { AgentGoalRevisionConflict, validateAgentGoalMutation } from './agentThreadGoalPolicy'
import { captureAgentGoalScope } from './agentThreadGoalScope'
import { agentThreadInteractions } from './agentThreadInteractions'

let production: Promise<AgentThreadGoalStore> | undefined
/**
 * Electron can expose safeStorage before Chromium has persisted a fresh profile key.
 * Poll the existing read-only readiness check for a short bounded window so the first
 * Goal-panel read does not race profile initialization. This never writes Local State,
 * enables plaintext encryption, or turns an unavailable codec into an available one.
 */
async function waitForCheckpointCodec(codec: { available(): boolean }): Promise<void> {
  const attempts = 60
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (codec.available()) return
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Encrypted goal storage unavailable.')
}
/** Only this fixed OS-backed wiring is used in production; no path/config fallback. */
export function getAgentThreadGoalStore(): Promise<AgentThreadGoalStore> {
  production ??= (async () => {
    const [{ checkpointCodec }, { createCheckpointBinaryCodec }, { getBuildEnv }] = await Promise.all([import('../figplugin/checkpointEncryption'), import('../figplugin/checkpointBinaryCodec'), import('../config/buildEnv')])
    const codec = { available: () => checkpointCodec.available(), ...createCheckpointBinaryCodec(checkpointCodec) }
    await waitForCheckpointCodec(codec)
    const root = realpathSync.native(getBuildEnv().pathMap.data)
    return new AgentThreadGoalStore(codec, path.join(root, 'agent-thread-goals', 'goals-v1.sqlite'))
  })().catch(error => { production = undefined; throw error })
  return production
}
export async function closeAgentThreadGoalStore(): Promise<void> {
  const owned = production
  if (!owned) return
  try { (await owned).close() } finally { if (production === owned) production = undefined }
}
const view = (doc: AgentGoalCollection): AgentGoalView => ({ revision: doc.revision, goals: structuredClone(doc.goals), untrustedData: true, grantsPermission: false })
/** User data editor only. This class never calls a model or admits tools/wakes. */
export class AgentThreadGoals {
  constructor(private readonly store: () => Promise<AgentThreadGoalStore> = getAgentThreadGoalStore) {}
  async list(req: AgentGoalScope, invocation?: ServiceInvocationContext): Promise<AgentGoalView> {
    const input = structuredClone(req), access = captureAgentGoalScope(input, invocation, 'listAgentGoals')
    if (Object.keys(input).some(key => !['route', 'conversationId', 'documentToken'].includes(key))) throw new Error('Invalid goal list request.')
    const lease = agentThreadInteractions.createScoped(input, invocation!)
    if (!lease) throw new Error('Goal records require a trusted document.')
    const check = () => { access(); lease.assertLive(); if (getConfig().use_remote_llm) throw new Error('Goal records require local desktop routing.') }
    try { check(); const store = await this.store(); check(); return view(store.read(input)) }
    finally { lease.dispose() }
  }
  async mutate(req: AgentGoalMutationReq, invocation?: ServiceInvocationContext): Promise<AgentGoalMutationResult> {
    const input = structuredClone(req), access = captureAgentGoalScope(input, invocation, 'mutateAgentGoal')
    const { route: _route, conversationId: _conversation, documentToken: _token, ...mutation } = input
    void _route; void _conversation; void _token
    validateAgentGoalMutation(mutation)
    const command: AgentGoalMutation = mutation
    const lease = agentThreadInteractions.createScoped(input, invocation!)
    if (!lease) throw new Error('Goal records require a trusted document.')
    const check = () => { access(); lease.assertLive(); if (getConfig().use_remote_llm) throw new Error('Goal records require local desktop routing.') }
    try {
      check(); const store = await this.store(); check()
      try {
        // Synchronous transaction after the final lease/token/local check.
        const current = store.mutateUser(input, command)
        check(); return { ...view(current), status: 'applied', operationId: command.operationId }
      } catch (error) {
        if (!(error instanceof AgentGoalRevisionConflict)) throw error
        check(); return { status: 'retry-not-applied', priorOutcome: 'unknown', operationId: command.operationId, reason: 'revision-conflict', currentRevision: error.currentRevision }
      }
    } finally { lease.dispose() }
  }
}
export const agentThreadGoals = new AgentThreadGoals()
