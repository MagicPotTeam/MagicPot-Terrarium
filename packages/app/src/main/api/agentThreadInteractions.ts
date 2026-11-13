import { AGENT_THREAD_CARD_ACCENTS, AGENT_THREAD_CARD_ACTION_STYLES, AGENT_THREAD_CARD_ICON_LIMIT, parseAgentThreadChoiceCard } from '@shared/api/agentThreadCardDisplay'
import { parseAgentAppDocument, parseAgentAppValues } from '@shared/api/agentThreadApp'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, webContents } from 'electron'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import {
  AGENT_THREAD_INTERACTION_LIMITS as LIMITS,
  type AgentThreadInteraction,
  type AgentThreadInteractionPrompt,
  type AgentThreadInteractionResult,
  type AgentThreadInteractionScope,
  type ResolveAgentThreadInteractionReq
} from '@shared/api/agentThreadInteraction'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'
import { withCanvasFileTools } from './canvasFileTools'
import { authorizeAgentThreadScope } from './agentThreadScope'

export type AgentThreadInteractionChannel = {
  request(prompt: AgentThreadInteractionPrompt, timeoutSeconds: number, signal?: AbortSignal): Promise<AgentThreadInteractionResult>
  dispose(): void
  assertLive(): void
  readonly signal: AbortSignal
}

type Owner = {
  senderId: number
  scope: AgentThreadInteractionScope
  assertLive(): void
  channel: AgentThreadInteractionChannel
}
type Pending = {
  owner: Owner
  view: AgentThreadInteraction
  settle(result: AgentThreadInteractionResult): void
}

const scopeKey = (scope: AgentThreadInteractionScope) =>
  JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])

/** Memory-only rendezvous. Answers are data; this service never creates approval grants. */
export class AgentThreadInteractions {
  private readonly pending = new Map<string, Pending>()

  create(request: LLMChatReq, invocation?: ServiceInvocationContext): AgentThreadInteractionChannel | undefined {
    if (!invocation || withCanvasFileTools(request, invocation) === request) return undefined
    try { return this.createScoped({ route: request.route!, conversationId: request.conversationId! }, invocation) }
    catch { return undefined } // Preserve optional-chat capability admission; dedicated side IPC throws.
  }

  /** Main-only document lease for explicitly authorized non-chat thread services. */
  createScoped(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext): AgentThreadInteractionChannel | undefined {
    authorizeAgentThreadScope(scope, invocation, invocation.methodName.split('.').at(-1)!)
    const sender = webContents.fromId(invocation.senderId!)
    const parent = sender && BrowserWindow.fromWebContents(sender)
    if (!sender || !parent || parent.webContents !== sender || sender.isDestroyed() || parent.isDestroyed()) return undefined
    const originalUrl = sender.getURL()
    if (originalUrl !== invocation.frameUrl || originalUrl !== invocation.senderUrl) return undefined
    scope = { route: normalizeAgentRoute(scope.route), conversationId: scope.conversationId }
    const identity = { ...invocation }
    let active = true
    const lifetime = new AbortController()
    const waiting = new Set<(reason: Error) => void>()
    const assertLive = () => {
      if (!active || sender.isDestroyed() || parent.isDestroyed() || parent.webContents !== sender || sender.getURL() !== originalUrl)
        throw new Error('Agent interaction request is no longer active.')
      authorizeMagicAgentApprovalRenderer({ ...identity, frameUrl: sender.getURL(), senderUrl: sender.getURL() })
    }
    const onNavigation = (details: { isMainFrame?: boolean } | undefined, _url?: string, _inPlace?: boolean, legacyIsMainFrame?: boolean) => {
      if ((details?.isMainFrame ?? legacyIsMainFrame) === false) return
      dispose()
    }
    const dispose = () => {
      if (!active) return
      active = false
      lifetime.abort(new Error('Agent thread document or request ended.'))
      for (const cancel of [...waiting]) cancel(new Error('Agent interaction request ended.'))
      sender.removeListener('did-start-navigation', onNavigation)
      sender.removeListener('render-process-gone', dispose)
      sender.removeListener('destroyed', dispose)
    }
    const owner: Owner = { senderId: sender.id, scope, assertLive, channel: undefined! }
    const channel: AgentThreadInteractionChannel = {
      dispose,
      signal: lifetime.signal,
      assertLive,
      request: async (prompt, timeoutSeconds, signal) => {
        assertLive()
        signal?.throwIfAborted()
        // Reject raw nonliteral accents before JSON can coerce boxed strings or invoke toJSON.
        if (prompt.kind === 'show_card' && Object.hasOwn(prompt, 'accent') && prompt.accent !== undefined &&
          (typeof prompt.accent !== 'string' || !AGENT_THREAD_CARD_ACCENTS.some(accent => accent === prompt.accent)))
          throw new Error('Invalid bounded choice-card prompt.')
        // Decorative text must also be a bounded raw primitive before JSON can invoke hooks.
        if (prompt.kind === 'show_card' && Object.hasOwn(prompt, 'icon') && prompt.icon !== undefined &&
          (typeof prompt.icon !== 'string' || prompt.icon.length > AGENT_THREAD_CARD_ICON_LIMIT))
          throw new Error('Invalid bounded choice-card prompt.')
        let hasActionStyle = false
        if (prompt.kind === 'show_card' && Array.isArray(prompt.actions)) for (const action of prompt.actions) {
          if (action && typeof action === 'object' && Object.hasOwn(action, 'style') && action.style !== undefined) {
            if (typeof action.style !== 'string' || !AGENT_THREAD_CARD_ACTION_STYLES.some(style => style === action.style))
              throw new Error('Invalid bounded choice-card prompt.')
            hasActionStyle = true
          }
        }
        const snapshot = prompt.kind === 'show_app' ? { kind: 'show_app' as const, document: parseAgentAppDocument(prompt.document) }
          : prompt.kind === 'show_card' && (Array.isArray(prompt.actions) && prompt.actions.length === 1 || Object.hasOwn(prompt, 'fields') && prompt.fields !== undefined || Object.hasOwn(prompt, 'subtitle') && prompt.subtitle !== undefined || Object.hasOwn(prompt, 'footer') && prompt.footer !== undefined || Object.hasOwn(prompt, 'accent') && prompt.accent !== undefined || Object.hasOwn(prompt, 'icon') && prompt.icon !== undefined || hasActionStyle)
            ? parseAgentThreadChoiceCard(JSON.stringify(prompt)) : structuredClone(prompt)
        if (!snapshot) throw new Error('Invalid bounded choice-card prompt.')
        if (snapshot.kind === 'show_card' && Array.isArray(snapshot.actions)) for (const action of snapshot.actions) {
          if (action && typeof action === 'object' && Object.hasOwn(action, 'style') && action.style === undefined) delete action.style
        }
        if (snapshot.kind === 'show_app' && [...this.pending.values()].filter((entry) => entry.view.prompt.kind === 'show_app').length >= 8) throw new Error('Agent display capacity reached.')
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > LIMITS.maxTimeoutSeconds)
          throw new Error('Invalid Agent interaction timeout.')
        if (this.pending.size >= 64 || [...this.pending.values()].some((p) => p.owner.senderId === sender.id && scopeKey(p.owner.scope) === scopeKey(scope)))
          throw new Error('An Agent interaction is already pending or the interaction limit was reached.')
        const id = randomUUID()
        return new Promise<AgentThreadInteractionResult>((resolve, reject) => {
          let settled = false
          const finish = (result?: AgentThreadInteractionResult, error?: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            waiting.delete(cancel)
            this.pending.delete(id)
            if (error) reject(error)
            else resolve(result!)
          }
          const cancel = (reason: Error) => finish(undefined, reason)
          const abort = () => finish(undefined, signal?.reason || new Error('Agent interaction cancelled.'))
          const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutSeconds * 1000)
          waiting.add(cancel)
          signal?.addEventListener('abort', abort, { once: true })
          this.pending.set(id, {
            owner,
            view: { id, expiresAt: Date.now() + timeoutSeconds * 1000, prompt: snapshot },
            settle: (result) => finish(result)
          })
          if (signal?.aborted) abort()
        })
      }
    }
    owner.channel = channel
    // Observe document replacement before the first model-issued tool, including
    // same-URL reloads and navigation away/back while the model is still thinking.
    sender.on('did-start-navigation', onNavigation)
    sender.on('render-process-gone', dispose)
    sender.on('destroyed', dispose)
    return channel
  }

  private authorize = authorizeAgentThreadScope

  list(scope: AgentThreadInteractionScope, invocation?: ServiceInvocationContext): AgentThreadInteraction[] {
    const senderId = this.authorize(scope, invocation, 'listAgentInteractions')
    return [...this.pending.values()].filter((pending) => {
      if (pending.owner.senderId !== senderId || scopeKey(pending.owner.scope) !== scopeKey(scope)) return false
      try { pending.owner.assertLive(); return true } catch { pending.owner.channel.dispose(); return false }
    }).map((pending) => structuredClone(pending.view))
  }

  resolve(request: ResolveAgentThreadInteractionReq, invocation?: ServiceInvocationContext): void {
    const senderId = this.authorize(request, invocation, 'resolveAgentInteraction')
    const pending = this.pending.get(request.interactionId)
    if (!pending || pending.owner.senderId !== senderId || scopeKey(pending.owner.scope) !== scopeKey(request))
      throw new Error('Agent interaction is not active for this conversation.')
    try { pending.owner.assertLive() } catch (error) { pending.owner.channel.dispose(); throw error }
    if (Date.now() >= pending.view.expiresAt) {
      pending.settle({ status: 'timeout' })
      throw new Error('Agent interaction expired.')
    }
    const answer = request.answer
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('Invalid Agent interaction answer.')
    if (answer.status === 'dismissed') {
      if (Object.keys(answer).length !== 1) throw new Error('Invalid Agent interaction answer.')
      pending.settle({ status: 'dismissed' })
    } else if (answer.status === 'answered' && pending.view.prompt.kind === 'ask_user' && 'text' in answer &&
      typeof answer.text === 'string' && answer.text.trim() && answer.text.length <= LIMITS.answer && Object.keys(answer).length === 2) {
      pending.settle({ status: 'answered', text: answer.text })
    } else if (answer.status === 'answered' && pending.view.prompt.kind === 'show_card' && 'actionId' in answer &&
      typeof answer.actionId === 'string' && Object.keys(answer).length === 2 && pending.view.prompt.actions.some((a) => a.id === answer.actionId)) {
      pending.settle({ status: 'answered', actionId: answer.actionId })
    } else if (answer.status === 'answered' && pending.view.prompt.kind === 'show_app' && 'values' in answer && Object.keys(answer).length === 2) {
      const values = parseAgentAppValues(pending.view.prompt.document, answer.values)
      pending.settle({ status: 'answered', values })
    } else throw new Error('Invalid Agent interaction answer.')
  }
}

export const agentThreadInteractions = new AgentThreadInteractions()
