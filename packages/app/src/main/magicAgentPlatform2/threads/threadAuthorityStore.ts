import { createHash, randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type {
  MagicAgentEventStore,
  ResourceMutationInput,
  StoredResource
} from '../persistence/eventStore'

/**
 * Thread authority records: durable MAIN records and checks that later automation (a trigger or
 * goal run that starts without a user message) must consult before it acts for a thread.
 *
 * What it is: a thread identity registry. MAIN issues an opaque thread id for one Agent thread
 * target, with a generation; revoking the target ends that generation for ever, and the next issue
 * gets a new id and generation + 1, so nothing bound to an old pair can come back.
 *
 * What it is not: no IPC method, no scheduler, timer or startup hook, no approval producer and no
 * production caller (backlog item 54 wires it, after the owner approved the grant card). The
 * target values come from the renderer and are not authority: the caller must have authenticated
 * them. Only controlled API use and normal reopen are covered: a restored or rolled-back database
 * and arbitrary writers to the event store are not detected.
 *
 * It supersedes the TEST-ONLY sketch ThreadAdmissionDraft (triggers/threadAdmissionDraft.ts),
 * which keys an owner by a free string and takes its approval from an injected fake verifier.
 *
 * Every check that leads to a write is closed by expectedRevision (two processes can open one
 * profile). A ResourceRevisionConflictError from the store is rethrown unchanged; calling again
 * answers from the new state. A row that is deleted, has another version, unknown or missing keys,
 * or does not match its id or partner record is unavailable: the method throws
 * ThreadAuthorityUnavailableError and writes nothing; such a row is never repaired or replaced.
 */

export const THREAD_IDENTITY_KIND = 'agent-thread-identity-v1'
export const THREAD_IDENTITY_INDEX_KIND = 'agent-thread-identity-index-v1'
/** Upper bound of the run grants one thread generation can be issued. */
export const MAX_RUN_GRANTS_PER_GENERATION = 64

export type ThreadAuthorityTarget = Readonly<{
  route: Readonly<{ channel: 'canvas'; scopeType: 'thread'; scopeId: string; threadId: string }>
  conversationId: string
  storageScope: string
}>
export type ThreadPair = Readonly<{ threadId: string; generation: number }>
export type ThreadView = Readonly<{
  threadId: string
  generation: number
  status: 'live' | 'revoked'
  issuedAt: number
  revokedAt?: number
}>
export type VerifyThreadResult =
  | Readonly<{ ok: true; target: ThreadAuthorityTarget }>
  | Readonly<{ ok: false; reason: 'unknown' | 'stale' | 'revoked' }>
export type RevokeThreadResult = Readonly<{ status: 'revoked' | 'already-revoked' | 'unknown' }>
export type ThreadAuthorityStoreOptions = Readonly<{
  /** The only clock of the store (default Date.now). */
  now?: () => number
  /** The only id source of the store (default randomUUID). */
  newId?: () => string
}>

export class ThreadAuthorityUnavailableError extends Error {
  readonly code = 'MAGIC_AGENT_THREAD_AUTHORITY_UNAVAILABLE'
  constructor() {
    super('Thread authority record unavailable.')
    this.name = 'ThreadAuthorityUnavailableError'
  }
}

type IdentityState = Readonly<{
  v: 1
  key: string
  target: ThreadAuthorityTarget
  threadId: string
  generation: number
  status: 'live' | 'revoked'
  issuedAt: number
  revokedAt?: number
  grants: readonly string[]
}>
type IndexState = Readonly<{ v: 1; threadId: string; key: string; generation: number }>
type LoadedIdentity = Readonly<{ row: StoredResource<unknown>; state: IdentityState }>
type Write = Readonly<{ kind: string; id: string; state: object; row?: StoredResource<unknown> }>

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const KEY_PATTERN = /^[a-f0-9]{64}$/
const TARGET_KEYS = ['route', 'conversationId', 'storageScope'] as const
const ROUTE_KEYS = ['channel', 'scopeType', 'scopeId', 'threadId'] as const
const IDENTITY_LIVE_KEYS = [
  'v',
  'key',
  'target',
  'threadId',
  'generation',
  'status',
  'issuedAt',
  'grants'
] as const
const IDENTITY_REVOKED_KEYS = [...IDENTITY_LIVE_KEYS, 'revokedAt'] as const
const INDEX_KEYS = ['v', 'threadId', 'key', 'generation'] as const

const isId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value)
const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const isTime = (value: unknown): value is number => isInteger(value, 0)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
const isStorageScope = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 512 &&
  !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const isIdList = (value: unknown, max: number): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(isId) &&
  new Set(value).size === value.length
const unavailable = (): ThreadAuthorityUnavailableError => new ThreadAuthorityUnavailableError()

/**
 * Copies a target field by field (each value read once) and validates the copy with the rules of
 * targetKey in api/agentThreadTriggerDeliveryStore.ts, with exact keys.
 */
function readTarget(value: unknown): ThreadAuthorityTarget {
  if (!isRecord(value) || !hasExactKeys(value, TARGET_KEYS))
    throw new TypeError('Invalid thread target.')
  const route = value.route
  const conversationId = value.conversationId
  const storageScope = value.storageScope
  if (!isRecord(route) || !hasExactKeys(route, ROUTE_KEYS))
    throw new TypeError('Invalid thread target.')
  const channel = route.channel
  const scopeType = route.scopeType
  const scopeId = route.scopeId
  const threadId = route.threadId
  if (
    channel !== 'canvas' ||
    scopeType !== 'thread' ||
    !isId(scopeId) ||
    !isId(threadId) ||
    !isId(conversationId) ||
    !isStorageScope(storageScope)
  )
    throw new TypeError('Invalid thread target.')
  return { route: { channel, scopeType, scopeId, threadId }, conversationId, storageScope }
}

function identityKey(target: ThreadAuthorityTarget): string {
  const session = getAgentSessionKey(normalizeAgentRoute(target.route))
  return createHash('sha256')
    .update(
      JSON.stringify([THREAD_IDENTITY_KIND, session, target.conversationId, target.storageScope])
    )
    .digest('hex')
}

function parseIdentity(value: unknown, key: string): IdentityState {
  if (!isRecord(value) || value.v !== 1) throw unavailable()
  if (value.status !== 'live' && value.status !== 'revoked') throw unavailable()
  if (!hasExactKeys(value, value.status === 'live' ? IDENTITY_LIVE_KEYS : IDENTITY_REVOKED_KEYS))
    throw unavailable()
  if (
    value.key !== key ||
    !isId(value.threadId) ||
    !isInteger(value.generation, 1) ||
    !isTime(value.issuedAt) ||
    (value.status === 'revoked' && !isTime(value.revokedAt)) ||
    !isIdList(value.grants, MAX_RUN_GRANTS_PER_GENERATION)
  )
    throw unavailable()
  let target: ThreadAuthorityTarget
  try {
    target = readTarget(value.target)
  } catch {
    throw unavailable()
  }
  if (identityKey(target) !== key) throw unavailable()
  return value as IdentityState
}

function parseIndex(value: unknown, threadId: string): IndexState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, INDEX_KEYS) ||
    value.v !== 1 ||
    value.threadId !== threadId ||
    typeof value.key !== 'string' ||
    !KEY_PATTERN.test(value.key) ||
    !isInteger(value.generation, 1)
  )
    throw unavailable()
  return value as IndexState
}

const copyTarget = (target: ThreadAuthorityTarget): ThreadAuthorityTarget => ({
  route: { ...target.route },
  conversationId: target.conversationId,
  storageScope: target.storageScope
})

export class ThreadAuthorityStore {
  private readonly clock: () => number
  private readonly ids: () => string

  constructor(
    private readonly store: MagicAgentEventStore,
    options: ThreadAuthorityStoreOptions = {}
  ) {
    if (!store || typeof store.mutateResourcesBatch !== 'function')
      throw new TypeError('ThreadAuthorityStore requires an event store.')
    if (!isRecord(options)) throw new TypeError('Invalid thread authority options.')
    if (options.now !== undefined && typeof options.now !== 'function')
      throw new TypeError('Invalid thread authority clock.')
    if (options.newId !== undefined && typeof options.newId !== 'function')
      throw new TypeError('Invalid thread authority id source.')
    this.clock = options.now ?? Date.now
    this.ids = options.newId ?? randomUUID
  }

  /**
   * Returns the live pair of the target. Never issued: one batch creates the identity (generation
   * 1) and its index. Live: the same pair, no write. Revoked: one batch moves the identity to a
   * new thread id and generation + 1 and creates the new index; the old index stays.
   */
  issueThread(target: ThreadAuthorityTarget): ThreadPair {
    const value = readTarget(target)
    const key = identityKey(value)
    const now = this.now()
    const current = this.loadIdentity(key)
    if (current && current.state.status === 'live')
      return { threadId: current.state.threadId, generation: current.state.generation }
    if (current && current.state.generation >= Number.MAX_SAFE_INTEGER)
      throw new Error('Thread generation exhausted.')
    const generation = current ? current.state.generation + 1 : 1
    const threadId = this.freshId([THREAD_IDENTITY_INDEX_KIND])
    const identity: IdentityState = {
      v: 1,
      key,
      target: value,
      threadId,
      generation,
      status: 'live',
      issuedAt: now,
      grants: []
    }
    const index: IndexState = { v: 1, threadId, key, generation }
    this.commit(
      [
        { kind: THREAD_IDENTITY_KIND, id: key, state: identity, row: current?.row },
        { kind: THREAD_IDENTITY_INDEX_KIND, id: threadId, state: index }
      ],
      now
    )
    return { threadId, generation }
  }

  /** Read-only. Undefined when the target was never issued. */
  readThread(target: ThreadAuthorityTarget): ThreadView | undefined {
    const current = this.loadIdentity(identityKey(readTarget(target)))
    if (!current) return undefined
    const state = current.state
    return {
      threadId: state.threadId,
      generation: state.generation,
      status: state.status,
      issuedAt: state.issuedAt,
      ...(state.status === 'revoked' ? { revokedAt: state.revokedAt } : {})
    }
  }

  /**
   * Read-only. 'unknown': MAIN never issued this thread id. 'stale': the identity has moved to
   * another id or generation. 'revoked': the pair is current but its generation was revoked.
   */
  verifyThread(threadId: string, generation: number): VerifyThreadResult {
    if (!isId(threadId) || !isInteger(generation, 1)) throw new TypeError('Invalid thread pair.')
    const identity = this.resolveThread(threadId)
    if (!identity) return { ok: false, reason: 'unknown' }
    const state = identity.state
    if (state.threadId !== threadId || state.generation !== generation)
      return { ok: false, reason: 'stale' }
    if (state.status !== 'live') return { ok: false, reason: 'revoked' }
    return { ok: true, target: copyTarget(state.target) }
  }

  /**
   * Ends the current generation of the target for ever. 'unknown' (never issued) and
   * 'already-revoked' write nothing.
   */
  revokeThread(target: ThreadAuthorityTarget): RevokeThreadResult {
    const key = identityKey(readTarget(target))
    const now = this.now()
    const current = this.loadIdentity(key)
    if (!current) return { status: 'unknown' }
    if (current.state.status === 'revoked') return { status: 'already-revoked' }
    const identity: IdentityState = { ...current.state, status: 'revoked', revokedAt: now }
    this.commit([{ kind: THREAD_IDENTITY_KIND, id: key, state: identity, row: current.row }], now)
    return { status: 'revoked' }
  }

  private now(): number {
    const value = this.clock()
    if (!isTime(value)) throw new Error('Thread authority clock returned an invalid time.')
    return value
  }

  /** A new id from the id source that no record of the given kinds has ever used. */
  private freshId(kinds: readonly string[]): string {
    const id = this.ids()
    if (!isId(id)) throw new Error('Thread authority id source returned an invalid id.')
    if (kinds.some((kind) => this.store.hasResourceEvidence(kind, id)))
      throw new Error('Thread authority id source repeated an id.')
    return id
  }

  /** Undefined only when the row is absent and the store holds no evidence that it existed. */
  private readRow(kind: string, id: string): StoredResource<unknown> | undefined {
    const row = this.store.getResource<unknown>(kind, id, { includeDeleted: true })
    if (!row) {
      if (this.store.hasResourceEvidence(kind, id)) throw unavailable()
      return undefined
    }
    if (row.deleted || row.kind !== kind || row.id !== id) throw unavailable()
    return row
  }

  /** The identity of a key together with its current index, which must match it. */
  private loadIdentity(key: string): LoadedIdentity | undefined {
    const row = this.readRow(THREAD_IDENTITY_KIND, key)
    if (!row) return undefined
    const state = parseIdentity(row.state, key)
    const indexRow = this.readRow(THREAD_IDENTITY_INDEX_KIND, state.threadId)
    if (!indexRow) throw unavailable()
    const index = parseIndex(indexRow.state, state.threadId)
    if (index.key !== key || index.generation !== state.generation) throw unavailable()
    return { row, state }
  }

  /** The identity a MAIN thread id was issued for; undefined when no index exists for it. */
  private resolveThread(threadId: string): LoadedIdentity | undefined {
    const indexRow = this.readRow(THREAD_IDENTITY_INDEX_KIND, threadId)
    if (!indexRow) return undefined
    const index = parseIndex(indexRow.state, threadId)
    const identity = this.loadIdentity(index.key)
    if (!identity) throw unavailable()
    if (identity.state.threadId !== threadId && index.generation >= identity.state.generation)
      throw unavailable()
    return identity
  }

  /**
   * One batch. createdAt is max(now, updatedAt of every row the batch updates), so a clock set
   * back can never make the store refuse a write (a revoke above all).
   */
  private commit(writes: readonly Write[], now: number): void {
    const createdAt = Math.max(now, ...writes.map((write) => write.row?.updatedAt ?? 0))
    const operation = this.freshId([])
    const commands = writes.map((write, index): ResourceMutationInput => {
      const eventId = `thread-authority:${operation}:${index}`
      const sequence = write.row ? write.row.revision + 1 : 0
      return {
        operation: write.row ? 'update' : 'create',
        kind: write.kind,
        id: write.id,
        ...(write.row ? { expectedRevision: write.row.revision } : {}),
        state: write.state,
        createdAt,
        idempotencyKey: eventId,
        event: {
          protocolVersion: '2.0.0',
          envelopeKind: 'event',
          id: eventId,
          type: 'thread-authority.changed',
          createdAt,
          payload: {},
          streamId: `${write.kind}:${write.id}:stream`,
          sequence
        }
      }
    })
    this.store.mutateResourcesBatch(commands)
  }
}
