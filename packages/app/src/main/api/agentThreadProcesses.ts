import { randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { AGENT_PROCESS_JOB_LIMITS as LIMITS, type AgentProcessJob, type AgentProcessJobReq, type AgentProcessReadReq, type AgentProcessReadResult, type AgentProcessKind } from '@shared/api/agentThreadProcessJob'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { authorizeAgentThreadScope } from './agentThreadScope'
import type { ThreadProcessControl } from './agentThreadProcessHost'

const ownerKey = (scope: AgentThreadInteractionScope, sender: number) => JSON.stringify([sender, getAgentSessionKey(scope.route), scope.conversationId])
type Entry = {
  scope: AgentThreadInteractionScope; sender: number; cancellationId?: string; id: string; kind: AgentProcessKind
  createdAt: number; expiresAt: number; finishedAt?: number; control?: ThreadProcessControl
  controller: AbortController; lease: AgentThreadInteractionChannel; revoked: boolean; settled: boolean; failed: boolean; started: boolean
  done: Promise<void>; detachParent(): void; expiry: ReturnType<typeof setTimeout>
}
/** Main-owned leases/handles, not a process registry reconstructed from workspace JSON. */
export class AgentThreadProcesses {
  private readonly entries = new Map<string, Entry>()
  async start(options: {
    request: LLMChatReq; invocation: ServiceInvocationContext; kind: AgentProcessKind; parentSignal?: AbortSignal
    execute(signal: AbortSignal, assertLive: () => void, onStarted: (control: ThreadProcessControl) => void, onOwned: (control: ThreadProcessControl) => void): Promise<unknown>
    registerRelease(release: (success: boolean) => void): void
  }): Promise<AgentProcessJob> {
    options.parentSignal?.throwIfAborted()
    const scope = { route: normalizeAgentRoute(options.request.route!), conversationId: options.request.conversationId! }
    const sender = authorizeAgentThreadScope(scope, options.invocation, options.invocation.methodName.split('.').at(-1)!)
    const key = ownerKey(scope, sender), owned = () => [...this.entries.values()].filter((entry) => ownerKey(entry.scope, entry.sender) === key)
    const active = (entry: Entry) => !entry.settled || ['unknown', 'running', 'preparing', 'stopping'].includes(this.view(entry).status)
    if ([...this.entries.values()].filter(active).length >= LIMITS.activeGlobal || owned().filter(active).length >= LIMITS.activePerScope) throw new Error('Background process concurrency limit reached.')
    while (this.entries.size >= LIMITS.retainedGlobal || owned().length >= LIMITS.retainedPerScope) {
      const list = owned().length >= LIMITS.retainedPerScope ? owned() : [...this.entries.values()]
      const oldest = list.find((entry) => !active(entry))
      if (!oldest) throw new Error('Background process retention capacity reached.')
      this.remove(oldest)
    }
    const lease = agentThreadInteractions.create(options.request, options.invocation)
    if (!lease) throw new Error('Background process requires a live local Agent document.')
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lease.signal])
    let finish!: () => void, started!: (job: AgentProcessJob) => void, notStarted!: (error: Error) => void
    const startedPromise = new Promise<AgentProcessJob>((resolve, reject) => { started = resolve; notStarted = reject })
    const parentAbort = () => controller.abort(new Error('Parent process request cancelled.'))
    const entry: Entry = {
      scope: structuredClone(scope), sender, cancellationId: options.request.cancellationId, id: randomUUID(), kind: options.kind,
      createdAt: Date.now(), expiresAt: Date.now() + LIMITS.retentionMs, controller, lease, revoked: false, settled: false, failed: false, started: false,
      done: new Promise<void>((resolve) => { finish = resolve }), detachParent: () => options.parentSignal?.removeEventListener('abort', parentAbort),
      expiry: setTimeout(() => { entry.revoked = true; controller.abort(new Error('Background process retention expired.')); if (entry.settled && this.view(entry).status !== 'unknown') this.remove(entry) }, LIMITS.retentionMs)
    }
    this.entries.set(entry.id, entry)
    const abort = () => {
      notStarted(new Error('Background process start was cancelled; check its owned status before retrying.'))
      // Signal cancellation triggers the host's owned stop path, even before a handle exists.
      if (entry.control) void entry.control.stop().catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    lease.signal.addEventListener('abort', () => { entry.revoked = true; if (entry.settled && this.view(entry).status !== 'unknown') this.remove(entry) }, { once: true })
    options.parentSignal?.addEventListener('abort', parentAbort, { once: true })
    options.registerRelease((success) => { entry.detachParent(); if (!success) controller.abort(new Error('Parent process request did not complete successfully.')) })
    if (options.parentSignal?.aborted) parentAbort()
    void (async () => {
      try {
        const check = () => { signal.throwIfAborted(); lease.assertLive() }
        check()
        await options.execute(signal, check, (control) => {
          if (entry.settled || entry.revoked || entry.started || entry.control && entry.control.jobId !== control.jobId) { void control.stop().catch(() => undefined); throw new Error('Background process callback is stale or already owned.') }
          entry.control = control
          check(); entry.started = true
          started(this.view(entry))
        }, (control) => {
          if (entry.settled || entry.control) { void control.stop().catch(() => undefined); throw new Error('Background process already owns a process or has settled.') }
          entry.control = control // Preserve handle even when cancellation/setup prevents successful start.
        })
        if (!entry.started) throw new Error('Process execution ended without an OS start event.')
      } catch {
        entry.failed = true
        notStarted(new Error('Background process did not start successfully; approval, configuration or execution failed.'))
      } finally {
        entry.settled = true; entry.finishedAt = Date.now(); signal.removeEventListener('abort', abort); finish()
        // Keep parent abort until normal release, but no process handle survives navigation.
        if (entry.revoked && this.view(entry).status !== 'unknown') this.remove(entry)
      }
    })()
    return startedPromise
  }
  private view(entry: Entry): AgentProcessJob {
    let record: ReturnType<ThreadProcessControl['status']> | undefined
    try { record = entry.control?.status() } catch { /* Unknown ownership is not success. */ }
    const live = !entry.settled
    let status: AgentProcessJob['status'] = !entry.control ? entry.settled ? 'failed' : 'preparing' : !record ? 'unknown'
      : record.state === 'stopped-interrupted' || record.outcome === 'unknown' && !['starting', 'running'].includes(record.state) ? 'unknown'
      : record.state === 'starting' ? 'preparing' : record.state
    if (live && !entry.started) status = 'preparing'
    if (live && (entry.controller.signal.aborted || entry.lease.signal.aborted)) status = 'stopping'
    if (entry.settled && record && ['starting', 'running'].includes(record.state)) status = 'unknown'
    if (entry.settled && entry.failed && status === 'completed') status = 'failed'
    return { id: entry.id, kind: entry.kind, status, createdAt: entry.createdAt, expiresAt: entry.expiresAt,
      ...(record?.startedAt ? { startedAt: record.startedAt } : {}), ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
      outcome: record?.outcome ?? (entry.settled && !entry.control ? 'known' : 'unknown'), ...(record?.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      stdoutBytes: record?.stdoutBytes ?? 0, stderrBytes: record?.stderrBytes ?? 0, truncated: record?.logsTruncated ?? false,
      ...(record?.termination ? { termination: { ...record.termination } } : {}),
      operationSettled: entry.settled, cancellationRequested: entry.controller.signal.aborted || entry.lease.signal.aborted }
  }
  private remove(entry: Entry) {
    if (!this.entries.delete(entry.id)) return
    clearTimeout(entry.expiry); entry.detachParent(); entry.lease.dispose()
  }
  private owned(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext | undefined, method: string): Entry[] {
    const sender = authorizeAgentThreadScope(scope, invocation, method)
    return [...this.entries.values()].filter((entry) => {
      if (ownerKey(scope, sender) !== ownerKey(entry.scope, entry.sender) || entry.revoked || Date.now() >= entry.expiresAt) return false
      try { entry.lease.assertLive(); return true } catch { entry.revoked = true; entry.controller.abort(); return false }
    })
  }
  list(scope: AgentThreadInteractionScope, invocation?: ServiceInvocationContext, method = 'listAgentProcesses'): AgentProcessJob[] { return this.owned(scope, invocation, method).map((entry) => this.view(entry)).reverse() }
  private find(req: AgentProcessJobReq, invocation: ServiceInvocationContext | undefined, method: string): Entry {
    const entry = this.owned(req, invocation, method).find((entry) => entry.id === req.jobId)
    if (!entry) throw new Error('Background process is not available in this document/thread/conversation.')
    return entry
  }
  read(req: AgentProcessReadReq, invocation?: ServiceInvocationContext, method = 'readAgentProcess'): AgentProcessReadResult {
    const entry = this.find(req, invocation, method), cursor = req.cursor ?? 0, maxBytes = req.maxBytes ?? LIMITS.readBytes
    if (!['stdout', 'stderr'].includes(req.stream) || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 262144 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.readBytes) throw new Error('Invalid process log range.')
    if (!entry.control) return { job: this.view(entry), data: '', nextCursor: 0, eof: entry.settled, truncated: false, untrustedData: true }
    try {
      const read = entry.control.read(req.stream, cursor, maxBytes)
      return { job: this.view(entry), ...read, untrustedData: true }
    } catch { throw new Error('Process log is unavailable, changed, or exceeds its bound.') }
  }
  async stop(req: AgentProcessJobReq, invocation?: ServiceInvocationContext, method = 'stopAgentProcess'): Promise<AgentProcessJob> {
    const entry = this.find(req, invocation, method)
    if (!entry.settled) {
      entry.controller.abort(new Error('Owned background process stopped.'))
      try { await entry.control?.stop() } catch { /* Report unknown, never stopped-success. */ }
      await entry.done
    }
    this.find(req, invocation, method)
    return this.view(entry)
  }
  async wait(req: AgentProcessJobReq, invocation: ServiceInvocationContext, seconds: number, signal?: AbortSignal): Promise<AgentProcessJob> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Invalid process wait duration.')
    const method = invocation.methodName.split('.').at(-1)!, entry = this.find(req, invocation, method)
    signal?.throwIfAborted()
    let timer!: ReturnType<typeof setTimeout>, abort!: () => void
    try {
      await Promise.race([entry.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, seconds * 1000) }), new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason ?? new Error('Process wait cancelled.')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
      })])
      signal?.throwIfAborted(); this.find(req, invocation, method)
      return this.view(entry)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  cancelConversation(conversationId: string, cancellationId: string | undefined, invocation?: ServiceInvocationContext): boolean {
    let cancelled = false
    for (const entry of this.entries.values()) {
      if (entry.settled || entry.scope.conversationId !== conversationId || cancellationId !== undefined && entry.cancellationId !== cancellationId) continue
      try { if (authorizeAgentThreadScope(entry.scope, invocation, 'cancelConversation') === entry.sender) { entry.controller.abort(); cancelled = true } } catch { /* Foreign owner. */ }
    }
    return cancelled
  }
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    for (const entry of entries) { entry.revoked = true; entry.controller.abort() }
    await Promise.all(entries.map((entry) => entry.done))
    for (const entry of entries) {
      if (this.view(entry).status === 'unknown') {
        clearTimeout(entry.expiry); entry.detachParent(); entry.lease.dispose()
        // Keep a bounded ownership tombstone: disposal is not confirmed termination.
      } else this.remove(entry)
    }
  }
}
export const agentThreadProcesses = new AgentThreadProcesses()
