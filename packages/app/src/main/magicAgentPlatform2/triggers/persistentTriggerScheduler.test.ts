import { afterEach, describe, expect, it, vi } from 'vitest'
import { CooperativeExecutionController } from '../agents/cooperativeExecutionController'
import {
  PersistentTriggerScheduler,
  type PersistentTriggerSchedulerOptions
} from './persistentTriggerScheduler'
import type { PersistentTriggerState, PersistentTriggerStore } from './persistentTriggerStore'

const trigger: PersistentTriggerState = {
  id: 'heartbeat',
  type: 'schedule',
  title: 'Heartbeat',
  enabled: true,
  schedule: { type: 'interval', intervalMs: 1_000 },
  nextFireAt: 100,
  claim: {
    claimId: 'claim-1',
    claimedAt: 100,
    expiresAt: 200,
    occurrenceAt: 100,
    windowStart: 100,
    windowEnd: 100,
    missedCount: 0,
    nextFireAtAfter: 1_100
  }
}

const claimed = {
  kind: 'trigger',
  id: trigger.id,
  revision: 1,
  state: trigger,
  createdAt: 1,
  updatedAt: 100
}

function createHarness(overrides: Partial<PersistentTriggerSchedulerOptions> = {}) {
  const claimDue = vi.fn(() => undefined as typeof claimed | undefined)
  const completeClaim = vi.fn()
  const failClaim = vi.fn()
  const execute = vi.fn(async () => undefined)
  const store = { claimDue, completeClaim, failClaim } as unknown as PersistentTriggerStore
  const scheduler = new PersistentTriggerScheduler({
    store,
    execute,
    pollIntervalMs: 25,
    leaseMs: 100,
    retryDelayMs: 500,
    now: () => 100,
    claimId: () => 'claim-1',
    ...overrides
  })
  return { scheduler, claimDue, completeClaim, failClaim, execute }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PersistentTriggerScheduler', () => {
  it('starts idempotently and continues polling', async () => {
    vi.useFakeTimers()
    const { scheduler, claimDue } = createHarness()

    scheduler.start()
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(claimDue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(25)
    expect(claimDue).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    await scheduler.stop()
  })

  it('stops scheduling and waits for in-flight execution', async () => {
    vi.useFakeTimers()
    const execution = deferred()
    const execute = vi.fn(() => execution.promise)
    const { scheduler, claimDue } = createHarness({ execute })
    claimDue.mockReturnValue(claimed)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(execute).toHaveBeenCalledTimes(1)

    let stopped = false
    const stopping = scheduler.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    execution.resolve()
    await stopping
    await vi.advanceTimersByTimeAsync(100)
    expect(stopped).toBe(true)
    expect(claimDue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('completes a successfully executed claim', async () => {
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(120)
    const { scheduler, claimDue, completeClaim, failClaim, execute } = createHarness({ now })
    claimDue.mockReturnValue(claimed)

    await expect(scheduler.runOnce()).resolves.toBe(true)

    expect(claimDue).toHaveBeenCalledWith(100, 'claim-1', 100)
    expect(execute).toHaveBeenCalledWith(trigger)
    expect(completeClaim).toHaveBeenCalledWith('heartbeat', 'claim-1', 120)
    expect(failClaim).not.toHaveBeenCalled()
  })

  it('fails a thrown execution with the configured retry backoff', async () => {
    const error = new Error('temporary failure')
    const execute = vi.fn(async () => {
      throw error
    })
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(130)
    const { scheduler, claimDue, completeClaim, failClaim } = createHarness({
      execute,
      now,
      retryDelayMs: 750
    })
    claimDue.mockReturnValue(claimed)

    await expect(scheduler.runOnce()).resolves.toBe(true)

    expect(completeClaim).not.toHaveBeenCalled()
    expect(failClaim).toHaveBeenCalledWith('heartbeat', 'claim-1', 130, 'temporary failure', 750)
  })

  it('blocks scheduled task dispatch while paused and waits for active dispatch to drain', async () => {
    const cooperativeExecution = new CooperativeExecutionController()
    const execution = deferred()
    const execute = vi.fn(() => execution.promise)
    const { scheduler, claimDue } = createHarness({ execute, cooperativeExecution })
    claimDue.mockReturnValue(claimed)
    const first = scheduler.runOnce()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    let paused = false
    const pause = cooperativeExecution.requestPause().then(() => {
      paused = true
    })
    await Promise.resolve()
    expect(paused).toBe(false)
    execution.resolve()
    await first
    await pause
    claimDue.mockReturnValue(claimed)
    const blocked = scheduler.runOnce()
    await Promise.resolve()
    expect(execute).toHaveBeenCalledTimes(1)
    cooperativeExecution.resume()
    await blocked
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not run concurrent runOnce calls', async () => {
    const execution = deferred()
    const execute = vi.fn(() => execution.promise)
    const { scheduler, claimDue, completeClaim } = createHarness({ execute })
    claimDue.mockReturnValue(claimed)

    const first = scheduler.runOnce()
    await Promise.resolve()
    await expect(scheduler.runOnce()).resolves.toBe(false)
    expect(claimDue).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)

    execution.resolve()
    await expect(first).resolves.toBe(true)
    expect(completeClaim).toHaveBeenCalledTimes(1)
  })
})
