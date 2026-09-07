import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ComfyLogBridge, { COMFY_LOG_BATCH_INTERVAL_MS, COMFY_LOG_BATCH_SIZE } from './ComfyLogBridge'
import { LOG_BATCH_CHARACTERS } from '@renderer/utils/logBuffer'

const watchComfyLogsMock = vi.fn()
const dispatchMock = vi.fn()
let generation = 0
let response: {
  onData: (data: { message: string }) => void
  abortReceiver: { isAborted: () => boolean }
}

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({ comfyProcess: { outputGeneration: generation } })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcLog: { watchComfyLogs: watchComfyLogsMock } })
}))

describe('ComfyLogBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    generation = 0
    watchComfyLogsMock.mockReset()
    dispatchMock.mockReset()
    watchComfyLogsMock.mockImplementation((_request, next) => {
      response = next
      return new Promise(() => undefined)
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('flushes ordinary logs in order only at the slower timer cadence', () => {
    render(<ComfyLogBridge />)
    response.onData({ message: '[comfyui] start ComfyUI...' })
    response.onData({ message: '[comfyui] To see the GUI go to: http://localhost:8188' })
    act(() => vi.advanceTimersByTime(COMFY_LOG_BATCH_INTERVAL_MS - 1))
    expect(dispatchMock).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith({
      type: 'comfyProcess/addOutputBatch',
      payload: [
        '[comfyui] start ComfyUI...',
        '[comfyui] To see the GUI go to: http://localhost:8188'
      ]
    })
  })

  it('coalesces a 20,000-line synchronous replay into one bounded dispatch with an omission notice', () => {
    render(<ComfyLogBridge />)
    for (let index = 0; index < 20_000; index += 1) response.onData({ message: `line-${index}` })
    expect(dispatchMock).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(COMFY_LOG_BATCH_INTERVAL_MS))
    expect(dispatchMock).toHaveBeenCalledTimes(1)
    const lines: string[] = dispatchMock.mock.calls[0][0].payload
    expect(lines).toHaveLength(COMFY_LOG_BATCH_SIZE)
    expect(lines[0]).toContain('omitted')
    expect(lines.at(-1)).toBe('line-19999')
    act(() => vi.advanceTimersByTime(3000))
    expect(dispatchMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes before queuing and bounds the total pending characters', () => {
    render(<ComfyLogBridge />)
    for (let index = 0; index < 1000; index += 1) {
      response.onData({ message: `ERROR ${index}: ${'field: '.repeat(500)}` })
    }
    response.onData({ message: `image=data:image/png;base64,${'A'.repeat(1_000_000)}; failed` })
    act(() => vi.advanceTimersByTime(COMFY_LOG_BATCH_INTERVAL_MS))
    const lines: string[] = dispatchMock.mock.calls[0][0].payload
    expect(lines.length).toBeLessThanOrEqual(COMFY_LOG_BATCH_SIZE)
    expect(lines.reduce((sum, line) => sum + line.length + 1, 0)).toBeLessThanOrEqual(
      LOG_BATCH_CHARACTERS
    )
    expect(lines.join('\n')).not.toContain('A'.repeat(256))
    expect(lines.join('\n')).toContain('failed')
    expect(lines[0]).toContain('omitted')
  })

  it('clears pending rows without replaying the stream and aborts/discards on unmount', () => {
    const view = render(<ComfyLogBridge />)
    response.onData({ message: 'before clear' })
    generation += 1
    view.rerender(<ComfyLogBridge />)
    act(() => vi.advanceTimersByTime(COMFY_LOG_BATCH_INTERVAL_MS))
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(watchComfyLogsMock).toHaveBeenCalledTimes(1)
    response.onData({ message: 'pending' })
    view.unmount()
    expect(response.abortReceiver.isAborted()).toBe(true)
    response.onData({ message: 'late' })
    act(() => vi.advanceTimersByTime(1000))
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the final pending batch after a stream completes, without an immediate flush', async () => {
    watchComfyLogsMock.mockImplementation(async (_request, next) =>
      next.onData({ message: 'last error' })
    )
    render(<ComfyLogBridge />)
    await act(async () => undefined)
    expect(dispatchMock).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(COMFY_LOG_BATCH_INTERVAL_MS))
    expect(dispatchMock.mock.calls[0][0].payload).toEqual(['last error'])
  })
})
