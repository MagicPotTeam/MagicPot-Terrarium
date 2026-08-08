import {
  canonicalPolicyJson,
  sha256PolicyText,
  type PolicyJsonValue
} from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'

export const TRIGGER_EXECUTION_OUTCOME_KIND = 'trigger-execution'
export type TriggerExecutionOutcomeStatus =
  | 'permit-consumed'
  | 'succeeded'
  | 'failed'
  | 'outcome-unknown'

type Evidence = Readonly<Record<string, PolicyJsonValue>>
export type TriggerExecutionOutcome = Readonly<{
  executionId: string
  triggerId: string
  occurrenceAt: number
  authorizationId: string
  requestDigest: string
  status: TriggerExecutionOutcomeStatus
  createdAt: number
  updatedAt: number
  consumedAt: number
  completedAt?: number
  result?: Evidence
  error?: Evidence
  revision: number
  idempotencyKey: string
}>

const limit = 4_096
const sensitive = /secret|token|password|apikey|authorization|prompt|input/i
const json = (value: unknown, depth = 0): PolicyJsonValue => {
  if (depth > 8) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => json(item, depth + 1))
  if (typeof value !== 'object') return String(value)
  const out: Record<string, PolicyJsonValue> = {}
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    out[key] = sensitive.test(key) ? { redacted: true } : json(child, depth + 1)
  }
  return out
}
const evidence = (value: unknown): Evidence => {
  const projected = json(value)
  const candidate =
    projected && typeof projected === 'object' && !Array.isArray(projected)
      ? (projected as Evidence)
      : { value: projected }
  const serialized = canonicalPolicyJson(candidate)
  return serialized.length <= limit
    ? candidate
    : { redacted: true, digest: sha256PolicyText(serialized) }
}
const idFor = (authorizationId: string, requestDigest: string) =>
  `trigger-execution:${sha256PolicyText(canonicalPolicyJson({ authorizationId, requestDigest }))}`
const event = (
  id: string,
  type: string,
  at: number,
  state: TriggerExecutionOutcome,
  revision: number
) => ({
  protocolVersion: '2.0.0',
  id: `${id}:${type}:${revision}`,
  type,
  createdAt: at,
  payload: state,
  envelopeKind: 'event' as const,
  streamId: `${id}:stream`,
  sequence: revision,
  resource: { kind: TRIGGER_EXECUTION_OUTCOME_KIND, id },
  revision
})

export class TriggerExecutionOutcomeConflictError extends Error {}
export class TriggerExecutionOutcomeStore {
  constructor(private readonly store: MagicAgentEventStore) {}
  get(executionId: string): StoredResource<TriggerExecutionOutcome> | undefined {
    return this.store.getResource(TRIGGER_EXECUTION_OUTCOME_KIND, executionId, {
      includeDeleted: true
    }) as StoredResource<TriggerExecutionOutcome> | undefined
  }
  list(): readonly StoredResource<TriggerExecutionOutcome>[] {
    return this.store.listResources({
      kind: TRIGGER_EXECUTION_OUTCOME_KIND,
      limit: 1_000
    }) as readonly StoredResource<TriggerExecutionOutcome>[]
  }
  listUncertain(): readonly StoredResource<TriggerExecutionOutcome>[] {
    return this.list()
      .filter((item) => item.state.status === 'permit-consumed')
      .map((item) => ({ ...item, state: { ...item.state, status: 'outcome-unknown' as const } }))
  }
  recordPermitConsumed(input: {
    triggerId: string
    occurrenceAt: number
    authorizationId: string
    requestDigest: string
    consumedAt: number
    idempotencyKey?: string
  }): StoredResource<TriggerExecutionOutcome> {
    const executionId = idFor(input.authorizationId, input.requestDigest)
    const existing = this.get(executionId)
    if (existing) {
      const state = existing.state
      if (
        state.triggerId !== input.triggerId ||
        state.occurrenceAt !== input.occurrenceAt ||
        state.authorizationId !== input.authorizationId ||
        state.requestDigest !== input.requestDigest ||
        state.consumedAt !== input.consumedAt
      )
        throw new TriggerExecutionOutcomeConflictError('Execution outcome identity conflict.')
      return existing
    }
    const state: TriggerExecutionOutcome = {
      executionId,
      triggerId: input.triggerId,
      occurrenceAt: input.occurrenceAt,
      authorizationId: input.authorizationId,
      requestDigest: input.requestDigest,
      status: 'permit-consumed',
      createdAt: input.consumedAt,
      updatedAt: input.consumedAt,
      consumedAt: input.consumedAt,
      revision: 0,
      idempotencyKey: input.idempotencyKey ?? executionId
    }
    return this.store.mutateResource({
      operation: 'create',
      kind: TRIGGER_EXECUTION_OUTCOME_KIND,
      id: executionId,
      idempotencyKey: state.idempotencyKey,
      state,
      createdAt: input.consumedAt,
      event: event(executionId, 'trigger-execution.permit-consumed', input.consumedAt, state, 0)
    }).resource as StoredResource<TriggerExecutionOutcome>
  }
  recoverFromConsumption(input: {
    triggerId: string
    occurrenceAt: number
    authorizationId: string
    requestDigest: string
    consumedAt: number
    idempotencyKey?: string
  }): StoredResource<TriggerExecutionOutcome> {
    return this.recordPermitConsumed(input)
  }

  complete(
    executionId: string,
    status: 'succeeded' | 'failed',
    at: number,
    value?: unknown
  ): StoredResource<TriggerExecutionOutcome> {
    const current = this.get(executionId)
    if (!current)
      throw new TriggerExecutionOutcomeConflictError('Execution outcome does not exist.')
    if (current.state.status !== 'permit-consumed')
      throw new TriggerExecutionOutcomeConflictError('Execution outcome is already completed.')
    const state: TriggerExecutionOutcome = {
      ...current.state,
      status,
      updatedAt: at,
      completedAt: at,
      revision: current.revision + 1,
      ...(status === 'succeeded' ? { result: evidence(value) } : { error: evidence(value) })
    }
    return this.store.mutateResource({
      operation: 'update',
      kind: TRIGGER_EXECUTION_OUTCOME_KIND,
      id: executionId,
      expectedRevision: current.revision,
      idempotencyKey: `${executionId}:${status}`,
      state,
      createdAt: at,
      event: event(executionId, `trigger-execution.${status}`, at, state, state.revision)
    }).resource as StoredResource<TriggerExecutionOutcome>
  }
}
