import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ComfyLogBridge, { COMFY_LOG_BATCH_SIZE } from './ComfyLogBridge'

const watchComfyLogsMock = vi.fn()
const dispatchMock = vi.fn()

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcLog: {
      watchComfyLogs: watchComfyLogsMock
    }
  })
}))

describe('ComfyLogBridge', () => {
  beforeEach(() => {
    watchComfyLogsMock.mockReset()
    dispatchMock.mockReset()
  })

  it('batches dedicated comfy logs into the shared comfy output store', async () => {
    watchComfyLogsMock.mockImplementation(
      async (
        _req: Record<string, never>,
        resp: { onData: (data: { message: string }) => void }
      ) => {
        resp.onData({ message: '[comfyui] start ComfyUI...' })
        resp.onData({ message: '[comfyui] To see the GUI go to: http://localhost:8188' })
      }
    )

    render(<ComfyLogBridge />)

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1)
    })

    expect(dispatchMock).toHaveBeenCalledWith({
      type: 'comfyProcess/addOutputBatch',
      payload: [
        '[comfyui] start ComfyUI...',
        '[comfyui] To see the GUI go to: http://localhost:8188'
      ]
    })
  })

  it('groups heavy streams instead of dispatching once per log line', async () => {
    watchComfyLogsMock.mockImplementation(
      async (
        _req: Record<string, never>,
        resp: { onData: (data: { message: string }) => void }
      ) => {
        for (let index = 0; index < 20_000; index += 1) {
          resp.onData({ message: `line-${index}` })
        }
      }
    )

    render(<ComfyLogBridge />)

    await waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(20_000 / COMFY_LOG_BATCH_SIZE)
    })

    expect(dispatchMock).toHaveBeenCalledTimes(200)
    expect(dispatchMock.mock.calls[0][0]).toEqual({
      type: 'comfyProcess/addOutputBatch',
      payload: Array.from({ length: COMFY_LOG_BATCH_SIZE }, (_, index) => `line-${index}`)
    })
    expect(dispatchMock.mock.calls.at(-1)?.[0]).toEqual({
      type: 'comfyProcess/addOutputBatch',
      payload: Array.from(
        { length: COMFY_LOG_BATCH_SIZE },
        (_, index) => `line-${20_000 - COMFY_LOG_BATCH_SIZE + index}`
      )
    })
  })
})
