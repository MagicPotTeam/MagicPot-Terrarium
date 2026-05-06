import { useEffect, useMemo, useState } from 'react'
import { Config, LLMAPIProfile } from '@shared/config/config'
import {
  buildChatAvailableProfiles,
  buildRemoteLlmServerErrorMessage,
  buildRemoteLlmServerHeaders,
  getRemoteLlmServerAccessToken,
  getRemoteLlmServerOrigin
} from '@renderer/utils/llmProfileUtils'

/**
 * LLM profile management hook.
 * Loads remote and local profiles, then exposes the merged available profile list.
 */
export function useChatProfiles(config: Config, isReady: boolean, enabled: boolean = true) {
  const [remoteProfiles, setRemoteProfiles] = useState<LLMAPIProfile[]>([])
  const remoteLlmServerOrigin = useMemo(
    () => getRemoteLlmServerOrigin(config).replace(/\/+$/, ''),
    [config]
  )
  const remoteLlmServerAccessToken = useMemo(() => getRemoteLlmServerAccessToken(config), [config])

  useEffect(() => {
    if (!enabled || !config?.use_remote_llm) return

    let cancelled = false
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 30000)
    fetch(`${remoteLlmServerOrigin}/api/profiles`, {
      headers: buildRemoteLlmServerHeaders(config),
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
        console.log('[ChatPage] Remote LLM profiles', data)
        const profiles = data?.profiles || data || []
        setRemoteProfiles(Array.isArray(profiles) ? profiles : [])
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
  }, [config?.use_remote_llm, enabled, remoteLlmServerAccessToken, remoteLlmServerOrigin, isReady])

  const availableProfiles = useMemo(
    () => buildChatAvailableProfiles(config, remoteProfiles),
    [config, remoteProfiles]
  )

  return { availableProfiles, remoteProfiles }
}
