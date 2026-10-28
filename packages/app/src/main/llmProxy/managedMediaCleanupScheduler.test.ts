import { describe, expect, it, vi } from 'vitest'
import {
  createManagedMediaCleanupScheduler,
  type ManagedMediaCleanupTimer
} from './managedMediaCleanupScheduler'
import {
  DEFAULT_MANAGED_MEDIA_RETENTION,
  type ManagedMediaCleanupPlan,
  type ManagedMediaCleanupResult
} from './managedMediaCleanup'

function createTimers() {
  let nextId = 0
  const timers = new Map<number, () => void>()
  return {
    setTimeout(callback: () => void, _delay: number) {
      const id = ++nextId
      timers.set(id, callback)
      return id as unknown as ManagedMediaCleanupTimer
    },
    clearTimeout(timer: ManagedMediaCleanupTimer) {
      timers.delete(timer as unknown as number)
    },
    fire() {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((callback) => callback())
    },
    size: () => timers.size
  }
}

const snapshot = {
  complete: true as const,
  chatMediaRoot: '/media',
  referencedMediaIds: ['a'],
  referenceCounts: { a: 2 }
}
const cleanupPlan: ManagedMediaCleanupPlan = {
  root: '/media',
  referencedMediaIds: new Set<string>(),
  referenceCounts: {},
  actions: [],
  skipped: [],
  retention: DEFAULT_MANAGED_MEDIA_RETENTION,
  audit: {
    stagingFileCount: 0,
    stagingBytes: 0,
    staleStagingFileCount: 0,
    staleStagingBytes: 0,
    quotaBytes: DEFAULT_MANAGED_MEDIA_RETENTION.maxStagingBytes,
    quotaExceeded: false,
    durableOrphanRecordCount: 0,
    retainedDurableOrphanRecordCount: 0,
    orphanTtlMs: DEFAULT_MANAGED_MEDIA_RETENTION.orphanTtlMs
  }
}
const result: ManagedMediaCleanupResult = {
  dryRun: false,
  deleted: ['/media/x'],
  skipped: [],
  audit: { ...cleanupPlan.audit, deletedCount: 1, skippedCount: 0 }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('managed media cleanup scheduler', () => {
  it('restores a persisted snapshot without authorizing cleanup until a fresh scan', async () => {
    const timers = createTimers()
    const plan = vi.fn(async () => cleanupPlan)
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan,
      execute: vi.fn(async () => result),
      loadPersistedSnapshot: vi.fn(async () => snapshot)
    })

    await expect(scheduler.restorePersistedSnapshot()).resolves.toBe(true)
    timers.fire()
    await flush()
    expect(plan).not.toHaveBeenCalled()

    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(plan).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it('passes and persists occurrence counts with the authoritative snapshot', async () => {
    const timers = createTimers()
    const plan = vi.fn(async (input) => {
      expect(input.referenceCounts).toEqual({ a: 2 })
      return cleanupPlan
    })
    const persistSnapshot = vi.fn(async (value) => {
      expect(value.referenceCounts).toEqual({ a: 2 })
    })
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan,
      persistSnapshot,
      execute: vi.fn(async () => result)
    })
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(plan).toHaveBeenCalledTimes(1)
    expect(persistSnapshot).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it('rejects occurrence counts for IDs missing from the authoritative snapshot', () => {
    const scheduler = createManagedMediaCleanupScheduler()
    expect(() =>
      scheduler.submitSnapshot({
        ...snapshot,
        referencedMediaIds: ['a'],
        referenceCounts: { a: 2, stale: 1 }
      })
    ).toThrow('unknown media ID')
  })

  it('does not let a delayed restore overwrite a renderer snapshot', async () => {
    const timers = createTimers()
    let resolveLoad!: (value: typeof snapshot) => void
    const loading = new Promise<typeof snapshot>((resolve) => {
      resolveLoad = resolve
    })
    const plan = vi.fn(async (input) => {
      expect([...input.referencedMediaIds]).toEqual(['fresh'])
      return cleanupPlan
    })
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan,
      execute: vi.fn(async () => result),
      loadPersistedSnapshot: () => loading
    })

    const restoring = scheduler.restorePersistedSnapshot()
    scheduler.submitSnapshot({
      ...snapshot,
      referencedMediaIds: ['fresh'],
      referenceCounts: { fresh: 2 }
    })
    resolveLoad(snapshot)
    await expect(restoring).resolves.toBe(false)
    timers.fire()
    await flush()
    expect(plan).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it('serializes snapshot persistence and waits for it during stop', async () => {
    const timers = createTimers()
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })
    const calls: string[][] = []
    const persistSnapshot = vi.fn(async (value) => {
      calls.push([...value.referencedMediaIds])
      await (calls.length === 1 ? first : second)
    })
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      persistSnapshot
    })

    scheduler.submitSnapshot(snapshot)
    scheduler.submitSnapshot({ ...snapshot, referencedMediaIds: ['b'], referenceCounts: { b: 2 } })
    const stopping = scheduler.stop()
    await flush()
    expect(calls).toEqual([['a']])
    resolveFirst()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls).toEqual([['a'], ['b']])
    resolveSecond()
    await stopping
    expect(persistSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not schedule without a complete authoritative snapshot', async () => {
    const timers = createTimers()
    const plan = vi.fn(async () => cleanupPlan)
    const scheduler = createManagedMediaCleanupScheduler({ ...timers, plan })
    scheduler.submitSnapshot({ ...snapshot, complete: false } as never)
    timers.fire()
    await flush()
    expect(plan).not.toHaveBeenCalled()
    await scheduler.stop()
  })

  it('debounces valid snapshots', async () => {
    const timers = createTimers()
    const plan = vi.fn(async () => cleanupPlan)
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan,
      execute: vi.fn(async () => result)
    })
    scheduler.submitSnapshot(snapshot)
    scheduler.submitSnapshot(snapshot)
    expect(plan).not.toHaveBeenCalled()
    timers.fire()
    await flush()
    expect(plan).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it('is single-flight and coalesces updates', async () => {
    const timers = createTimers()
    let resolveExecute!: () => void
    const execute = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          resolveExecute = () => resolve(result)
        })
    )
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan: vi.fn(async () => cleanupPlan),
      execute
    })
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    expect(execute).toHaveBeenCalledTimes(1)
    resolveExecute()
    await flush()
    expect(timers.size()).toBe(1)
    await scheduler.stop()
  })

  it('abandons a plan when a newer renderer snapshot arrives before execution', async () => {
    const timers = createTimers()
    let firstPlan = true
    let resolvePlan!: (value: ManagedMediaCleanupPlan) => void
    const plan = vi.fn(() => {
      if (!firstPlan) return Promise.resolve(cleanupPlan)
      firstPlan = false
      return new Promise<ManagedMediaCleanupPlan>((resolve) => {
        resolvePlan = resolve
      })
    })
    const execute = vi.fn(async () => result)
    const scheduler = createManagedMediaCleanupScheduler({ ...timers, plan, execute })

    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    scheduler.submitSnapshot({
      ...snapshot,
      referencedMediaIds: ['fresh'],
      referenceCounts: { fresh: 2 }
    })
    resolvePlan(cleanupPlan)
    await flush()
    expect(execute).not.toHaveBeenCalled()

    timers.fire()
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it('reruns promptly after execution is invalidated instead of consuming the daily budget', async () => {
    const timers = createTimers()
    const holder: { scheduler?: ReturnType<typeof createManagedMediaCleanupScheduler> } = {}
    let invalidate = true
    const execute = vi.fn(async (_plan, options) => {
      if (invalidate) {
        invalidate = false
        holder.scheduler!.submitSnapshot({
          ...snapshot,
          referencedMediaIds: ['fresh'],
          referenceCounts: { fresh: 2 }
        })
        expect(options.shouldContinue?.()).toBe(false)
      }
      return result
    })
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan: vi.fn(async () => cleanupPlan),
      execute,
      dailyMs: 60_000
    })
    holder.scheduler = scheduler

    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(timers.size()).toBe(1)

    timers.fire()
    await flush()
    expect(execute).toHaveBeenCalledTimes(2)
    await scheduler.stop()
  })

  it('limits successful execution to once per day', async () => {
    const timers = createTimers()
    let time = 100
    const execute = vi.fn(async () => result)
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      now: () => time,
      plan: vi.fn(async () => cleanupPlan),
      execute,
      dailyMs: 1_000
    })
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    time += 1_000
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(execute).toHaveBeenCalledTimes(2)
    await scheduler.stop()
  })

  it('stop clears debounce and waits for in-flight work', async () => {
    const timers = createTimers()
    let resolveExecute!: () => void
    const execute = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          resolveExecute = () => resolve(result)
        })
    )
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan: vi.fn(async () => cleanupPlan),
      execute
    })
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    resolveExecute()
    await stopping
    expect(stopped).toBe(true)
    expect(timers.size()).toBe(0)
  })

  it('incomplete snapshots invalidate a pending complete timer', async () => {
    vi.useFakeTimers()
    try {
      const plan = vi.fn(async () => cleanupPlan)
      const scheduler = createManagedMediaCleanupScheduler({ plan })
      scheduler.submitSnapshot(snapshot)
      scheduler.submitSnapshot({ ...snapshot, complete: false })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(plan).not.toHaveBeenCalled()
      await scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes dryRun false and logs non-sensitive audit counts', async () => {
    const timers = createTimers()
    const execute = vi.fn(async (_plan, options) => {
      expect(options).toMatchObject({ dryRun: false, shouldContinue: expect.any(Function) })
      return result
    })
    const logger = { cleanupCompleted: vi.fn() }
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan: vi.fn(async () => ({
        ...cleanupPlan,
        skipped: [{ relativePath: 'user-output', reason: 'protected namespace' }]
      })),
      execute,
      logger
    })
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(logger.cleanupCompleted).toHaveBeenCalledWith({
      deletedCount: 1,
      skippedCount: 1,
      audit: { ...result.audit, skippedCount: 1 }
    })
    expect(JSON.stringify(logger.cleanupCompleted.mock.calls)).not.toContain('/media')
    await scheduler.stop()
  })
})
