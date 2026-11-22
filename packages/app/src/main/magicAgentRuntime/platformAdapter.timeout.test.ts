import { describe, expect, it, vi } from 'vitest'
import type { MagicAgentPlatformRunReq } from '@shared/api/svcMagicAgentPlatform'
import type { AssistantInboundMessage, AssistantRuntimeResult } from '../assistantRuntime/types'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp/magicpot-test-user-data'), getVersion: vi.fn(() => '1.0.0') } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true }, platform: { isWindows: false, isMacOS: false, isLinux: true } }))

import { AgentKernel } from '../agentKernel'
import { MagicAgentPlatformAdapter } from './platformAdapter'
import { MagicAgentCreativeToolRegistry } from './tools'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { PersistentAgentInstanceStore } from '../magicAgentPlatform2/agents/persistentAgentInstanceStore'
import { ProductionAgentInstanceLifecycleService } from '../magicAgentPlatform2/agents/productionAgentInstanceLifecycle'
import type { MagicAgentPolicyAuthorizationService } from '../magicAgentPlatform2/policy'

const actor = { kind: 'user', id: 'timeout-owner' } as const
const route = { channel: 'generic', scopeType: 'dm', scopeId: 'platform-returned-promise' } as const
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve() }
const completed = (): AssistantRuntimeResult => ({
  runId: 'local-assistant-run', sessionKey: 'generic:dm:platform-returned-promise', historySize: 1,
  status: 'completed', reply: { content: 'late raw result' }, events: []
})
const request = (): MagicAgentPlatformRunReq => ({ agentId: 'local-agent', text: 'local', route, timeoutMs: 20 })

// Real platform/kernel/controller/lifecycle/store with one explicitly local
// handleMessage promise. No SDK/provider/external effects or restart guarantee.
function fixture() {
  const started = deferred<void>(), raw = deferred<AssistantRuntimeResult>()
  const runtime = {
    listTools: vi.fn(() => []),
    callTool: vi.fn(async () => ({ content: 'unused local tool' })),
    handleMessage: vi.fn((_request: AssistantInboundMessage) => { started.resolve(undefined); return raw.promise })
  }
  const kernel = new AgentKernel()
  const adapter = new MagicAgentPlatformAdapter({
    assistantRuntime: runtime, agentKernel: kernel, chatService: { chat: vi.fn(async () => ({ content: 'unused' })) },
    creativeToolRegistry: new MagicAgentCreativeToolRegistry({ adapters: [] })
  })
  const events = new MagicAgentEventStore(':memory:'), store = new PersistentAgentInstanceStore(events)
  store.create({ instance: {
    id: 'instance', name: 'instance', definitionId: 'local-agent', configVersion: 'v1', depth: 0, status: 'created',
    limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] }
  }, createdAt: 1, idempotencyKey: 'create' })
  const authorization = { authorize: vi.fn(() => ({ status: 'authorized', permit: {} })), consumeExecutionPermit: vi.fn() }
  let execution!: CooperativeExecutionController, now = 10
  let invocation: ReturnType<MagicAgentPlatformAdapter['runAgent']> | undefined
  const dispatch = vi.fn((req: MagicAgentPlatformRunReq, options: { signal: AbortSignal; cooperativeExecution: CooperativeExecutionController }) => {
    execution = options.cooperativeExecution
    invocation = adapter.runAgent(req, options)
    void invocation.catch(() => undefined)
    return invocation
  })
  const lifecycle = new ProductionAgentInstanceLifecycleService(store, authorization as unknown as MagicAgentPolicyAuthorizationService, dispatch, () => now++)
  const start = () => lifecycle.start({ actor, instanceId: 'instance', expectedRevision: store.get('instance')!.revision, request: request(), idempotencyKey: `start:${now}` })
  return {
    started, raw, runtime, kernel, adapter, events, store, lifecycle, dispatch, start,
    get execution() { return execution }, get invocation() { return invocation! },
    async cleanup() {
      raw.resolve(completed())
      await invocation?.catch(() => undefined)
      await flush()
      await lifecycle.close().catch(() => undefined)
      adapter.dispose(); events.close()
    }
  }
}

describe('MagicAgentPlatformAdapter actual returned-runtime promise ownership after timeout', () => {
  it.each(['fulfilled', 'rejected'] as const)('returns timeout promptly but retains the entire %s handleMessage promise', async outcome => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController()
    try {
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: execution })
      await s.started.promise
      expect(execution.isQuiescent()).toBe(false)
      const captured = s.runtime.handleMessage.mock.calls[0][0]
      expect(captured.cooperativeExecution).not.toBe(execution)
      await vi.advanceTimersByTimeAsync(20)
      const result = await caller
      expect(result.status).toBe('timeout')
      expect(captured.signal?.aborted).toBe(true)
      expect(execution.isQuiescent()).toBe(false)
      const liveAbortedDescendant = vi.fn()
      await expect(captured.cooperativeExecution!.run('tool-invocation', undefined, liveAbortedDescendant)).rejects.toBe(captured.signal!.reason)
      expect(liveAbortedDescendant).not.toHaveBeenCalled()
      expect(execution.isQuiescent()).toBe(false)
      let drained = false
      const drain = execution.whenQuiescent().then(() => { drained = true })
      await flush(); expect(drained).toBe(false)
      if (outcome === 'fulfilled') s.raw.resolve(completed())
      else s.raw.reject(new Error('explicit late runtime rejection'))
      await drain; await flush()
      expect(execution.isQuiescent()).toBe(true)
      expect(result.status).toBe('timeout')
      expect(s.kernel.listRuns()).toHaveLength(1)
      expect(s.kernel.listRuns()[0].status).toBe('failed')
      expect(s.kernel.listEvents().filter(event => event.runId === s.kernel.listRuns()[0].runId && event.type === 'run.failed')).toHaveLength(1)
      expect(s.runtime.handleMessage).toHaveBeenCalledOnce()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it.each(['stop', 'close'] as const)('keeps lifecycle capacity and %s pending after timeout until the runtime promise fulfills', async action => {
    vi.useFakeTimers()
    const s = fixture()
    try {
      await s.start(); await s.started.promise
      await vi.advanceTimersByTimeAsync(20)
      await expect(s.invocation).resolves.toMatchObject({ status: 'timeout' })
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('running')
      expect(s.lifecycle.isAtSafePoint('instance')).toBe(false)
      await expect(s.start()).rejects.toThrow(/already active/i)
      expect(() => s.lifecycle.recoverInterrupted()).toThrow(/owns|closes/i)
      const pause = vi.spyOn(s.execution, 'requestPause'), resume = vi.spyOn(s.execution, 'resume')
      let settled = false
      const closing = (action === 'close' ? s.lifecycle.close() : s.lifecycle.stop({ actor, instanceId: 'instance', expectedRevision: s.store.get('instance')!.revision, idempotencyKey: 'stop' }))
        .then(() => { settled = true })
      await flush(); expect(settled).toBe(false)
      expect(pause).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
      s.raw.resolve(completed())
      await closing
      expect(s.store.get('instance')?.state.status).toBe('stopped')
      expect(s.dispatch).toHaveBeenCalledOnce()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it.each(['fulfilled', 'rejected'] as const)('does not acknowledge a pause for a timed-out but still %s-pending runtime', async outcome => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController()
    try {
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: execution })
      await s.started.promise; await vi.advanceTimersByTimeAsync(20)
      await expect(caller).resolves.toMatchObject({ status: 'timeout' })
      let paused = false
      const pause = execution.requestPause().then(ticket => { paused = true; return ticket })
      await flush(); expect(paused).toBe(false)
      if (outcome === 'fulfilled') s.raw.resolve(completed())
      else s.raw.reject(new Error('late failure while pause waits'))
      expect(execution.isPauseCurrent(await pause)).toBe(true)
      expect(execution.isPaused()).toBe(true)
      expect(s.runtime.handleMessage).toHaveBeenCalledOnce()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it.each(['stop', 'close'] as const)('keeps %s pending through late runtime rejection without replacing the platform timeout', async action => {
    vi.useFakeTimers()
    const s = fixture()
    try {
      await s.start(); await s.started.promise; await vi.advanceTimersByTimeAsync(20)
      const result = await s.invocation
      expect(result.status).toBe('timeout')
      let settled = false
      const closing = (action === 'close' ? s.lifecycle.close() : s.lifecycle.stop({ actor, instanceId: 'instance', expectedRevision: s.store.get('instance')!.revision, idempotencyKey: 'stop-late-rejection' }))
        .then(() => { settled = true })
      await flush(); expect(settled).toBe(false)
      s.raw.reject(new Error('explicit late finalization rejection'))
      await closing
      expect(s.store.get('instance')?.state.status).toBe('stopped')
      expect(result.status).toBe('timeout')
      expect(s.dispatch).toHaveBeenCalledOnce()
      expect(s.kernel.listEvents().filter(event => event.type === 'run.failed')).toHaveLength(1)
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it.each(['fulfilled', 'rejected'] as const)('retains a %s scripted final-publication tail after its inner runtime operation has drained', async outcome => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController(), innerFinished = deferred<void>()
    s.runtime.handleMessage.mockImplementation(async req => {
      s.started.resolve(undefined)
      await req.cooperativeExecution!.run('assistant-turn', undefined, async () => { await Promise.resolve() })
      innerFinished.resolve(undefined)
      return s.raw.promise
    })
    try {
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: execution })
      await innerFinished.promise
      expect(execution.isQuiescent()).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      const result = await caller
      expect(result.status).toBe('timeout')
      expect(execution.isQuiescent()).toBe(false)
      let drained = false
      const drain = execution.whenQuiescent().then(() => { drained = true })
      await flush(); expect(drained).toBe(false)
      if (outcome === 'fulfilled') s.raw.resolve(completed())
      else s.raw.reject(new Error('scripted final persistence failed'))
      await drain
      expect(result.status).toBe('timeout')
      expect(s.kernel.listEvents().filter(event => event.type === 'run.failed')).toHaveLength(1)
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it('gives the admitted runtime an exact live child that can drain during pause and becomes stale after settlement', async () => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController()
    try {
      const caller = s.adapter.runAgent({ ...request(), timeoutMs: undefined }, { cooperativeExecution: execution })
      await s.started.promise
      const child = s.runtime.handleMessage.mock.calls[0][0].cooperativeExecution!
      expect(child).not.toBe(execution)
      let paused = false
      const pause = execution.requestPause().then(ticket => { paused = true; return ticket })
      await flush(); expect(paused).toBe(false)
      const descendant = vi.fn(async () => { await Promise.resolve() })
      await child.run('tool-invocation', undefined, descendant)
      expect(descendant).toHaveBeenCalledOnce()
      expect(paused).toBe(false)
      s.raw.resolve(completed())
      await caller
      expect(execution.isPauseCurrent(await pause)).toBe(true)
      const stale = vi.fn()
      await expect(child.run('tool-invocation', undefined, stale)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(stale).not.toHaveBeenCalled()
      expect(s.runtime.handleMessage.mock.calls[0][0].signal?.aborted).toBe(true)
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it('times out a paused admission without ever invoking runtime preparation or leaving a registration', async () => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController()
    try {
      const ticket = await execution.requestPause()
      const caller = s.adapter.runAgent(request(), { cooperativeExecution: execution })
      await flush()
      expect(s.runtime.handleMessage).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20)
      await expect(caller).resolves.toMatchObject({ status: 'timeout' })
      expect(s.runtime.handleMessage).not.toHaveBeenCalled()
      expect(execution.isPauseCurrent(ticket)).toBe(true)
      expect(execution.isQuiescent()).toBe(true)
      execution.resume(); await flush()
      expect(s.runtime.handleMessage).not.toHaveBeenCalled()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it('resumes a paused admission into one runtime invocation with a child, not root fallback', async () => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController()
    try {
      await execution.requestPause()
      const caller = s.adapter.runAgent({ ...request(), timeoutMs: undefined }, { cooperativeExecution: execution })
      await flush()
      expect(s.runtime.handleMessage).not.toHaveBeenCalled()
      execution.resume()
      await s.started.promise
      expect(s.runtime.handleMessage.mock.calls[0][0].cooperativeExecution).not.toBe(execution)
      s.raw.resolve(completed())
      await expect(caller).resolves.toMatchObject({ status: 'completed' })
      expect(execution.isQuiescent()).toBe(true)
      expect(s.runtime.handleMessage).toHaveBeenCalledOnce()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it.each([false, true])('preserves %s-gated pre-abort behavior and releases any rejected admission', async gated => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController(), abort = new AbortController()
    const reason = new Error('explicit pre-aborted runtime input')
    abort.abort(reason)
    try {
      const caller = s.adapter.runAgent({ ...request(), timeoutMs: undefined }, { signal: abort.signal, ...(gated ? { cooperativeExecution: execution } : {}) })
      if (gated) {
        const rejected = expect(caller).rejects.toBe(reason)
        await flush()
        s.raw.resolve({ ...completed(), status: 'cancelled' })
        await rejected
        expect(s.runtime.handleMessage).not.toHaveBeenCalled()
      } else {
        await s.started.promise
        expect(s.runtime.handleMessage.mock.calls[0][0].signal?.reason).toBe(reason)
        s.raw.resolve({ ...completed(), status: 'cancelled' })
        await expect(caller).resolves.toMatchObject({ status: 'aborted' })
      }
      expect(execution.isQuiescent()).toBe(true)
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it('releases the holder for a synchronous runtime throw and preserves its original error', async () => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController(), error = new Error('synchronous runtime fault')
    s.runtime.handleMessage.mockImplementationOnce(() => { throw error })
    try {
      await expect(s.adapter.runAgent(request(), { cooperativeExecution: execution })).rejects.toBe(error)
      expect(execution.isQuiescent()).toBe(true)
      expect(s.kernel.listEvents().filter(event => event.type === 'run.failed')).toHaveLength(1)
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it.each(['before', 'after'] as const)('retains the lifecycle owner on a %s-commit terminal fault only after raw runtime drainage', async side => {
    vi.useFakeTimers()
    const s = fixture()
    try {
      await s.start(); await s.started.promise; await vi.advanceTimersByTimeAsync(20)
      await expect(s.invocation).resolves.toMatchObject({ status: 'timeout' })
      const stop = s.store.stop.bind(s.store), fault = new Error(`terminal-${side}-commit`)
      const write = vi.spyOn(s.store, 'stop').mockImplementationOnce(input => { if (side === 'after') stop(input); throw fault })
      expect(write).not.toHaveBeenCalled()
      let settled = false
      const closing = s.lifecycle.close()
      const observed = closing.then(() => { settled = true }, error => { settled = true; return error })
      await flush(); expect(settled).toBe(false)
      s.raw.resolve(completed())
      expect(await observed).toBe(fault)
      expect(s.lifecycle.close()).toBe(closing)
      expect(write).toHaveBeenCalledOnce()
      expect(s.lifecycle.isAtSafePoint('instance')).toBe(false)
      expect(s.store.get('instance')?.state.status).toBe(side === 'after' ? 'stopped' : 'running')
      expect(s.dispatch).toHaveBeenCalledOnce()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it('preserves prompt no-gate timeout without waiting for its ignoring runtime fixture', async () => {
    vi.useFakeTimers()
    const s = fixture()
    try {
      const caller = s.adapter.runAgent(request())
      await s.started.promise; await vi.advanceTimersByTimeAsync(20)
      await expect(caller).resolves.toMatchObject({ status: 'timeout' })
      expect(s.runtime.handleMessage.mock.calls[0][0].cooperativeExecution).toBeUndefined()
      s.raw.reject(new Error('late no-gate rejection is observed'))
      await flush()
    } finally { await s.cleanup(); vi.useRealTimers() }
  })

  it('releases normal non-timeout completion and does not add a caller drainage wait', async () => {
    vi.useFakeTimers()
    const s = fixture(), execution = new CooperativeExecutionController()
    try {
      const caller = s.adapter.runAgent({ ...request(), timeoutMs: undefined }, { cooperativeExecution: execution })
      await s.started.promise
      expect(execution.isQuiescent()).toBe(false)
      s.raw.resolve(completed())
      await expect(caller).resolves.toMatchObject({ status: 'completed', content: 'late raw result' })
      expect(execution.isQuiescent()).toBe(true)
    } finally { await s.cleanup(); vi.useRealTimers() }
  })
})
