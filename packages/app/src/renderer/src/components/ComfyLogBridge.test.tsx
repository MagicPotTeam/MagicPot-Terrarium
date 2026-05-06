import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ComfyLogBridge from './ComfyLogBridge'

const watchComfyLogsMock = vi.fn()
const addOutputMock = vi.fn()

vi.mock('@renderer/store/hooks/comfyProcess', () => ({
  useComfyProcess: () => ({
    addOutput: addOutputMock
  })
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
    addOutputMock.mockReset()
  })

  it('replays dedicated comfy logs into the shared comfy output store', async () => {
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
      expect(watchComfyLogsMock).toHaveBeenCalledTimes(1)
    })

    expect(addOutputMock).toHaveBeenNthCalledWith(1, '[comfyui] start ComfyUI...')
    expect(addOutputMock).toHaveBeenNthCalledWith(
      2,
      '[comfyui] To see the GUI go to: http://localhost:8188'
    )
  })
})
