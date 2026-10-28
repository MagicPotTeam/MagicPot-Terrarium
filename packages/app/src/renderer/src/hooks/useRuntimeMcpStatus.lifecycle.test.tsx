import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GetMcpStatusResp } from '@shared/api/svcState'
import { useRuntimeMcpStatusSource } from './useRuntimeMcpStatus'

const { getMcpStatus } = vi.hoisted(() => ({
  getMcpStatus: vi.fn<() => Promise<GetMcpStatusResp>>()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcState: { getMcpStatus } })
}))

const status = (count: number): GetMcpStatusResp => ({
  client: { connections: [], discoveredToolCount: count },
  server: { enabled: true, path: '/api/mcp', exposeResources: false, authRequired: false }
})

const deferred = () => {
  let resolve!: (value: GetMcpStatusResp) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<GetMcpStatusResp>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const renderStatus = () =>
  renderHook(
    ({ enabled, refreshTrigger }) =>
      useRuntimeMcpStatusSource({ enabled, refreshTrigger, refreshIntervalMs: 0 }),
    { initialProps: { enabled: true, refreshTrigger: 0 } }
  )

beforeEach(() => {
  getMcpStatus.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MCP status refresh ownership', () => {
  it('does not let an older config refresh replace the newer result', async () => {
    const older = deferred()
    const newer = deferred()
    getMcpStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = renderStatus()
    rerender({ enabled: true, refreshTrigger: 1 })

    await act(async () => newer.resolve(status(2)))
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
    await act(async () => older.resolve(status(1)))
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
    expect(result.current.isRuntimeMcpStatusLoading).toBe(false)
  })

  it('keeps loading true while the newest request is pending', async () => {
    const older = deferred()
    const newer = deferred()
    getMcpStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = renderStatus()
    rerender({ enabled: true, refreshTrigger: 1 })

    await act(async () => older.resolve(status(1)))
    expect(result.current.isRuntimeMcpStatusLoading).toBe(true)
    expect(result.current.runtimeMcpStatus).toBeNull()
    await act(async () => newer.resolve(status(2)))
    expect(result.current.isRuntimeMcpStatusLoading).toBe(false)
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
  })

  it('ignores stale failures after a newer refresh succeeds', async () => {
    const older = deferred()
    const newer = deferred()
    getMcpStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = renderStatus()
    rerender({ enabled: true, refreshTrigger: 1 })

    await act(async () => newer.resolve(status(2)))
    await act(async () => older.reject(new Error('obsolete failure')))
    expect(result.current.runtimeMcpStatusError).toBeNull()
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('invalidates pending work immediately when disabled and refreshes when reenabled', async () => {
    const older = deferred()
    const newer = deferred()
    getMcpStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = renderStatus()
    rerender({ enabled: false, refreshTrigger: 0 })
    expect(result.current.isRuntimeMcpStatusLoading).toBe(false)
    await act(async () => older.resolve(status(1)))
    expect(result.current.runtimeMcpStatus).toBeNull()
    await expect(result.current.refreshRuntimeMcpStatus()).resolves.toBeNull()
    expect(getMcpStatus).toHaveBeenCalledTimes(1)

    rerender({ enabled: true, refreshTrigger: 0 })
    await act(async () => newer.resolve(status(2)))
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
  })

  it('does not dispatch a retained refresh callback after unmount', async () => {
    const pending = deferred()
    getMcpStatus.mockReturnValueOnce(pending.promise)
    const { result, unmount } = renderStatus()
    const refresh = result.current.refreshRuntimeMcpStatus
    unmount()
    await expect(refresh()).resolves.toBeNull()
    expect(getMcpStatus).toHaveBeenCalledTimes(1)
    await act(async () => pending.reject(new Error('unmounted')))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('ignores a StrictMode effect generation after cleanup', async () => {
    const older = deferred()
    const newer = deferred()
    getMcpStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result } = renderHook(
      () => useRuntimeMcpStatusSource({ enabled: true, refreshTrigger: 0, refreshIntervalMs: 0 }),
      { wrapper: React.StrictMode }
    )
    expect(getMcpStatus).toHaveBeenCalledTimes(2)
    await act(async () => newer.resolve(status(2)))
    await act(async () => older.resolve(status(1)))
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
  })

  it('applies request ordering to manual and focus refreshes too', async () => {
    const older = deferred()
    const newer = deferred()
    getMcpStatus
      .mockResolvedValueOnce(status(0))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const { result } = renderStatus()
    await act(async () => {})
    let manual!: Promise<GetMcpStatusResp | null>
    act(() => {
      manual = result.current.refreshRuntimeMcpStatus()
    })
    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => newer.resolve(status(2)))
    await act(async () => older.resolve(status(1)))
    await expect(manual).resolves.toEqual(status(1))
    expect(result.current.runtimeMcpStatus).toEqual(status(2))
  })

  it('reports a current error and clears it on a successful retry', async () => {
    getMcpStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(status(3))
    const { result } = renderStatus()
    await act(async () => {})
    expect(result.current.runtimeMcpStatusError).toBe('offline')
    expect(result.current.isRuntimeMcpStatusLoading).toBe(false)
    await act(async () => {
      await result.current.refreshRuntimeMcpStatus()
    })
    expect(result.current.runtimeMcpStatusError).toBeNull()
    expect(result.current.runtimeMcpStatus).toEqual(status(3))
  })
})
