import { useCallback, useEffect, useRef, useState } from 'react'
import type { GetMcpStatusResp } from '@shared/api/svcState'
import { useConfig } from './useConfig'
import { api } from '@renderer/utils/windowUtils'

export const DEFAULT_RUNTIME_MCP_STATUS_REFRESH_INTERVAL_MS = 30_000

type UseRuntimeMcpStatusResult = {
  runtimeMcpStatus: GetMcpStatusResp | null
  refreshRuntimeMcpStatus: () => Promise<GetMcpStatusResp | null>
  isRuntimeMcpStatusLoading: boolean
  runtimeMcpStatusError: string | null
}

type RuntimeMcpStatusSourceOptions = {
  enabled: boolean
  refreshTrigger: unknown
  refreshIntervalMs?: number
}

export function useRuntimeMcpStatusSource({
  enabled,
  refreshTrigger,
  refreshIntervalMs = DEFAULT_RUNTIME_MCP_STATUS_REFRESH_INTERVAL_MS
}: RuntimeMcpStatusSourceOptions): UseRuntimeMcpStatusResult {
  const [runtimeMcpStatus, setRuntimeMcpStatus] = useState<GetMcpStatusResp | null>(null)
  const [isRuntimeMcpStatusLoading, setIsRuntimeMcpStatusLoading] = useState(false)
  const [runtimeMcpStatusError, setRuntimeMcpStatusError] = useState<string | null>(null)
  const isMountedRef = useRef(true)

  const refreshRuntimeMcpStatus = useCallback(async () => {
    if (!enabled) {
      return null
    }

    try {
      if (isMountedRef.current) {
        setIsRuntimeMcpStatusLoading(true)
        setRuntimeMcpStatusError(null)
      }
      const runtimeApi = api()?.svcState
      if (!runtimeApi?.getMcpStatus) {
        return null
      }

      const nextStatus = await runtimeApi.getMcpStatus({})
      if (isMountedRef.current && nextStatus) {
        setRuntimeMcpStatus(nextStatus)
      }
      return nextStatus || null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[useRuntimeMcpStatus] Failed to load MCP runtime status:', error)
      if (isMountedRef.current) {
        setRuntimeMcpStatusError(message)
      }
      return null
    } finally {
      if (isMountedRef.current) {
        setIsRuntimeMcpStatusLoading(false)
      }
    }
  }, [enabled])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    const triggerRefresh = () => {
      if (cancelled) {
        return
      }
      void refreshRuntimeMcpStatus()
    }

    triggerRefresh()

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerRefresh()
      }
    }

    const handleFocus = () => {
      triggerRefresh()
    }

    const timerId =
      refreshIntervalMs > 0 ? window.setInterval(triggerRefresh, refreshIntervalMs) : null

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      if (timerId !== null) {
        window.clearInterval(timerId)
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [enabled, refreshIntervalMs, refreshRuntimeMcpStatus, refreshTrigger])

  return {
    runtimeMcpStatus,
    refreshRuntimeMcpStatus,
    isRuntimeMcpStatusLoading,
    runtimeMcpStatusError
  }
}

export function useRuntimeMcpStatus(
  refreshIntervalMs: number = DEFAULT_RUNTIME_MCP_STATUS_REFRESH_INTERVAL_MS,
  enabled: boolean = true
): UseRuntimeMcpStatusResult {
  const { config, isReady } = useConfig()

  return useRuntimeMcpStatusSource({
    enabled: isReady && enabled,
    refreshTrigger: config,
    refreshIntervalMs
  })
}
