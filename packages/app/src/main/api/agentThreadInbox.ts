import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { webContents } from 'electron'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import {
  AGENT_THREAD_INBOX_LIMITS as LIMITS,
  type AgentThreadEventClaim,
  type AgentThreadEventExpire,
  type AgentThreadEventListScope,
  type AgentThreadEventRelease,
  type AgentThreadEventType,
  type AgentThreadEventView
} from '@shared/api/agentThreadInbox'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { getBuildEnv } from '../config/buildEnv'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { activeInstanceLeasePids } from '../magicAgentPlatform2/persistence/writeLock'
import {
  THREAD_INBOX_UNAVAILABLE,
  ThreadInboxStore,
  type ThreadEventEntry,
  type ThreadEventSession
} from './agentThreadInboxStore'
import { authorizeAgentThreadScope } from './agentThreadScope'

/** This MAIN process. A claim of another boot never started a turn (see ThreadInboxStore). */
const BOOT = randomUUID()
const RETRY_MS = 30_000
const BOOT_STARTED_AT = Date.now()
export const THREAD_EVENT_UNAVAILABLE = 'Thread event is no longer available.'
export const THREAD_EVENT_BUSY = 'Thread event waits: its session has a running turn.'
const PRODUCER_TYPES: ReadonlySet<AgentThreadEventType> = new Set([
  'trigger_fire',
  'drive_ready',
  'job_done'
])
const valid = (x: unknown): x is string =>
  typeof x === 'string' &&
  x.length > 0 &&
  x.length <= 512 &&
  x.trim() === x &&
  !Array.from(x).some((c) => c.charCodeAt(0) < 32)
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const EXPIRE_REASONS: ReadonlySet<unknown> = new Set(['session-removed', 'session-unavailable'])
/** Request fields that stand for the user's own act; an event turn may carry none of them. */
const USER_AUTHORITY_FIELDS = [
  'teamMember',
  'teamMessageHop',
  'teamMessageDelivery',
  'goalProgressToken',
  'expectedProfileRevision',
  'comparisonRouting',
  'imageRequest',
  'threadImageReview',
  'isEdit',
  'isRegenerate'
] as const
type Sender = NonNullable<ReturnType<typeof webContents.fromId>>
type Owner = { sender: Sender; leases: Set<string>; detach(): void }
type NavigationDetails = { isMainFrame?: boolean; isSameDocument?: boolean } | undefined

export type ThreadInboxStoreOpener = {
  /** create false: undefined when the file does not exist (nothing queued); never creates it. */
  open(create: boolean): ThreadInboxStore | undefined
  close(): void
}

/**
 * Opens <file> on first use. A failure (including another live process holding the file) is
 * remembered for RETRY_MS on the monotonic clock: no open, and no audit of the file, on every poll.
 * Each distinct failure is logged once.
 */
export function threadInboxStoreOpener(
  file: string,
  boot: string,
  now?: () => number
): ThreadInboxStoreOpener {
  let store: ThreadInboxStore | undefined,
    failure: unknown,
    retryAt = 0,
    logged: string | undefined
  return {
    open(create) {
      if (store) return store
      if (performance.now() < retryAt) throw failure
      if (!create && !existsSync(file)) return undefined
      try {
        if (activeInstanceLeasePids(file).some((pid) => pid !== process.pid))
          throw new Error(THREAD_INBOX_UNAVAILABLE)
        mkdirSync(dirname(file), { recursive: true })
        const db = new MagicAgentEventStore(file)
        let opened: ThreadInboxStore
        try {
          opened = new ThreadInboxStore(db, boot, now)
        } catch (error) {
          db.close()
          throw error
        }
        if (opened.unavailable) {
          opened.close()
          throw new Error(THREAD_INBOX_UNAVAILABLE)
        }
        store = opened
        logged = undefined
        return store
      } catch (error) {
        failure = error
        const detail = String(error instanceof Error ? error.message : error).slice(0, 300)
        if (detail !== logged) {
          logged = detail
          console.warn('[ThreadInbox] The thread event file is not served for now.', detail)
        }
        retryAt = performance.now() + RETRY_MS
        throw error
      }
    },
    close() {
      const opened = store
      store = undefined
      opened?.close()
    }
  }
}

function productionOpener(): ThreadInboxStoreOpener {
  let opener: ThreadInboxStoreOpener | undefined
  const resolve = () =>
    (opener ??= threadInboxStoreOpener(
      join(getBuildEnv().pathMap.data, 'thread-inbox', 'events.sqlite'),
      BOOT
    ))
  return { open: (create) => resolve().open(create), close: () => opener?.close() }
}

/** MAIN-only producer input (S3 jobs, S4 triggers, S5 goals). Never reachable over IPC. */
export type AgentThreadEventInput = {
  route: AgentRouteLike
  storageScope: string
  conversationId: string
  type: AgentThreadEventType
  source: string
  text: string
  /** Optional: a repeat while an event with this key waits in the session returns that event. */
  idempotencyKey?: string
}

function threadRoute(route: AgentRouteLike): AgentRouteLike {
  const normalized = normalizeAgentRoute(route)
  if (
    normalized.channel !== 'canvas' ||
    normalized.scopeType !== 'thread' ||
    !safeId(normalized.scopeId) ||
    !safeId(normalized.threadId)
  )
    throw new Error('Invalid thread event route.')
  return normalized
}

/**
 * MAIN-owned per-session thread event inbox over the durable ThreadInboxStore (D7 plan A: a renderer
 * wake pump runs each event as one turn while the app and the project's chat are open). Only MAIN
 * code enqueues. A renderer lists the queued events of its own canvas thread route and storage
 * scope (authorizeAgentThreadScope), claims one (a lease: this boot, this webContents, a
 * memory-only token), and runs the turn; MAIN admits the turn's request with the lease (the event
 * becomes done before the request goes on) or the renderer releases it. When the claiming document
 * ends, its unstarted claims are queued again. An event turn is not a user turn: the request is
 * marked threadEventOrigin, never a composer submission, consent or approval.
 */
export class AgentThreadInbox {
  private readonly owners = new Map<number, Owner>()
  /** id -> the lease of the claim (memory only). */
  private readonly leases = new Map<string, { token: string; senderId: number }>()
  private readonly opener: ThreadInboxStoreOpener

  constructor(options: { store?: ThreadInboxStoreOpener } = {}) {
    this.opener = options.store ?? productionOpener()
  }

  private owner(senderId: number, invocation: ServiceInvocationContext): Owner {
    const sender = webContents.fromId(senderId)
    if (
      !sender ||
      sender.isDestroyed() ||
      sender.getURL() !== invocation.frameUrl ||
      sender.getURL() !== invocation.senderUrl
    )
      throw Error('Thread inbox owner unavailable.')
    const existing = this.owners.get(senderId)
    if (existing) {
      if (existing.sender !== sender) throw Error('Thread inbox owner changed.')
      return existing
    }
    // The claiming document is gone: its claims never started a turn and are queued again.
    const end = () => {
      for (const id of owner.leases) {
        this.leases.delete(id)
        try {
          this.opener.open(false)?.release(id)
        } catch {
          console.warn('[ThreadInbox] A claim stays open until the next start of the app.')
        }
      }
      owner.leases.clear()
      owner.detach()
      this.owners.delete(senderId)
    }
    const navigation = (
      details: NavigationDetails,
      _url?: string,
      inPlace?: boolean,
      legacyMainFrame?: boolean
    ) => {
      if ((details?.isMainFrame ?? legacyMainFrame) === false) return
      if ((details?.isSameDocument ?? inPlace) !== true) end()
    }
    const owner: Owner = {
      sender,
      leases: new Set(),
      detach: () => {
        sender.removeListener('did-start-navigation', navigation)
        sender.removeListener('render-process-gone', end)
        sender.removeListener('destroyed', end)
      }
    }
    sender.on('did-start-navigation', navigation)
    sender.on('render-process-gone', end)
    sender.on('destroyed', end)
    this.owners.set(senderId, owner)
    return owner
  }

  private view(entry: ThreadEventEntry, lease?: string): AgentThreadEventView {
    const { event } = entry
    return {
      id: event.id,
      conversationId: event.conversationId,
      type: event.type,
      source: event.source,
      text: event.text,
      createdAt: event.createdAt,
      expiresAt: event.expiresAt,
      ...(event.createdAt < BOOT_STARTED_AT ? { carriedOver: true as const } : {}),
      ...(lease === undefined ? {} : { lease })
    }
  }

  private session(
    scope: { route: AgentRouteLike; storageScope: string },
    conversationId: string
  ): ThreadEventSession {
    if (!valid(scope.storageScope) || !safeId(conversationId))
      throw Error('Invalid thread event scope.')
    return {
      storageScope: scope.storageScope,
      routeKey: getAgentSessionKey(threadRoute(scope.route)),
      conversationId
    }
  }

  /**
   * MAIN-internal producer: validated and capped, never authorized by a renderer. Returns the event
   * id; with an idempotency key a waiting event of the session with that key is returned instead.
   */
  enqueue(input: AgentThreadEventInput): { id: string; duplicate: boolean } {
    if (!input || !PRODUCER_TYPES.has(input.type)) throw Error('Invalid thread event type.')
    if (
      !valid(input.source) ||
      input.source.length > LIMITS.sourceCharacters ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > LIMITS.textCharacters ||
      (input.idempotencyKey !== undefined &&
        (!valid(input.idempotencyKey) ||
          input.idempotencyKey.length > LIMITS.idempotencyKeyCharacters))
    )
      throw Error('Invalid thread event.')
    const session = this.session(input, input.conversationId)
    const store = this.opener.open(true)!
    store.expireStale()
    const append = () =>
      store.append({
        ...session,
        type: input.type,
        source: input.source,
        text: input.text,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey })
      })
    // A repeat of a waiting key never counts against the caps: it writes nothing.
    if (input.idempotencyKey !== undefined) {
      const probe = store
        .queued()
        .find(
          (entry) =>
            entry.event.idempotencyKey === input.idempotencyKey &&
            entry.event.storageScope === session.storageScope &&
            entry.event.routeKey === session.routeKey &&
            entry.event.conversationId === session.conversationId
        )
      if (probe) return { id: probe.event.id, duplicate: true }
    }
    if (store.queuedCount(session) >= LIMITS.perSession || store.queuedCount() >= LIMITS.total)
      throw Error('Thread inbox capacity reached.')
    const { event, duplicate } = append()
    return { id: event.id, duplicate }
  }

  /** Every queued event of this canvas thread route and storage scope, oldest first. */
  list(
    scope: AgentThreadEventListScope,
    invocation?: ServiceInvocationContext
  ): AgentThreadEventView[] {
    if (!scope || !valid(scope.storageScope)) throw Error('Invalid thread event scope.')
    const route = threadRoute(scope.route)
    // The route (scopeId must be the sender's own canvas document) is the authority; the thread id
    // stands in for the conversation, which differs per event.
    authorizeAgentThreadScope(
      { route, conversationId: route.threadId! },
      invocation,
      'listAgentThreadEvents'
    )
    let store: ThreadInboxStore | undefined
    try {
      store = this.opener.open(false)
    } catch {
      return [] // Fail closed; the opener logs each distinct failure once.
    }
    if (!store) return []
    store.expireStale()
    const routeKey = getAgentSessionKey(route)
    return store
      .queued()
      .filter(
        (entry) =>
          entry.event.routeKey === routeKey && entry.event.storageScope === scope.storageScope
      )
      .map((entry) => this.view(entry))
  }

  /** Durable before it returns; the lease token is given out exactly once. */
  claim(
    req: AgentThreadEventClaim,
    invocation?: ServiceInvocationContext
  ): AgentThreadEventView | undefined {
    const session = this.session(req, req?.conversationId)
    const senderId = authorizeAgentThreadScope(
      { route: threadRoute(req.route), conversationId: req.conversationId },
      invocation,
      'claimAgentThreadEvent'
    )
    if (!invocation || !valid(req.id)) return undefined
    const store = this.opener.open(false)
    const entry = store?.peek(req.id)
    if (
      !store ||
      !entry ||
      entry.state.status !== 'queued' ||
      entry.event.storageScope !== session.storageScope ||
      entry.event.routeKey !== session.routeKey ||
      entry.event.conversationId !== session.conversationId
    )
      return undefined
    const owner = this.owner(senderId, invocation)
    const claimed = store.claim(req.id)
    if (!claimed) return undefined
    const token = randomUUID()
    this.leases.set(req.id, { token, senderId })
    owner.leases.add(req.id)
    return this.view(claimed, token)
  }

  /** The turn did not start: the claim ends and the event is queued again. Lease holder only. */
  release(
    req: AgentThreadEventRelease,
    invocation?: ServiceInvocationContext
  ): { released: boolean } {
    this.session(req, req?.conversationId)
    const senderId = authorizeAgentThreadScope(
      { route: threadRoute(req.route), conversationId: req.conversationId },
      invocation,
      'releaseAgentThreadEvent'
    )
    const lease = valid(req.id) ? this.leases.get(req.id) : undefined
    if (!lease || lease.token !== req.lease || lease.senderId !== senderId)
      return { released: false }
    this.leases.delete(req.id)
    this.owners.get(senderId)?.leases.delete(req.id)
    const store = this.opener.open(false)
    return { released: store?.release(req.id) === 'queued' }
  }

  /**
   * The session was removed for good (or cannot take an event turn): every waiting event of it
   * expires and is never delivered, so nothing re-creates or reopens it. A stopped (dormant) session
   * is not expired: its events wait until the user resumes it. Only removes work, so any sender
   * authorized for the route may ask.
   */
  expire(req: AgentThreadEventExpire, invocation?: ServiceInvocationContext): { expired: number } {
    const session = this.session(req, req?.conversationId)
    if (!EXPIRE_REASONS.has(req.reason)) throw Error('Invalid thread event scope.')
    authorizeAgentThreadScope(
      { route: threadRoute(req.route), conversationId: req.conversationId },
      invocation,
      'expireAgentThreadEvents'
    )
    let store: ThreadInboxStore | undefined
    try {
      store = this.opener.open(false)
    } catch {
      return { expired: 0 }
    }
    if (!store) return { expired: 0 }
    for (const id of [...this.leases.keys()]) {
      const event = store.peek(id)?.event
      if (
        event &&
        event.routeKey === session.routeKey &&
        event.storageScope === session.storageScope &&
        event.conversationId === session.conversationId
      )
        this.dropLease(id)
    }
    return { expired: store.expireSession(session, req.reason) }
  }

  private dropLease(id: string): void {
    const lease = this.leases.get(id)
    if (!lease) return
    this.leases.delete(id)
    this.owners.get(lease.senderId)?.leases.delete(id)
  }

  /**
   * Admission of an event turn's request (before any provider, tool or goal set-up). A request
   * without threadEvent passes unchanged. With it, the claim must be this process's, held by this
   * webContents with this token, for this route and conversation; MAIN then marks the event done
   * (durable) and the request goes on without the field, marked threadEventOrigin so nothing
   * downstream treats it as the user's own turn. Anything else is refused.
   */
  admitEvent<T extends LLMChatReq>(
    req: T,
    invocation?: ServiceInvocationContext,
    isConversationBusy: (conversationId: string) => boolean = () => false
  ): T {
    if (!Object.hasOwn(req, 'threadEvent')) return req
    const { threadEvent: delivery, ...rest } = req
    let type: AgentThreadEventType
    let busy = false
    try {
      const senderId = invocation?.senderId
      if (
        !invocation ||
        !Number.isSafeInteger(senderId) ||
        !['svcLLMProxy.chat', 'svcLLMProxy.chatStream'].includes(invocation.methodName)
      )
        throw Error()
      if (
        !delivery ||
        typeof delivery !== 'object' ||
        Object.keys(delivery).length !== 2 ||
        !valid(delivery.id) ||
        !valid(delivery.lease)
      )
        throw Error()
      // An event turn carries no user authority: never a team delivery, a goal progress share, a
      // consent to a model configuration snapshot, an explicit image request or review, an edit or a
      // regeneration. Such a request is refused, not stripped.
      // isEdit: false and isRegenerate: false are what an ordinary new turn sends.
      for (const field of USER_AUTHORITY_FIELDS)
        if (req[field] !== undefined && req[field] !== false) throw Error()
      const lease = this.leases.get(delivery.id)
      if (!lease || lease.token !== delivery.lease || lease.senderId !== senderId) throw Error()
      const store = this.opener.open(false)
      const entry = store?.peek(delivery.id)
      if (!store || !entry || !req.route || !safeId(req.conversationId)) throw Error()
      if (getAgentSessionKey(threadRoute(req.route)) !== entry.event.routeKey) throw Error()
      if (req.conversationId !== entry.event.conversationId) throw Error()
      // The session's turn (and anything it waits for, such as an approval) is still running: the
      // event is not started and its claim stays, so the renderer releases it for a later turn.
      if (isConversationBusy(req.conversationId)) {
        busy = true
        throw Error()
      }
      store.start(delivery.id)
      type = entry.event.type
      this.dropLease(delivery.id)
    } catch {
      throw new Error(busy ? THREAD_EVENT_BUSY : THREAD_EVENT_UNAVAILABLE)
    }
    return { ...rest, threadEventOrigin: type } as T
  }

  /** Stops watching every sender and closes the file. Claims stay (like a process exit). */
  dispose(): void {
    for (const owner of this.owners.values()) owner.detach()
    this.owners.clear()
    this.leases.clear()
    this.opener.close()
  }
}
