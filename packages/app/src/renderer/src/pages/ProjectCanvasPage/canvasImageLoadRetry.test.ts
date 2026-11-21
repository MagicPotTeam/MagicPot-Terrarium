import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS,
  CanvasImageLoadRetries,
  probeCanvasImageLoadRetry
} from './canvasImageLoadRetry'

const SRC = 'local-media:///Users/x/Pictures/a.png'

describe('CanvasImageLoadRetries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('loads an unavailable image again, later each time, a bounded number of times', async () => {
    const retry = vi.fn()
    const retries = new CanvasImageLoadRetries(retry, { probe: async () => true })
    const at: number[] = []
    retry.mockImplementation(() => {
      at.push(Date.now())
      // The load fails again.
      retries.noteFailure('a', SRC)
    })
    const started = Date.now()
    retries.noteFailure('a', SRC)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(at.map((time) => time - started)).toEqual(
      CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS.map((_, index) =>
        CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS.slice(0, index + 1).reduce((sum, delay) => sum + delay)
      )
    )
    expect(retry).toHaveBeenCalledTimes(CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS.length)
  })

  it('starts over once the image loaded or its source changed, and stops for items that left', async () => {
    const retry = vi.fn()
    const retries = new CanvasImageLoadRetries(retry, { probe: async () => true })
    for (let index = 0; index < CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS.length + 2; index += 1) {
      retries.noteFailure('a', SRC)
    }
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(retry).not.toHaveBeenCalled()
    retries.forget('a')
    retries.noteFailure('a', SRC)
    retries.noteFailure('b', 'local-media:///Users/x/Pictures/b.png')
    retries.retain(new Set(['a']))
    await vi.advanceTimersByTimeAsync(CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS[0])
    expect(retry.mock.calls).toEqual([['a', SRC]])
    retries.noteFailure('a', SRC)
    retries.noteFailure('a', 'local-media:///Users/x/Pictures/a-v2.png')
    await vi.advanceTimersByTimeAsync(CANVAS_IMAGE_LOAD_RETRY_DELAYS_MS[0])
    expect(retry).toHaveBeenLastCalledWith('a', 'local-media:///Users/x/Pictures/a-v2.png')
    retries.noteFailure('a', SRC)
    retries.dispose()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('never retries a load the probe calls final', async () => {
    const retry = vi.fn()
    const retries = new CanvasImageLoadRetries(retry, { probe: async () => false })
    retries.noteFailure('a', SRC)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('probeCanvasImageLoadRetry', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('retries a local image main could not answer for, or serves now; never a refused or missing one', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const [status, retryable] of [
      [503, true],
      [200, true],
      [403, false],
      [404, false],
      [500, false]
    ] as const) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }))
      await expect(probeCanvasImageLoadRetry(SRC)).resolves.toBe(retryable)
    }
    expect(fetchMock).toHaveBeenLastCalledWith(SRC, { method: 'HEAD', cache: 'no-store' })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(probeCanvasImageLoadRetry(SRC)).resolves.toBe(false)
    fetchMock.mockClear()
    for (const src of [
      'file:///a.png',
      'blob:file:///x',
      'data:image/png;base64,AA',
      'https://x/a.png'
    ]) {
      await expect(probeCanvasImageLoadRetry(src)).resolves.toBe(false)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
