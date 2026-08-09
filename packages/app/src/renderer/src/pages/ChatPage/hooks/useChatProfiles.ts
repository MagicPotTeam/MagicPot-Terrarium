import { useEffect, useMemo, useRef, useState } from 'react'
import { Config, LLMAPIProfile } from '@shared/config/config'
import { isRunnableProfile } from '@shared/llm'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import {
  buildChatAvailableProfiles,
  buildRemoteLlmServerErrorMessage,
  buildRemoteLlmServerHeaders,
  getRemoteLlmServerAccessToken,
  getRemoteLlmServerOrigin,
  normalizeRemoteLlmProfiles
} from '@renderer/utils/llmProfileUtils'

/**
 * LLM profile management hook.
 * Loads remote and local profiles, then exposes the merged available profile list.
 */
export function useChatProfiles(config: Config, isReady: boolean, enabled: boolean = true) {
  const [remoteProfiles, setRemoteProfiles] = useState<LLMAPIProfile[]>([])
  const [discoveredModelsByProfileId, setDiscoveredModelsByProfileId] = useState<
    Record<string, string[]>
  >({})
  const discoveryGenerationRef = useRef(0)
  const remoteLlmServerOrigin = useMemo(
    () => getRemoteLlmServerOrigin(config).replace(/\/+$/, ''),
    [config]
  )
  const remoteLlmServerAccessToken = useMemo(() => getRemoteLlmServerAccessToken(config), [config])
  const remoteLlmServerHeaders = useMemo(() => buildRemoteLlmServerHeaders(config), [config])
  const useRemoteLlm = Boolean(config?.use_remote_llm)

  useEffect(() => {
    if (!enabled || !useRemoteLlm) return

    let cancelled = false
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 30000)
    fetch(`${remoteLlmServerOrigin}/api/profiles`, {
      headers: remoteLlmServerHeaders,
      signal: ac.signal
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(buildRemoteLlmServerErrorMessage('profiles', res, await res.text()))
        }
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setRemoteProfiles(normalizeRemoteLlmProfiles(data))
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[ChatPage] Failed to load remote LLM profiles:', err)
        setRemoteProfiles([])
      })
      .finally(() => clearTimeout(tid))

    return () => {
      cancelled = true
      ac.abort()
      clearTimeout(tid)
    }
  }, [
    enabled,
    remoteLlmServerAccessToken,
    remoteLlmServerHeaders,
    remoteLlmServerOrigin,
    isReady,
    useRemoteLlm
  ])

  useEffect(() => {
    const generation = ++discoveryGenerationRef.current
    const profiles = (config?.llm_config?.api_profiles || []).filter(isRunnableProfile)
    const profileIds = new Set(profiles.map((profile) => profile.id))

    // Configuration can change while this pane is inactive. Drop discoveries whose
    // base profile no longer exists, but retain valid discoveries across deactivation.
    setDiscoveredModelsByProfileId((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([profileId]) => !useRemoteLlm && profileIds.has(profileId))
      )
      return Object.keys(retained).length === Object.keys(current).length ? current : retained
    })

    if (!enabled || !isReady || useRemoteLlm || profiles.length === 0) return

    const controller = new AbortController()
    void Promise.all(
      profiles.map(async (profile) => {
        try {
          if (controller.signal.aborted) return null
          const modelNames = await rendererHostExtensionApiV1.chat?.discoverModelNames?.(profile)
          return [profile.id, modelNames || []] as const
        } catch (error) {
          console.warn('[ChatPage] Failed to discover CLIProxyAPI/Codex models:', error)
          return null
        }
      })
    ).then((entries) => {
      if (controller.signal.aborted || discoveryGenerationRef.current !== generation) return

      // Successful results replace active discoveries (including an explicit empty
      // result). Failed results retain the last known-good models.
      setDiscoveredModelsByProfileId((current) => {
        const next = { ...current }
        for (const entry of entries) {
          if (entry) next[entry[0]] = entry[1]
        }
        return next
      })
    })

    return () => {
      controller.abort()
    }
  }, [config?.llm_config?.api_profiles, enabled, isReady, useRemoteLlm])

  const availableProfiles = useMemo(
    () => buildChatAvailableProfiles(config, remoteProfiles, discoveredModelsByProfileId),
    [config, discoveredModelsByProfileId, remoteProfiles]
  )

  return { availableProfiles, remoteProfiles }
}
