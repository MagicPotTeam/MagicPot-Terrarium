import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ManagedComfyProcessBridge from './ManagedComfyProcessBridge'

const bridgeState = vi.hoisted(() => ({
  isReady: true,
  useRemoteComfyui: false,
  comfyCommandAvailable: true,
  managedComfyStartupApiAvailable: true,
  pid: 0
}))
const comfyPortDetectMock = vi.fn()
const connectSubProcessMock = vi.fn()
const setPidMock = vi.fn()
const setIsRunningMock = vi.fn()
const addOutputMock = vi.fn()

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    isReady: bridgeState.isReady,
    config: {
      use_remote_comfyui: bridgeState.useRemoteComfyui
    },
    configUtils: {
      isComfyUICommandAvailable: () => bridgeState.comfyCommandAvailable
    }
  })
}))

vi.mock('@renderer/store/hooks/comfyProcess', () => ({
  useComfyProcess: () => ({
    state: {
      pid: bridgeState.pid
    },
    setPid: setPidMock,
    setIsRunning: setIsRunningMock,
    addOutput: addOutputMock
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcHyper: {
      comfyPortDetect: comfyPortDetectMock,
      connectSubProcess: connectSubProcessMock
    }
  }),
  hasManagedComfyStartupApi: () => bridgeState.managedComfyStartupApiAvailable
}))

describe('ManagedComfyProcessBridge', () => {
  beforeEach(() => {
    bridgeState.isReady = true
    bridgeState.useRemoteComfyui = false
    bridgeState.comfyCommandAvailable = true
    bridgeState.managedComfyStartupApiAvailable = true
    bridgeState.pid = 0
    comfyPortDetectMock.mockReset()
    connectSubProcessMock.mockReset()
    setPidMock.mockReset()
    setIsRunningMock.mockReset()
    addOutputMock.mockReset()
  })

  it('reconnects to an existing managed ComfyUI process without duplicating streamed logs', async () => {
    comfyPortDetectMock.mockResolvedValue({ pid: 4321 })
    connectSubProcessMock.mockImplementation(
      async (
        _req: { pid: number },
        resp: { onData: (data: { pid: number; logLine: string }) => void }
      ) => {
        resp.onData({
          pid: 4321,
          logLine: '[comfyui] replayed startup line'
        })
      }
    )

    render(<ManagedComfyProcessBridge />)

    await waitFor(() => {
      expect(comfyPortDetectMock).toHaveBeenCalledTimes(1)
      expect(connectSubProcessMock).toHaveBeenCalledTimes(1)
    })

    expect(setPidMock).toHaveBeenCalledWith(4321)
    expect(setIsRunningMock).toHaveBeenCalledWith(true)
    expect(addOutputMock).toHaveBeenCalledWith(
      '> [comfyui] detected existing process with pid: 4321'
    )
    expect(addOutputMock).toHaveBeenCalledTimes(1)
    expect(setIsRunningMock).toHaveBeenLastCalledWith(false)
  })

  it('does nothing when no existing local ComfyUI process is detected', async () => {
    comfyPortDetectMock.mockResolvedValue({ pid: 0 })

    render(<ManagedComfyProcessBridge />)

    await waitFor(() => {
      expect(comfyPortDetectMock).toHaveBeenCalledTimes(1)
    })

    expect(connectSubProcessMock).not.toHaveBeenCalled()
    expect(addOutputMock).not.toHaveBeenCalled()
  })

  it('retries the initial attach when the managed startup API becomes available later', async () => {
    bridgeState.managedComfyStartupApiAvailable = false
    comfyPortDetectMock.mockResolvedValue({ pid: 4321 })

    const { rerender } = render(<ManagedComfyProcessBridge />)

    expect(comfyPortDetectMock).not.toHaveBeenCalled()

    bridgeState.managedComfyStartupApiAvailable = true
    rerender(<ManagedComfyProcessBridge />)

    await waitFor(() => {
      expect(comfyPortDetectMock).toHaveBeenCalledTimes(1)
    })
  })
})
