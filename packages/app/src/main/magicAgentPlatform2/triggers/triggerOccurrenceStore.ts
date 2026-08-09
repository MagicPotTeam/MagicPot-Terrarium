import {
  canonicalPolicyJson,
  sha256PolicyText,
  type PolicyJsonRecord
} from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence'

export const MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND = 'trigger-occurrence'
export const TRIGGER_OCCURRENCE_SCHEMA_VERSION = 1 as const
export type TriggerOccurrenceSource =
  | 'manual'
  | 'startup'
  | 'channel-message'
  | 'workflow-completion'
  | 'drive-state'
  | 'calendar'
  | 'cron'
  | 'sdk'
  | 'custom'
export type TriggerOccurrenceStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'dead-letter'
export type TriggerOccurrenceClaim = Readonly<{
  owner: string
  claimedAt: number
  expiresAt: number
}>
export type TriggerOccurrenceState = Readonly<{
  schemaVersion: 1
  occurrenceId: string
  triggerId: string
  source: TriggerOccurrenceSource
  scheduledAt: number
  requestedAt: number
  status: TriggerOccurrenceStatus
  attempt: number
  idempotencyKey: string
  semanticDigest: string
  claim?: TriggerOccurrenceClaim
  lastError?: Readonly<{ name: string; message: string }>
  nextRetryAt?: number
  createdAt: number
  updatedAt: number
  payloadDigest?: string
}>

export class TriggerOccurrenceConflictError extends Error {}
export class TriggerOccurrenceFencingError extends Error {}
const finite = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`)
}
const required = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`${name} is required.`)
}
const event = (id: string, type: string, at: number, payload: unknown, revision: number) => ({
  protocolVersion: '2.0.0',
  id: `${id}:${type}:${revision}`,
  type,
  createdAt: at,
  payload,
  envelopeKind: 'event' as const,
  streamId: `${MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND}:${id}`,
  sequence: revision,
  resource: { kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND, id },
  revision
})

const withoutExecutionState = (
  state: TriggerOccurrenceState
): Omit<TriggerOccurrenceState, 'claim' | 'nextRetryAt' | 'lastError'> => {
  const { claim, nextRetryAt, lastError, ...base } = state
  void claim
  void nextRetryAt
  void lastError
  return base
}

const semantic = (input: {
  occurrenceId: string
  triggerId: string
  source: string
  scheduledAt: number
  requestedAt: number
  idempotencyKey: string
  payloadDigest?: string
}) => sha256PolicyText(canonicalPolicyJson(input))

export class TriggerOccurrenceStore {
  constructor(private readonly eventStore: MagicAgentEventStore) {}
  get(id: string): StoredResource<TriggerOccurrenceState> | undefined {
    return this.eventStore.getResource(MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND, id) as
      | StoredResource<TriggerOccurrenceState>
      | undefined
  }
  list(): readonly StoredResource<TriggerOccurrenceState>[] {
    return this.eventStore.listResources({
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      limit: 1000
    }) as readonly StoredResource<TriggerOccurrenceState>[]
  }
  enqueue(input: {
    occurrenceId: string
    triggerId: string
    source: TriggerOccurrenceSource
    scheduledAt: number
    requestedAt: number
    idempotencyKey: string
    payloadDigest?: string
  }): StoredResource<TriggerOccurrenceState> {
    required(input.occurrenceId, 'occurrenceId')
    required(input.triggerId, 'triggerId')
    required(input.idempotencyKey, 'idempotencyKey')
    finite(input.scheduledAt, 'scheduledAt')
    finite(input.requestedAt, 'requestedAt')
    const digest = semantic(input)
    const sameKey = this.list().find(
      (item) => item.state.idempotencyKey === input.idempotencyKey && item.id !== input.occurrenceId
    )
    if (sameKey) {
      if (sameKey.state.semanticDigest !== digest)
        throw new TriggerOccurrenceConflictError('Occurrence idempotency key conflict.')
      return sameKey
    }
    const existing = this.get(input.occurrenceId)
    if (existing) {
      if (existing.state.semanticDigest !== digest)
        throw new TriggerOccurrenceConflictError('Occurrence idempotency conflict.')
      return existing
    }
    const state: TriggerOccurrenceState = {
      schemaVersion: 1,
      occurrenceId: input.occurrenceId,
      triggerId: input.triggerId,
      source: input.source,
      scheduledAt: input.scheduledAt,
      requestedAt: input.requestedAt,
      status: 'pending',
      attempt: 0,
      idempotencyKey: input.idempotencyKey,
      semanticDigest: digest,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
      ...(input.payloadDigest === undefined ? {} : { payloadDigest: input.payloadDigest })
    }
    return this.eventStore.mutateResource({
      operation: 'create',
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      id: input.occurrenceId,
      idempotencyKey: input.idempotencyKey,
      state,
      createdAt: input.requestedAt,
      event: event(input.occurrenceId, 'occurrence.enqueued', input.requestedAt, state, 0)
    }).resource as StoredResource<TriggerOccurrenceState>
  }
  enqueueManual(input: Omit<Parameters<TriggerOccurrenceStore['enqueue']>[0], 'source'>) {
    return this.enqueue({ ...input, source: 'manual' })
  }
  claimNext(
    now: number,
    owner: string,
    leaseMs: number,
    maxAttempts = 3,
    eligible?: (state: TriggerOccurrenceState) => boolean
  ): StoredResource<TriggerOccurrenceState> | undefined {
    finite(now, 'now')
    required(owner, 'owner')
    finite(leaseMs, 'leaseMs')
    if (leaseMs <= 0) throw new Error('leaseMs must be positive.')
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0)
      throw new Error('maxAttempts must be a positive integer.')
    const expiredMax = this.list().find(
      (item) =>
        item.state.status === 'claimed' &&
        (item.state.claim?.expiresAt ?? Infinity) <= now &&
        item.state.attempt >= maxAttempts
    )
    if (expiredMax) {
      this.update(
        expiredMax,
        { ...withoutExecutionState(expiredMax.state), status: 'dead-letter', updatedAt: now },
        now,
        'occurrence.dead-lettered'
      )
    }
    const candidate = this.list()
      .filter(
        (item) =>
          ((item.state.status === 'pending' && item.state.scheduledAt <= now) ||
            (item.state.status === 'failed' &&
              item.state.scheduledAt <= now &&
              (item.state.nextRetryAt ?? Infinity) <= now) ||
            (item.state.status === 'claimed' &&
              (item.state.claim?.expiresAt ?? Infinity) <= now)) &&
          item.state.attempt < maxAttempts &&
          (eligible === undefined || eligible(item.state))
      )
      .sort(
        (a, b) =>
          a.state.scheduledAt - b.state.scheduledAt ||
          a.state.requestedAt - b.state.requestedAt ||
          a.id.localeCompare(b.id)
      )[0]
    if (!candidate) return undefined
    const state: TriggerOccurrenceState = {
      ...withoutExecutionState(candidate.state),
      status: 'claimed',
      attempt: candidate.state.attempt + 1,
      claim: { owner, claimedAt: now, expiresAt: now + leaseMs },
      updatedAt: now
    }
    return this.eventStore.mutateResource({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      id: candidate.id,
      expectedRevision: candidate.revision,
      idempotencyKey: `${candidate.id}:claim:${owner}:${now}`,
      state,
      createdAt: now,
      event: event(candidate.id, 'occurrence.claimed', now, state, candidate.revision + 1)
    }).resource as StoredResource<TriggerOccurrenceState>
  }
  complete(id: string, owner: string, now: number): StoredResource<TriggerOccurrenceState> {
    return this.transition(id, owner, now, 'completed')
  }
  fail(
    id: string,
    owner: string,
    now: number,
    error: unknown,
    retryDelayMs = 0,
    maxAttempts = 3,
    eligible?: (state: TriggerOccurrenceState) => boolean
  ): StoredResource<TriggerOccurrenceState> {
    finite(retryDelayMs, 'retryDelayMs')
    if (retryDelayMs < 0) throw new Error('retryDelayMs must be non-negative.')
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0)
      throw new Error('maxAttempts must be a positive integer.')
    const current = this.requireClaim(id, owner, now)
    const status = current.state.attempt >= maxAttempts ? 'dead-letter' : 'failed'
    const state: TriggerOccurrenceState = {
      ...withoutExecutionState(current.state),
      status,
      ...(status === 'failed' ? { nextRetryAt: now + retryDelayMs } : {}),
      lastError: {
        name: error instanceof Error ? error.name : 'Error',
        message: 'Trigger occurrence execution failed.'
      },
      updatedAt: now
    }
    return this.update(
      current,
      state,
      now,
      status === 'dead-letter' ? 'occurrence.dead-lettered' : 'occurrence.failed'
    )
  }
  private requireClaim(id: string, owner: string, now: number) {
    const current = this.get(id)
    if (
      !current ||
      current.state.status !== 'claimed' ||
      current.state.claim?.owner !== owner ||
      current.state.claim.expiresAt <= now
    )
      throw new TriggerOccurrenceFencingError('Claim fence rejected.')
    return current
  }
  private transition(id: string, owner: string, now: number, status: 'completed') {
    const current = this.requireClaim(id, owner, now)
    return this.update(
      current,
      { ...withoutExecutionState(current.state), status, updatedAt: now },
      now,
      'occurrence.completed'
    )
  }
  private update(
    current: StoredResource<TriggerOccurrenceState>,
    state: TriggerOccurrenceState,
    now: number,
    type: string
  ) {
    return this.eventStore.mutateResource({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      id: current.id,
      expectedRevision: current.revision,
      idempotencyKey: `${current.id}:${type}:${state.attempt}:${now}`,
      state,
      createdAt: now,
      event: event(current.id, type, now, state, current.revision + 1)
    }).resource as StoredResource<TriggerOccurrenceState>
  }
}
