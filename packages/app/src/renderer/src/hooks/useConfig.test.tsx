import React, { StrictMode } from 'react'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { ConfigProvider, useConfig } from './useConfig'

const getConfig = vi.fn()
const getBuildEnv = vi.fn()
const watchConfig = vi.fn()
const saveConfig = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcState: { getConfig, getBuildEnv, watchConfig, saveConfig } })
}))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function Probe() {
  const { config, isReady } = useConfig()
  return <div>{isReady ? String(config) : 'pending'}</div>
}

describe('ConfigProvider stream lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConfig.mockResolvedValue({ config: DEFAULT_CONFIG })
    getBuildEnv.mockResolvedValue({ buildEnv: DEFAULT_BUILD_ENV })
    watchConfig.mockReturnValue(new Promise(() => undefined))
  })

  it('does not start a watch or update state when unmounted before initialization', async () => {
    const config = deferred<{ config: typeof DEFAULT_CONFIG }>()
    getConfig.mockReturnValue(config.promise)
    const view = renderHook(() => useConfig(), {
      wrapper: ({ children }) => <ConfigProvider>{children}</ConfigProvider>
    })

    view.unmount()
    await act(async () => config.resolve({ config: DEFAULT_CONFIG }))

    expect(watchConfig).not.toHaveBeenCalled()
  })

  it('aborts its watch and ignores events after unmount', async () => {
    let onData: ((data: { config: typeof DEFAULT_CONFIG }) => void) | undefined
    watchConfig.mockImplementation((_req, response) => {
      onData = response.onData
      return new Promise(() => undefined)
    })
    const view = renderHook(() => useConfig(), {
      wrapper: ({ children }) => <ConfigProvider>{children}</ConfigProvider>
    })
    await waitFor(() => expect(watchConfig).toHaveBeenCalledOnce())
    const receiver = watchConfig.mock.calls[0][1].abortReceiver

    view.unmount()
    expect(receiver.isAborted()).toBe(true)
    expect(() => onData?.({ config: DEFAULT_CONFIG })).not.toThrow()
  })

  it('isolates StrictMode generations', async () => {
    const callbacks: Array<(data: { config: typeof DEFAULT_CONFIG }) => void> = []
    watchConfig.mockImplementation((_req, response) => {
      callbacks.push(response.onData)
      return new Promise(() => undefined)
    })

    render(
      <StrictMode>
        <ConfigProvider>
          <Probe />
        </ConfigProvider>
      </StrictMode>
    )
    await waitFor(() => expect(watchConfig).toHaveBeenCalledOnce())
    expect(callbacks).toHaveLength(1)
    expect(screen.getByText(String(DEFAULT_CONFIG))).toBeTruthy()
  })
})
