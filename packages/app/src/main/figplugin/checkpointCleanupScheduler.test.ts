import { describe, expect, it } from 'vitest'
import {
  createCheckpointCleanupScheduler,
  FIGPLUGIN_CHECKPOINT_CLEANUP_INTERVAL_MS
} from './checkpointCleanupScheduler'

describe('createCheckpointCleanupScheduler', () => {
  const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  it('runs a startup pass, reports bounded stats, and schedules the next pass', async () => {
    const callbacks: Array<() => void> = []
    const delays: number[] = []
    const summaries: unknown[] = []
    let cleanupCalls = 0
    const scheduler = createCheckpointCleanupScheduler({
      createStore: () => ({
        cleanupExpired: () => {
          cleanupCalls += 1
          return { expiredRecordCount: 2, retainedRecordCount: 1, databasePresent: true }
        }
      }),
      setTimeout: (callback, delay) => {
        callbacks.push(callback)
        delays.push(delay)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => undefined,
      cleanupCompleted: (summary) => summaries.push(summary)
    })

    scheduler.start()
    await flush()

    expect(cleanupCalls).toBe(1)
    expect(summaries).toEqual([
      { expiredRecordCount: 2, retainedRecordCount: 1, databasePresent: true }
    ])
    expect(delays).toEqual([FIGPLUGIN_CHECKPOINT_CLEANUP_INTERVAL_MS])

    callbacks.shift()?.()
    await flush()
    expect(cleanupCalls).toBe(2)
    await scheduler.stop()
  })

  it('keeps failures fail-closed and retries on the next interval', async () => {
    const callbacks: Array<() => void> = []
    let failures = 0
    const scheduler = createCheckpointCleanupScheduler({
      createStore: () => {
        throw new Error('unavailable')
      },
      setTimeout: (callback) => {
        callbacks.push(callback)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => undefined,
      cleanupFailed: () => {
        failures += 1
      }
    })

    scheduler.start()
    await flush()
    expect(failures).toBe(1)
    expect(callbacks).toHaveLength(1)

    callbacks.shift()?.()
    await flush()
    expect(failures).toBe(2)
    await scheduler.stop()
  })

  it('does not schedule a new pass after stop', async () => {
    const callbacks: Array<() => void> = []
    let cleared = 0
    const scheduler = createCheckpointCleanupScheduler({
      createStore: () => ({
        cleanupExpired: () => ({
          expiredRecordCount: 0,
          retainedRecordCount: 0,
          databasePresent: false
        })
      }),
      setTimeout: (callback) => {
        callbacks.push(callback)
        return callbacks.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {
        cleared += 1
      }
    })

    scheduler.start()
    await flush()
    expect(callbacks).toHaveLength(1)
    await scheduler.stop()
    expect(cleared).toBe(1)
    callbacks.shift()?.()
    await flush()
    expect(callbacks).toHaveLength(0)
  })
})
