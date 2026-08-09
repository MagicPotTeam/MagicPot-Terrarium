import { describe, expect, it, vi } from 'vitest'
import {
  createManagedMediaCleanupScheduler,
  type ManagedMediaCleanupTimer
} from './managedMediaCleanupScheduler'

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

const snapshot = { complete: true as const, chatMediaRoot: '/media', referencedMediaIds: ['a'] }
const cleanupPlan = {
  root: '/media',
  referencedMediaIds: new Set<string>(),
  actions: [],
  skipped: []
}
const result = { dryRun: false, deleted: ['/media/x'], skipped: [] }

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('managed media cleanup scheduler', () => {
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

  it('passes dryRun false and logs counts only', async () => {
    const timers = createTimers()
    const execute = vi.fn(async (_plan, options) => {
      expect(options).toEqual({ dryRun: false })
      return result
    })
    const logger = { cleanupCompleted: vi.fn() }
    const scheduler = createManagedMediaCleanupScheduler({
      ...timers,
      plan: vi.fn(async () => cleanupPlan),
      execute,
      logger
    })
    scheduler.submitSnapshot(snapshot)
    timers.fire()
    await flush()
    expect(logger.cleanupCompleted).toHaveBeenCalledWith({ deletedCount: 1, skippedCount: 0 })
    expect(JSON.stringify(logger.cleanupCompleted.mock.calls)).not.toContain('/media')
    await scheduler.stop()
  })
})
