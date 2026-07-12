import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueueManager, type QueueSource } from './queueManager'

type Item = { id: string }

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const createSource = (items: Item[]) => {
  let active: Item | null = null
  const pending = [...items]
  const done = vi.fn((item: Item) => {
    if (active?.id === item.id) {
      active = null
    }
  })
  const source: QueueSource<Item> = {
    next: vi.fn(() => {
      if (active) {
        return active
      }
      active = pending.shift() ?? null
      return active
    }),
    done,
    error: vi.fn(),
    queueLength: () => pending.length
  }
  return { source, done }
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('QueueManager stop/start concurrency', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets the active executor finish after stop without starting another task', async () => {
    vi.useFakeTimers()
    const first = { id: 'first' }
    const second = { id: 'second' }
    const firstExecution = createDeferred<Item>()
    const { source, done } = createSource([first, second])
    const execute = vi.fn((item: Item) => {
      if (item === first) {
        return firstExecution.promise
      }
      return Promise.resolve(item)
    })
    const manager = new QueueManager(source, execute, 10)

    manager.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(execute).toHaveBeenCalledTimes(1)

    manager.stop()
    firstExecution.resolve(first)
    await flushPromises()

    expect(done).toHaveBeenCalledOnce()
    expect(done).toHaveBeenCalledWith(first)
    await vi.advanceTimersByTimeAsync(100)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not execute the active task again when restarted before it finishes', async () => {
    vi.useFakeTimers()
    const first = { id: 'first' }
    const second = { id: 'second' }
    const executions = new Map<string, Deferred<Item>>()
    const { source, done } = createSource([first, second])
    const execute = vi.fn((item: Item) => {
      const deferred = createDeferred<Item>()
      executions.set(item.id, deferred)
      return deferred.promise
    })
    const manager = new QueueManager(source, execute, 10)

    manager.start()
    await vi.advanceTimersByTimeAsync(10)
    manager.stop()
    manager.start()
    await vi.advanceTimersByTimeAsync(10)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenLastCalledWith(first)

    executions.get(first.id)?.resolve(first)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10)

    expect(done).toHaveBeenCalledWith(first)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenLastCalledWith(second)

    executions.get(second.id)?.resolve(second)
    await flushPromises()
    manager.stop()
  })
})
