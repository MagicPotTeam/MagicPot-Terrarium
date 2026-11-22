import { describe, expect, it, vi } from 'vitest'
import type { MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import { MagicAgentEventStore } from '../persistence/eventStore'
import type { AgentInstanceRunAdapter } from './productionAgentInstanceLifecycle'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd(), getVersion: () => '1' }
}))
import {
  closeProductionAgentInstanceLifecycle,
  getProductionAgentInstanceLifecycle,
  startProductionAgentInstanceLifecycle
} from './productionAgentInstanceLifecycleOwner'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const completed = (): MagicAgentPlatformRunResp => ({
  runId: 'local', agentId: 'agent', status: 'completed', content: 'done',
  messages: [], toolCalls: [], events: [], startedAt: 1, finishedAt: 2
})
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

describe('production lifecycle singleton retains closing owner', () => {
  it('keeps the singleton and exact close join during child drainage and abort re-entry', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const wrapper = deferred<MagicAgentPlatformRunResp>()
    const raw = deferred<void>()
    const authorization = {
      authorize: vi.fn(() => ({ status: 'authorized', permit: {} })),
      consumeExecutionPermit: vi.fn()
    } as unknown as MagicAgentPolicyAuthorizationService
    let runSignal!: AbortSignal
    const runAgent = vi.fn<AgentInstanceRunAdapter>((_req, options) => {
      runSignal = options.signal
      void options.cooperativeExecution.run('tool-invocation', undefined, async () => { await raw.promise }).catch(() => undefined)
      return wrapper.promise
    })
    const options = {
      eventStore, authorization,
      platformService: { runAgent: vi.fn() },
      runAgent, now: () => 5
    }
    const lifecycle = startProductionAgentInstanceLifecycle(options)
    lifecycle.store.create({
      instance: {
        id: 'retained-instance', name: 'worker', definitionId: 'agent', depth: 0,
        configVersion: 'v1', status: 'created',
        limits: { maxChildren: 1, maxDepth: 1, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] }
      },
      createdAt: 1, idempotencyKey: 'create'
    })
    try {
      const input = {
        instanceId: 'retained-instance', expectedRevision: 0,
        actor: { kind: 'user', id: 'owner' } as const,
        request: { text: 'local', route: { channel: 'generic', scopeType: 'dm' as const, scopeId: 'retention' } },
        idempotencyKey: 'start'
      }
      await lifecycle.service.start(input)
      let reentrant: Promise<void> | undefined
      let reentrantOwner: unknown
      runSignal.addEventListener('abort', () => {
        reentrantOwner = startProductionAgentInstanceLifecycle(options)
        reentrant = closeProductionAgentInstanceLifecycle()
      }, { once: true })
      const first = closeProductionAgentInstanceLifecycle()
      expect(runSignal.aborted).toBe(true)
      // Compare booleans so an assertion formatter never traverses the closed
      // native SQLite objects after finally has cleaned up a failing old run.
      expect(reentrantOwner === lifecycle).toBe(true)
      expect(getProductionAgentInstanceLifecycle() === lifecycle).toBe(true)
      expect(startProductionAgentInstanceLifecycle(options) === lifecycle).toBe(true)
      expect(reentrant).toBe(first)
      expect(closeProductionAgentInstanceLifecycle()).toBe(first)
      let finished = false
      void first.then(() => { finished = true })
      wrapper.resolve(completed())
      await flush()
      expect(finished).toBe(false)
      await expect(lifecycle.service.start({ ...input, expectedRevision: 1, idempotencyKey: 'while-closing' })).rejects.toThrow(/clos/i)
      expect(runAgent).toHaveBeenCalledOnce()
      raw.resolve(undefined)
      await first
      expect(getProductionAgentInstanceLifecycle()).toBeUndefined()
      expect(lifecycle.store.get('retained-instance')?.state.status).toBe('stopped')
    } finally {
      wrapper.resolve(completed()); raw.resolve(undefined)
      await closeProductionAgentInstanceLifecycle().catch(() => undefined)
      await lifecycle.close().catch(() => undefined)
      eventStore.close()
    }
  })

  it('retains the failed singleton and exact rejected close without reconstructing or retrying publication', async () => {
    // A failed singleton deliberately stays fail-closed. Give this test its own
    // module registry rather than adding a production reset/recovery escape hatch.
    vi.resetModules()
    const singleton = await import('./productionAgentInstanceLifecycleOwner')
    // The singleton and its concrete persistence fences must share this reset
    // registry. An old EventStore import must not accept a new registry's brand.
    const { MagicAgentEventStore: ResetEventStore } = await import('../persistence/eventStore')
    const eventStore = new ResetEventStore(':memory:')
    const wrapper = deferred<MagicAgentPlatformRunResp>()
    const failure = new Error('singleton terminal publication failed')
    const runAgent = vi.fn<AgentInstanceRunAdapter>(() => wrapper.promise)
    const options = {
      eventStore,
      authorization: {
        authorize: vi.fn(() => ({ status: 'authorized', permit: {} })),
        consumeExecutionPermit: vi.fn()
      } as unknown as MagicAgentPolicyAuthorizationService,
      platformService: { runAgent: vi.fn() }, runAgent, now: () => 10
    }
    const lifecycle = singleton.startProductionAgentInstanceLifecycle(options)
    try {
      lifecycle.store.create({
        instance: {
          id: 'failed-owner', name: 'worker', definitionId: 'agent', depth: 0,
          configVersion: 'v1', status: 'created',
          limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] }
        }, createdAt: 1, idempotencyKey: 'create'
      })
      await lifecycle.service.start({
        instanceId: 'failed-owner', expectedRevision: 0,
        actor: { kind: 'user', id: 'owner' },
        request: { text: 'local', route: { channel: 'generic', scopeType: 'dm', scopeId: 'failed-owner' } },
        idempotencyKey: 'start'
      })
      const stop = vi.spyOn(lifecycle.store, 'stop').mockImplementationOnce(() => { throw failure })
      const closing = singleton.closeProductionAgentInstanceLifecycle()
      const rejected = expect(closing).rejects.toBe(failure)
      wrapper.resolve(completed())
      await rejected
      expect(singleton.getProductionAgentInstanceLifecycle() === lifecycle).toBe(true)
      expect(singleton.startProductionAgentInstanceLifecycle(options) === lifecycle).toBe(true)
      expect(singleton.closeProductionAgentInstanceLifecycle()).toBe(closing)
      await expect(singleton.closeProductionAgentInstanceLifecycle()).rejects.toBe(failure)
      expect(stop).toHaveBeenCalledOnce()
      expect(runAgent).toHaveBeenCalledOnce()
      expect(lifecycle.service.isAtSafePoint('failed-owner')).toBe(false)
    } finally {
      wrapper.resolve(completed())
      await singleton.closeProductionAgentInstanceLifecycle().catch(() => undefined)
      eventStore.close()
      vi.resetModules()
    }
  })
})
