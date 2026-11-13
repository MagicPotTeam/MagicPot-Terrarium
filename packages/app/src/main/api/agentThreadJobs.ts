import { randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { AGENT_THREAD_JOB_LIMITS as LIMITS, type AgentThreadJob, type AgentThreadJobReadReq, type AgentThreadJobReq } from '@shared/api/agentThreadJob'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { authorizeAgentThreadScope } from './agentThreadScope'

const key = (scope: AgentThreadInteractionScope, senderId: number) => JSON.stringify([senderId, getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
type Entry = {
  scope: AgentThreadInteractionScope
  senderId: number
  cancellationId?: string
  view: AgentThreadJob
  controller: AbortController
  lease: AgentThreadInteractionChannel
  done: Promise<void>
  finish(): void
  detachParent(): void
  expiry: ReturnType<typeof setTimeout>
}

/** Bounded, memory-only jobs; no persistent authority and no automatic model wake-up. */
export class AgentThreadJobs {
  private readonly entries = new Map<string, Entry>()

  start(options: {
    request: LLMChatReq
    invocation: ServiceInvocationContext
    kind: AgentThreadJob['kind']
    task: string
    parentSignal?: AbortSignal
    execute(signal: AbortSignal, assertLive: () => void): Promise<{ content: string }>
  }): { job: AgentThreadJob; release(success: boolean): void } {
    const parentSignal = options.parentSignal
    parentSignal?.throwIfAborted()
    const scope = { route: normalizeAgentRoute(options.request.route!), conversationId: options.request.conversationId! }
    const senderId = authorizeAgentThreadScope(scope, options.invocation, options.invocation.methodName.split('.').at(-1)!)
    const ownKey = key(scope, senderId)
    const same = () => [...this.entries.values()].filter((entry) => key(entry.scope, entry.senderId) === ownKey)
    if ([...this.entries.values()].filter((entry) => entry.view.status === 'running').length >= LIMITS.activeGlobal || same().filter((entry) => entry.view.status === 'running').length >= LIMITS.activePerScope)
      throw new Error('Background sub-agent concurrency limit reached.')
    while (same().length >= LIMITS.retainedPerScope || this.entries.size >= LIMITS.retainedGlobal) {
      const candidates = same().length >= LIMITS.retainedPerScope ? same() : [...this.entries.values()]
      const oldest = candidates.find((entry) => entry.view.status !== 'running')
      if (!oldest) throw new Error('Background sub-agent retention limit reached.')
      this.remove(oldest)
    }
    const lease = agentThreadInteractions.create(options.request, options.invocation)
    if (!lease) throw new Error('Background sub-agent requires a live local Agent document.')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lease.signal])
    const id = randomUUID()
    let done!: () => void
    const entry: Entry = {
      scope: structuredClone(scope), senderId, cancellationId: options.request.cancellationId,
      view: { id, kind: options.kind, task: options.task.slice(0, 200), status: 'running', createdAt: Date.now(), expiresAt: Date.now() + LIMITS.retentionMs },
      controller, lease, done: new Promise<void>((resolve) => { done = resolve }), finish: () => done(),
      detachParent: () => parentSignal?.removeEventListener('abort', parentAbort),
      expiry: setTimeout(() => this.remove(entry), LIMITS.retentionMs)
    }
    const parentAbort = () => this.cancel(entry)
    const revoked = () => {
      this.cancel(entry)
      // Same-URL reload must not disclose old results into the successor document.
      if (lease.signal.aborted) this.remove(entry)
    }
    lease.signal.addEventListener('abort', revoked, { once: true })
    parentSignal?.addEventListener('abort', parentAbort, { once: true })
    this.entries.set(id, entry)
    void (async () => {
      try {
        signal.throwIfAborted(); lease.assertLive()
        const result = await options.execute(signal, () => { signal.throwIfAborted(); lease.assertLive() })
        signal.throwIfAborted(); lease.assertLive()
        if (entry.view.status !== 'running') return
        const parsed = JSON.parse(result.content) as { status?: string; content?: unknown; truncated?: boolean }
        entry.view.status = ['completed', 'incomplete', 'budget_exhausted'].includes(parsed.status || '') ? parsed.status as AgentThreadJob['status'] : 'failed'
        let encoded = JSON.stringify(parsed)
        if (encoded.length > LIMITS.resultCharacters) {
          if (typeof parsed.content === 'string') {
            let content = parsed.content
            while (encoded.length > LIMITS.resultCharacters && content.length) {
              content = content.slice(0, Math.floor(content.length / 2))
              parsed.content = content
              parsed.truncated = true
              encoded = JSON.stringify(parsed)
            }
          }
          entry.view.resultTruncated = true
          if (encoded.length > LIMITS.resultCharacters) {
            entry.view.status = 'incomplete'
            encoded = JSON.stringify({ status: 'incomplete', content: 'Report exceeded the retention limit.', truncated: true, advisoryOnly: true })
          }
        }
        entry.view.result = encoded
      } catch (error) {
        if (entry.view.status === 'running') {
          entry.view.status = signal.aborted ? 'cancelled' : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'failed'
          // Never expose provider bodies, credentials or raw OS errors in a job list.
          entry.view.error = entry.view.status === 'timeout' ? 'Sub-agent time limit exceeded.' : entry.view.status === 'cancelled' ? undefined : 'Background sub-agent failed; no completed report is available.'
        }
      } finally {
        entry.view.finishedAt ??= Date.now()
        entry.finish()
        // The parent abort listener remains until release: a child can complete
        // before the parent later fails or is stopped.
        // Retain the document listener until eviction/expiry to protect old results.
      }
    })()
    if (parentSignal?.aborted) parentAbort()
    return {
      job: this.view(entry),
      release: (success) => { entry.detachParent(); if (!success) this.cancel(entry) }
    }
  }

  private view(entry: Entry, includeResult = false): AgentThreadJob {
    const { result: _result, ...summary } = entry.view
    return structuredClone(includeResult ? entry.view : summary)
  }
  private cancel(entry: Entry): void {
    if (entry.view.status === 'cancelled') return
    entry.view.status = 'cancelled'
    delete entry.view.result
    delete entry.view.error
    delete entry.view.resultTruncated
    entry.view.finishedAt = Date.now()
    entry.detachParent()
    entry.controller.abort(new DOMException('Background sub-agent stopped.', 'AbortError'))
    entry.finish()
  }
  private remove(entry: Entry): void {
    if (!this.entries.delete(entry.view.id)) return
    this.cancel(entry)
    clearTimeout(entry.expiry)
    entry.detachParent()
    entry.lease.dispose()
  }
  private owned(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext | undefined, method: string): Entry[] {
    const senderId = authorizeAgentThreadScope(scope, invocation, method)
    const result: Entry[] = []
    for (const entry of this.entries.values()) {
      if (key(scope, senderId) !== key(entry.scope, entry.senderId)) continue
      if (Date.now() >= entry.view.expiresAt) { this.remove(entry); continue }
      try { entry.lease.assertLive(); result.push(entry) } catch { this.remove(entry) }
    }
    return result
  }
  list(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext | undefined, method = 'listAgentJobs'): AgentThreadJob[] {
    return this.owned(scope, invocation, method).map((entry) => this.view(entry)).reverse()
  }
  private find(req: AgentThreadJobReq, invocation: ServiceInvocationContext | undefined, method: string): Entry {
    const entry = this.owned(req, invocation, method).find((item) => item.view.id === req.jobId)
    if (!entry) throw new Error('Background job is not available in this Agent conversation.')
    return entry
  }
  read(req: AgentThreadJobReadReq, invocation: ServiceInvocationContext | undefined, method = 'readAgentJob') {
    const entry = this.find(req, invocation, method)
    const offset = req.offset ?? 0, limit = req.limit ?? 8000
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > LIMITS.resultCharacters || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new Error('Invalid background result range.')
    const text = entry.view.result || ''
    return { job: this.view(entry), text: text.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, text.length), totalCharacters: text.length, untrustedData: true }
  }
  stop(req: AgentThreadJobReq, invocation: ServiceInvocationContext | undefined, method = 'stopAgentJob') {
    const entry = this.find(req, invocation, method)
    if (entry.view.status === 'running') this.cancel(entry)
    return this.view(entry)
  }
  async wait(req: AgentThreadJobReq, invocation: ServiceInvocationContext, seconds: number, signal?: AbortSignal) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Invalid job wait timeout.')
    const method = invocation.methodName.split('.').at(-1)!
    const entry = this.find(req, invocation, method)
    signal?.throwIfAborted()
    let abort!: () => void, timer!: ReturnType<typeof setTimeout>
    try {
      await Promise.race([entry.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, seconds * 1000) }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason || new Error('Job wait cancelled.'))
        signal?.addEventListener('abort', abort, { once: true })
      })])
      signal?.throwIfAborted()
      return this.read(req, invocation, method)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  cancelConversation(conversationId: string, cancellationId: string | undefined, invocation?: ServiceInvocationContext): boolean {
    let cancelled = false
    if (!invocation) return false
    for (const entry of this.entries.values()) {
      if (entry.scope.conversationId !== conversationId || (cancellationId !== undefined && cancellationId !== entry.cancellationId)) continue
      try {
        if (authorizeAgentThreadScope(entry.scope, invocation, 'cancelConversation') !== entry.senderId) continue
        if (entry.view.status !== 'cancelled') { this.cancel(entry); cancelled = true }
      } catch { /* Other document's jobs are not a cancellation target. */ }
    }
    return cancelled
  }
  dispose(): void { for (const entry of [...this.entries.values()]) this.remove(entry) }
}

export const agentThreadJobs = new AgentThreadJobs()
