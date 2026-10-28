import { afterEach, describe, expect, it, vi } from 'vitest'
import { withProjectCanvasWebGLTimeout } from './projectCanvasWebGLTimeout'

describe('withProjectCanvasWebGLTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects at the deadline and closes a late decoded asset', async () => {
    vi.useFakeTimers()
    let resolvePending!: (value: { close: () => void }) => void
    const pending = new Promise<{ close: () => void }>((resolve) => {
      resolvePending = resolve
    })
    const onTimeout = vi.fn()
    const timedOut = withProjectCanvasWebGLTimeout(pending, 25, 'decode timed out', onTimeout)

    const rejection = expect(timedOut).rejects.toThrow('decode timed out')
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(onTimeout).toHaveBeenCalledOnce()

    const close = vi.fn()
    resolvePending({ close })
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })
})
