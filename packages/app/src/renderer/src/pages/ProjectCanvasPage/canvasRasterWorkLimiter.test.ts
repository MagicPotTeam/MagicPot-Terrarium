import { describe, expect, it, vi } from 'vitest'
import { runWithCanvasRasterWorkLimit } from './canvasRasterWorkLimiter'

describe('runWithCanvasRasterWorkLimit', () => {
  it('runs memory-heavy work one at a time in FIFO order', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = runWithCanvasRasterWorkLimit(async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
      return 1
    })
    const secondWork = vi.fn(async () => {
      events.push('second')
      return 2
    })
    const thirdWork = vi.fn(async () => {
      events.push('third')
      return 3
    })
    const second = runWithCanvasRasterWorkLimit(secondWork)
    const third = runWithCanvasRasterWorkLimit(thirdWork)

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    expect(secondWork).not.toHaveBeenCalled()
    expect(thirdWork).not.toHaveBeenCalled()

    releaseFirst()

    await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3])
    expect(events).toEqual(['first:start', 'first:end', 'second', 'third'])
  })

  it('releases the next queued operation after a failure', async () => {
    const failure = new Error('encode failed')
    const first = runWithCanvasRasterWorkLimit(async () => {
      throw failure
    })
    const second = runWithCanvasRasterWorkLimit(async () => 'completed')

    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBe('completed')
  })
})
