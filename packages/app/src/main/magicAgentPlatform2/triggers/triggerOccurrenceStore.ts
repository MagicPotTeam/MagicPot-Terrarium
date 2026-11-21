import {
  canonicalPolicyJson,
  sha256PolicyText,
  type PolicyJsonRecord
} from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence'
import {
  MAX_RESOURCE_MUTATION_BATCH_SIZE,
  ResourceNotFoundError,
  ResourceRevisionConflictError,
  type ResourceCursor
} from '../persistence/eventStore'

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
/** 'unknown' is terminal: the execution permit step began, so the outcome cannot be retried safely. */
export type TriggerOccurrenceStatus =
  'pending' | 'claimed' | 'completed' | 'failed' | 'dead-letter' | 'unknown'
/**
 * Statuses no transition leaves. Only these are ever archived. 'failed' is not one: it is retried,
 * and a 'failed' record an older build marked stays in the live index for good (harmless, rare).
 */
export const TRIGGER_OCCURRENCE_TERMINAL_STATUSES: ReadonlySet<TriggerOccurrenceStatus> = new Set([
  'completed',
  'dead-letter',
  'unknown'
])
/**
 * Live-index retention. Once more than ARCHIVE_ABOVE records are unarchived, a call archives the
 * oldest terminal ones, at most ARCHIVE_BATCH, aiming at ARCHIVE_DOWN_TO. After a drain at most
 * ARCHIVE_ABOVE remain, plus any non-terminal records beyond that. The gap between the two marks
 * batches archive writes instead of one extra write per completion.
 */
export const TRIGGER_OCCURRENCE_ARCHIVE_ABOVE = 128
export const TRIGGER_OCCURRENCE_ARCHIVE_DOWN_TO = 64
export const TRIGGER_OCCURRENCE_ARCHIVE_BATCH = 100
const SCAN_PAGE_SIZE = 500
export type TriggerOccurrenceClaim = Readonly<{
  owner: string
  claimedAt: number
  expiresAt: number
}>
/**
 * Durable write-ahead marker: written by the claim owner before the execution permit is
 * consumed. A marked record is never claimed again and the marker is never removed.
 */
export type TriggerOccurrencePermitMarker = Readonly<{
  attempt: number
  owner: string
  markedAt: number
  authorizationId: string
  requestDigest: string
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
  permit?: TriggerOccurrencePermitMarker
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

// Keeps `permit`: a marker survives every transition.
const withoutExecutionState = (
  state: TriggerOccurrenceState
): Omit<TriggerOccurrenceState, 'claim' | 'nextRetryAt' | 'lastError'> => {
  const { claim, nextRetryAt, lastError, ...base } = state
  void claim
  void nextRetryAt
  void lastError
  return base
}

const OUTCOME_UNKNOWN_EVENT = 'occurrence.outcome-unknown'
const outcomeUnknown = (state: TriggerOccurrenceState, now: number): TriggerOccurrenceState => ({
  ...withoutExecutionState(state),
  status: 'unknown',
  lastError: {
    name: 'TriggerOccurrenceOutcomeUnknown',
    message: 'Trigger occurrence outcome is unknown.'
  },
  updatedAt: now
})

const ARCHIVED_EVENT = 'occurrence.archived'
const isTerminal = (state: TriggerOccurrenceState) =>
  TRIGGER_OCCURRENCE_TERMINAL_STATUSES.has(state.status)
const claimOrder = (
  a: StoredResource<TriggerOccurrenceState>,
  b: StoredResource<TriggerOccurrenceState>
) =>
  a.state.scheduledAt - b.state.scheduledAt ||
  a.state.requestedAt - b.state.requestedAt ||
  a.id.localeCompare(b.id)

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
  /**
   * The record by id, archived or not. An archived record keeps its final state (`deleted` is
   * true), so dedup, replayed responses and history read it exactly as before archiving.
   */
  get(id: string): StoredResource<TriggerOccurrenceState> | undefined {
    return this.eventStore.getResource(MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND, id, {
      includeDeleted: true
    }) as StoredResource<TriggerOccurrenceState> | undefined
  }
  /**
   * Diagnostic snapshot: the oldest 1000 unarchived records (every non-terminal one plus the most
   * recent terminal ones). It is not complete, so claiming, sweeping and dedup never use it.
   */
  list(): readonly StoredResource<TriggerOccurrenceState>[] {
    return this.eventStore.listResources({
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      limit: 1000
    }) as readonly StoredResource<TriggerOccurrenceState>[]
  }
  /**
   * Every unarchived record, oldest update first, one page in memory at a time. A record only
   * moves forward in this order (updatedAt never decreases), so none is skipped while paging.
   */
  private *scanUnarchived(pageSize: number): Generator<StoredResource<TriggerOccurrenceState>> {
    let after: ResourceCursor | undefined
    for (;;) {
      const page = this.eventStore.listResources({
        kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
        limit: pageSize,
        ...(after === undefined ? {} : { after })
      }) as readonly StoredResource<TriggerOccurrenceState>[]
      yield* page
      const last = page.at(-1)
      if (page.length < pageSize || last === undefined) return
      after = { updatedAt: last.updatedAt, resourceKind: last.kind, resourceId: last.id }
    }
  }
  /**
   * Moves the oldest terminal records out of the live index (a soft delete that keeps the final
   * state, the receipts and the events), so claimNext reads non-terminal records plus a bounded
   * recent tail instead of the whole history. Bounded work per call: one count, the pages up to
   * `limit` terminal records, one transaction. Returns how many were archived; `limit` means more
   * may remain. Claiming never depends on this, it only bounds the cost of claiming.
   */
  archiveTerminal(now: number, limit = TRIGGER_OCCURRENCE_ARCHIVE_BATCH): number {
    finite(now, 'now')
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RESOURCE_MUTATION_BATCH_SIZE)
      throw new Error(`limit must be an integer from 1 to ${MAX_RESOURCE_MUTATION_BATCH_SIZE}.`)
    const unarchived = this.eventStore.countResources({
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND
    })
    if (unarchived <= TRIGGER_OCCURRENCE_ARCHIVE_ABOVE) return 0
    const wanted = Math.min(unarchived - TRIGGER_OCCURRENCE_ARCHIVE_DOWN_TO, limit)
    const archive: StoredResource<TriggerOccurrenceState>[] = []
    for (const item of this.scanUnarchived(wanted)) {
      if (!isTerminal(item.state)) continue
      archive.push(item)
      if (archive.length >= wanted) break
    }
    if (archive.length === 0) return 0
    try {
      this.eventStore.mutateResourcesBatch(
        archive.map((item) => {
          // Resource timestamps never decrease; a clock step back must not stall archiving.
          const at = Math.max(now, item.updatedAt)
          return {
            operation: 'delete' as const,
            kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
            id: item.id,
            expectedRevision: item.revision,
            idempotencyKey: `${item.id}:${ARCHIVED_EVENT}:${item.state.attempt}:${at}`,
            createdAt: at,
            event: event(item.id, ARCHIVED_EVENT, at, item.state, item.revision + 1)
          }
        })
      )
    } catch (error) {
      // Another store archived one of them first; the whole batch rolled back. Retry next time.
      if (error instanceof ResourceRevisionConflictError || error instanceof ResourceNotFoundError)
        return 0
      throw error
    }
    return archive.length
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
    // Exact receipt lookup: the key's create receipt outlives archiving and has no window.
    const receipt = this.eventStore.getResourceMutation(input.idempotencyKey)
    const sameKey =
      receipt?.resource.kind === MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND &&
      receipt.resource.id !== input.occurrenceId
        ? this.get(receipt.resource.id)
        : undefined
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
    eligible?: (state: TriggerOccurrenceState) => boolean,
    mutable?: (state: TriggerOccurrenceState) => boolean
  ): StoredResource<TriggerOccurrenceState> | undefined {
    finite(now, 'now')
    required(owner, 'owner')
    finite(leaseMs, 'leaseMs')
    if (leaseMs <= 0) throw new Error('leaseMs must be positive.')
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0)
      throw new Error('maxAttempts must be a positive integer.')
    // One pass over every unarchived record, one page in memory. The sweep targets are never
    // candidates (marked, or out of attempts), so the pre-sweep candidate is the post-sweep one.
    let expiredMarked: StoredResource<TriggerOccurrenceState> | undefined
    let expiredMax: StoredResource<TriggerOccurrenceState> | undefined
    let candidate: StoredResource<TriggerOccurrenceState> | undefined
    for (const item of this.scanUnarchived(SCAN_PAGE_SIZE)) {
      const state = item.state
      if (
        state.status === 'claimed' &&
        (state.claim?.expiresAt ?? Infinity) <= now &&
        (mutable === undefined || mutable(state))
      ) {
        // Settle one expired marked claim per call; never-claimable does not depend on this.
        if (state.permit !== undefined) expiredMarked ??= item
        else if (state.attempt >= maxAttempts) expiredMax ??= item
      }
      if (
        state.permit === undefined &&
        ((state.status === 'pending' && state.scheduledAt <= now) ||
          (state.status === 'failed' &&
            state.scheduledAt <= now &&
            (state.nextRetryAt ?? Infinity) <= now) ||
          (state.status === 'claimed' && (state.claim?.expiresAt ?? Infinity) <= now)) &&
        state.attempt < maxAttempts &&
        (eligible === undefined || eligible(state)) &&
        (candidate === undefined || claimOrder(item, candidate) < 0)
      )
        candidate = item
    }
    if (expiredMarked)
      this.update(
        expiredMarked,
        outcomeUnknown(expiredMarked.state, now),
        now,
        OUTCOME_UNKNOWN_EVENT
      )
    if (expiredMax) {
      this.update(
        expiredMax,
        { ...withoutExecutionState(expiredMax.state), status: 'dead-letter', updatedAt: now },
        now,
        'occurrence.dead-lettered'
      )
    }
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
  /**
   * Writes the permit marker for the current attempt before the permit is consumed. Needs the
   * live claim (owner and unexpired lease); repeating the same marker is a no-op, any other
   * call on a marked record is refused.
   */
  markPermit(
    id: string,
    owner: string,
    now: number,
    input: Readonly<{ authorizationId: string; requestDigest: string }>
  ): StoredResource<TriggerOccurrenceState> {
    finite(now, 'now')
    required(owner, 'owner')
    required(input.authorizationId, 'authorizationId')
    required(input.requestDigest, 'requestDigest')
    const current = this.requireClaim(id, owner, now)
    const marked = current.state.permit
    if (marked) {
      if (
        marked.attempt === current.state.attempt &&
        marked.authorizationId === input.authorizationId &&
        marked.requestDigest === input.requestDigest
      )
        return current
      throw new TriggerOccurrenceFencingError('Occurrence permit is already marked.')
    }
    const state: TriggerOccurrenceState = {
      ...current.state,
      permit: {
        attempt: current.state.attempt,
        owner,
        markedAt: now,
        authorizationId: input.authorizationId,
        requestDigest: input.requestDigest
      },
      updatedAt: now
    }
    return this.update(current, state, now, 'occurrence.permit-marked')
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
    const current = this.requireSettlementClaim(id, owner, now)
    if (current.state.permit !== undefined)
      return this.update(current, outcomeUnknown(current.state, now), now, OUTCOME_UNKNOWN_EVENT)
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
  // A marked record is never claimed again, so its claim owner cannot change: settling it
  // checks status and owner only. An unmarked record keeps the full lease fence.
  private requireSettlementClaim(id: string, owner: string, now: number) {
    const current = this.get(id)
    if (
      !current ||
      current.state.status !== 'claimed' ||
      current.state.claim?.owner !== owner ||
      (current.state.permit === undefined && current.state.claim.expiresAt <= now)
    )
      throw new TriggerOccurrenceFencingError('Claim fence rejected.')
    return current
  }
  private transition(id: string, owner: string, now: number, status: 'completed') {
    const current = this.requireSettlementClaim(id, owner, now)
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
