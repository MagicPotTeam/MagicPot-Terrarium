import { createHash, randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import { AGENT_GOAL_LIMITS } from '@shared/api/agentThreadGoal'
import type {
  MagicAgentEventStore,
  ResourceMutationInput,
  StoredResource
} from '../persistence/eventStore'

/**
 * Thread authority records: durable MAIN records and checks that later automation (a trigger or
 * goal run that starts without a user message) must consult before it acts for a thread.
 *
 * What it is: (1) a thread identity registry. MAIN issues an opaque thread id for one Agent thread
 * target, with a generation; revoking the target ends that generation for ever, and the next issue
 * gets a new id and generation + 1, so nothing bound to an old pair can come back. (2) Run grants:
 * what the user allowed one trigger delivery or goal generation to spend in one thread generation,
 * with hard limits on turns, tool calls and wall time (the turn, tool_call and walltime axes of
 * upstream core/budget.py), an expiry and revocation. Upstream counts after the fact; a run grant
 * is charged BEFORE the work and refuses what would cross a hard limit. It is not the ApprovalGrant
 * of shared/magicAgentPlatform2/policy.ts and is never a grantProvider of the trigger lifecycle.
 *
 * What it is not: no IPC method, no scheduler, timer or startup hook, no approval producer and no
 * production caller (backlog item 54 wires it, after the owner approved the grant card). The
 * approval verifier is injected and has no default or implementation here. The target values come
 * from the renderer and are not authority: the caller must have authenticated them. Only
 * controlled API use and normal reopen are covered: a restored or rolled-back database and
 * arbitrary writers to the event store are not detected. Records hold ids, integers and enums
 * only, plus the storageScope key of the target (at most 512 characters, no control characters);
 * never prompt, goal or message text.
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
export const RUN_GRANT_KIND = 'agent-thread-run-grant-v1'
export const RUN_GRANT_STATE_KIND = 'agent-thread-run-grant-state-v1'
/** Upper bound of the run grants one thread generation can be issued. */
export const MAX_RUN_GRANTS_PER_GENERATION = 64
/** Upper bound of expiresAt - issuedAt of a run grant (31 days). */
export const MAX_RUN_GRANT_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000
/** The number of most recent charge ids a run grant state keeps for replay answers. */
export const RUN_GRANT_CHARGE_HISTORY = 16

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
export type RunGrantAxis = 'turns' | 'toolCalls' | 'walltimeSeconds'
export type RunGrantAmounts = Readonly<Record<RunGrantAxis, number>>
export type RunGrantSubject =
  | Readonly<{ kind: 'trigger'; deliveryId: string }>
  | Readonly<{ kind: 'goal'; goalId: string; goalGeneration: number }>
export type RunGrantApproval = Readonly<{ approvedAt: number; proofId: string }>
export type RunGrantRequest = Readonly<{
  threadId: string
  generation: number
  subject: RunGrantSubject
  limits: RunGrantAmounts
  expiresAt: number
  approval: RunGrantApproval
}>
/** What the approval verifier is shown: exactly the values the grant stores, plus the target. */
export type RunGrantApprovalRequest = Readonly<RunGrantRequest & { target: ThreadAuthorityTarget }>
/** Approves only by returning the value true; any other value or a throw refuses. */
export type RunGrantApprovalVerifier = (request: RunGrantApprovalRequest) => unknown
export type RunGrantStatus = 'active' | 'revoked' | 'expired' | 'exhausted'
export type RunGrantRevokeReason = 'paused' | 'user' | 'subject-ended'
export type RunGrantEndReason = RunGrantRevokeReason | 'thread-revoked' | RunGrantAxis
export type RunGrantView = Readonly<{
  grantId: string
  threadId: string
  generation: number
  subject: RunGrantSubject
  limits: RunGrantAmounts
  issuedAt: number
  expiresAt: number
  approval: RunGrantApproval
  /** A stored terminal status wins; else the thread, then the clock decide. */
  status: RunGrantStatus
  reason?: RunGrantEndReason
  /** Only for a terminal status that is stored. */
  endedAt?: number
  used: RunGrantAmounts
  remaining: RunGrantAmounts
  /** The status is active and the clock is not before issuedAt. */
  usable: boolean
}>
export type IssueGrantResult =
  | Readonly<{ ok: true; grant: RunGrantView }>
  | Readonly<{
      ok: false
      reason:
        | 'thread-unknown'
        | 'thread-stale'
        | 'thread-revoked'
        | 'subject-has-active-grant'
        | 'capacity'
        | 'approval-refused'
    }>
export type ListGrantsResult =
  | Readonly<{ ok: true; grants: readonly RunGrantView[] }>
  | Readonly<{ ok: false; reason: 'thread-unknown' | 'thread-stale' }>
export type RevokeGrantResult =
  | Readonly<{ ok: true; changed: boolean; grant: RunGrantView }>
  | Readonly<{ ok: false; reason: 'unknown' }>
export type ChargeGrantResult =
  | Readonly<{ ok: true; replay: boolean; used: RunGrantAmounts; remaining: RunGrantAmounts }>
  | Readonly<{
      ok: false
      reason:
        'unknown' | 'binding' | 'revoked' | 'expired' | 'exhausted' | 'thread-revoked' | 'clock'
      /** For 'exhausted': the axis whose hard limit refused. */
      axis?: RunGrantAxis
      /** For 'revoked': the stored revoke reason. */
      revokeReason?: RunGrantRevokeReason | 'thread-revoked'
    }>
export type ThreadAuthorityStoreOptions = Readonly<{
  /** The only clock of the store (default Date.now). */
  now?: () => number
  /** The only id source of the store (default randomUUID). */
  newId?: () => string
  /** Required; there is no default. Called once per issueGrant, after every other check. */
  verifyApproval: RunGrantApprovalVerifier
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
type ResolvedThread = Readonly<{ index: IndexState; identity: LoadedIdentity }>
type GrantRecord = Readonly<{ v: 1; grantId: string; issuedAt: number } & RunGrantRequest>
type GrantStateRecord = Readonly<{
  v: 1
  grantId: string
  status: RunGrantStatus
  used: RunGrantAmounts
  charges: readonly string[]
  endedAt?: number
  reason?: RunGrantEndReason
}>
type LoadedGrant = Readonly<{
  grant: GrantRecord
  stateRow: StoredResource<unknown>
  state: GrantStateRecord
}>
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
const AXES = ['turns', 'toolCalls', 'walltimeSeconds'] as const
const AXIS_CEILINGS: RunGrantAmounts = {
  turns: AGENT_GOAL_LIMITS.maxTurns,
  toolCalls: AGENT_GOAL_LIMITS.maxToolCalls,
  walltimeSeconds: AGENT_GOAL_LIMITS.maxWalltimeSeconds
}
const REQUEST_KEYS = [
  'threadId',
  'generation',
  'subject',
  'limits',
  'expiresAt',
  'approval'
] as const
const GRANT_KEYS = ['v', 'grantId', 'issuedAt', ...REQUEST_KEYS] as const
const APPROVAL_KEYS = ['approvedAt', 'proofId'] as const
const STATE_ACTIVE_KEYS = ['v', 'grantId', 'status', 'used', 'charges'] as const
const STATE_EXPIRED_KEYS = [...STATE_ACTIVE_KEYS, 'endedAt'] as const
const STATE_ENDED_KEYS = [...STATE_EXPIRED_KEYS, 'reason'] as const
const REVOKE_REASONS: readonly string[] = ['paused', 'user', 'subject-ended']
const STORED_REVOKE_REASONS: readonly string[] = [...REVOKE_REASONS, 'thread-revoked']
const STATUSES: readonly string[] = ['active', 'revoked', 'expired', 'exhausted']
const GOAL_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ZERO: RunGrantAmounts = { turns: 0, toolCalls: 0, walltimeSeconds: 0 }

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
const isIdList = (
  value: unknown,
  max: number,
  item: (value: unknown) => value is string = isId
): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((entry) => item(entry)) &&
  new Set(value).size === value.length
/** A charge id is an id of at most 64 characters, which keeps a grant state under 2 KB. */
const CHARGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const isChargeId = (value: unknown): value is string =>
  typeof value === 'string' && CHARGE_ID_PATTERN.test(value)
const unavailable = (): ThreadAuthorityUnavailableError => new ThreadAuthorityUnavailableError()
/** Rethrows any failure of a stored-value check as unavailable. */
function stored<T>(read: () => T): T {
  try {
    return read()
  } catch {
    throw unavailable()
  }
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDeep(item)
    Object.freeze(value)
  }
  return value
}

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

function readSubject(value: unknown): RunGrantSubject {
  if (!isRecord(value)) throw new TypeError('Invalid run grant subject.')
  const kind = value.kind
  if (kind === 'trigger' && hasExactKeys(value, ['kind', 'deliveryId'])) {
    const deliveryId = value.deliveryId
    if (isId(deliveryId)) return { kind, deliveryId }
  } else if (kind === 'goal' && hasExactKeys(value, ['kind', 'goalId', 'goalGeneration'])) {
    const goalId = value.goalId
    const goalGeneration = value.goalGeneration
    if (typeof goalId === 'string' && GOAL_ID_PATTERN.test(goalId) && isInteger(goalGeneration, 1))
      return { kind, goalId, goalGeneration }
  }
  throw new TypeError('Invalid run grant subject.')
}

/** Three required axes, each an integer from 1 to its AGENT_GOAL_LIMITS ceiling. */
function readLimits(value: unknown): RunGrantAmounts {
  if (!isRecord(value) || !hasExactKeys(value, AXES))
    throw new TypeError('Invalid run grant limits.')
  const turns = value.turns
  const toolCalls = value.toolCalls
  const walltimeSeconds = value.walltimeSeconds
  if (
    !isInteger(turns, 1, AXIS_CEILINGS.turns) ||
    !isInteger(toolCalls, 1, AXIS_CEILINGS.toolCalls) ||
    !isInteger(walltimeSeconds, 1, AXIS_CEILINGS.walltimeSeconds)
  )
    throw new RangeError('Invalid run grant limits.')
  return { turns, toolCalls, walltimeSeconds }
}

function readApproval(value: unknown): RunGrantApproval {
  if (!isRecord(value) || !hasExactKeys(value, APPROVAL_KEYS))
    throw new TypeError('Invalid run grant approval.')
  const approvedAt = value.approvedAt
  const proofId = value.proofId
  if (!isTime(approvedAt) || !isId(proofId)) throw new TypeError('Invalid run grant approval.')
  return { approvedAt, proofId }
}

/** A copy of the request, each value read once; expiry and approval time are checked against now. */
function readGrantRequest(value: unknown, now: number): RunGrantRequest {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS))
    throw new TypeError('Invalid run grant request.')
  const threadId = value.threadId
  const generation = value.generation
  const expiresAt = value.expiresAt
  const subject = readSubject(value.subject)
  const limits = readLimits(value.limits)
  const approval = readApproval(value.approval)
  if (!isId(threadId) || !isInteger(generation, 1)) throw new TypeError('Invalid thread pair.')
  if (!isInteger(expiresAt, now + 1, now + MAX_RUN_GRANT_LIFETIME_MS))
    throw new RangeError('Invalid run grant expiry.')
  if (approval.approvedAt > now) throw new RangeError('Run grant approval lies in the future.')
  return { threadId, generation, subject, limits, expiresAt, approval }
}

/**
 * The amounts of one charge: only the keys turns, toolCalls and walltimeSeconds (a missing key is
 * 0), each a non-negative safe integer, at least one above 0.
 */
function readAmounts(value: unknown): RunGrantAmounts {
  if (!isRecord(value)) throw new TypeError('Invalid run grant charge.')
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some((key) => !(AXES as readonly string[]).includes(key)))
    throw new TypeError('Invalid run grant charge.')
  const turns = Object.hasOwn(value, 'turns') ? value.turns : 0
  const toolCalls = Object.hasOwn(value, 'toolCalls') ? value.toolCalls : 0
  const walltimeSeconds = Object.hasOwn(value, 'walltimeSeconds') ? value.walltimeSeconds : 0
  if (!isInteger(turns, 0) || !isInteger(toolCalls, 0) || !isInteger(walltimeSeconds, 0))
    throw new RangeError('Invalid run grant charge.')
  if (turns === 0 && toolCalls === 0 && walltimeSeconds === 0)
    throw new RangeError('A run grant charge must charge something.')
  return { turns, toolCalls, walltimeSeconds }
}

function readPair(value: unknown): ThreadPair {
  if (!isRecord(value) || !hasExactKeys(value, ['threadId', 'generation']))
    throw new TypeError('Invalid thread pair.')
  const threadId = value.threadId
  const generation = value.generation
  if (!isId(threadId) || !isInteger(generation, 1)) throw new TypeError('Invalid thread pair.')
  return { threadId, generation }
}

function parseGrant(value: unknown, grantId: string): GrantRecord {
  if (!isRecord(value) || value.v !== 1 || !hasExactKeys(value, GRANT_KEYS)) throw unavailable()
  const issuedAt = value.issuedAt
  if (value.grantId !== grantId || !isTime(issuedAt)) throw unavailable()
  const request = stored(() => {
    const { v: _v, grantId: _grantId, issuedAt: _issuedAt, ...rest } = value
    return readGrantRequest(rest, issuedAt)
  })
  return { v: 1, grantId, issuedAt, ...request }
}

function parseGrantState(value: unknown, grant: GrantRecord): GrantStateRecord {
  if (!isRecord(value) || value.v !== 1 || typeof value.status !== 'string') throw unavailable()
  const status = value.status
  if (!STATUSES.includes(status)) throw unavailable()
  const keys =
    status === 'active'
      ? STATE_ACTIVE_KEYS
      : status === 'expired'
        ? STATE_EXPIRED_KEYS
        : STATE_ENDED_KEYS
  if (!hasExactKeys(value, keys) || value.grantId !== grant.grantId) throw unavailable()
  const used = value.used
  if (
    !isRecord(used) ||
    !hasExactKeys(used, AXES) ||
    !AXES.every((axis) => isInteger(used[axis], 0, grant.limits[axis])) ||
    !isIdList(value.charges, RUN_GRANT_CHARGE_HISTORY, isChargeId) ||
    (status !== 'active' && !isTime(value.endedAt)) ||
    (status === 'revoked' && !STORED_REVOKE_REASONS.includes(value.reason as string)) ||
    (status === 'exhausted' && !(AXES as readonly unknown[]).includes(value.reason))
  )
    throw unavailable()
  return value as GrantStateRecord
}

const sameSubject = (a: RunGrantSubject, b: RunGrantSubject): boolean =>
  a.kind === 'trigger'
    ? b.kind === 'trigger' && a.deliveryId === b.deliveryId
    : b.kind === 'goal' && a.goalId === b.goalId && a.goalGeneration === b.goalGeneration

const copySubject = (subject: RunGrantSubject): RunGrantSubject => ({ ...subject })
const copyAmounts = (amounts: RunGrantAmounts): RunGrantAmounts => ({
  turns: amounts.turns,
  toolCalls: amounts.toolCalls,
  walltimeSeconds: amounts.walltimeSeconds
})

/** True when the identity is live in the thread id and generation the grant is bound to. */
const threadIsLive = (identity: LoadedIdentity, grant: GrantRecord): boolean =>
  identity.state.threadId === grant.threadId &&
  identity.state.generation === grant.generation &&
  identity.state.status === 'live'

function grantView(
  grant: GrantRecord,
  state: GrantStateRecord,
  live: boolean,
  now: number
): RunGrantView {
  let status: RunGrantStatus = state.status
  let reason = state.reason
  if (status === 'active' && !live) {
    status = 'revoked'
    reason = 'thread-revoked'
  } else if (status === 'active' && now >= grant.expiresAt) status = 'expired'
  return {
    grantId: grant.grantId,
    threadId: grant.threadId,
    generation: grant.generation,
    subject: copySubject(grant.subject),
    limits: copyAmounts(grant.limits),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    approval: { ...grant.approval },
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
    used: copyAmounts(state.used),
    remaining: {
      turns: grant.limits.turns - state.used.turns,
      toolCalls: grant.limits.toolCalls - state.used.toolCalls,
      walltimeSeconds: grant.limits.walltimeSeconds - state.used.walltimeSeconds
    },
    usable: status === 'active' && now >= grant.issuedAt
  }
}

export class ThreadAuthorityStore {
  private readonly clock: () => number
  private readonly ids: () => string
  private readonly verifyApproval: RunGrantApprovalVerifier

  constructor(
    private readonly store: MagicAgentEventStore,
    options: ThreadAuthorityStoreOptions
  ) {
    if (!store || typeof store.mutateResourcesBatch !== 'function')
      throw new TypeError('ThreadAuthorityStore requires an event store.')
    if (!isRecord(options)) throw new TypeError('Invalid thread authority options.')
    if (options.now !== undefined && typeof options.now !== 'function')
      throw new TypeError('Invalid thread authority clock.')
    if (options.newId !== undefined && typeof options.newId !== 'function')
      throw new TypeError('Invalid thread authority id source.')
    if (typeof options.verifyApproval !== 'function')
      throw new TypeError('ThreadAuthorityStore requires an approval verifier.')
    this.clock = options.now ?? Date.now
    this.ids = options.newId ?? randomUUID
    this.verifyApproval = options.verifyApproval
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
    const resolved = this.resolveThread(threadId)
    if (!resolved) return { ok: false, reason: 'unknown' }
    const state = resolved.identity.state
    if (state.threadId !== threadId || state.generation !== generation)
      return { ok: false, reason: 'stale' }
    if (state.status !== 'live') return { ok: false, reason: 'revoked' }
    return { ok: true, target: copyTarget(state.target) }
  }

  /**
   * Ends the current generation of the target for ever. One batch writes the identity and
   * 'revoked' / 'thread-revoked' to every grant state of that generation whose stored status is
   * active. 'unknown' (never issued) and 'already-revoked' write nothing.
   */
  revokeThread(target: ThreadAuthorityTarget): RevokeThreadResult {
    const key = identityKey(readTarget(target))
    const now = this.now()
    const current = this.loadIdentity(key)
    if (!current) return { status: 'unknown' }
    if (current.state.status === 'revoked') return { status: 'already-revoked' }
    const grants = this.loadListedGrants(current)
    const identity: IdentityState = { ...current.state, status: 'revoked', revokedAt: now }
    this.commit(
      [
        { kind: THREAD_IDENTITY_KIND, id: key, state: identity, row: current.row },
        ...grants
          .filter((loaded) => loaded.state.status === 'active')
          .map((loaded) => ({
            kind: RUN_GRANT_STATE_KIND,
            id: loaded.grant.grantId,
            row: loaded.stateRow,
            state: { ...loaded.state, status: 'revoked', reason: 'thread-revoked', endedAt: now }
          }))
      ],
      now
    )
    return { status: 'revoked' }
  }

  /**
   * Issues a run grant for one live thread generation and one subject. Refusals write nothing:
   * 'thread-unknown' | 'thread-stale' | 'thread-revoked' (from the identity),
   * 'subject-has-active-grant' (a grant of this generation with the same subject whose stored
   * status is active and which is not past its expiry), 'capacity' (the generation holds
   * MAX_RUN_GRANTS_PER_GENERATION grants), 'approval-refused' (the verifier, called once after
   * every other check with a frozen copy of the values stored, did not return true or threw).
   * Success is one batch: the identity lists the grant id (closed by the revision read), the grant
   * and its state (active, nothing used) are created, and a grant of the same subject whose stored
   * status is active but which is past its expiry (the issue relied on that) is recorded 'expired'.
   */
  issueGrant(request: RunGrantRequest): IssueGrantResult {
    const now = this.now()
    const value = readGrantRequest(request, now)
    const resolved = this.resolveThread(value.threadId)
    if (!resolved) return { ok: false, reason: 'thread-unknown' }
    const identity = resolved.identity
    if (
      identity.state.threadId !== value.threadId ||
      identity.state.generation !== value.generation
    )
      return { ok: false, reason: 'thread-stale' }
    if (identity.state.status !== 'live') return { ok: false, reason: 'thread-revoked' }
    const sameSubjectGrants = this.loadListedGrants(identity).filter((loaded) =>
      sameSubject(loaded.grant.subject, value.subject)
    )
    // Stored active; past this check, every one of them is past its expiry.
    const lapsed = sameSubjectGrants.filter((loaded) => loaded.state.status === 'active')
    if (lapsed.some((loaded) => now < loaded.grant.expiresAt))
      return { ok: false, reason: 'subject-has-active-grant' }
    if (identity.state.grants.length >= MAX_RUN_GRANTS_PER_GENERATION)
      return { ok: false, reason: 'capacity' }
    const shown: RunGrantApprovalRequest = freezeDeep({
      target: copyTarget(identity.state.target),
      threadId: value.threadId,
      generation: value.generation,
      subject: copySubject(value.subject),
      limits: copyAmounts(value.limits),
      expiresAt: value.expiresAt,
      approval: { ...value.approval }
    })
    const verify = this.verifyApproval
    let approved: unknown
    try {
      approved = verify(shown)
    } catch {
      approved = false
    }
    if (approved !== true) return { ok: false, reason: 'approval-refused' }
    const grantId = this.freshId([RUN_GRANT_KIND, RUN_GRANT_STATE_KIND])
    const grant: GrantRecord = { v: 1, grantId, issuedAt: now, ...value }
    const state: GrantStateRecord = { v: 1, grantId, status: 'active', used: ZERO, charges: [] }
    this.commit(
      [
        {
          kind: THREAD_IDENTITY_KIND,
          id: identity.state.key,
          row: identity.row,
          state: { ...identity.state, grants: [...identity.state.grants, grantId] }
        },
        // The new grant exists because these lapsed: record it, so that a clock set back
        // can never make two grants of one subject usable at once.
        ...lapsed.map((loaded) => ({
          kind: RUN_GRANT_STATE_KIND,
          id: loaded.grant.grantId,
          row: loaded.stateRow,
          state: { ...loaded.state, status: 'expired', endedAt: now }
        })),
        { kind: RUN_GRANT_KIND, id: grantId, state: grant },
        { kind: RUN_GRANT_STATE_KIND, id: grantId, state }
      ],
      now
    )
    return { ok: true, grant: grantView(grant, state, true, now) }
  }

  /** Read-only. Undefined when the grant id was never issued. */
  readGrant(grantId: string): RunGrantView | undefined {
    if (!isId(grantId)) throw new TypeError('Invalid run grant id.')
    const now = this.now()
    const loaded = this.loadBoundGrant(grantId)
    if (!loaded) return undefined
    return grantView(loaded.grant, loaded.state, threadIsLive(loaded.identity, loaded.grant), now)
  }

  /**
   * Read-only. The grants of a current thread generation (live or revoked). A pair MAIN never
   * issued is 'thread-unknown'; a pair the identity has moved on from is 'thread-stale'.
   */
  listGrants(threadId: string, generation: number): ListGrantsResult {
    if (!isId(threadId) || !isInteger(generation, 1)) throw new TypeError('Invalid thread pair.')
    const now = this.now()
    const resolved = this.resolveThread(threadId)
    if (!resolved) return { ok: false, reason: 'thread-unknown' }
    const identity = resolved.identity
    if (identity.state.threadId !== threadId || identity.state.generation !== generation)
      return { ok: false, reason: 'thread-stale' }
    const grants = this.loadListedGrants(identity).map((loaded) =>
      grantView(loaded.grant, loaded.state, threadIsLive(identity, loaded.grant), now)
    )
    return { ok: true, grants }
  }

  /**
   * Revokes a grant whose stored status is active, with the given reason (pausing is revoking with
   * 'paused'; there is no resume: a new grant needs a new approval). A grant whose stored status
   * is terminal is returned unchanged and nothing is written: the first terminal status is final.
   */
  revokeGrant(grantId: string, reason: RunGrantRevokeReason): RevokeGrantResult {
    if (!isId(grantId) || !REVOKE_REASONS.includes(reason))
      throw new TypeError('Invalid run grant revoke.')
    const now = this.now()
    const loaded = this.loadBoundGrant(grantId)
    if (!loaded) return { ok: false, reason: 'unknown' }
    const live = threadIsLive(loaded.identity, loaded.grant)
    if (loaded.state.status !== 'active')
      return { ok: true, changed: false, grant: grantView(loaded.grant, loaded.state, live, now) }
    const state: GrantStateRecord = { ...loaded.state, status: 'revoked', reason, endedAt: now }
    this.commit([{ kind: RUN_GRANT_STATE_KIND, id: grantId, row: loaded.stateRow, state }], now)
    return { ok: true, changed: true, grant: grantView(loaded.grant, state, live, now) }
  }

  /**
   * Charges a grant BEFORE the work it pays for; a refusal means the work must not run. Checks in
   * this order: no grant -> 'unknown'; a pair other than the grant's -> 'binding'; a stored
   * terminal status -> that status; the thread not live in the grant's generation ->
   * 'thread-revoked'; the clock before issuedAt -> 'clock' (none of these write); the clock at or
   * after expiresAt -> 'expired' is written; a charge id among the last RUN_GRANT_CHARGE_HISTORY
   * -> a replay with the current numbers, no write; any axis where used + amount would exceed its
   * hard limit -> 'exhausted' is written with the first such axis (turns, toolCalls,
   * walltimeSeconds) and nothing is added; otherwise every axis is charged at once. Reaching a
   * hard limit exactly succeeds; the next charge on that axis exhausts the grant.
   *
   * A call that throws has an unknown outcome: the caller must count the amount as spent. A
   * repeat with the same charge id is answered as a replay if the first call committed and the
   * grant is still active; a replay pays for the work of that first call only, never for new
   * work. A charge id older than the last RUN_GRANT_CHARGE_HISTORY is charged again: this errs
   * towards spending, never towards extra budget.
   */
  chargeGrant(
    grantId: string,
    binding: ThreadPair,
    chargeId: string,
    amounts: Partial<RunGrantAmounts>
  ): ChargeGrantResult {
    if (!isId(grantId) || !isChargeId(chargeId)) throw new TypeError('Invalid run grant charge.')
    const pair = readPair(binding)
    const amount = readAmounts(amounts)
    const now = this.now()
    const loaded = this.loadBoundGrant(grantId)
    if (!loaded) return { ok: false, reason: 'unknown' }
    const { grant, state, stateRow } = loaded
    if (pair.threadId !== grant.threadId || pair.generation !== grant.generation)
      return { ok: false, reason: 'binding' }
    if (state.status === 'exhausted')
      return { ok: false, reason: 'exhausted', axis: state.reason as RunGrantAxis }
    if (state.status === 'revoked')
      return {
        ok: false,
        reason: 'revoked',
        revokeReason: state.reason as RunGrantRevokeReason | 'thread-revoked'
      }
    if (state.status !== 'active') return { ok: false, reason: state.status }
    if (!threadIsLive(loaded.identity, grant)) return { ok: false, reason: 'thread-revoked' }
    if (now < grant.issuedAt) return { ok: false, reason: 'clock' }
    const write = (next: GrantStateRecord) =>
      this.commit([{ kind: RUN_GRANT_STATE_KIND, id: grantId, row: stateRow, state: next }], now)
    if (now >= grant.expiresAt) {
      write({ ...state, status: 'expired', endedAt: now })
      return { ok: false, reason: 'expired' }
    }
    const remaining = (used: RunGrantAmounts): RunGrantAmounts => ({
      turns: grant.limits.turns - used.turns,
      toolCalls: grant.limits.toolCalls - used.toolCalls,
      walltimeSeconds: grant.limits.walltimeSeconds - used.walltimeSeconds
    })
    if (state.charges.includes(chargeId))
      return {
        ok: true,
        replay: true,
        used: copyAmounts(state.used),
        remaining: remaining(state.used)
      }
    const axis = AXES.find((name) => amount[name] > grant.limits[name] - state.used[name])
    if (axis !== undefined) {
      write({ ...state, status: 'exhausted', reason: axis, endedAt: now })
      return { ok: false, reason: 'exhausted', axis }
    }
    const used: RunGrantAmounts = {
      turns: state.used.turns + amount.turns,
      toolCalls: state.used.toolCalls + amount.toolCalls,
      walltimeSeconds: state.used.walltimeSeconds + amount.walltimeSeconds
    }
    write({
      ...state,
      used,
      charges: [...state.charges, chargeId].slice(-RUN_GRANT_CHARGE_HISTORY)
    })
    return { ok: true, replay: false, used: copyAmounts(used), remaining: remaining(used) }
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
  private resolveThread(threadId: string): ResolvedThread | undefined {
    const indexRow = this.readRow(THREAD_IDENTITY_INDEX_KIND, threadId)
    if (!indexRow) return undefined
    const index = parseIndex(indexRow.state, threadId)
    const identity = this.loadIdentity(index.key)
    if (!identity) throw unavailable()
    if (identity.state.threadId !== threadId && index.generation >= identity.state.generation)
      throw unavailable()
    return { index, identity }
  }

  /** A grant with its state; a grant without state or a state without grant is unavailable. */
  private loadGrant(grantId: string): LoadedGrant | undefined {
    const row = this.readRow(RUN_GRANT_KIND, grantId)
    if (!row) {
      if (this.store.hasResourceEvidence(RUN_GRANT_STATE_KIND, grantId)) throw unavailable()
      return undefined
    }
    const grant = parseGrant(row.state, grantId)
    const stateRow = this.readRow(RUN_GRANT_STATE_KIND, grantId)
    if (!stateRow) throw unavailable()
    return { grant, stateRow, state: parseGrantState(stateRow.state, grant) }
  }

  /**
   * A grant with its state and the identity of its thread. The index of its thread id must name
   * its generation, and while that generation is current the identity must list the grant.
   */
  private loadBoundGrant(
    grantId: string
  ): (LoadedGrant & { identity: LoadedIdentity }) | undefined {
    const loaded = this.loadGrant(grantId)
    if (!loaded) return undefined
    const resolved = this.resolveThread(loaded.grant.threadId)
    if (!resolved || resolved.index.generation !== loaded.grant.generation) throw unavailable()
    const identity = resolved.identity
    if (
      identity.state.generation === loaded.grant.generation &&
      !identity.state.grants.includes(grantId)
    )
      throw unavailable()
    return { ...loaded, identity }
  }

  /** Every grant the identity lists for its current generation, each bound to it. */
  private loadListedGrants(identity: LoadedIdentity): LoadedGrant[] {
    return identity.state.grants.map((grantId) => {
      const loaded = this.loadGrant(grantId)
      if (
        !loaded ||
        loaded.grant.threadId !== identity.state.threadId ||
        loaded.grant.generation !== identity.state.generation
      )
        throw unavailable()
      return loaded
    })
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
