import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CooperativeExecutionController,
  type CooperativeOperationGate
} from '../agents/cooperativeExecutionController'
import {
  PersistentTriggerScheduler,
  type PersistentTriggerSchedulerOptions
} from './persistentTriggerScheduler'
import type { PersistentTriggerState, PersistentTriggerStore } from './persistentTriggerStore'

const claimed = {
  kind: 'trigger',
  id: 'scoped-schedule',
  revision: 1,
  createdAt: 1,
  updatedAt: 100,
  state: {
    id: 'scoped-schedule',
    type: 'schedule',
    title: 'Scoped schedule',
    enabled: true,
    schedule: { type: 'interval', intervalMs: 1000 },
    nextFireAt: 100,
    claim: {
      claimId: 'exact-claim',
      claimedAt: 100,
      expiresAt: 1000,
      occurrenceAt: 100,
      windowStart: 100,
      windowEnd: 100,
      missedCount: 0,
      nextFireAtAfter: 1100
    }
  } as PersistentTriggerState
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function microtasks() {
  for (let i = 0; i < 48; i++) await Promise.resolve()
}
function harness(options: Partial<PersistentTriggerSchedulerOptions> = {}) {
  const claimDue = vi.fn(() => claimed as typeof claimed | undefined),
    completeClaim = vi.fn(),
    failClaim = vi.fn(),
    execute = vi.fn(async () => undefined),
    claimId = vi.fn(() => 'exact-claim'),
    now = vi.fn(() => 100)
  const store = { claimDue, completeClaim, failClaim } as unknown as PersistentTriggerStore
  const scheduler = new PersistentTriggerScheduler({
    store,
    execute,
    claimId,
    now,
    pollIntervalMs: 25,
    ...options
  })
  return { scheduler, claimDue, completeClaim, failClaim, execute, claimId, now }
}
function callbackOnly(controller: CooperativeExecutionController): CooperativeOperationGate {
  return { run: (kind, signal, operation) => controller.run(kind, signal, operation) }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scheduler atomic admission before durable claim (not underlying effect recovery)', () => {
  it('cancels an attempt even when stop overtakes its deferred gate invocation', async () => {
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const h = harness({ cooperativeExecution: execution }),
      running = h.scheduler.runOnce()
    let stopped = false
    const stopping = h.scheduler.stop().then(() => {
      stopped = true
    })
    try {
      await microtasks()
      expect(stopped).toBe(true)
      expect(await running).toBe(false)
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(execution.isPaused()).toBe(true)
      await stopping
    } finally {
      execution.resume()
      await running
      await stopping
    }
  })

  it('does not mask a released child gate with stop cancellation before deferred admission', async () => {
    const execution = new CooperativeExecutionController()
    let stale!: CooperativeOperationGate
    await execution.run('assistant-turn', undefined, (child) => {
      stale = child
    })
    const h = harness({ cooperativeExecution: stale }),
      running = h.scheduler.runOnce(),
      observed = running.catch((error) => error)
    const stopping = h.scheduler.stop().catch((error) => error)
    try {
      const error = await observed
      expect(error).toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(h.scheduler.getFault()).toMatchObject({ cause: error })
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.failClaim).not.toHaveBeenCalled()
      await stopping
    } finally {
      await observed
      await stopping
    }
  })

  it('does not allocate a claim identity, timestamp or durable claim while paused', async () => {
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const h = harness({ cooperativeExecution: execution }),
      running = h.scheduler.runOnce()
    try {
      await microtasks()
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.claimId).not.toHaveBeenCalled()
      expect(h.now).not.toHaveBeenCalled()
      expect(h.execute).not.toHaveBeenCalled()
      execution.resume()
      expect(await running).toBe(true)
      expect(h.claimDue).toHaveBeenCalledOnce()
      expect(h.completeClaim).toHaveBeenCalledOnce()
    } finally {
      execution.resume()
      await running
      await h.scheduler.stop()
    }
  })

  it('stops paused admission without resume, claim mutation, execution or failure accounting', async () => {
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const h = harness({ cooperativeExecution: execution }),
      running = h.scheduler.runOnce()
    let stopped = false
    await microtasks()
    const stopping = h.scheduler.stop().then(() => {
      stopped = true
    })
    try {
      await microtasks()
      expect(stopped).toBe(true)
      expect(execution.isPaused()).toBe(true)
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.failClaim).not.toHaveBeenCalled()
      expect(h.execute).not.toHaveBeenCalled()
      expect(await running).toBe(false)
      await stopping
    } finally {
      execution.resume()
      await running
      await stopping
    }
  })

  it('restart uses a fresh admission signal and cannot revive the cancelled old attempt', async () => {
    vi.useFakeTimers()
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const signals: (AbortSignal | undefined)[] = []
    const gate: CooperativeOperationGate = {
      run: (kind, signal, operation) => {
        signals.push(signal)
        return execution.run(kind, signal, operation)
      }
    }
    const h = harness({ cooperativeExecution: gate }),
      old = h.scheduler.runOnce(),
      oldObserved = old.catch((error) => error)
    await microtasks()
    let stopped = false
    const stopping = h.scheduler.stop().then(() => {
      stopped = true
    })
    try {
      await microtasks()
      expect(stopped).toBe(true)
      await stopping
      expect(await oldObserved).toBe(false)
      expect(signals[0]?.aborted).toBe(true)
      h.scheduler.start()
      const next = h.scheduler.runOnce()
      await microtasks()
      expect(signals).toHaveLength(2)
      expect(signals[1]).not.toBe(signals[0])
      expect(signals[1]?.aborted).toBe(false)
      expect(h.claimDue).not.toHaveBeenCalled()
      execution.resume()
      expect(await next).toBe(true)
      expect(h.execute).toHaveBeenCalledOnce()
      expect(h.claimDue).toHaveBeenCalledOnce()
    } finally {
      execution.resume()
      await oldObserved
      await stopping
      await h.scheduler.stop()
    }
  })

  it('same-tick resume and stop still cancel before claim admission', async () => {
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const h = harness({ cooperativeExecution: execution }),
      running = h.scheduler.runOnce()
    await microtasks()
    execution.resume()
    const stopping = h.scheduler.stop()
    try {
      await microtasks()
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.execute).not.toHaveBeenCalled()
      expect(await running).toBe(false)
      await stopping
    } finally {
      execution.resume()
      await running
      await stopping
    }
  })

  it.each(['claimId', 'claimDue', 'execute'] as const)(
    'publishes single-flight before reentrant %s',
    async (hook) => {
      const nested: Promise<boolean>[] = [],
        finish = deferred(),
        started = deferred()
      let reentered = false
      const reenter = () => {
        if (!reentered) {
          reentered = true
          nested.push(h.scheduler.runOnce())
        }
      }
      const h = harness({
        execute: async () => {
          if (hook === 'execute') reenter()
          started.resolve()
          await finish.promise
        }
      })
      if (hook === 'claimId')
        h.claimId.mockImplementation(() => {
          reenter()
          return 'exact-claim'
        })
      if (hook === 'claimDue')
        h.claimDue.mockImplementation(() => {
          reenter()
          return claimed
        })
      const running = h.scheduler.runOnce()
      try {
        await started.promise
        await microtasks()
        expect(h.claimDue).toHaveBeenCalledOnce()
        expect(nested).toHaveLength(1)
        expect(await nested[0]).toBe(false)
        finish.resolve()
        expect(await running).toBe(true)
      } finally {
        finish.resolve()
        await running
        await Promise.all(nested)
        await h.scheduler.stop()
      }
    }
  )

  it.each(['complete', 'failure'] as const)(
    'owns %s claim settlement and never uses a legacy split gate',
    async (outcome) => {
      const execution = new CooperativeExecutionController(),
        finish = deferred(),
        started = deferred()
      const gate = callbackOnly(execution),
        checkpoint = vi.spyOn(execution, 'checkpoint'),
        enter = vi.spyOn(execution, 'enter')
      let child: CooperativeOperationGate | undefined,
        pause: Promise<unknown> | undefined,
        wasActiveDuringSettlement = false
      const h = harness({
        cooperativeExecution: gate,
        execute: async (_state, options) => {
          child = options?.cooperativeExecution
          started.resolve()
          await finish.promise
          if (outcome === 'failure') throw new Error('owned failure')
        }
      })
      const settle = () => {
        wasActiveDuringSettlement = !execution.isQuiescent()
        pause = execution.requestPause()
      }
      if (outcome === 'complete') h.completeClaim.mockImplementation(settle)
      else h.failClaim.mockImplementation(settle)
      const running = h.scheduler.runOnce(),
        observed = running.catch((error) => error)
      try {
        await Promise.race([
          started.promise,
          observed.then((result) => {
            throw new Error(`No actual callback execution: ${String(result)}`)
          })
        ])
        expect(child).toBeDefined()
        await child!.run('tool-invocation', undefined, () => undefined)
        finish.resolve()
        expect(await observed).toBe(true)
        expect(wasActiveDuringSettlement).toBe(true)
        await pause
        expect(execution.isQuiescent()).toBe(true)
        await expect(
          child!.run('tool-invocation', undefined, () => undefined)
        ).rejects.toMatchObject({
          code: 'COOPERATIVE_SCOPE_RELEASED'
        })
        expect(checkpoint).not.toHaveBeenCalled()
        expect(enter).not.toHaveBeenCalled()
      } finally {
        finish.resolve()
        execution.resume()
        await observed
        await pause
        await h.scheduler.stop()
      }
    }
  )

  it('stop retains an already-admitted callback, rejects overlapping restart and does not abort its child signal', async () => {
    vi.useFakeTimers()
    const execution = new CooperativeExecutionController(),
      finish = deferred(),
      started = deferred()
    let signal: AbortSignal | undefined, child: CooperativeOperationGate | undefined
    const h = harness({
      cooperativeExecution: execution,
      execute: async (_state, options) => {
        signal = options?.signal
        child = options?.cooperativeExecution
        started.resolve()
        await finish.promise
      }
    })
    const running = h.scheduler.runOnce()
    await started.promise
    let stopped = false
    const stopping = h.scheduler.stop().then(() => {
      stopped = true
    })
    try {
      await microtasks()
      expect(stopped).toBe(false)
      expect(execution.isQuiescent()).toBe(false)
      expect(signal?.aborted).toBe(false)
      expect(() => h.scheduler.start()).toThrow()
      await child!.run('tool-invocation', signal, () => undefined)
      finish.resolve()
      expect(await running).toBe(true)
      await stopping
      expect(h.completeClaim).toHaveBeenCalledOnce()
      h.scheduler.start()
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      finish.resolve()
      execution.resume()
      await running
      await stopping
      await h.scheduler.stop()
    }
  })

  it('latches an unexpected poll error without rearming or silently claiming another trigger', async () => {
    vi.useFakeTimers()
    const failure = new Error('claim append failed'),
      h = harness()
    h.claimDue.mockImplementation(() => {
      throw failure
    })
    h.scheduler.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(h.claimDue).toHaveBeenCalledOnce()
      expect(h.scheduler.getFault()).toMatchObject({ cause: failure })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.claimDue).toHaveBeenCalledOnce()
      expect(() => h.scheduler.start()).toThrow('fault')
      await expect(h.scheduler.runOnce()).rejects.toBe(failure)
      expect(h.failClaim).not.toHaveBeenCalled()
    } finally {
      await h.scheduler.stop().catch(() => undefined)
    }
  })

  it('a stopped manual poll cannot claim again until explicit start', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.scheduler.stop()
    try {
      expect(await h.scheduler.runOnce()).toBe(false)
      expect(h.claimDue).not.toHaveBeenCalled()
      h.scheduler.start()
      expect(await h.scheduler.runOnce()).toBe(true)
      expect(h.claimDue).toHaveBeenCalledOnce()
    } finally {
      await h.scheduler.stop()
    }
  })

  it('an old poll continuation cannot install a second timer after stop and restart', async () => {
    vi.useFakeTimers()
    const finish = deferred(),
      started = deferred()
    const h = harness({
      execute: async () => {
        started.resolve()
        await finish.promise
      }
    })
    h.scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    await started.promise
    const stopping = h.scheduler.stop()
    finish.resolve()
    await stopping
    h.scheduler.start()
    try {
      await microtasks()
      expect(vi.getTimerCount()).toBe(1)
      expect(h.claimDue).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.claimDue).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      finish.resolve()
      await h.scheduler.stop()
    }
  })

  it('a resume immediately followed by re-pause is not admission to claim', async () => {
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const h = harness({ cooperativeExecution: execution }),
      running = h.scheduler.runOnce()
    try {
      await microtasks()
      execution.resume()
      await execution.requestPause()
      await microtasks()
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.execute).not.toHaveBeenCalled()
      execution.resume()
      expect(await running).toBe(true)
      expect(h.claimDue).toHaveBeenCalledOnce()
    } finally {
      execution.resume()
      await running
      await h.scheduler.stop()
    }
  })

  it('guards a cancelled callback even when a custom MAIN gate ignores the admission signal', async () => {
    const entered = deferred(),
      release = deferred()
    const execution = new CooperativeExecutionController()
    const gate: CooperativeOperationGate = {
      run: async (kind, _signal, operation) => {
        entered.resolve()
        await release.promise
        await execution.run(kind, undefined, operation)
      }
    }
    const h = harness({ cooperativeExecution: gate }),
      running = h.scheduler.runOnce()
    await entered.promise
    const stopping = h.scheduler.stop()
    release.resolve()
    try {
      expect(await running).toBe(false)
      await stopping
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.execute).not.toHaveBeenCalled()
      expect(h.scheduler.getFault()).toBeUndefined()
      expect(execution.isQuiescent()).toBe(true)
    } finally {
      release.resolve()
      await running
      await stopping
    }
  })

  it('publishes single-flight before even the custom gate can reenter runOnce', async () => {
    const execution = new CooperativeExecutionController()
    let nested: Promise<boolean> | undefined
    const gate: CooperativeOperationGate = {
      run: (kind, signal, operation) => {
        nested = h.scheduler.runOnce()
        return execution.run(kind, signal, operation)
      }
    }
    const h = harness({ cooperativeExecution: gate })
    try {
      expect(await h.scheduler.runOnce()).toBe(true)
      expect(await nested).toBe(false)
      expect(h.claimDue).toHaveBeenCalledOnce()
    } finally {
      await h.scheduler.stop()
    }
  })

  it('a stop reentered from claim does not abort already-owned execution or release it before completion', async () => {
    const execution = new CooperativeExecutionController(),
      finish = deferred(),
      started = deferred()
    let signal: AbortSignal | undefined,
      stopped = false,
      stopping: Promise<void> | undefined
    const h = harness({
      cooperativeExecution: execution,
      execute: async (_state, options) => {
        signal = options.signal
        started.resolve()
        await finish.promise
      }
    })
    h.claimDue.mockImplementation(() => {
      stopping = h.scheduler.stop().then(() => {
        stopped = true
      })
      return claimed
    })
    const running = h.scheduler.runOnce()
    try {
      await started.promise
      await microtasks()
      expect(stopped).toBe(false)
      expect(signal?.aborted).toBe(false)
      expect(execution.isQuiescent()).toBe(false)
      finish.resolve()
      expect(await running).toBe(true)
      await stopping
      expect(h.completeClaim).toHaveBeenCalledOnce()
      expect(execution.isQuiescent()).toBe(true)
    } finally {
      finish.resolve()
      execution.resume()
      await running
      await stopping
      await h.scheduler.stop()
    }
  })

  it('keeps existing completion failure accounting inside ownership and surfaces failClaim persistence errors', async () => {
    const execution = new CooperativeExecutionController(),
      completionFailure = new Error('completion append failed'),
      failFailure = new Error('failure append failed')
    const h = harness({ cooperativeExecution: execution })
    let active = false
    h.completeClaim.mockImplementation(() => {
      throw completionFailure
    })
    h.failClaim.mockImplementation(() => {
      active = !execution.isQuiescent()
      throw failFailure
    })
    try {
      await expect(h.scheduler.runOnce()).rejects.toBe(failFailure)
      expect(active).toBe(true)
      expect(h.failClaim).toHaveBeenCalledWith(
        claimed.id,
        'exact-claim',
        100,
        completionFailure.message,
        5000
      )
      expect(h.scheduler.getFault()).toMatchObject({ cause: failFailure })
      expect(execution.isQuiescent()).toBe(true)
      await expect(h.scheduler.runOnce()).rejects.toBe(failFailure)
      expect(h.claimDue).toHaveBeenCalledOnce()
    } finally {
      await h.scheduler.stop().catch(() => undefined)
    }
  })

  it('an unexpected pre-admission gate failure is not converted into trigger failure or a stop-cancelled no-op', async () => {
    const failure = new Error('custom gate failed'),
      wait = deferred()
    const gate: CooperativeOperationGate = {
      run: async () => {
        await wait.promise
        throw failure
      }
    }
    const h = harness({ cooperativeExecution: gate }),
      running = h.scheduler.runOnce(),
      observed = running.catch((error) => error)
    const stopping = h.scheduler.stop().catch((error) => error)
    wait.resolve()
    try {
      expect(await observed).toBe(failure)
      expect(h.claimDue).not.toHaveBeenCalled()
      expect(h.failClaim).not.toHaveBeenCalled()
      await stopping
    } finally {
      wait.resolve()
      await observed
      await stopping
    }
  })
})
