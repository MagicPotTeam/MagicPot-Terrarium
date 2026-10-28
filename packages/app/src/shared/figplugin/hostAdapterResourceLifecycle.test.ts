import { describe, expect, it, vi } from 'vitest'
import {
  createHostAdapterLifecycle,
  hostAdapterLifecycleResultSchema,
  type HostAdapterLifecycleOptions
} from './hostAdapterLifecycle'
import { createHostPlanReadback, type HostContext, type HostPlan } from './hostPlan'

const captureId = 'c'.repeat(32)
const nativeResources = () => ({ documentLease: { nativeDocument: 'opaque-document' } })
const nativeExecution = () => ({ nativeNode: { handle: 'opaque-node' } })
type Resources = ReturnType<typeof nativeResources>
type Execution = ReturnType<typeof nativeExecution>
type Options = HostAdapterLifecycleOptions<Resources, Execution>
type PrepareArgs = Parameters<NonNullable<Options['prepareResources']>>[0]

const context = (): HostContext => ({
  version: 1,
  host: 'figma',
  documentId: 'document',
  scopeId: 'page',
  captureId,
  selectedIds: ['1:2'],
  nodes: [
    {
      id: '1:2',
      type: 'FRAME',
      name: 'Before',
      parentId: 'page',
      ancestors: [{ id: 'page', type: 'PAGE', locked: false }],
      locked: false,
      visible: true,
      commands: ['node.rename']
    }
  ],
  execution: {
    mode: 'native-write',
    adapterVersion: 'resource-fixture',
    supports: ['node.rename'],
    rollback: 'none',
    visualAudit: 'unavailable'
  }
})

const plan = (): HostPlan => ({
  schemaVersion: 2,
  kind: 'host-plan',
  captureId,
  steps: [{ command: 'node.rename', targetId: '1:2', name: 'After' }]
})

const readback: Options['readback'] = ({ context: before, plan: currentPlan }) => {
  const after = structuredClone(before)
  after.nodes[0].name = 'After'
  return createHostPlanReadback(before, after, currentPlan)
}

const options = (overrides: Partial<Options> = {}): Options => ({
  host: 'figma',
  adapterVersion: 'resource-fixture',
  captureContext: () => context(),
  prepareResources: () => nativeResources(),
  execute: () => nativeExecution(),
  readback,
  ...overrides
})

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

// Supplement the public receipt assertions with a deterministic check that
// completed run metadata no longer holds the adapter's working references.
const observeRunState = <T>(runId: string, start: () => Promise<T>) => {
  let state: Record<string, unknown> | undefined
  const originalSet = Map.prototype.set
  const set = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ) {
    if (
      key === runId &&
      typeof value === 'object' &&
      value !== null &&
      'controller' in value &&
      'runId' in value &&
      value.runId === runId
    )
      state = value as Record<string, unknown>
    return originalSet.call(this, key, value)
  })
  let running: Promise<T>
  try {
    running = start()
  } finally {
    set.mockRestore()
  }
  expect(state).toBeDefined()
  return { running, state: state! }
}

const expectWorkingReferencesReleased = (state: Record<string, unknown>) => {
  for (const key of ['plan', 'context', 'resources', 'execution', 'cancelCallbackPromise'])
    expect(state[key], key).toBeUndefined()
}

describe('shared HostAdapter resource lifecycle', () => {
  it('releases in LIFO order after readback without retaining opted-out native handles', async () => {
    const events: string[] = []
    const resources = nativeResources()
    const execution = nativeExecution()
    const releaseFirst = vi.fn(() => {
      events.push('release-first')
    })
    const releaseSecond = vi.fn(async () => {
      events.push('release-second')
    })
    const releaseResources = vi.fn<NonNullable<Options['releaseResources']>>((args) => {
      events.push('release-hook')
      expect(args).toEqual({
        runId: 'successful-release',
        resources,
        execution,
        status: 'completed'
      })
      expect(args.resources).toBe(resources)
      expect(args.execution).toBe(execution)
    })
    const prepareResources = vi.fn<NonNullable<Options['prepareResources']>>(({ deferRelease }) => {
      events.push('prepare')
      deferRelease(releaseFirst)
      deferRelease(releaseSecond)
      return resources
    })
    const execute = vi.fn<Options['execute']>(() => {
      events.push('execute')
      return execution
    })
    const read = vi.fn<Options['readback']>((args) => {
      events.push('readback')
      expect(args.execution).toBe(execution)
      return readback(args)
    })
    const lifecycle = createHostAdapterLifecycle(
      options({
        retainExecution: false,
        prepareResources,
        execute,
        readback: read,
        releaseResources
      })
    )
    const { running, state } = observeRunState('successful-release', () =>
      lifecycle.run({ runId: 'successful-release', plan: plan() })
    )
    const result = await running

    expect(events).toEqual([
      'prepare',
      'execute',
      'readback',
      'release-second',
      'release-first',
      'release-hook'
    ])
    expect(result).toMatchObject({
      status: 'completed',
      resourceCleanup: { status: 'completed', failureCount: 0 }
    })
    expect(result.readback?.steps[0].observation).toBe('requested')
    expect(result.progress.map((entry) => entry.stage)).toEqual([
      'validating',
      'preparing',
      'executing',
      'readback',
      'terminal'
    ])
    expect(result.progress.every((entry) => entry.total === 1)).toBe(true)
    expect(result).not.toHaveProperty('execution')
    expect(lifecycle.getResult('successful-release')).toBe(result)
    expect(lifecycle.getResult('successful-release')).not.toHaveProperty('execution')
    expect(lifecycle.diagnostics().runs[0]).toEqual({
      runId: 'successful-release',
      status: 'completed',
      stage: 'terminal',
      resourceCleanup: { status: 'completed', failureCount: 0 }
    })
    expect(hostAdapterLifecycleResultSchema.parse(result)).toEqual(result)
    expectWorkingReferencesReleased(state)
    expect(JSON.stringify([result, lifecycle.diagnostics()])).not.toContain('opaque-')
    for (const callback of [
      prepareResources,
      execute,
      read,
      releaseFirst,
      releaseSecond,
      releaseResources
    ])
      expect(callback).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, true])(
    'preserves legacy execution retention when retainExecution is %s',
    async (retainExecution) => {
      const execution = nativeExecution()
      const releaseResources = vi.fn()
      const lifecycle = createHostAdapterLifecycle(
        options({ retainExecution, execute: () => execution, releaseResources })
      )
      const { running, state } = observeRunState('legacy-execution', () =>
        lifecycle.run({ runId: 'legacy-execution', plan: plan() })
      )
      const result = await running

      expect(result.status).toBe('completed')
      expect(result.execution).toBe(execution)
      expect(lifecycle.getResult('legacy-execution')?.execution).toBe(execution)
      expectWorkingReferencesReleased(state)
      expect(releaseResources).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['prepare', 'PREPARE_FAILED'],
    ['execute', 'EXECUTE_FAILED'],
    ['readback-throw', 'READBACK_FAILED'],
    ['readback-invalid', 'READBACK_FAILED']
  ] as const)(
    'releases partial resources exactly once after %s failure without changing the write error',
    async (failure, code) => {
      const resources = nativeResources()
      const execution = nativeExecution()
      const secret = 'private-native-error: C:/private/document.psd token=secret'
      const events: string[] = []
      const releasePartial = vi.fn(() => {
        events.push('partial')
        throw new Error(secret)
      })
      const releaseResources = vi.fn<NonNullable<Options['releaseResources']>>(async (args) => {
        events.push('hook')
        expect(args.runId).toBe(`failure-${failure}`)
        expect(args.status).toBe('failed')
        expect(args.resources).toBe(failure === 'prepare' ? undefined : resources)
        expect(args.execution).toBe(failure.startsWith('readback') ? execution : undefined)
        throw new Error(secret)
      })
      const prepareResources = vi.fn<NonNullable<Options['prepareResources']>>(
        ({ deferRelease }) => {
          deferRelease(releasePartial)
          if (failure === 'prepare') throw new Error(secret)
          return resources
        }
      )
      const execute = vi.fn<Options['execute']>(() => {
        if (failure === 'execute') throw new Error(secret)
        return execution
      })
      const read = vi.fn<Options['readback']>(() => {
        if (failure === 'readback-throw') throw new Error(secret)
        return {}
      })
      const lifecycle = createHostAdapterLifecycle(
        options({
          retainExecution: false,
          prepareResources,
          execute,
          readback: read,
          releaseResources
        })
      )
      const runId = `failure-${failure}`
      const { running, state } = observeRunState(runId, () =>
        lifecycle.run({ runId, plan: plan() })
      )
      const result = await running

      expect(result).toMatchObject({
        status: 'failed',
        error: { code, retryable: true },
        resourceCleanup: { status: 'failed', failureCount: 2 }
      })
      expect(result).not.toHaveProperty('execution')
      expect(events).toEqual(['partial', 'hook'])
      expect(lifecycle.getResult(runId)).toBe(result)
      expectWorkingReferencesReleased(state)
      expect(JSON.stringify([result, lifecycle.diagnostics()])).not.toContain(secret)
      expect(prepareResources).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(failure === 'prepare' ? 0 : 1)
      expect(read).toHaveBeenCalledTimes(failure.startsWith('readback') ? 1 : 0)
      expect(releasePartial).toHaveBeenCalledTimes(1)
      expect(releaseResources).toHaveBeenCalledTimes(1)
      expect((await lifecycle.run({ runId, plan: plan() })).error?.code).toBe('CONCURRENT_RUN')
      expect(releaseResources).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['invalid-plan', 'capture-failure', 'already-cancelled'] as const)(
    'does not acquire or release resources for %s before prepare is entered',
    async (failure) => {
      const prepareResources = vi.fn(() => nativeResources())
      const execute = vi.fn(() => nativeExecution())
      const read = vi.fn(readback)
      const releaseResources = vi.fn()
      const cancel = vi.fn()
      const controller = new AbortController()
      if (failure === 'already-cancelled') controller.abort()
      const lifecycle = createHostAdapterLifecycle(
        options({
          retainExecution: false,
          captureContext: () => {
            if (failure === 'capture-failure') throw new Error('private-capture-error')
            return context()
          },
          prepareResources,
          execute,
          readback: read,
          releaseResources,
          cancel
        })
      )
      const { running, state } = observeRunState(failure, () =>
        lifecycle.run({
          runId: failure,
          plan: failure === 'invalid-plan' ? {} : plan(),
          signal: controller.signal
        })
      )
      const result = await running

      expect(result).toMatchObject({
        status: failure === 'already-cancelled' ? 'cancelled' : 'failed',
        error: { code: failure === 'already-cancelled' ? 'CANCELLED' : 'INVALID_PLAN' },
        resourceCleanup: { status: 'not-required', failureCount: 0 }
      })
      expect(prepareResources).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(releaseResources).not.toHaveBeenCalled()
      expectWorkingReferencesReleased(state)
      expect(cancel).toHaveBeenCalledTimes(failure === 'already-cancelled' ? 1 : 0)
    }
  )

  it('reports no cleanup required when neither cleanup mechanism is registered', async () => {
    const lifecycle = createHostAdapterLifecycle(options({ retainExecution: false }))
    const result = await lifecycle.run({ runId: 'no-cleanup-required', plan: plan() })

    expect(result).toMatchObject({
      status: 'completed',
      resourceCleanup: { status: 'not-required', failureCount: 0 }
    })
    expect(result).not.toHaveProperty('execution')
  })

  it.each(['preparing', 'executing', 'readback'] as const)(
    'waits for actual %s work and releases late native values after cancellation',
    async (pendingStage) => {
      const entered = deferred<void>()
      const work = deferred<void>()
      const resources = nativeResources()
      const execution = nativeExecution()
      const releases: string[] = []
      const cancel = vi.fn()
      const prepareResources = vi.fn<NonNullable<Options['prepareResources']>>(
        async ({ deferRelease }) => {
          deferRelease(() => {
            releases.push('initial-resource')
          })
          if (pendingStage === 'preparing') {
            entered.resolve()
            await work.promise
            // Cancellation is advisory: native acquisition may finish late.
            deferRelease(() => {
              releases.push('late-resource')
            })
          }
          return resources
        }
      )
      const execute = vi.fn<Options['execute']>(async () => {
        if (pendingStage === 'executing') {
          entered.resolve()
          await work.promise
        }
        return execution
      })
      const read = vi.fn<Options['readback']>(async (args) => {
        if (pendingStage === 'readback') {
          entered.resolve()
          await work.promise
        }
        return readback(args)
      })
      const releaseResources = vi.fn<NonNullable<Options['releaseResources']>>((args) => {
        releases.push('hook')
        expect(args.status).toBe('cancelled')
        expect(args.resources).toBe(resources)
        expect(args.execution).toBe(pendingStage === 'preparing' ? undefined : execution)
      })
      const lifecycle = createHostAdapterLifecycle(
        options({
          retainExecution: false,
          prepareResources,
          execute,
          readback: read,
          cancel,
          releaseResources
        })
      )
      const runId = `cancel-${pendingStage}`
      let settled = false
      const running = lifecycle.run({ runId, plan: plan() }).then((result) => {
        settled = true
        return result
      })
      await entered.promise
      await expect(lifecycle.cancel(runId)).resolves.toBe(true)
      await expect(lifecycle.cancel(runId)).resolves.toBe(true)

      expect(settled).toBe(false)
      expect(releases).toEqual([])
      expect(releaseResources).not.toHaveBeenCalled()
      expect(lifecycle.getResult(runId)).toBeUndefined()
      expect(lifecycle.diagnostics().runs).toEqual([
        { runId, status: 'active', stage: pendingStage }
      ])
      expect(cancel).toHaveBeenCalledTimes(1)

      work.resolve()
      const result = await running
      expect(result).toMatchObject({
        status: 'cancelled',
        error: { code: 'CANCELLED', retryable: false },
        resourceCleanup: { status: 'completed', failureCount: 0 }
      })
      expect(result).not.toHaveProperty('execution')
      expect(releases).toEqual(
        pendingStage === 'preparing'
          ? ['late-resource', 'initial-resource', 'hook']
          : ['initial-resource', 'hook']
      )
      expect(execute).toHaveBeenCalledTimes(pendingStage === 'preparing' ? 0 : 1)
      expect(read).toHaveBeenCalledTimes(pendingStage === 'readback' ? 1 : 0)
      expect(releaseResources).toHaveBeenCalledTimes(1)
      await expect(lifecycle.cancel(runId)).resolves.toBe(false)
      expect(cancel).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['resolved', 'rejected'] as const)(
    'waits for a pending cancellation callback to be %s before starting resource cleanup',
    async (cancelOutcome) => {
      const executionEntered = deferred<void>()
      const work = deferred<Execution>()
      const cancelEntered = deferred<void>()
      const cancelSettled = deferred<void>()
      const releasePartial = vi.fn()
      const releaseResources = vi.fn()
      const cancel = vi.fn(async () => {
        cancelEntered.resolve()
        await cancelSettled.promise
        if (cancelOutcome === 'rejected') throw new Error('private-cancel-callback-error')
      })
      const read = vi.fn(readback)
      const lifecycle = createHostAdapterLifecycle(
        options({
          retainExecution: false,
          prepareResources: ({ deferRelease }) => {
            deferRelease(releasePartial)
            return nativeResources()
          },
          execute: () => {
            executionEntered.resolve()
            return work.promise
          },
          readback: read,
          cancel,
          releaseResources
        })
      )
      const { running, state } = observeRunState('pending-cancel-callback', () =>
        lifecycle.run({ runId: 'pending-cancel-callback', plan: plan() })
      )
      await executionEntered.promise
      const cancelling = lifecycle.cancel('pending-cancel-callback')
      await cancelEntered.promise
      work.resolve(nativeExecution())
      await vi.waitFor(() =>
        expect(lifecycle.diagnostics().runs).toEqual([
          { runId: 'pending-cancel-callback', status: 'active', stage: 'terminal' }
        ])
      )

      expect(lifecycle.getResult('pending-cancel-callback')).toBeUndefined()
      expect(releasePartial).not.toHaveBeenCalled()
      expect(releaseResources).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      await expect(lifecycle.cancel('pending-cancel-callback')).resolves.toBe(false)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(
        (await lifecycle.run({ runId: 'pending-cancel-callback', plan: plan() })).error?.code
      ).toBe('CONCURRENT_RUN')

      cancelSettled.resolve()
      await expect(cancelling).resolves.toBe(true)
      const result = await running
      expect(result).toMatchObject({
        status: 'cancelled',
        resourceCleanup: { status: 'completed', failureCount: 0 }
      })
      expect(releasePartial).toHaveBeenCalledTimes(1)
      expect(releaseResources).toHaveBeenCalledTimes(1)
      expectWorkingReferencesReleased(state)
      expect(JSON.stringify([result, lifecycle.diagnostics()])).not.toContain(
        'private-cancel-callback-error'
      )
    }
  )

  it('preserves cancellation when deferred cleanup and the release hook both fail', async () => {
    const executeEntered = deferred<void>()
    const work = deferred<Execution>()
    const secret = 'private-cancelled-resource-error'
    const releasePartial = vi.fn(async () => {
      throw new Error(secret)
    })
    const releaseResources = vi.fn(() => {
      throw new Error(secret)
    })
    const execute = vi.fn<Options['execute']>(() => {
      executeEntered.resolve()
      return work.promise
    })
    const read = vi.fn(readback)
    const cancel = vi.fn()
    const lifecycle = createHostAdapterLifecycle(
      options({
        retainExecution: false,
        prepareResources: ({ deferRelease }) => {
          deferRelease(releasePartial)
          return nativeResources()
        },
        execute,
        readback: read,
        cancel,
        releaseResources
      })
    )
    const running = lifecycle.run({ runId: 'cancelled-cleanup-failure', plan: plan() })
    await executeEntered.promise
    await expect(lifecycle.cancel('cancelled-cleanup-failure')).resolves.toBe(true)
    work.resolve(nativeExecution())
    const result = await running

    expect(result).toMatchObject({
      status: 'cancelled',
      error: { code: 'CANCELLED', retryable: false },
      resourceCleanup: { status: 'failed', failureCount: 2 }
    })
    expect(result).not.toHaveProperty('execution')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(releasePartial).toHaveBeenCalledTimes(1)
    expect(releaseResources).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([result, lifecycle.diagnostics()])).not.toContain(secret)
  })

  it('does not publish a terminal receipt or accept cancellation while the release hook is pending', async () => {
    const cleanupEntered = deferred<void>()
    const cleanup = deferred<void>()
    const controller = new AbortController()
    const cancel = vi.fn()
    const releaseResources = vi.fn(async () => {
      cleanupEntered.resolve()
      await cleanup.promise
    })
    const execute = vi.fn(() => nativeExecution())
    const lifecycle = createHostAdapterLifecycle(
      options({ retainExecution: false, execute, cancel, releaseResources })
    )
    let settled = false
    const running = lifecycle
      .run({ runId: 'pending-cleanup', plan: plan(), signal: controller.signal })
      .then((result) => {
        settled = true
        return result
      })
    await cleanupEntered.promise

    expect(settled).toBe(false)
    expect(lifecycle.getResult('pending-cleanup')).toBeUndefined()
    expect(lifecycle.diagnostics()).toMatchObject({
      activeRunIds: ['pending-cleanup'],
      activeCount: 1,
      completedCount: 0,
      cancelledCount: 0,
      failedCount: 0,
      runs: [{ runId: 'pending-cleanup', status: 'active', stage: 'terminal' }]
    })
    controller.abort()
    await expect(lifecycle.cancel('pending-cleanup')).resolves.toBe(false)
    expect(cancel).not.toHaveBeenCalled()
    const duplicate = await lifecycle.run({ runId: 'pending-cleanup', plan: plan() })
    expect(duplicate.error?.code).toBe('CONCURRENT_RUN')
    expect(lifecycle.getResult('pending-cleanup')).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(releaseResources).toHaveBeenCalledTimes(1)

    cleanup.resolve()
    const result = await running
    expect(result).toMatchObject({
      status: 'completed',
      resourceCleanup: { status: 'completed', failureCount: 0 }
    })
    expect(result.readback?.steps[0].observation).toBe('requested')
    expect(lifecycle.getResult('pending-cleanup')).toBe(result)
    expect(lifecycle.diagnostics()).toMatchObject({ activeCount: 0, completedCount: 1 })
    expect(releaseResources).toHaveBeenCalledTimes(1)
  })

  it('awaits deferred cleanup before the hook and explicitly rejects registration after finalization begins', async () => {
    const cleanupEntered = deferred<void>()
    const cleanup = deferred<void>()
    const events: string[] = []
    let deferRelease!: PrepareArgs['deferRelease']
    const lateRelease = vi.fn()
    const releaseResources = vi.fn(() => {
      events.push('hook')
    })
    const lifecycle = createHostAdapterLifecycle(
      options({
        retainExecution: false,
        prepareResources: (args) => {
          deferRelease = args.deferRelease
          deferRelease(() => {
            events.push('first')
          })
          return nativeResources()
        },
        execute: () => {
          deferRelease(async () => {
            events.push('last-start')
            cleanupEntered.resolve()
            await cleanup.promise
            events.push('last-end')
          })
          return nativeExecution()
        },
        releaseResources
      })
    )
    const running = lifecycle.run({ runId: 'closed-resource-scope', plan: plan() })
    await cleanupEntered.promise

    expect(() => deferRelease(lateRelease)).toThrow()
    expect(events).toEqual(['last-start'])
    expect(releaseResources).not.toHaveBeenCalled()
    expect(lifecycle.getResult('closed-resource-scope')).toBeUndefined()
    cleanup.resolve()
    const result = await running

    expect(events).toEqual(['last-start', 'last-end', 'first', 'hook'])
    expect(result.resourceCleanup).toEqual({ status: 'completed', failureCount: 0 })
    expect(() => deferRelease(lateRelease)).toThrow()
    expect(lateRelease).not.toHaveBeenCalled()
    expect(releaseResources).toHaveBeenCalledTimes(1)
  })

  it('attempts all 256 deferred releases and the hook after failures, exposing only bounded counts', async () => {
    const order: Array<number | 'hook'> = []
    const secret = 'sensitive-native-handle C:/private/source.fig bearer-secret'
    const rejectedRelease = vi.fn()
    const prepareResources = vi.fn<NonNullable<Options['prepareResources']>>(({ deferRelease }) => {
      for (let index = 0; index < 256; index += 1) {
        deferRelease(() => {
          order.push(index)
          if (index % 2 === 0) throw new Error(`${secret}:${index}`)
          return Promise.reject({ message: secret, nativeDocument: index })
        })
      }
      expect(() => deferRelease(rejectedRelease)).toThrow()
      return nativeResources()
    })
    const execute = vi.fn(() => nativeExecution())
    const read = vi.fn(readback)
    const releaseResources = vi.fn(async () => {
      order.push('hook')
      throw new Error(secret)
    })
    const lifecycle = createHostAdapterLifecycle(
      options({
        retainExecution: false,
        prepareResources,
        execute,
        readback: read,
        releaseResources
      })
    )
    const result = await lifecycle.run({ runId: 'all-cleanups-fail', plan: plan() })

    expect(order).toEqual([...Array.from({ length: 256 }, (_, index) => 255 - index), 'hook'])
    expect(result).toMatchObject({
      status: 'completed',
      resourceCleanup: { status: 'failed', failureCount: 257 }
    })
    expect(result).not.toHaveProperty('error')
    expect(result).not.toHaveProperty('execution')
    expect(result.readback?.steps[0].observation).toBe('requested')
    expect(lifecycle.getResult('all-cleanups-fail')).toBe(result)
    expect(lifecycle.diagnostics().runs[0]).toEqual({
      runId: 'all-cleanups-fail',
      status: 'completed',
      stage: 'terminal',
      resourceCleanup: { status: 'failed', failureCount: 257 }
    })
    expect(JSON.stringify([result, lifecycle.diagnostics()])).not.toContain(secret)
    expect(prepareResources).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(releaseResources).toHaveBeenCalledTimes(1)
    expect(rejectedRelease).not.toHaveBeenCalled()
    expect((await lifecycle.run({ runId: 'all-cleanups-fail', plan: plan() })).error?.code).toBe(
      'CONCURRENT_RUN'
    )
    expect(order).toHaveLength(257)
    expect(releaseResources).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid deferred cleanup registrations without poisoning a valid resource scope', async () => {
    const release = vi.fn()
    const lifecycle = createHostAdapterLifecycle(
      options({
        retainExecution: false,
        prepareResources: ({ deferRelease }) => {
          const registerUnknown = deferRelease as (callback: unknown) => void
          for (const invalid of [undefined, null, 1, 'release', {}])
            expect(() => registerUnknown(invalid)).toThrow()
          deferRelease(release)
          return nativeResources()
        }
      })
    )
    const result = await lifecycle.run({ runId: 'invalid-release-registration', plan: plan() })

    expect(result).toMatchObject({
      status: 'completed',
      resourceCleanup: { status: 'completed', failureCount: 0 }
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps cleanup metadata optional for old receipts while enforcing strict bounded new metadata', () => {
    const legacyResult = {
      runId: 'legacy-receipt',
      status: 'failed',
      stage: 'terminal',
      progress: [{ stage: 'terminal', completed: 0, total: 0, timestamp: 1 }],
      error: { code: 'EXECUTE_FAILED', retryable: true }
    }
    expect(hostAdapterLifecycleResultSchema.parse(legacyResult)).toEqual(legacyResult)
    for (const resourceCleanup of [
      { status: 'not-required', failureCount: 0 },
      { status: 'completed', failureCount: 0 },
      { status: 'failed', failureCount: 1 },
      { status: 'failed', failureCount: 257 }
    ])
      expect(
        hostAdapterLifecycleResultSchema.safeParse({ ...legacyResult, resourceCleanup }).success
      ).toBe(true)
    for (const resourceCleanup of [
      { status: 'failed', failureCount: -1 },
      { status: 'failed', failureCount: 258 },
      { status: 'failed', failureCount: 0.5 },
      { status: 'failed', failureCount: Infinity },
      { status: 'failed', failureCount: 0 },
      { status: 'completed', failureCount: 1 },
      { status: 'not-required', failureCount: 1 },
      { status: 'failed', failureCount: 1, error: 'private-native-error' },
      { status: 'unknown', failureCount: 0 }
    ])
      expect(
        hostAdapterLifecycleResultSchema.safeParse({ ...legacyResult, resourceCleanup }).success
      ).toBe(false)
  })
})
