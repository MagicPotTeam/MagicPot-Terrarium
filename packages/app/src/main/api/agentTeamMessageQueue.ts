import { randomUUID } from 'node:crypto'
import { webContents } from 'electron'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { AgentTeamMessageIntent, AgentTeamMessageClaim } from '@shared/api/agentTeamMessage'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { TeamMessageIntent } from './agentTeamMessageTools'
import { authorizeAgentThreadScope } from './agentThreadScope'

const CAPACITY = 128, TTL_MS = 60_000
const valid = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512 && x.trim() === x && !Array.from(x).some(c => c.charCodeAt(0) < 32)
type Owner = { sender: NonNullable<ReturnType<typeof webContents.fromId>>; url: string; dispose(): void }
type Entry = { senderId: number; routeKey: string; view: AgentTeamMessageIntent }

/** Process-local intent handoff. Claim means removed, not delivered. Source tuple
 * is a controlled-renderer functional contract, not authenticated team identity. */
export class AgentTeamMessageQueue {
  private readonly entries = new Map<string, Entry>()
  private readonly owners = new Map<number, Owner>()
  private timer: ReturnType<typeof setTimeout> | undefined

  private prune(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) if (entry.view.expiresAt <= now) this.entries.delete(id)
    for (const [id, owner] of this.owners) if (![...this.entries.values()].some(entry => entry.senderId === id)) owner.dispose()
    this.schedule()
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.entries.size) return
    const expires = Math.min(...[...this.entries.values()].map(entry => entry.view.expiresAt))
    this.timer = setTimeout(() => { this.timer = undefined; this.prune() }, Math.max(0, expires - Date.now()))
    this.timer.unref?.()
  }
  private owner(senderId: number, invocation: ServiceInvocationContext): Owner {
    const sender = webContents.fromId(senderId)
    if (!sender || sender.isDestroyed() || sender.getURL() !== invocation.frameUrl || sender.getURL() !== invocation.senderUrl) throw Error('Team queue owner unavailable.')
    const existing = this.owners.get(senderId)
    if (existing) {
      if (existing.sender !== sender || existing.url !== sender.getURL()) throw Error('Team queue owner changed.')
      return existing
    }
    const dispose = () => {
      for (const [id, entry] of this.entries) if (entry.senderId === senderId) this.entries.delete(id)
      sender.removeListener('did-start-navigation', navigation); sender.removeListener('render-process-gone', dispose); sender.removeListener('destroyed', dispose)
      this.owners.delete(senderId); this.schedule()
    }
    const navigation = (details: { isMainFrame?: boolean } | undefined, _url?: string, _inPlace?: boolean, legacyMainFrame?: boolean) => { if ((details?.isMainFrame ?? legacyMainFrame) !== false) dispose() }
    const owner: Owner = { sender, url: sender.getURL(), dispose }
    sender.on('did-start-navigation', navigation); sender.on('render-process-gone', dispose); sender.on('destroyed', dispose)
    this.owners.set(senderId, owner)
    return owner
  }
  enqueue(intent: TeamMessageIntent, options: { invocation: ServiceInvocationContext; route: AgentThreadInteractionScope['route']; lease: { assertLive(): void }; signal?: AbortSignal }): { requestId: string } {
    options.signal?.throwIfAborted(); options.lease.assertLive()
    const source = intent?.source
    if (!source || ![source.scope, source.thread, source.lead, source.member].every(valid) || source.member === source.lead || (intent.hop !== 1 && intent.hop !== 2) || typeof intent.text !== 'string' || !intent.text.trim() || intent.text.length > 4000 || !['message', 'channel'].includes(intent.kind) || (intent.kind === 'message' ? typeof intent.recipient !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(intent.recipient) || intent.recipient === source.member : intent.recipient !== undefined)) throw Error('Invalid team message intent.')
    const route = normalizeAgentRoute(options.route)
    if (source.thread !== route.threadId) throw Error('Team queue route mismatch.')
    if (!['svcLLMProxy.chat', 'svcLLMProxy.chatStream'].includes(options.invocation.methodName)) throw Error('Invalid team queue source invocation.')
    const senderId = authorizeAgentThreadScope({ route, conversationId: source.member }, options.invocation, options.invocation.methodName.split('.').at(-1)!)
    this.prune()
    if (this.entries.size >= CAPACITY) throw Error('Team queue capacity reached.')
    options.signal?.throwIfAborted(); options.lease.assertLive()
    this.owner(senderId, options.invocation)
    const requestId = randomUUID(), view: AgentTeamMessageIntent = { id: requestId, source: { ...source }, kind: intent.kind, hop: intent.hop, ...(intent.recipient === undefined ? {} : { recipient: intent.recipient }), text: intent.text, expiresAt: Date.now() + TTL_MS }
    this.entries.set(requestId, { senderId, routeKey: getAgentSessionKey(route), view }); this.schedule()
    return { requestId }
  }
  list(scope: AgentThreadInteractionScope & { storageScope: string }, invocation?: ServiceInvocationContext): AgentTeamMessageIntent[] {
    if (!valid(scope.storageScope)) throw Error('Invalid team queue scope.')
    const senderId = authorizeAgentThreadScope(scope, invocation, 'listAgentTeamMessages')
    this.prune()
    const owner = this.owners.get(senderId)
    if (!invocation || !owner || owner.sender.isDestroyed() || owner.sender.getURL() !== invocation.senderUrl) return []
    const routeKey = getAgentSessionKey(normalizeAgentRoute(scope.route))
    return [...this.entries.values()].filter(entry => entry.senderId === senderId && entry.routeKey === routeKey && entry.view.source.scope === scope.storageScope && entry.view.source.lead === scope.conversationId).map(entry => structuredClone(entry.view))
  }
  claim(req: AgentTeamMessageClaim, invocation?: ServiceInvocationContext): AgentTeamMessageIntent | undefined {
    if (!valid(req.storageScope)) throw Error('Invalid team queue scope.')
    const senderId = authorizeAgentThreadScope(req, invocation, 'claimAgentTeamMessage')
    this.prune()
    const owner = this.owners.get(senderId), entry = this.entries.get(req.id)
    if (!invocation || !owner || owner.sender.isDestroyed() || owner.sender.getURL() !== invocation.senderUrl || !entry || entry.senderId !== senderId || entry.routeKey !== getAgentSessionKey(normalizeAgentRoute(req.route)) || entry.view.source.scope !== req.storageScope || entry.view.source.lead !== req.conversationId) return undefined
    this.entries.delete(req.id); this.prune()
    return structuredClone(entry.view)
  }
  dispose(): void { for (const owner of [...this.owners.values()]) owner.dispose(); this.entries.clear(); this.schedule() }
}
