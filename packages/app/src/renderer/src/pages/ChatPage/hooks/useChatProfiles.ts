import { useEffect, useMemo, useState } from 'react'
import { Config, LLMAPIProfile } from '@shared/config/config'
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
  const [cliProxyModelsByProfileId, setCliProxyModelsByProfileId] = useState<
    Record<string, string[]>
  >({})
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
    if (!enabled || !isReady || useRemoteLlm) {
      setCliProxyModelsByProfileId({})
      return
    }

    const profiles = (config?.llm_config?.api_profiles || []).filter(
      (profile) =>
        profile.call_type === 'cliproxyapi' &&
        Boolean(profile.base_url?.trim() && profile.api_key?.trim())
    )
    if (profiles.length === 0) {
      setCliProxyModelsByProfileId({})
      return
    }

    let cancelled = false
    const controller = new AbortController()
    void Promise.all(
      profiles.map(async (profile) => {
        try {
          if (controller.signal.aborted) return [profile.id, []] as const
          const modelNames = await rendererHostExtensionApiV1.chat?.discoverModelNames?.(profile)
          return [profile.id, modelNames || []] as const
        } catch (error) {
          console.warn('[ChatPage] Failed to discover CLIProxyAPI/Codex models:', error)
          return [profile.id, []] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) {
        setCliProxyModelsByProfileId(Object.fromEntries(entries))
      }
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [config?.llm_config?.api_profiles, enabled, isReady, useRemoteLlm])

  const availableProfiles = useMemo(
    () => buildChatAvailableProfiles(config, remoteProfiles, cliProxyModelsByProfileId),
    [cliProxyModelsByProfileId, config, remoteProfiles]
  )

  return { availableProfiles, remoteProfiles }
}
