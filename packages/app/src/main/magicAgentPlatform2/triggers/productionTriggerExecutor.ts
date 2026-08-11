import {
  digestPolicyRequest,
  type PolicyJsonRecord,
  type TriggerPolicyRequestFactoryInput
} from '../../../shared/magicAgentPlatform2/policy'
import type { AuthorizationResult, MagicAgentPolicyAuthorizationService } from '../policy'
import {
  TriggerPolicyExecutionBoundary,
  TriggerPolicyExecutionError,
  type TriggerPolicyExecutionResult
} from './policyExecution'
import type { TriggerPermitConsumedHook } from './policyExecution'
import type { TriggerExecutionOutcomeStore } from './executionOutcomeStore'
import {
  adaptTrustedTriggerTarget,
  type TrustedTriggerExecutionTarget
} from './trustedTargetAdapter'
import type { PersistentTriggerState } from './persistentTriggerStore'
import type { TriggerOccurrenceState } from './triggerOccurrenceStore'
import type { TriggerTrustedDispatchContext } from '../../magicAgentRuntime/triggerTrustedDispatchContext'

export type TriggerAgentDispatchInput = Readonly<{
  agentId: string
  prompt: string
  sessionId?: string
  route: PolicyJsonRecord
  trustedContext?: TriggerTrustedDispatchContext
}>

export type TriggerGraphDispatchInput = Readonly<{
  graphId: string
  input: PolicyJsonRecord
  sessionId?: string
  route: PolicyJsonRecord
}>

export type ProductionTriggerDispatchers<TResult> = Readonly<{
  runAgent: (input: TriggerAgentDispatchInput) => TResult | Promise<TResult>
  runGraph: (input: TriggerGraphDispatchInput) => TResult | Promise<TResult>
}>

export type TrustedTriggerRouteResolver = (trigger: PersistentTriggerState) => PolicyJsonRecord

export type ProductionTriggerExecutorOptions<TResult> = Readonly<{
  authorizationService: MagicAgentPolicyAuthorizationService
  grantProvider: (
    request: import('../../../shared/magicAgentPlatform2/policy').PolicyRequest
  ) =>
    | { grantId: string; expectedGrantUseCount?: number }
    | undefined
    | Promise<{ grantId: string; expectedGrantUseCount?: number } | undefined>
  resolveTrustedRoute: TrustedTriggerRouteResolver
  dispatch: ProductionTriggerDispatchers<TResult>
  outcomes?: TriggerExecutionOutcomeStore
  now?: () => number
}>

const systemActor = { kind: 'system', id: 'trigger-system' } as const

const targetFromState = (trigger: PersistentTriggerState): unknown => {
  const config = trigger.config
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Trigger config must contain a trusted target.')
  const target = (config as Record<string, unknown>).target
  if (target === undefined) throw new Error('Trigger config must contain a trusted target.')
  return target
}

const occurrenceInput = (trigger: PersistentTriggerState) => {
  if (trigger.type !== 'schedule')
    throw new Error('Scheduled execution requires a schedule Trigger.')
  const claim = trigger.claim
  if (!claim) throw new Error('Trigger must be claimed before execution.')
  return {
    requestId: `trigger-run:${trigger.id}:${claim.claimId}:${claim.occurrenceAt}`,
    actor: systemActor,
    triggerId: trigger.id,
    occurrence: {
      occurrenceAt: claim.occurrenceAt,
      windowStart: claim.windowStart,
      windowEnd: claim.windowEnd,
      missedCount: claim.missedCount,
      nextFireAtAfter: claim.nextFireAtAfter,
      ...(claim.batchEndAt === undefined ? {} : { batchEndAt: claim.batchEndAt })
    },
    triggerBase: {
      type: trigger.type,
      title: trigger.title
    },
    effects: []
  }
}

const dispatchTarget = <TResult>(
  target: TrustedTriggerExecutionTarget,
  policyInput: TriggerPolicyRequestFactoryInput,
  route: PolicyJsonRecord,
  dispatch: ProductionTriggerDispatchers<TResult>
): Promise<TResult> | TResult => {
  if (target.kind === 'agent-run')
    return dispatch.runAgent({
      agentId: target.agentId,
      prompt: target.prompt,
      ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
      route,
      trustedContext: {
        triggerId: policyInput.triggerId,
        requestId: policyInput.requestId,
        occurrenceAt: policyInput.occurrence.occurrenceAt,
        triggerType: policyInput.trigger.type,
        triggerTitle: policyInput.trigger.title,
        targetAgentId: target.agentId,
        ...(policyInput.occurrence.occurrenceId === undefined
          ? {}
          : { occurrenceId: policyInput.occurrence.occurrenceId }),
        ...(target.sessionId === undefined ? {} : { targetSessionId: target.sessionId }),
        ...(policyInput.occurrence.source === undefined
          ? {}
          : { source: policyInput.occurrence.source }),
        ...(policyInput.occurrence.attempt === undefined
          ? {}
          : { attempt: policyInput.occurrence.attempt })
      }
    })
  return dispatch.runGraph({
    graphId: target.graphId,
    input: target.input,
    ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
    route
  })
}

export class TriggerOccurrenceNotExecutedError extends Error {
  readonly code = 'MAGIC_AGENT_TRIGGER_OCCURRENCE_NOT_EXECUTED'
  constructor(readonly status: string) {
    super(`Trigger occurrence was not executed: ${status}.`)
    this.name = 'TriggerOccurrenceNotExecutedError'
  }
}

export class TriggerOutcomePersistenceError extends Error {
  readonly code = 'MAGIC_AGENT_TRIGGER_OUTCOME_PERSISTENCE'
  constructor(
    readonly cause: unknown,
    readonly outcomeError: unknown
  ) {
    super('Durable trigger execution outcome could not be persisted.', { cause })
    this.name = 'TriggerOutcomePersistenceError'
  }
}

export class ProductionTriggerExecutor<TResult = unknown> {
  private readonly now: () => number

  constructor(private readonly options: ProductionTriggerExecutorOptions<TResult>) {
    this.now = options.now ?? Date.now
  }

  async executeOccurrence(
    trigger: PersistentTriggerState,
    occurrence: TriggerOccurrenceState
  ): Promise<TResult> {
    const route = this.options.resolveTrustedRoute(trigger)
    const adapted = adaptTrustedTriggerTarget({
      requestId: `trigger-run:${trigger.id}:${occurrence.occurrenceId}:${occurrence.claim?.owner ?? 'unclaimed'}`,
      actor: systemActor,
      triggerId: trigger.id,
      occurrence: {
        occurrenceAt: occurrence.scheduledAt,
        windowStart: occurrence.scheduledAt,
        windowEnd: occurrence.scheduledAt,
        missedCount: 0,
        nextFireAtAfter: trigger.type === 'schedule' ? trigger.nextFireAt : occurrence.scheduledAt,
        occurrenceId: occurrence.occurrenceId,
        source: occurrence.source,
        requestedAt: occurrence.requestedAt,
        attempt: occurrence.attempt
      },
      triggerBase: { type: trigger.type, title: trigger.title },
      route,
      trustedTarget: targetFromState(trigger)
    })
    const result = await this.executeAdaptedWithOutcome(adapted, route)
    if (result.status !== 'executed') throw new TriggerOccurrenceNotExecutedError(result.status)
    return result.result
  }

  async execute(trigger: PersistentTriggerState): Promise<TResult | AuthorizationResult> {
    const route = this.options.resolveTrustedRoute(trigger)
    const adapted = adaptTrustedTriggerTarget({
      ...occurrenceInput(trigger),
      route,
      trustedTarget: targetFromState(trigger)
    })
    const result = await this.executeAdaptedWithOutcome(adapted, route)
    return result.status === 'executed' ? result.result : result.authorization
  }

  private async executeAdaptedWithOutcome(
    adapted: ReturnType<typeof adaptTrustedTriggerTarget>,
    route: PolicyJsonRecord
  ): Promise<TriggerPolicyExecutionResult<TResult>> {
    let outcome: ReturnType<TriggerExecutionOutcomeStore['recordPermitConsumed']> | undefined
    const boundary = new TriggerPolicyExecutionBoundary(
      this.options.authorizationService,
      this.options.grantProvider,
      (_request, _authorization) =>
        dispatchTarget(
          adapted.executionTarget,
          adapted.policyRequestInput,
          route,
          this.options.dispatch
        ),
      this.now,
      this.options.outcomes === undefined
        ? undefined
        : ({ request, authorizationId, requestDigest }) => {
            const occurrence = request.input.occurrence as { occurrenceAt: number }
            outcome = this.options.outcomes!.recordPermitConsumed({
              triggerId: request.target.id,
              occurrenceAt: occurrence.occurrenceAt,
              authorizationId,
              requestDigest,
              consumedAt: this.now()
            })
          }
    )
    try {
      const result = await boundary.execute(adapted.policyRequestInput)
      if (result.status !== 'executed') return result
      if (this.options.outcomes && outcome) {
        try {
          this.options.outcomes.complete(outcome.id, 'succeeded', this.now(), {
            status: 'succeeded',
            targetKind: adapted.executionTarget.kind
          })
        } catch (error) {
          throw new TriggerOutcomePersistenceError(result.result, error)
        }
      }
      return result
    } catch (error) {
      if (this.options.outcomes && outcome && error instanceof TriggerPolicyExecutionError) {
        try {
          this.options.outcomes.complete(outcome.id, 'failed', this.now(), {
            error:
              error.cause instanceof Error
                ? { name: error.cause.name, message: 'dispatch failed' }
                : { name: 'Error', message: 'dispatch failed' },
            status: 'failed',
            targetKind: adapted.executionTarget.kind
          })
        } catch (outcomeError) {
          throw new TriggerOutcomePersistenceError(error.cause ?? error, outcomeError)
        }
        throw error.cause ?? error
      }
      throw error
    }
  }
}
