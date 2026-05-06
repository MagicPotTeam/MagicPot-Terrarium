import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RUNTIME_MCP_STATUS_REFRESH_INTERVAL_MS,
  useRuntimeMcpStatus
} from './useRuntimeMcpStatus'

const { getConfigState, subscribeConfig, resetConfigState, applyConfigPatch, getMcpStatusMock } =
  vi.hoisted(() => {
    let configState: Record<string, unknown> = {
      mcp_config: {
        client: { servers: [] },
        server: {
          enabled: true,
          path: '/api/mcp',
          auth_token: '',
          expose_resources: false
        }
      }
    }

    const listeners = new Set<() => void>()
    let callCount = 0

    const notify = () => listeners.forEach((listener) => listener())

    const cloneConfig = (value: Record<string, unknown>) => ({
      ...value,
      mcp_config: {
        ...(value.mcp_config as Record<string, unknown>),
        client: {
          ...((value.mcp_config as Record<string, unknown>)?.client as Record<string, unknown>)
        },
        server: {
          ...((value.mcp_config as Record<string, unknown>)?.server as Record<string, unknown>)
        }
      }
    })

    return {
      getConfigState: () => configState,
      subscribeConfig: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      resetConfigState: () => {
        configState = cloneConfig({
          mcp_config: {
            client: { servers: [] },
            server: {
              enabled: true,
              path: '/api/mcp',
              auth_token: '',
              expose_resources: false
            }
          }
        })
        callCount = 0
        notify()
      },
      applyConfigPatch: (partial: Record<string, unknown>) => {
        configState = cloneConfig({
          ...configState,
          ...partial,
          mcp_config: {
            ...(configState.mcp_config as Record<string, unknown>),
            ...(partial.mcp_config as Record<string, unknown>)
          }
        })
        notify()
      },
      getMcpStatusMock: vi.fn(async () => {
        callCount += 1
        return {
          client: {
            connections: [],
            discoveredToolCount: callCount
          },
          server: {
            enabled: true,
            path: '/api/mcp',
            exposeResources: false,
            authRequired: false
          }
        }
      })
    }
  })

vi.mock('./useConfig', async () => {
  const React = await import('react')

  return {
    useConfig: () => {
      const config = React.useSyncExternalStore(subscribeConfig, getConfigState, getConfigState)

      return {
        config,
        buildEnv: {},
        isReady: true,
        configUtils: {},
        updateConfig: vi.fn()
      }
    }
  }
})

const originalWindowApi = window.api

const Harness = () => {
  const { runtimeMcpStatus } = useRuntimeMcpStatus(DEFAULT_RUNTIME_MCP_STATUS_REFRESH_INTERVAL_MS)

  return (
    <div>
      <div data-testid="runtime-mcp-status">
        {runtimeMcpStatus?.client.discoveredToolCount ?? 'none'}
      </div>
    </div>
  )
}

describe('useRuntimeMcpStatus', () => {
  beforeEach(() => {
    resetConfigState()
    vi.useFakeTimers()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcState: {
          getMcpStatus: getMcpStatusMock
        }
      } as unknown as Window['api']
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    getMcpStatusMock.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalWindowApi
    })
  })

  it('refreshes on mount, config changes, focus, and timer ticks', async () => {
    render(<Harness />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(getMcpStatusMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-mcp-status')).toHaveTextContent('1')

    await act(async () => {
      applyConfigPatch({
        mcp_config: {
          server: {
            enabled: false
          }
        }
      })
      await Promise.resolve()
    })
    expect(getMcpStatusMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('runtime-mcp-status')).toHaveTextContent('2')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(getMcpStatusMock).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('runtime-mcp-status')).toHaveTextContent('3')

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_RUNTIME_MCP_STATUS_REFRESH_INTERVAL_MS)
      await Promise.resolve()
    })
    expect(getMcpStatusMock).toHaveBeenCalledTimes(4)
    expect(screen.getByTestId('runtime-mcp-status')).toHaveTextContent('4')
  })
})
