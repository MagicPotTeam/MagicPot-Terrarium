import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStoredImageMigrationProgress,
  startStoredImageMigration,
  type StoredImageMigrationOutcome,
  type StoredImageMigrationTiming
} from './chatStoredImageMigration'

// FIX-PLAN item 4, part 2: one conversation at a time, in idle time, paused while a reply runs or
// the user types, and a conversation that fails is not tried again until the next start.

const timing: StoredImageMigrationTiming = {
  startDelayMs: 1_000,
  idleTimeoutMs: 500,
  pauseRetryMs: 300,
  busyRetryMs: 2_000,
  maxAttemptsPerSession: 3
}

/** requestIdleCallback stand-in: the callback runs when the test says the renderer is idle. */
const createIdle = () => {
  const waiting: Array<() => void> = []
  return {
    requestIdle: (callback: () => void) => {
      waiting.push(callback)
      return () => {
        const index = waiting.indexOf(callback)
        if (index >= 0) waiting.splice(index, 1)
      }
    },
    get waiting() {
      return waiting.length
    },
    runIdle: async () => {
      const callbacks = waiting.splice(0)
      for (const callback of callbacks) callback()
      await vi.advanceTimersByTimeAsync(0)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startStoredImageMigration', () => {
  it('waits for the pane to settle and an idle period, then migrates one conversation at a time', async () => {
    const idle = createIdle()
    const pending = new Set(['a', 'b'])
    const releases: Array<() => void> = []
    const migrate = vi.fn(
      (id: string) =>
        new Promise<StoredImageMigrationOutcome>((resolve) => {
          releases.push(() => {
            pending.delete(id)
            resolve('migrated')
          })
        })
    )
    const scheduler = startStoredImageMigration({
      pendingSessionIds: () => [...pending],
      isPaused: () => false,
      migrate,
      timing,
      requestIdle: idle.requestIdle
    })

    await vi.advanceTimersByTimeAsync(timing.startDelayMs - 1)
    expect(idle.waiting).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(migrate).not.toHaveBeenCalled()
    await idle.runIdle()
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(migrate).toHaveBeenLastCalledWith('a')
    // The second conversation does not start while the first is running.
    await vi.advanceTimersByTimeAsync(10_000)
    await idle.runIdle()
    expect(migrate).toHaveBeenCalledTimes(1)

    releases[0]()
    await vi.advanceTimersByTimeAsync(0)
    await idle.runIdle()
    expect(migrate).toHaveBeenCalledTimes(2)
    expect(migrate).toHaveBeenLastCalledWith('b')
    releases[1]()
    await vi.advanceTimersByTimeAsync(0)
    // Nothing is left: no timer or idle callback keeps running.
    await idle.runIdle()
    expect(vi.getTimerCount()).toBe(0)
    expect(idle.waiting).toBe(0)
    scheduler.stop()
  })

  it('does not start while a reply runs or the user types', async () => {
    const idle = createIdle()
    let paused = true
    const migrate = vi.fn(async (): Promise<StoredImageMigrationOutcome> => 'migrated')
    const pending = ['a']
    const scheduler = startStoredImageMigration({
      pendingSessionIds: () => (migrate.mock.calls.length ? [] : pending),
      isPaused: () => paused,
      migrate,
      timing,
      requestIdle: idle.requestIdle
    })
    await vi.advanceTimersByTimeAsync(timing.startDelayMs)
    for (let round = 0; round < 5; round += 1) {
      await idle.runIdle()
      await vi.advanceTimersByTimeAsync(timing.pauseRetryMs)
    }
    expect(migrate).not.toHaveBeenCalled()
    paused = false
    await idle.runIdle()
    await vi.advanceTimersByTimeAsync(timing.pauseRetryMs)
    await idle.runIdle()
    expect(migrate).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('does not try a failed conversation again in this start, and retries a busy one a few times', async () => {
    const idle = createIdle()
    const progress = createStoredImageMigrationProgress()
    const outcomes: Record<string, StoredImageMigrationOutcome> = {
      failing: 'failed',
      busy: 'busy'
    }
    const migrate = vi.fn(async (id: string) => {
      if (id === 'throws') throw new Error('unexpected')
      return outcomes[id]
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const scheduler = startStoredImageMigration({
      pendingSessionIds: () => ['failing', 'busy', 'throws'],
      isPaused: () => false,
      migrate,
      progress,
      timing,
      requestIdle: idle.requestIdle
    })
    try {
      for (let round = 0; round < 20; round += 1) {
        await vi.advanceTimersByTimeAsync(timing.busyRetryMs)
        await idle.runIdle()
      }
    } finally {
      warn.mockRestore()
    }
    const calls = (id: string) => migrate.mock.calls.filter(([called]) => called === id).length
    expect(calls('failing')).toBe(1)
    expect(calls('throws')).toBe(1)
    expect(calls('busy')).toBe(timing.maxAttemptsPerSession)
    expect([...progress.settled].sort()).toEqual(['busy', 'failing', 'throws'])
    expect(vi.getTimerCount()).toBe(0)
    scheduler.stop()

    // A new start for the same pane (shown again) keeps that: still no loop.
    const again = startStoredImageMigration({
      pendingSessionIds: () => ['failing', 'busy', 'throws'],
      isPaused: () => false,
      migrate,
      progress,
      timing,
      requestIdle: idle.requestIdle
    })
    await vi.advanceTimersByTimeAsync(timing.startDelayMs)
    await idle.runIdle()
    expect(migrate).toHaveBeenCalledTimes(2 + timing.maxAttemptsPerSession)
    again.stop()
  })

  it('stops for good', async () => {
    const idle = createIdle()
    const migrate = vi.fn(async (): Promise<StoredImageMigrationOutcome> => 'migrated')
    const scheduler = startStoredImageMigration({
      pendingSessionIds: () => ['a'],
      isPaused: () => false,
      migrate,
      timing,
      requestIdle: idle.requestIdle
    })
    await vi.advanceTimersByTimeAsync(timing.startDelayMs)
    scheduler.stop()
    await idle.runIdle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(migrate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
