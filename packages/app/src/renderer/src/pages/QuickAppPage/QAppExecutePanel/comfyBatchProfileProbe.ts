import { api } from '@renderer/utils/windowUtils'
import type { ComfyBatchProfile, ComfyBatchProbeResult } from '@shared/api/svcComfyBatch'
import { useCallback, useEffect, useState } from 'react'

export type ComfyBatchProfileProbeState = {
  probeResults: Record<string, ComfyBatchProbeResult>
  isProbingAll: boolean
  probeAllProfiles: () => Promise<void>
}

export function useComfyBatchProfileProbe(
  profiles: ComfyBatchProfile[]
): ComfyBatchProfileProbeState {
  const [probeResults, setProbeResults] = useState<Record<string, ComfyBatchProbeResult>>({})
  const [isProbingAll, setIsProbingAll] = useState(false)

  const probeProfile = useCallback(async (profile: ComfyBatchProfile) => {
    try {
      const result = await api().svcComfyBatch.probeProfile({ baseUrl: profile.baseUrl })
      setProbeResults((current) => ({ ...current, [profile.id]: result.result }))
    } catch (error) {
      setProbeResults((current) => ({
        ...current,
        [profile.id]: {
          ok: false,
          baseUrl: profile.baseUrl,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  }, [])

  const probeAllProfiles = useCallback(async () => {
    setIsProbingAll(true)
    try {
      await Promise.all(profiles.map((profile) => probeProfile(profile)))
    } finally {
      setIsProbingAll(false)
    }
  }, [probeProfile, profiles])

  useEffect(() => {
    setProbeResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => profiles.some((profile) => profile.id === id))
      )
    )
  }, [profiles])

  return { probeResults, isProbingAll, probeAllProfiles }
}
