import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CancellablePriorityScheduler,
  ensureCachedChatImageDerivative,
  resetChatImageDerivativeCacheForTests
} from './chatImageDerivativeScheduler'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

const flushScheduler = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const reference = (id: string) => ({
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: `assets/${id}.png`,
  sha256: id.padStart(64, '0'),
  sizeBytes: 1,
  mimeType: 'image/png'
})

const result = {
  status: 'fallbackOriginal' as const,
  reason: 'animated-gif' as const,
  localMediaUrl: 'local-media:///original.png'
}

afterEach(() => resetChatImageDerivativeCacheForTests())

describe('CancellablePriorityScheduler', () => {
  it('runs lower numeric priorities first while respecting bounded concurrency', async () => {
    const scheduler = new CancellablePriorityScheduler(2)
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()]
    const started: string[] = []
    let active = 0
    let maxActive = 0
    const run = (name: string, gate: Promise<void>) => () => {
      started.push(name)
      active += 1
      maxActive = Math.max(maxActive, active)
      return gate.then(() => {
        active -= 1
        return name
      })
    }

    const first = scheduler.schedule(run('first', gates[0].promise), { priority: 10 })
    const second = scheduler.schedule(run('second', gates[1].promise), { priority: 10 })
    await flushScheduler()
    expect(started).toEqual(['first', 'second'])
    const low = scheduler.schedule(run('low', gates[2].promise), { priority: 20 })
    const high = scheduler.schedule(run('high', gates[3].promise), { priority: 1 })
    await flushScheduler()
    expect(maxActive).toBe(2)

    gates[0].resolve()
    await first
    await flushScheduler()
    expect(started).toEqual(['first', 'second', 'high'])
    gates[1].resolve()
    gates[3].resolve()
    await Promise.all([second, high])
    await flushScheduler()
    expect(started).toEqual(['first', 'second', 'high', 'low'])
    gates[2].resolve()
    await low
    expect(maxActive).toBe(2)
  })

  it('does not enqueue an already-aborted caller', async () => {
    const scheduler = new CancellablePriorityScheduler(1)
    const controller = new AbortController()
    controller.abort()
    await expect(
      scheduler.schedule(async () => 'unused', { priority: 1, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects cancellation before start and while the caller awaits', async () => {
    const scheduler = new CancellablePriorityScheduler(1)
    const gate = deferred<void>()
    const blocker = scheduler.schedule(() => gate.promise, { priority: 0 })
    const controller = new AbortController()
    const task = vi.fn(async () => 'late')
    const queued = scheduler.schedule(task, { priority: 1, signal: controller.signal })
    await flushScheduler()
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(task).not.toHaveBeenCalled()
    gate.resolve()
    await blocker

    const runningGate = deferred<string>()
    const runningController = new AbortController()
    const running = scheduler.schedule(() => runningGate.promise, {
      priority: 0,
      signal: runningController.signal
    })
    await flushScheduler()
    runningController.abort()
    runningGate.resolve('done')
    await expect(running).resolves.toBe('done')
  })
})

describe('chat managed-image derivative scheduling', () => {
  it('deduplicates a shared backend request and cancellation only rejects that caller', async () => {
    const gate = deferred<typeof result>()
    const ensureDerivative = vi.fn(() => gate.promise)
    const controller = new AbortController()
    const first = ensureCachedChatImageDerivative(
      { ensureDerivative } as never,
      reference('1'),
      512,
      { signal: controller.signal }
    )
    const second = ensureCachedChatImageDerivative(
      { ensureDerivative } as never,
      reference('1'),
      512
    )
    await flushScheduler()
    expect(ensureDerivative).toHaveBeenCalledTimes(1)

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(ensureDerivative).toHaveBeenCalledTimes(1)
    gate.resolve(result)
    await expect(second).resolves.toEqual(result)
  })

  it('removes an aborted queued caller without starting its backend request', async () => {
    const gates = [deferred<typeof result>(), deferred<typeof result>(), deferred<typeof result>()]
    const ensureDerivative = vi.fn(() => gates[ensureDerivative.mock.calls.length - 1].promise)
    const running = [0, 1, 2].map((id) =>
      ensureCachedChatImageDerivative({ ensureDerivative } as never, reference(String(id + 1)), 512)
    )
    await flushScheduler()
    expect(ensureDerivative).toHaveBeenCalledTimes(3)

    const controller = new AbortController()
    const queued = ensureCachedChatImageDerivative(
      { ensureDerivative } as never,
      reference('4'),
      512,
      { signal: controller.signal }
    )
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    gates.forEach((gate) => gate.resolve(result))
    await Promise.all(running)
    expect(ensureDerivative).toHaveBeenCalledTimes(3)
  })
})
