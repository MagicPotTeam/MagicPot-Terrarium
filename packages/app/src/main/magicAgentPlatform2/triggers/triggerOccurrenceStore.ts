import {
  canonicalPolicyJson,
  sha256PolicyText,
  type PolicyJsonRecord
} from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence'
import {
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
 * Live-index retention. Once more than ARCHIVE_ABOVE records are unarchived, a poll archives the
 * oldest terminal ones, aiming at ARCHIVE_DOWN_TO. After a drain at most ARCHIVE_ABOVE remain,
 * plus any non-terminal records beyond that. The gap between the two marks batches archive
 * writes instead of one extra write per completion.
 */
export const TRIGGER_OCCURRENCE_ARCHIVE_ABOVE = 128
export const TRIGGER_OCCURRENCE_ARCHIVE_DOWN_TO = 64
/**
 * Most writes of one poll's archive and dead-letter transaction: an archive is one write, a
 * dead-letter two (the final state, then its archive). The first poll adds the queue marker.
 */
export const TRIGGER_OCCURRENCE_ARCHIVE_BATCH = 100
/**
 * A cron or calendar occurrence due this long and never claimed is stale: a missed instant of its
 * schedule (the app slept or was closed, runs fell behind, or the trigger is disabled or deleted).
 * As for a cron catch-up, only the newest maxCatchUpRuns stale instants of a trigger still run;
 * older ones are dead-lettered (final in every build) and archived without running. Any other
 * occurrence is a separate event and never goes stale with age: of those, only the ones an older
 * build stranded are treated so (see TriggerOccurrenceQueueMarker).
 */
export const TRIGGER_OCCURRENCE_STALE_AFTER_MS = 10 * 60_000
/** Sources whose occurrences are instants of a schedule, which a catch-up may coalesce. */
export const TRIGGER_OCCURRENCE_SCHEDULE_SOURCES: ReadonlySet<TriggerOccurrenceSource> = new Set([
  'cron',
  'calendar'
])
/**
 * One record of its own kind, written by the first poll of a build that claims beyond the oldest
 * 1000 records. Older builds claimed only within their oldest 1000 unarchived records, so once a
 * store held more, a never-claimed record past them was never reached. A store that held at most
 * 1000 holds no stranded record. Older builds never read this kind.
 */
export const MAGIC_AGENT_TRIGGER_OCCURRENCE_QUEUE_RESOURCE_KIND = 'trigger-occurrence-queue'
export const TRIGGER_OCCURRENCE_QUEUE_MARKER_ID = 'marker'
/** How many of the oldest unarchived records an older build claimed within. */
const LEGACY_CLAIM_WINDOW = 1000
export type TriggerOccurrenceQueueMarker = Readonly<{
  schemaVersion: 1
  /** When the store was first polled by a build that claims every record. */
  firstPollAt: number
  /**
   * Set when more than LEGACY_CLAIM_WINDOW records were unarchived at that poll: a never-claimed
   * record both due and last written before this time may be one an older build stranded. It is
   * the stale horizon before that poll, so nothing enqueued shortly before counts.
   */
  strandedBefore?: number
}>
/** Rows of the old part of the live index one poll reads; see TriggerOccurrenceStore.poll. */
const SCAN_PAGE_SIZE = 500
/**
 * Polls in a row whose archive and dead-letter batch failed before the pass moves past the page
 * without it. A batch that keeps failing must not hold the pass on one page: the old records past
 * it would never be read again, so never claimed. The next pass tries those writes again.
 */
const PASS_FAILED_BATCH_LIMIT = 3
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
const event = (
  id: string,
  type: string,
  at: number,
  payload: unknown,
  revision: number,
  kind = MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND
) => ({
  protocolVersion: '2.0.0',
  id: `${id}:${type}:${revision}`,
  type,
  createdAt: at,
  payload,
  envelopeKind: 'event' as const,
  streamId: `${kind}:${id}`,
  sequence: revision,
  resource: { kind, id },
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
const DEAD_LETTERED_EVENT = 'occurrence.dead-lettered'
const QUEUE_MARKED_EVENT = 'occurrence-queue.marked'
const STALE_ERROR = Object.freeze({
  name: 'TriggerOccurrenceStale',
  message: 'Trigger occurrence went stale before it was claimed.'
})
/**
 * The event store refuses a write stamped before the record's last update, so a clock that stepped
 * back (or a record stamped by a clock ahead of this one) would make every claim and settlement of
 * it fail, and a settled dispatch would stay claimed and run again after its lease. Writes are
 * stamped no earlier than the record; leases, retries and markers still use the caller's clock.
 */
const writeTime = (now: number, current: StoredResource<TriggerOccurrenceState>) =>
  Math.max(now, current.updatedAt)
const isTerminal = (state: TriggerOccurrenceState) =>
  TRIGGER_OCCURRENCE_TERMINAL_STATUSES.has(state.status)
type Occurrence = StoredResource<TriggerOccurrenceState>
type OrderKey = Readonly<{ id: string; scheduledAt: number; requestedAt: number }>
const orderKey = (item: Occurrence): OrderKey => ({
  id: item.id,
  scheduledAt: item.state.scheduledAt,
  requestedAt: item.state.requestedAt
})
// Claim order, oldest first; the newest of a trigger's stale records are the last in it.
const keyOrder = (a: OrderKey, b: OrderKey) =>
  a.scheduledAt - b.scheduledAt || a.requestedAt - b.requestedAt || a.id.localeCompare(b.id)
const claimOrder = (a: Occurrence, b: Occurrence) => keyOrder(orderKey(a), orderKey(b))
// Never claimed, and both due and last written before `before`.
const unclaimedBefore = (item: Occurrence, before: number) =>
  item.state.status === 'pending' &&
  item.state.attempt === 0 &&
  item.state.permit === undefined &&
  item.updatedAt < before &&
  item.state.scheduledAt < before
// A stale record runs only if it is among the newest `catchUpRuns` stale ones of its trigger: a
// cron or calendar instant unclaimed past the horizon, or another occurrence an older build
// stranded. Within min(...) a stranded record is always in the old part of the live index.
const isStale = (item: Occurrence, staleBefore: number, strandedBefore: number | undefined) =>
  TRIGGER_OCCURRENCE_SCHEDULE_SOURCES.has(item.state.source)
    ? unclaimedBefore(item, staleBefore)
    : strandedBefore !== undefined && unclaimedBefore(item, Math.min(staleBefore, strandedBefore))
// The bound a stored marker sets; a marker this build cannot read marks nothing as stranded.
const strandedBeforeOf = (state: unknown): number | undefined => {
  const { schemaVersion, strandedBefore } = (state ?? {}) as Record<string, unknown>
  return schemaVersion === 1 &&
    typeof strandedBefore === 'number' &&
    Number.isFinite(strandedBefore)
    ? strandedBefore
    : undefined
}
const cursorOf = (item: Occurrence): ResourceCursor => ({
  updatedAt: item.updatedAt,
  resourceKind: item.kind,
  resourceId: item.id
})
// '!' sorts before every resource kind, so this cursor starts at the first record written at `at`.
const firstAt = (at: number): ResourceCursor => ({
  updatedAt: at,
  resourceKind: '!',
  resourceId: '!'
})

export type TriggerOccurrencePollInput = Readonly<{
  now: number
  owner: string
  leaseMs: number
  maxAttempts?: number
  /** Whether an occurrence may be claimed now (its trigger exists and is enabled). */
  eligible?: (state: TriggerOccurrenceState) => boolean
  /** Whether this store may sweep or dead-letter the record (it may always claim it). */
  mutable?: (state: TriggerOccurrenceState) => boolean
  /** The trigger's maxCatchUpRuns: how many of its stale occurrences still run. Default 1. */
  catchUpRuns?: (triggerId: string) => number
}>
export type TriggerOccurrencePollResult = Readonly<{
  claimed?: StoredResource<TriggerOccurrenceState>
  /** This poll archived or dead-lettered records and more are left: poll again soon. */
  backlog: boolean
  /** Stale records this poll dead-lettered: they will not run. */
  deadLettered: number
  /** Archiving or dead-lettering failed and rolled back; the claim still ran. */
  maintenanceError?: unknown
}>

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
  // The pass: a walk over the old part of the live index (records not written for the stale
  // horizon), a page per poll, and the newest stale records per trigger it has met so far. It is
  // per store instance; a new instance starts a new pass, which is always safe.
  private pass: { after?: ResourceCursor; kept: Map<string, OrderKey[]> } = { kept: new Map() }
  // From the last finished pass: the stale records that may still run, and for each trigger that
  // filled its quota the oldest of them. A stale record older than that has at least `quota`
  // newer ones, so it is dead-lettered.
  private keptStale: ReadonlySet<string> = new Set()
  private staleFloor: ReadonlyMap<string, Readonly<{ key: OrderKey; quota: number }>> = new Map()
  // The marker's bound, once this store has read or written the marker. Until then polls go by
  // the marker this store's first poll proposed, and each writes it with its batch.
  private markerKnown = false
  private strandedBefore: number | undefined
  private proposedMarker: TriggerOccurrenceQueueMarker | undefined
  // Batches that failed in a row; see PASS_FAILED_BATCH_LIMIT.
  private failedBatches = 0
  /** The marker this poll must write, if none is stored yet; sets `strandedBefore` either way. */
  private markerToWrite(now: number, live: number): TriggerOccurrenceQueueMarker | undefined {
    if (this.markerKnown) return undefined
    const stored = this.eventStore.getResource(
      MAGIC_AGENT_TRIGGER_OCCURRENCE_QUEUE_RESOURCE_KIND,
      TRIGGER_OCCURRENCE_QUEUE_MARKER_ID,
      { includeDeleted: true }
    )
    if (stored) {
      this.markerKnown = true
      this.strandedBefore = strandedBeforeOf(stored.state)
      return undefined
    }
    this.proposedMarker ??= {
      schemaVersion: 1,
      firstPollAt: now,
      ...(live > LEGACY_CLAIM_WINDOW
        ? { strandedBefore: now - TRIGGER_OCCURRENCE_STALE_AFTER_MS }
        : {})
    }
    this.strandedBefore = this.proposedMarker.strandedBefore
    return this.proposedMarker
  }
  // Committed with the poll's batch, so no record is dead-lettered as stranded unless the marker
  // that says so is stored. A concurrent writer's marker makes the create conflict; the next poll
  // reads that one.
  private markerMutation(marker: TriggerOccurrenceQueueMarker) {
    const kind = MAGIC_AGENT_TRIGGER_OCCURRENCE_QUEUE_RESOURCE_KIND
    const id = TRIGGER_OCCURRENCE_QUEUE_MARKER_ID
    return {
      operation: 'create' as const,
      kind,
      id,
      idempotencyKey: `${kind}:${id}:${QUEUE_MARKED_EVENT}`,
      state: marker,
      createdAt: marker.firstPollAt,
      event: event(id, QUEUE_MARKED_EVENT, marker.firstPollAt, marker, 0, kind)
    }
  }
  private page(after: ResourceCursor | undefined): readonly Occurrence[] {
    return this.eventStore.listResources({
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      limit: SCAN_PAGE_SIZE,
      ...(after === undefined ? {} : { after })
    }) as readonly Occurrence[]
  }
  /**
   * Every unarchived record after `after`, oldest update first, one page in memory at a time. A
   * record only moves forward in this order (updatedAt never decreases), so none is skipped.
   */
  private *scanUnarchived(after: ResourceCursor): Generator<Occurrence> {
    for (;;) {
      const page = this.page(after)
      yield* page
      const last = page.at(-1)
      if (page.length < SCAN_PAGE_SIZE || last === undefined) return
      after = cursorOf(last)
    }
  }
  /**
   * What one poll reads: a page of the old part (records last written before `staleBefore`) from
   * where the pass stands, then the whole recent part. In steady state the old part fits in the
   * page, so a poll reads the live index once. After an upgrade the old part holds the backlog:
   * the pass walks it a page per poll, while every poll still reads every recent record.
   */
  private readPoll(staleBefore: number) {
    const page = this.page(this.pass.after)
    let split = page.findIndex((item) => item.updatedAt >= staleBefore)
    if (split < 0) split = page.length
    const old = page.slice(0, split)
    const recent = page.slice(split)
    const last = page.at(-1)
    if (last !== undefined && page.length === SCAN_PAGE_SIZE)
      for (const item of this.scanUnarchived(
        split < page.length ? cursorOf(last) : firstAt(staleBefore)
      ))
        recent.push(item)
    return { old, recent, passEnds: split < page.length || page.length < SCAN_PAGE_SIZE }
  }
  // Moves the pass on after its writes committed; at its end, publishes what it kept.
  private advancePass(
    last: Occurrence | undefined,
    done: boolean,
    kept: readonly Occurrence[],
    quota: (triggerId: string) => number
  ) {
    for (const item of kept) {
      const triggerId = item.state.triggerId
      const newest = (this.pass.kept.get(triggerId) ?? []).filter((key) => key.id !== item.id)
      newest.push(orderKey(item))
      this.pass.kept.set(
        triggerId,
        newest.sort((a, b) => keyOrder(b, a)).slice(0, quota(triggerId))
      )
    }
    if (!done) {
      if (last !== undefined) this.pass.after = cursorOf(last)
      return
    }
    const ids = new Set<string>()
    const floor = new Map<string, Readonly<{ key: OrderKey; quota: number }>>()
    for (const [triggerId, keys] of this.pass.kept) {
      for (const key of keys) ids.add(key.id)
      const oldest = keys.at(-1)
      if (oldest !== undefined && keys.length >= quota(triggerId))
        floor.set(triggerId, { key: oldest, quota: keys.length })
    }
    this.keptStale = ids
    this.staleFloor = floor
    this.pass = { kept: new Map() }
  }
  // Soft delete that keeps the final state, the receipts and the events. The row and the
  // receipt already hold that state, and nothing reads occurrence events, so the archive event
  // names only the final status instead of a third copy of the state.
  private archiveMutation(item: Occurrence, revision: number, now: number) {
    const at = writeTime(now, item)
    return {
      operation: 'delete' as const,
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      id: item.id,
      expectedRevision: revision,
      idempotencyKey: `${item.id}:${ARCHIVED_EVENT}:${item.state.attempt}:${at}`,
      createdAt: at,
      event: event(item.id, ARCHIVED_EVENT, at, { status: item.state.status }, revision + 1)
    }
  }
  // A stale record ends as dead-letter, which every build treats as final, and is archived in
  // the same transaction so it never comes back into the live index.
  private deadLetterStale(item: Occurrence, now: number) {
    const at = writeTime(now, item)
    const state: TriggerOccurrenceState = {
      ...withoutExecutionState(item.state),
      status: 'dead-letter',
      lastError: STALE_ERROR,
      updatedAt: at
    }
    const deadLettered = { ...item, state, updatedAt: at }
    return [
      {
        operation: 'update' as const,
        kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
        id: item.id,
        expectedRevision: item.revision,
        idempotencyKey: `${item.id}:${DEAD_LETTERED_EVENT}:${state.attempt}:${now}`,
        state,
        createdAt: at,
        event: event(item.id, DEAD_LETTERED_EVENT, at, state, item.revision + 1)
      },
      this.archiveMutation(deadLettered, item.revision + 1, now)
    ]
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
  /** One poll's claim; a failed archive or dead-letter batch is left to the next call. */
  claimNext(
    now: number,
    owner: string,
    leaseMs: number,
    maxAttempts = 3,
    eligible?: (state: TriggerOccurrenceState) => boolean,
    mutable?: (state: TriggerOccurrenceState) => boolean
  ): StoredResource<TriggerOccurrenceState> | undefined {
    return this.poll({
      now,
      owner,
      leaseMs,
      maxAttempts,
      ...(eligible === undefined ? {} : { eligible }),
      ...(mutable === undefined ? {} : { mutable })
    }).claimed
  }
  /**
   * One scheduler poll: archive and dead-letter a bounded batch, sweep, then claim the first due
   * occurrence in schedule order. Its work is bounded: a count, one page of the old part of the
   * live index plus its recent part (see readPoll), one transaction of at most ARCHIVE_BATCH
   * writes, two sweeps and the claim.
   * - Terminal records beyond the retained tail are archived, oldest first.
   * - Stale records (missed cron and calendar instants, and records an older build stranded; see
   *   isStale) are dead-lettered and archived, except the newest `catchUpRuns` of each trigger.
   *   Those still run, but only once a poll has read the whole old part or a pass over it has
   *   ended, so that they are known to be the newest; none runs while a long backlog drains.
   *   Every other record runs, however long it waited.
   * - While a pass spans polls, an old record is claimable only in the poll that reads it; recent
   *   records are read by every poll, so a fresh occurrence is claimed at once.
   * - A failed batch rolls back whole and is reported; the claim still runs. After
   *   PASS_FAILED_BATCH_LIMIT failures in a row the pass moves past the page without it.
   * - The first poll also writes the queue marker (see TriggerOccurrenceQueueMarker).
   */
  poll(input: TriggerOccurrencePollInput): TriggerOccurrencePollResult {
    const { now, owner, leaseMs, maxAttempts = 3, eligible, mutable } = input
    finite(now, 'now')
    required(owner, 'owner')
    finite(leaseMs, 'leaseMs')
    if (leaseMs <= 0) throw new Error('leaseMs must be positive.')
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0)
      throw new Error('maxAttempts must be a positive integer.')
    const quotas = new Map<string, number>()
    const quota = (triggerId: string) => {
      let value = quotas.get(triggerId)
      if (value === undefined) {
        const runs = input.catchUpRuns?.(triggerId)
        value = runs !== undefined && Number.isInteger(runs) && runs > 0 ? runs : 1
        quotas.set(triggerId, value)
      }
      return value
    }
    const staleBefore = now - TRIGGER_OCCURRENCE_STALE_AFTER_MS
    const live = this.eventStore.countResources({
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND
    })
    const marker = this.markerToWrite(now, live)
    const strandedBefore = this.strandedBefore
    // A poll that reads the old part from its start to its end sees every stale record, so its
    // own count of the newest per trigger is exact, whatever it manages to write.
    const fromStart = this.pass.after === undefined
    const { old, recent, passEnds } = this.readPoll(staleBefore)
    const seesAllStale = fromStart && passEnds
    const stale = (item: Occurrence) =>
      isStale(item, staleBefore, strandedBefore) && (mutable === undefined || mutable(item.state))
    // A stale record goes once its trigger has at least `quota` newer stale ones, in this page or
    // as the last finished pass found. That never removes one of the newest `quota`.
    const doomed = new Set<string>()
    const byTrigger = new Map<string, Occurrence[]>()
    for (const item of old) {
      if (!stale(item)) continue
      const triggerId = item.state.triggerId
      const floor = this.staleFloor.get(triggerId)
      if (
        floor !== undefined &&
        floor.quota >= quota(triggerId) &&
        keyOrder(orderKey(item), floor.key) < 0
      )
        doomed.add(item.id)
      else {
        const items = byTrigger.get(triggerId)
        if (items) items.push(item)
        else byTrigger.set(triggerId, [item])
      }
    }
    for (const [triggerId, items] of byTrigger)
      for (const item of items.sort((a, b) => claimOrder(b, a)).slice(quota(triggerId)))
        doomed.add(item.id)
    let room =
      live > TRIGGER_OCCURRENCE_ARCHIVE_ABOVE ? live - TRIGGER_OCCURRENCE_ARCHIVE_DOWN_TO : 0
    const deadLetter: Occurrence[] = []
    const archive: Occurrence[] = []
    const kept: Occurrence[] = []
    let full = false
    const take = (item: Occurrence, into: Occurrence[]) => {
      const writes = 2 * deadLetter.length + archive.length + (into === deadLetter ? 2 : 1)
      full = writes > TRIGGER_OCCURRENCE_ARCHIVE_BATCH
      if (!full) into.push(item)
      return !full
    }
    // The pass stops at the batch limit; the next poll reads on from the last record handled.
    let processed = 0
    for (const item of old) {
      if (doomed.has(item.id)) {
        if (!take(item, deadLetter)) break
      } else if (isTerminal(item.state) && room > 0) {
        if (!take(item, archive)) break
        room -= 1
      } else if (stale(item)) kept.push(item)
      processed += 1
    }
    const passDone = passEnds && !full
    // Recent terminal records are newer than every old one: archived only once the pass is done.
    if (passDone)
      for (const item of recent) {
        if (room === 0) break
        if (!isTerminal(item.state)) continue
        if (!take(item, archive)) break
        room -= 1
      }
    const writes = [
      ...(marker ? [this.markerMutation(marker)] : []),
      ...deadLetter.flatMap((item) => this.deadLetterStale(item, now)),
      ...archive.map((item) => this.archiveMutation(item, item.revision, now))
    ]
    let committed = true
    let maintenanceError: unknown
    if (writes.length > 0)
      try {
        this.eventStore.mutateResourcesBatch(writes)
      } catch (error) {
        committed = false
        // A record changed under this poll (another store or process): the batch rolled back
        // whole and the next poll reads again. Anything else is reported.
        if (!(
          error instanceof ResourceRevisionConflictError || error instanceof ResourceNotFoundError
        ))
          maintenanceError = error
      }
    this.failedBatches = committed ? 0 : this.failedBatches + 1
    if (committed && marker) this.markerKnown = true
    if (committed) this.advancePass(old[processed - 1], passDone, kept, quota)
    else if (this.failedBatches >= PASS_FAILED_BATCH_LIMIT) {
      // Past the whole page, still counting the stale records it holds among the newest.
      for (const item of old.slice(processed))
        if (stale(item) && !doomed.has(item.id)) kept.push(item)
      this.failedBatches = 0
      this.advancePass(old.at(-1), passEnds, kept, quota)
    }
    // One pass over the records read: the sweep targets are never candidates (marked, or out of
    // attempts), so the pre-sweep candidate is the post-sweep one.
    const removed = new Set(archive.map((item) => item.id))
    let expiredMarked: Occurrence | undefined
    let expiredMax: Occurrence | undefined
    let candidate: Occurrence | undefined
    for (const rows of [old, recent])
      for (const item of rows) {
        if (doomed.has(item.id) || removed.has(item.id)) continue
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
        if (stale(item) && !seesAllStale && !this.keptStale.has(item.id)) continue
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
        DEAD_LETTERED_EVENT
      )
    }
    const maintained = deadLetter.length + archive.length > 0
    const report = {
      backlog: committed && maintained && (full || !passDone),
      deadLettered: committed ? deadLetter.length : 0,
      ...(maintenanceError === undefined ? {} : { maintenanceError })
    }
    if (!candidate) return report
    // The lease runs on this clock; the write is stamped no earlier than the record (see update).
    const at = writeTime(now, candidate)
    const state: TriggerOccurrenceState = {
      ...withoutExecutionState(candidate.state),
      status: 'claimed',
      attempt: candidate.state.attempt + 1,
      claim: { owner, claimedAt: now, expiresAt: now + leaseMs },
      updatedAt: at
    }
    const claimed = this.eventStore.mutateResource({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      id: candidate.id,
      expectedRevision: candidate.revision,
      idempotencyKey: `${candidate.id}:claim:${owner}:${now}`,
      state,
      createdAt: at,
      event: event(candidate.id, 'occurrence.claimed', at, state, candidate.revision + 1)
    }).resource as Occurrence
    return { ...report, claimed }
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
      status === 'dead-letter' ? DEAD_LETTERED_EVENT : 'occurrence.failed'
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
    next: TriggerOccurrenceState,
    now: number,
    type: string
  ) {
    const at = writeTime(now, current)
    const state: TriggerOccurrenceState = { ...next, updatedAt: at }
    return this.eventStore.mutateResource({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_OCCURRENCE_RESOURCE_KIND,
      id: current.id,
      expectedRevision: current.revision,
      idempotencyKey: `${current.id}:${type}:${state.attempt}:${now}`,
      state,
      createdAt: at,
      event: event(current.id, type, at, state, current.revision + 1)
    }).resource as StoredResource<TriggerOccurrenceState>
  }
}
