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
  fail: vi.fn()
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
