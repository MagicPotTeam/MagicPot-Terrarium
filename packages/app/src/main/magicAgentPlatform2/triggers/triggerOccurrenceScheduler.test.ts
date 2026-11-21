import { describe, expect, it, vi } from 'vitest'
import type { PersistentTriggerState } from './persistentTriggerStore'
import type { TriggerOccurrenceState } from './triggerOccurrenceStore'
import { TriggerOccurrenceScheduler } from './triggerOccurrenceScheduler'

const occurrence = {
  occurrenceId: 'o',
  triggerId: 't',
  source: 'manual' as const,
  scheduledAt: 0,
  requestedAt: 0,
  status: 'pending' as const,
  attempt: 0,
  idempotencyKey: 'i',
  semanticDigest: 'd',
  createdAt: 0,
  updatedAt: 0,
  schemaVersion: 1 as const
}
const stores = (claimed = occurrence) => ({
  claimNext: vi.fn(() => ({
    id: claimed.occurrenceId,
    revision: 0,
    state: {
      ...claimed,
      status: 'claimed' as const,
      claim: { owner: 'c', claimedAt: 0, expiresAt: 100 }
    }
  })),
  complete: vi.fn(),
  fail: vi.fn(),
  archiveTerminal: vi.fn(() => 0)
})
const triggers = (state: unknown = { enabled: true }) => ({
  get: vi.fn(() => ({ id: 't', revision: 0, state }))
})

describe('TriggerOccurrenceScheduler', () => {
  it.each([
    ['pollIntervalMs', { pollIntervalMs: 0 }],
    ['leaseMs', { leaseMs: 0 }],
    ['retryDelayMs', { retryDelayMs: 0 }]
  ])('rejects invalid %s', (_name, option) =>
    expect(
      () =>
        new TriggerOccurrenceScheduler({
          occurrences: stores() as never,
          triggers: triggers() as never,
          execute: vi.fn(),
          ...option
        })
    ).toThrow()
  )
  it('starts/stops idempotently and waits for a single flight', async () => {
    const gate = Promise.withResolvers<void>()
    const store = stores()
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store as never,
      triggers: triggers() as never,
      execute: async () => gate.promise,
      pollIntervalMs: 60_000,
      claimId: () => 'claim-1'
    })
    scheduler.start()
    scheduler.start()
    const running = scheduler.runOnce()
    expect(await scheduler.runOnce()).toBe(false)
    const stopped = scheduler.stop()
    gate.resolve()
    await stopped
    await running
  })
  it('skips disabled occurrences without claiming', async () => {
    const store = stores()
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store as never,
      triggers: triggers({ enabled: false }) as never,
      execute: vi.fn()
    })
    await scheduler.runOnce()
    expect(store.claimNext).toHaveBeenCalledOnce()
  })
  it('fails a race-missing trigger after claim', async () => {
    const store = stores()
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store as never,
      triggers: { get: vi.fn(() => undefined) } as never,
      execute: vi.fn(),
      claimId: () => 'claim-race'
    })
    await expect(scheduler.runOnce()).resolves.toBe(true)
    expect(store.fail).toHaveBeenCalledWith(
      'o',
      'claim-race',
      expect.any(Number),
      expect.any(Error),
      expect.any(Number)
    )
  })
  it('uses unique claim ids for successful occurrences', async () => {
    const store = stores()
    const execute = vi.fn(
      async (_trigger: PersistentTriggerState, _occurrence: TriggerOccurrenceState) => undefined
    )
    let n = 0
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store as never,
      triggers: triggers() as never,
      execute,
      claimId: () => `claim-${++n}`
    })
    await scheduler.runOnce()
    await scheduler.runOnce()
    const calls = store.claimNext.mock.calls as unknown as Array<
      [number, string, number, number, unknown]
    >
    expect(calls[0]?.[1]).not.toBe(calls[1]?.[1])
  })
})

describe('TriggerOccurrenceScheduler settlement failures', () => {
  // Fake only the poll timer: a real setImmediate lets Node report unhandled rejections.
  const withPollTimer = async (run: (unhandled: unknown[]) => Promise<void>) => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await run(unhandled)
    } finally {
      vi.useRealTimers()
      await new Promise((resolve) => setImmediate(resolve))
      process.off('unhandledRejection', record)
    }
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  it('calls fail once when complete throws after a successful execute', async () => {
    const store = stores()
    const completion = new Error('complete failed')
    store.complete.mockImplementation(() => {
      throw completion
    })
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store as never,
      triggers: triggers() as never,
      execute: vi.fn(async () => undefined),
      claimId: () => 'claim-1'
    })
    await expect(scheduler.runOnce()).resolves.toBe(true)
    expect(store.fail).toHaveBeenCalledOnce()
    expect(store.fail).toHaveBeenCalledWith('o', 'claim-1', expect.any(Number), completion, 5_000)
  })

  it('still rejects a direct runOnce when fail throws as well', async () => {
    const store = stores()
    store.complete.mockImplementation(() => {
      throw new Error('complete failed')
    })
    store.fail.mockImplementation(() => {
      throw new Error('fail failed')
    })
    const scheduler = new TriggerOccurrenceScheduler({
      occurrences: store as never,
      triggers: triggers() as never,
      execute: vi.fn(async () => undefined)
    })
    await expect(scheduler.runOnce()).rejects.toThrow('fail failed')
  })

  it('keeps polling on the timer without an unhandled rejection when settlement throws', async () => {
    await withPollTimer(async (unhandled) => {
      const store = stores()
      store.complete.mockImplementation(() => {
        throw new Error('complete failed')
      })
      store.fail.mockImplementation(() => {
        throw new Error('fail failed')
      })
      const scheduler = new TriggerOccurrenceScheduler({
        occurrences: store as never,
        triggers: triggers() as never,
        execute: vi.fn(async () => undefined),
        pollIntervalMs: 1_000
      })
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)
      await settle()
      expect(store.claimNext).toHaveBeenCalledTimes(1)
      expect(store.fail).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      await settle()
      expect(store.claimNext).toHaveBeenCalledTimes(2)
      await scheduler.stop()
      expect(unhandled).toEqual([])
    })
  })

  it('polls at the interval, without stalling or busy looping, when every claim throws', async () => {
    await withPollTimer(async (unhandled) => {
      const store = stores()
      store.claimNext.mockImplementation(() => {
        throw new Error('sweep write failed')
      })
      const scheduler = new TriggerOccurrenceScheduler({
        occurrences: store as never,
        triggers: triggers() as never,
        execute: vi.fn(async () => undefined),
        pollIntervalMs: 1_000
      })
      scheduler.start()
      await vi.advanceTimersByTimeAsync(0)
      await settle()
      expect(store.claimNext).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(store.claimNext).toHaveBeenCalledTimes(1)
      for (let poll = 2; poll <= 4; poll += 1) {
        await vi.advanceTimersByTimeAsync(poll === 2 ? 1 : 1_000)
        await settle()
        expect(store.claimNext).toHaveBeenCalledTimes(poll)
      }
      await scheduler.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(store.claimNext).toHaveBeenCalledTimes(4)
      expect(unhandled).toEqual([])
    })
  })

  it('logs only the error name of failing polls, rate-limited, and once on recovery', async () => {
    await withPollTimer(async (unhandled) => {
      const minute = 60_000
      let clock = 0
      let failure: Error | undefined
      const failWith = (name: string) => {
        failure = new Error('/home/user/private/events.db: synthetic record content')
        failure.name = name
      }
      const store = stores()
      store.claimNext.mockImplementation(() => {
        if (failure) throw failure
        return undefined as never
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const scheduler = new TriggerOccurrenceScheduler({
        occurrences: store as never,
        triggers: triggers() as never,
        execute: vi.fn(async () => undefined),
        pollIntervalMs: minute,
        now: () => clock
      })
      // Polls at 0, 1, 2, ... minutes; each step sets what the next poll sees.
      const steps: Array<() => void> = [
        () => failWith('SqliteError'),
        ...Array.from({ length: 10 }, () => () => undefined),
        () => undefined,
        () => failWith('TypeError'),
        () => undefined,
        () => failWith('ENOENT /home/user/private'),
        () => {
          failure = undefined
        },
        () => undefined,
        () => failWith('Error')
      ]
      try {
        scheduler.start()
        for (const [index, step] of steps.entries()) {
          step()
          clock = index * minute
          await vi.advanceTimersByTimeAsync(index === 0 ? 0 : minute)
          await settle()
        }
        expect(store.claimNext).toHaveBeenCalledTimes(steps.length)
        expect(warn.mock.calls).toEqual([
          ['[triggers] Occurrence poll failed: SqliteError'],
          ['[triggers] Occurrence poll still failing: SqliteError'],
          ['[triggers] Occurrence poll failed: TypeError'],
          ['[triggers] Occurrence poll failed: Error'],
          ['[triggers] Occurrence polls recovered.'],
          ['[triggers] Occurrence poll failed: Error']
        ])
        expect(unhandled).toEqual([])
      } finally {
        await scheduler.stop()
        warn.mockRestore()
      }
    })
  })
})
