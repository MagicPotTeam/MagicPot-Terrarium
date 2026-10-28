import { describe, expect, it, vi } from 'vitest'
import {
  FigPluginBridgeSupervisor,
  FigPluginBridgeSupervisorError,
  type FigPluginBridgeServer
} from './bridgeSupervisor'

const server = (
  origin: string,
  close: FigPluginBridgeServer['close'] = vi.fn(async (): Promise<void> => undefined)
): FigPluginBridgeServer => ({
  origin,
  close
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('FigPluginBridgeSupervisor', () => {
  it('serializes concurrent starts and publishes a ready snapshot', async () => {
    let now = 100
    const start = vi.fn(async ({ origin }: { origin: string }) => server(origin))
    const supervisor = new FigPluginBridgeSupervisor({ start, now: () => now })

    const first = supervisor.start({ origin: 'http://127.0.0.1:41234' })
    const second = supervisor.start({ origin: 'http://127.0.0.1:41234' })
    expect(supervisor.snapshot()).toMatchObject({ state: 'starting', generation: 1 })
    now = 101
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(start).toHaveBeenCalledTimes(1)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'ready',
      origin: 'http://127.0.0.1:41234',
      generation: 1,
      changedAt: 101
    })
  })

  it('rejects a different origin without taking down a healthy server', async () => {
    const start = vi.fn(async ({ origin }: { origin: string }) => server(origin))
    const supervisor = new FigPluginBridgeSupervisor({ start })
    await supervisor.start({ origin: 'http://127.0.0.1:41234' })

    await expect(supervisor.start({ origin: 'http://127.0.0.1:41235' })).rejects.toMatchObject({
      code: 'ORIGIN_MISMATCH'
    })
    expect(supervisor.snapshot()).toMatchObject({
      state: 'ready',
      failure: { code: 'ORIGIN_MISMATCH' }
    })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('records a bounded start failure and permits a same-origin retry', async () => {
    const start = vi
      .fn<({ origin }: { origin: string }) => Promise<FigPluginBridgeServer>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('secret URL should not escape'), { code: 'EADDRINUSE' })
      )
      .mockImplementationOnce(async ({ origin }) => server(origin))
    const supervisor = new FigPluginBridgeSupervisor({ start })

    await expect(supervisor.start({ origin: 'http://127.0.0.1:41234' })).rejects.toMatchObject({
      code: 'EADDRINUSE'
    })
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      failure: { code: 'PORT_IN_USE' }
    })
    await supervisor.start({ origin: 'http://127.0.0.1:41234' })
    expect(supervisor.snapshot().state).toBe('ready')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('closes a late server when stop races with startup', async () => {
    const gate = deferred<FigPluginBridgeServer>()
    const late = server('http://127.0.0.1:41234')
    const start = vi.fn(() => gate.promise)
    const supervisor = new FigPluginBridgeSupervisor({ start })
    const pending = supervisor.start({ origin: 'http://127.0.0.1:41234' })
    const stopping = supervisor.stop()
    expect(supervisor.snapshot().state).toBe('stopping')
    gate.resolve(late)
    await expect(pending).rejects.toMatchObject({ code: 'STOPPED_DURING_START' })
    await stopping
    expect(late.close).toHaveBeenCalledTimes(1)
    expect(supervisor.snapshot().state).toBe('stopped')
  })

  it('retains a mismatched server when startup cleanup fails and blocks a second launch', async () => {
    let attempts = 0
    const close = vi.fn(async () => {
      if (++attempts === 1) throw new Error('private close detail')
    })
    const start = vi.fn(async () => server('http://127.0.0.1:41235', close))
    const supervisor = new FigPluginBridgeSupervisor({ start })

    await expect(supervisor.start({ origin: 'http://127.0.0.1:41234' })).rejects.toMatchObject({
      code: 'STOP_FAILED'
    })
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      failure: { code: 'STOP_FAILED' }
    })
    await expect(supervisor.start({ origin: 'http://127.0.0.1:41234' })).rejects.toMatchObject({
      code: 'STOP_FAILED'
    })
    expect(start).toHaveBeenCalledTimes(1)
    await supervisor.stop()
    expect(close).toHaveBeenCalledTimes(2)
    expect(supervisor.snapshot().state).toBe('stopped')
  })

  it('makes stop idempotent and reports close failures without leaking the error', async () => {
    let attempts = 0
    const close = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('path/credential must not be exposed')
    })
    const start = vi.fn(async ({ origin }: { origin: string }) => server(origin, close))
    const supervisor = new FigPluginBridgeSupervisor({ start })
    await supervisor.start({ origin: 'http://127.0.0.1:41234' })
    const first = supervisor.stop()
    const second = supervisor.stop()
    expect(first).toBe(second)
    await expect(first).rejects.toThrow()
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      failure: { code: 'STOP_FAILED' }
    })
    expect(supervisor.snapshot()).not.toHaveProperty('message')
    expect(new FigPluginBridgeSupervisorError('STOP_FAILED').message).not.toContain('path')

    await expect(supervisor.start({ origin: 'http://127.0.0.1:41234' })).rejects.toMatchObject({
      code: 'STOP_FAILED'
    })
    await supervisor.stop()
    await supervisor.start({ origin: 'http://127.0.0.1:41234' })
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('records an explicit user stop without starting a replacement', async () => {
    const close = vi.fn(async (): Promise<void> => undefined)
    const start = vi.fn(async ({ origin }: { origin: string }) => server(origin, close))
    const supervisor = new FigPluginBridgeSupervisor({ start })
    await supervisor.start({ origin: 'http://127.0.0.1:41234' })
    await supervisor.stop('user-stop')
    expect(start).toHaveBeenCalledOnce()
    expect(supervisor.snapshot()).toMatchObject({
      state: 'stopped',
      lifecycleReason: 'user-stop'
    })
  })

  it('requires an explicit restart after a child crash and records the reason', async () => {
    let crash!: () => void
    const onCrash = vi.fn()
    const close = vi.fn(async (): Promise<void> => undefined)
    const start = vi.fn(async ({ origin }: { origin: string }) => ({
      origin,
      close,
      onCrash(listener: () => void) {
        crash = listener
        return () => {
          if (crash === listener) crash = undefined!
        }
      }
    }))
    const supervisor = new FigPluginBridgeSupervisor({ start, onCrash })
    await supervisor.start({ origin: 'http://127.0.0.1:41234' })
    crash()
    expect(onCrash).toHaveBeenCalledOnce()
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      generation: 1,
      lifecycleReason: 'child-crash',
      failure: { code: 'CHILD_CRASHED' }
    })
    // A crash is observable and does not silently create a retry loop.
    expect(start).toHaveBeenCalledOnce()

    await supervisor.restart({ origin: 'http://127.0.0.1:41234' }, 'child-crash')
    expect(close).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'ready',
      generation: 2,
      lifecycleReason: 'child-crash'
    })
  })

  it.each(['config-change', 'version-upgrade'] as const)(
    'supports one explicit %s replacement without an automatic restart loop',
    async (reason) => {
      const start = vi.fn(async ({ origin }: { origin: string }) => server(origin))
      const supervisor = new FigPluginBridgeSupervisor({ start })
      await supervisor.start({ origin: 'http://127.0.0.1:41234' })
      await supervisor.restart({ origin: 'http://127.0.0.1:41234' }, reason)
      expect(start).toHaveBeenCalledTimes(2)
      expect(supervisor.snapshot()).toMatchObject({
        state: 'ready',
        generation: 2,
        lifecycleReason: reason
      })
    }
  )
})
