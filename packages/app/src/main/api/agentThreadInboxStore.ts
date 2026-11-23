import { randomUUID } from 'node:crypto'
import {
  ResourceRevisionConflictError,
  type MagicAgentEventStore,
  type ResourceCursor,
  type ResourceMutationInput,
  type StoredResource
} from '../magicAgentPlatform2/persistence/eventStore'
import { activeInstanceLeasePids } from '../magicAgentPlatform2/persistence/writeLock'
import {
  AGENT_THREAD_EVENT_TYPES,
  AGENT_THREAD_INBOX_LIMITS as LIMITS,
  type AgentThreadEventType
} from '@shared/api/agentThreadInbox'

/** Written once and never updated: the event itself. */
export const THREAD_EVENT_KIND = 'agent-thread-event-v1'
/** The small record that changes: status, claim and start. No lease token or webContents id. */
export const THREAD_EVENT_STATE_KIND = 'agent-thread-event-state-v1'
export const THREAD_INBOX_UNAVAILABLE = 'Thread inbox unavailable.'
const PAGE = 1000

/** One Agent thread session: storage scope + normalized route key + conversation (session) id. */
export type ThreadEventSession = Readonly<{
  storageScope: string
  routeKey: string
  conversationId: string
}>
export type ThreadEventRecord = Readonly<
  ThreadEventSession & {
    v: 1
    id: string
    type: AgentThreadEventType
    source: string
    text: string
    /** Unique per session among queued and claimed events: a repeat while one waits collapses into it. */
    idempotencyKey?: string
    createdAt: number
    expiresAt: number
  }
>
/**
 * queued -> claimed -> done | queued (released, or a claim of another boot, which never started a
 * turn); queued | claimed -> expired. done and expired are final: an event runs at most one turn.
 */
export type ThreadEventStatus = 'queued' | 'claimed' | 'done' | 'expired'
export type ThreadEventState = Readonly<{
  v: 1
  id: string
  status: ThreadEventStatus
  /** The process (boot id) that holds the claim; only while claimed. */
  claim?: Readonly<{ boot: string; at: number }>
  /** When MAIN admitted the turn's request (status done). */
  startedAt?: number
  /** Why it expired: 'ttl', or the session was stopped or removed. */
  expiredReason?: string
}>
export type ThreadEventEntry = Readonly<{ event: ThreadEventRecord; state: ThreadEventState }>
export type ThreadEventAppend = Readonly<
  ThreadEventSession & {
    type: AgentThreadEventType
    source: string
    text: string
    idempotencyKey?: string
  }
>
type Indexed = {
  event: ThreadEventRecord
  state: ThreadEventState
  revision: number
  updatedAt: number
}

const FINAL: ReadonlySet<ThreadEventStatus> = new Set(['done', 'expired'])
const STATUSES: ReadonlySet<unknown> = new Set(['queued', 'claimed', 'done', 'expired'])
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown, max = 512): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const sameSession = (a: ThreadEventSession, b: ThreadEventSession): boolean =>
  a.storageScope === b.storageScope &&
  a.routeKey === b.routeKey &&
  a.conversationId === b.conversationId
const keyOf = (session: ThreadEventSession, key: string): string =>
  JSON.stringify([session.storageScope, session.routeKey, session.conversationId, key])
const withoutClaim = (state: ThreadEventState): Omit<ThreadEventState, 'claim'> => {
  const { claim: _claim, ...rest } = state
  return rest
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

export function isThreadEventSession(value: unknown): value is ThreadEventSession {
  return (
    plain(value) &&
    str(value.storageScope) &&
    str(value.routeKey, 4096) &&
    str(value.conversationId, 128)
  )
}

function readState(row: StoredResource): ThreadEventState | undefined {
  const state = row.state
  if (
    row.deleted ||
    !plain(state) ||
    state.v !== 1 ||
    state.id !== row.id ||
    !STATUSES.has(state.status)
  )
    return undefined
  const claim = state.claim
  if (claim !== undefined && (!plain(claim) || !str(claim.boot) || !time(claim.at)))
    return undefined
  if ((state.status === 'claimed') !== (claim !== undefined)) return undefined
  if (state.startedAt !== undefined && (!time(state.startedAt) || state.status !== 'done'))
    return undefined
  return state as ThreadEventState
}
function validRecord(record: unknown, id: string): record is ThreadEventRecord {
  if (!plain(record) || record.v !== 1 || record.id !== id || !isThreadEventSession(record))
    return false
  const r = record as unknown as Record<string, unknown>
  if (!(AGENT_THREAD_EVENT_TYPES as readonly unknown[]).includes(r.type)) return false
  if (!str(r.source, LIMITS.sourceCharacters)) return false
  if (typeof r.text !== 'string' || !r.text.trim() || r.text.length > LIMITS.textCharacters)
    return false
  if (r.idempotencyKey !== undefined && !str(r.idempotencyKey, LIMITS.idempotencyKeyCharacters))
    return false
  return time(r.createdAt) && time(r.expiresAt) && r.expiresAt > r.createdAt
}
function readRecord(row: StoredResource | undefined, id: string): ThreadEventRecord | undefined {
  return row && !row.deleted && validRecord(row.state, id) ? row.state : undefined
}

/**
 * Durable MAIN store of thread events. Append-only: the event is written once; every later change
 * writes only the small state record (compare-and-swap). A claim belongs to the boot (process) that
 * made it. A start makes the event final, so on open a claim of another boot never started a turn
 * and is queued again: delivering it cannot run a second turn. Events past their TTL expire on open
 * and whenever the queued set is swept. Recovery never runs while another live process holds the
 * same file: then the store serves nothing.
 */
export class ThreadInboxStore {
  private readonly index = new Map<string, Indexed>()
  /** Idempotency key (per session) -> event id, for queued and claimed events only. */
  private readonly keys = new Map<string, string>()
  readonly unavailable: boolean

  constructor(
    private readonly store: MagicAgentEventStore,
    private readonly boot: string,
    private readonly now: () => number = Date.now
  ) {
    if (!str(boot)) throw new Error('Invalid thread inbox boot.')
    const path = store.getStorageInfo().path
    this.unavailable =
      path !== ':memory:' && activeInstanceLeasePids(path).some((pid) => pid !== process.pid)
    if (!this.unavailable) this.recover()
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error(THREAD_INBOX_UNAVAILABLE)
  }

  private mutation(
    operation: 'create' | 'update',
    kind: string,
    id: string,
    state: unknown,
    createdAt: number,
    expectedRevision?: number
  ): ResourceMutationInput {
    const eventId = randomUUID(),
      revision = operation === 'create' ? 0 : expectedRevision! + 1
    return {
      operation,
      kind,
      id,
      idempotencyKey: `thread-event:${eventId}`,
      state,
      createdAt,
      ...(operation === 'update' ? { expectedRevision } : {}),
      event: {
        protocolVersion: '2.0.0',
        id: eventId,
        type: kind === THREAD_EVENT_KIND ? 'thread-event-queued' : 'thread-event-state',
        createdAt,
        payload: {},
        envelopeKind: 'event',
        streamId: `${kind}:${id}`,
        sequence: revision
      }
    }
  }

  /** CAS on the state record; final states leave the index (and free the idempotency key). */
  private write(entry: Indexed, next: ThreadEventState): ThreadEventEntry | undefined {
    let written: { revision: number; updatedAt: number }
    try {
      const [result] = this.store.mutateResourcesBatch([
        this.mutation(
          'update',
          THREAD_EVENT_STATE_KIND,
          next.id,
          next,
          Math.max(this.now(), entry.updatedAt),
          entry.revision
        )
      ])
      written = { revision: result.resource.revision, updatedAt: result.resource.updatedAt }
    } catch (error) {
      if (!(error instanceof ResourceRevisionConflictError)) throw error
      this.refresh(entry.event.id)
      return undefined
    }
    if (FINAL.has(next.status)) this.forget(entry.event)
    else this.remember(freeze({ event: entry.event, state: next, ...written }))
    return freeze({ event: entry.event, state: next })
  }

  private remember(entry: Indexed): void {
    this.index.set(entry.event.id, entry)
    if (entry.event.idempotencyKey)
      this.keys.set(keyOf(entry.event, entry.event.idempotencyKey), entry.event.id)
  }

  private forget(event: ThreadEventRecord): void {
    this.index.delete(event.id)
    if (event.idempotencyKey) {
      const key = keyOf(event, event.idempotencyKey)
      if (this.keys.get(key) === event.id) this.keys.delete(key)
    }
  }

  private recover(): void {
    const rows: Array<[StoredResource, ThreadEventState]> = []
    let after: ResourceCursor | undefined
    for (;;) {
      const page = this.store.listResources({
        kind: THREAD_EVENT_STATE_KIND,
        limit: PAGE,
        ...(after ? { after } : {})
      })
      for (const row of page) {
        const state = readState(row)
        if (state && !FINAL.has(state.status)) rows.push([row, state])
      }
      if (page.length < PAGE) break
      const last = page[page.length - 1]
      after = { updatedAt: last.updatedAt, resourceKind: last.kind, resourceId: last.id }
    }
    for (const [row, state] of rows) {
      const event = readRecord(this.store.getResource(THREAD_EVENT_KIND, row.id), row.id)
      if (!event) continue
      const entry = freeze({ event, state, revision: row.revision, updatedAt: row.updatedAt })
      this.remember(entry)
      // A claim of another boot never started a turn: queued again (delivery stays at most once).
      if (state.status === 'claimed' && state.claim!.boot !== this.boot)
        this.write(entry, { ...withoutClaim(state), status: 'queued' })
    }
    this.expireStale()
  }

  /**
   * Both records in one transaction. With an idempotency key that a queued (unexpired) or claimed
   * event of the same session already holds, nothing is written and that event is returned.
   */
  append(input: ThreadEventAppend): ThreadEventEntry & { duplicate: boolean } {
    this.assertAvailable()
    if (!isThreadEventSession(input)) throw new Error('Invalid thread event.')
    if (input.idempotencyKey !== undefined) {
      const existing = this.index.get(this.keys.get(keyOf(input, input.idempotencyKey)) ?? '')
      if (existing?.state.status === 'queued' && existing.event.expiresAt <= this.now())
        this.write(existing, { ...existing.state, status: 'expired', expiredReason: 'ttl' })
      else if (existing) return { event: existing.event, state: existing.state, duplicate: true }
    }
    const id = randomUUID(),
      createdAt = this.now()
    const event = {
      v: 1 as const,
      id,
      storageScope: input.storageScope,
      routeKey: input.routeKey,
      conversationId: input.conversationId,
      type: input.type,
      source: input.source,
      text: input.text,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      createdAt,
      expiresAt: createdAt + LIMITS.ttlMs
    }
    if (!validRecord(event, id)) throw new Error('Invalid thread event.')
    const state: ThreadEventState = { v: 1, id, status: 'queued' }
    const [, result] = this.store.mutateResourcesBatch([
      this.mutation('create', THREAD_EVENT_KIND, id, event, createdAt),
      this.mutation('create', THREAD_EVENT_STATE_KIND, id, state, createdAt)
    ])
    const entry = freeze({
      event,
      state,
      revision: result.resource.revision,
      updatedAt: result.resource.updatedAt
    })
    this.remember(entry)
    return { event: entry.event, state: entry.state, duplicate: false }
  }

  /** queued -> claimed{boot, at}. Undefined when not queued here, expired, or another claim won. */
  claim(id: string): ThreadEventEntry | undefined {
    this.assertAvailable()
    const entry = this.index.get(id)
    if (!entry || entry.state.status !== 'queued') return undefined
    if (entry.event.expiresAt <= this.now()) {
      this.write(entry, { ...entry.state, status: 'expired', expiredReason: 'ttl' })
      return undefined
    }
    return this.write(entry, {
      ...entry.state,
      status: 'claimed',
      claim: { boot: this.boot, at: this.now() }
    })
  }

  /** MAIN admitted the turn's request: claimed (by this boot) -> done. Final; never runs again. */
  start(id: string): ThreadEventEntry {
    this.assertAvailable()
    const entry = this.index.get(id)
    if (!entry || entry.state.status !== 'claimed' || entry.state.claim?.boot !== this.boot)
      throw new Error('Thread event is not claimed.')
    const done = this.write(entry, {
      ...withoutClaim(entry.state),
      status: 'done',
      startedAt: this.now()
    })
    if (!done) throw new Error('Thread event is not claimed.')
    return done
  }

  /** The turn did not start (busy, refused before dispatch, document gone): claimed -> queued. */
  release(id: string): ThreadEventStatus | undefined {
    this.assertAvailable()
    const entry = this.index.get(id)
    if (!entry) return this.get(id)?.state.status
    if (entry.state.status !== 'claimed' || entry.state.claim?.boot !== this.boot)
      return entry.state.status
    return this.write(entry, { ...withoutClaim(entry.state), status: 'queued' })?.state.status
  }

  /** Every queued or claimed event of one session -> expired (the session was removed for good). */
  expireSession(session: ThreadEventSession, reason: string): number {
    this.assertAvailable()
    if (!isThreadEventSession(session)) throw new Error('Invalid thread event session.')
    return this.expireWhere((entry) => sameSession(entry.event, session), reason)
  }

  /** Every queued event past its TTL -> expired. A claimed one expires when claimed or stopped. */
  expireStale(): number {
    if (this.unavailable) return 0
    const now = this.now()
    return this.expireWhere(
      (entry) => entry.state.status === 'queued' && entry.event.expiresAt <= now,
      'ttl'
    )
  }

  private expireWhere(match: (entry: Indexed) => boolean, reason: string): number {
    const matched = [...this.index.values()].filter(match)
    for (let i = 0; i < matched.length; i += PAGE) {
      const chunk = matched.slice(i, i + PAGE)
      this.store.mutateResourcesBatch(
        chunk.map((entry) =>
          this.mutation(
            'update',
            THREAD_EVENT_STATE_KIND,
            entry.event.id,
            { ...withoutClaim(entry.state), status: 'expired', expiredReason: reason },
            Math.max(this.now(), entry.updatedAt),
            entry.revision
          )
        )
      )
      for (const entry of chunk) this.forget(entry.event)
    }
    return matched.length
  }

  /** The stored receipt (reads SQLite), or undefined for a missing or unknown record. */
  get(id: string): ThreadEventEntry | undefined {
    this.assertAvailable()
    if (!str(id, 128)) return undefined
    const row = this.store.getResource(THREAD_EVENT_STATE_KIND, id)
    const state = row && readState(row)
    const event = state && readRecord(this.store.getResource(THREAD_EVENT_KIND, id), id)
    return state && event ? freeze({ event, state }) : undefined
  }

  /** In memory only: the event while it is queued or claimed. */
  peek(id: string): ThreadEventEntry | undefined {
    const entry = this.unavailable ? undefined : this.index.get(id)
    return entry && { event: entry.event, state: entry.state }
  }

  /** In memory only: every queued event, oldest first. Empty while the store is unavailable. */
  queued(): ThreadEventEntry[] {
    if (this.unavailable) return []
    return [...this.index.values()]
      .filter((entry) => entry.state.status === 'queued')
      .sort((a, b) => a.event.createdAt - b.event.createdAt || (a.event.id < b.event.id ? -1 : 1))
      .map((entry) => ({ event: entry.event, state: entry.state }))
  }

  queuedCount(session?: ThreadEventSession): number {
    let count = 0
    for (const entry of this.index.values())
      if (entry.state.status === 'queued' && (!session || sameSession(entry.event, session)))
        count++
    return count
  }

  close(): void {
    this.index.clear()
    this.keys.clear()
    this.store.close()
  }

  /** After a lost CAS: the stored state wins; the index keeps only queued and claimed records. */
  private refresh(id: string): void {
    const entry = this.index.get(id)
    if (!entry) return
    const row = this.store.getResource(THREAD_EVENT_STATE_KIND, id)
    const state = row && readState(row)
    if (
      !row ||
      !state ||
      FINAL.has(state.status) ||
      (state.status === 'claimed' && state.claim?.boot !== this.boot)
    )
      this.forget(entry.event)
    else
      this.remember(
        freeze({ event: entry.event, state, revision: row.revision, updatedAt: row.updatedAt })
      )
  }
}
