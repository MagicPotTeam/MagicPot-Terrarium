import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { webContents } from 'electron'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { AgentTeamMessageIntent, AgentTeamMessageClaim } from '@shared/api/agentTeamMessage'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMChatReq, LLMTeamIdentity, LLMTeamMember } from '@shared/api/svcLLMProxy'
import { getBuildEnv } from '../config/buildEnv'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { activeInstanceLeasePids } from '../magicAgentPlatform2/persistence/writeLock'
import type { TeamMessageIntent } from './agentTeamMessageTools'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { getTeamEndStore } from './teamEndStore'
import { TEAM_QUEUE_UNAVAILABLE, TeamMessageStore, type TeamMessageEntry } from './teamMessageStore'

const TEAM_CAPACITY = 128,
  TOTAL_CAPACITY = 1024,
  RETRY_MS = 30_000
/** This MAIN process. A claim made by another boot is over (see TeamMessageStore). Memory only. */
const BOOT = randomUUID()
const valid = (x: unknown): x is string =>
  typeof x === 'string' &&
  x.length > 0 &&
  x.length <= 512 &&
  x.trim() === x &&
  !Array.from(x).some((c) => c.charCodeAt(0) < 32)
type Sender = NonNullable<ReturnType<typeof webContents.fromId>>
type Owner = { sender: Sender; fresh: Set<string>; leases: Set<string>; detach(): void }
type NavigationDetails = { isMainFrame?: boolean; isSameDocument?: boolean } | undefined

export type TeamMessageStoreOpener = {
  /** create false: undefined when the file does not exist (nothing queued), and the file is never created. */
  open(create: boolean): TeamMessageStore | undefined
  close(): void
}

/**
 * Opens <file> on first use, like getTeamEndStore. A failure is remembered and the file is not
 * opened again for RETRY_MS (no open, and no audit of the whole file, on every poll). While another
 * live process holds the file nothing is opened or recovered: every call throws 'Team queue unavailable.'.
 */
export function teamMessageStoreOpener(file: string, boot: string): TeamMessageStoreOpener {
  let store: TeamMessageStore | undefined,
    failure: unknown,
    retryAt = 0
  return {
    open(create) {
      if (store) return store
      if (Date.now() < retryAt) throw failure
      if (!create && !existsSync(file)) return undefined
      try {
        if (activeInstanceLeasePids(file).some((pid) => pid !== process.pid))
          throw new Error(TEAM_QUEUE_UNAVAILABLE)
        mkdirSync(dirname(file), { recursive: true })
        const db = new MagicAgentEventStore(file)
        let opened: TeamMessageStore
        try {
          opened = new TeamMessageStore(db, boot)
        } catch (error) {
          db.close()
          throw error
        }
        if (opened.unavailable) {
          opened.close()
          throw new Error(TEAM_QUEUE_UNAVAILABLE)
        }
        store = opened
        return store
      } catch (error) {
        failure = error
        retryAt = Date.now() + RETRY_MS
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

function productionOpener(): TeamMessageStoreOpener {
  let opener: TeamMessageStoreOpener | undefined
  const resolve = () =>
    (opener ??= teamMessageStoreOpener(
      join(getBuildEnv().pathMap.data, 'team-messages', 'messages.sqlite'),
      BOOT
    ))
  return { open: (create) => resolve().open(create), close: () => opener?.close() }
}
const unavailable = (error: unknown): boolean =>
  error instanceof Error && error.message === TEAM_QUEUE_UNAVAILABLE
export const TEAM_MESSAGE_UNAVAILABLE = 'Team message is no longer available.'

/**
 * MAIN-owned member message queue over the durable TeamMessageStore. A record is fresh while the
 * document that enqueued it in this process lives: only that webContents lists and claims it. Every
 * other queued record is carried over: any sender that passes authorizeAgentThreadScope for the same
 * route, storage scope and lead lists and claims it. A claim is a lease (this boot, the claiming
 * webContents, a memory-only token); when its document ends the claim is closed ('closed' when MAIN
 * admitted a request, else 'unknown') and the message is never delivered again. The source tuple is a
 * controlled-renderer functional contract, not authenticated team identity.
 */
export class AgentTeamMessageQueue {
  private readonly owners = new Map<number, Owner>()
  /** id -> the webContents that enqueued it, while its document lives (fresh records). */
  private readonly fresh = new Map<string, number>()
  /** id -> the lease of the claim (memory only). */
  private readonly leases = new Map<string, { token: string; senderId: number }>()
  private readonly opener: TeamMessageStoreOpener
  private readonly assertTeamActive: (member: LLMTeamMember) => void

  constructor(
    options: {
      store?: TeamMessageStoreOpener
      assertTeamActive?: (member: LLMTeamMember) => void
    } = {}
  ) {
    this.opener = options.store ?? productionOpener()
    this.assertTeamActive =
      options.assertTeamActive ?? ((member) => getTeamEndStore().assertActive(member))
  }

  private owner(senderId: number, invocation: ServiceInvocationContext): Owner {
    const sender = webContents.fromId(senderId)
    if (
      !sender ||
      sender.isDestroyed() ||
      sender.getURL() !== invocation.frameUrl ||
      sender.getURL() !== invocation.senderUrl
    )
      throw Error('Team queue owner unavailable.')
    const existing = this.owners.get(senderId)
    if (existing) {
      if (existing.sender !== sender) throw Error('Team queue owner changed.')
      return existing
    }
    // The document that enqueued its fresh records is gone (or moved): they are carried over, never deleted.
    const carryOver = () => {
      for (const id of owner.fresh) if (this.fresh.get(id) === senderId) this.fresh.delete(id)
      owner.fresh.clear()
    }
    const endClaims = () => {
      for (const id of owner.leases) {
        this.leases.delete(id)
        try {
          this.opener.open(false)?.closeClaim(id)
        } catch {
          console.warn('[TeamQueue] A claim stays open until the next start of the app.')
        }
      }
      owner.leases.clear()
    }
    const end = () => {
      carryOver()
      endClaims()
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
      // Same document: the page and its dispatcher still live, so their claims stay.
      if ((details?.isSameDocument ?? inPlace) === true) carryOver()
      else end()
    }
    const owner: Owner = {
      sender,
      fresh: new Set(),
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

  private view(entry: TeamMessageEntry, lease?: string): AgentTeamMessageIntent {
    const { intent } = entry
    return {
      id: intent.id,
      source: { ...intent.source },
      kind: intent.kind,
      hop: intent.hop,
      ...(intent.recipient === undefined ? {} : { recipient: intent.recipient }),
      text: intent.text,
      ...(this.fresh.has(intent.id) ? {} : { carriedOver: true as const }),
      ...(lease === undefined ? {} : { lease })
    }
  }

  /** Visible to this sender: same route, storage scope and lead; a fresh record only to its own webContents. */
  private visible(
    entry: TeamMessageEntry,
    senderId: number,
    routeKey: string,
    scope: { storageScope: string; conversationId: string }
  ): boolean {
    const owner = this.fresh.get(entry.intent.id)
    return (
      entry.state.status === 'queued' &&
      entry.intent.routeKey === routeKey &&
      entry.intent.source.scope === scope.storageScope &&
      entry.intent.source.lead === scope.conversationId &&
      (owner === undefined || owner === senderId)
    )
  }

  enqueue(
    intent: TeamMessageIntent,
    options: {
      invocation: ServiceInvocationContext
      route: AgentThreadInteractionScope['route']
      lease: { assertLive(): void }
      signal?: AbortSignal
    }
  ): { requestId: string } {
    options.signal?.throwIfAborted()
    options.lease.assertLive()
    const source = intent?.source
    if (
      !source ||
      ![source.scope, source.thread, source.lead, source.member].every(valid) ||
      source.member === source.lead ||
      (intent.hop !== 1 && intent.hop !== 2) ||
      typeof intent.text !== 'string' ||
      !intent.text.trim() ||
      intent.text.length > 4000 ||
      !['message', 'channel'].includes(intent.kind) ||
      (intent.kind === 'message'
        ? typeof intent.recipient !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(intent.recipient) ||
          intent.recipient === source.member
        : intent.recipient !== undefined)
    )
      throw Error('Invalid team message intent.')
    const route = normalizeAgentRoute(options.route)
    if (source.thread !== route.threadId) throw Error('Team queue route mismatch.')
    if (!['svcLLMProxy.chat', 'svcLLMProxy.chatStream'].includes(options.invocation.methodName))
      throw Error('Invalid team queue source invocation.')
    const senderId = authorizeAgentThreadScope(
      { route, conversationId: source.member },
      options.invocation,
      options.invocation.methodName.split('.').at(-1)!
    )
    const store = this.opener.open(true)!
    // Only queued records count: claimed and settled ones never fill the queue.
    if (store.queuedCount(source) >= TEAM_CAPACITY || store.queuedCount() >= TOTAL_CAPACITY)
      throw Error('Team queue capacity reached.')
    options.signal?.throwIfAborted()
    options.lease.assertLive()
    const owner = this.owner(senderId, options.invocation)
    // The request ID is returned only after the message and its state are committed.
    const { intent: stored } = store.append({
      source,
      routeKey: getAgentSessionKey(route),
      kind: intent.kind,
      hop: intent.hop,
      ...(intent.recipient === undefined ? {} : { recipient: intent.recipient }),
      text: intent.text
    })
    this.fresh.set(stored.id, senderId)
    owner.fresh.add(stored.id)
    return { requestId: stored.id }
  }

  list(
    scope: AgentThreadInteractionScope & { storageScope: string },
    invocation?: ServiceInvocationContext
  ): AgentTeamMessageIntent[] {
    if (!valid(scope.storageScope)) throw Error('Invalid team queue scope.')
    const senderId = authorizeAgentThreadScope(scope, invocation, 'listAgentTeamMessages')
    let store: TeamMessageStore | undefined
    try {
      store = this.opener.open(false)
    } catch (error) {
      if (unavailable(error)) return []
      throw error
    }
    if (!store) return []
    const routeKey = getAgentSessionKey(normalizeAgentRoute(scope.route))
    // Memory only: the store keeps its queued records in an index, so a poll does no SQLite work.
    return store
      .queued()
      .filter((entry) => this.visible(entry, senderId, routeKey, scope))
      .map((entry) => this.view(entry))
  }

  /** Durable before it returns; the lease token is given out exactly once. */
  claim(
    req: AgentTeamMessageClaim,
    invocation?: ServiceInvocationContext
  ): AgentTeamMessageIntent | undefined {
    if (!valid(req.storageScope)) throw Error('Invalid team queue scope.')
    const senderId = authorizeAgentThreadScope(req, invocation, 'claimAgentTeamMessage')
    const store = this.opener.open(false)
    const entry = store?.peek(req.id)
    if (
      !store ||
      !invocation ||
      !entry ||
      !this.visible(entry, senderId, getAgentSessionKey(normalizeAgentRoute(req.route)), req)
    )
      return undefined
    try {
      this.assertTeamActive(entry.intent.source)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Team has ended.') throw error
      store.endQueued(req.id)
      this.fresh.delete(req.id)
      return undefined
    }
    const owner = this.owner(senderId, invocation)
    const claimed = store.claim(req.id)
    if (!claimed) return undefined
    const token = randomUUID()
    this.leases.set(req.id, { token, senderId })
    owner.leases.add(req.id)
    const view = this.view(claimed, token)
    if (this.fresh.get(req.id) === senderId) {
      this.fresh.delete(req.id)
      owner.fresh.delete(req.id)
    }
    return view
  }

  /**
   * Admission of a member-message delivery request (after the End check, before any provider, tool
   * or goal set-up). A request without teamMessageDelivery passes unchanged and never touches the
   * store. With it, the claim must be this process's, held by this webContents with this token, for
   * this team, route, hop and a valid recipient; MAIN then records the start of the request, and
   * only then does the request go on, without the field. A repeat of a recipient already started
   * by the same lease holder is admitted without a second record. Anything else is refused.
   */
  admitDelivery<T extends LLMChatReq>(req: T, invocation?: ServiceInvocationContext): T {
    if (!Object.hasOwn(req, 'teamMessageDelivery')) return req
    const { teamMessageDelivery: delivery, ...admitted } = req
    try {
      const member = req.teamMember,
        senderId = invocation?.senderId
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
      if (!member || ![member.scope, member.thread, member.lead, member.member].every(valid))
        throw Error()
      const lease = this.leases.get(delivery.id)
      if (!lease || lease.token !== delivery.lease || lease.senderId !== senderId) throw Error()
      const store = this.opener.open(false)
      const entry = store && (store.peek(delivery.id) ?? store.get(delivery.id))
      if (!store || !entry) throw Error()
      const { intent, state } = entry
      if (
        req.teamMessageHop !== intent.hop ||
        member.scope !== state.team.scope ||
        member.thread !== state.team.thread ||
        member.lead !== state.team.lead
      )
        throw Error()
      if (!req.route || getAgentSessionKey(normalizeAgentRoute(req.route)) !== intent.routeKey)
        throw Error()
      // Durable before the request goes on. The store refuses a claim that is not this boot's and a
      // recipient other than the message's own (or, for a channel, the source member itself).
      store.start(delivery.id, member.member)
    } catch {
      throw new Error(TEAM_MESSAGE_UNAVAILABLE)
    }
    return admitted as T
  }

  /** After End was recorded: every queued message of the team is 'ended'. A profile without the file gets none. */
  endTeam(team: LLMTeamIdentity): void {
    const store = this.opener.open(false)
    if (!store) return
    store.endTeam({ scope: team.scope, thread: team.thread, lead: team.lead })
    for (const id of [...this.fresh.keys()]) if (!store.peek(id)) this.fresh.delete(id)
  }

  /** Stops watching every sender and closes the file. Claims stay as they are (like a process exit). */
  dispose(): void {
    for (const owner of this.owners.values()) owner.detach()
    this.owners.clear()
    this.fresh.clear()
    this.leases.clear()
    this.opener.close()
  }
}
