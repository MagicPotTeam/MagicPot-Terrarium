import type { Config, LLMAPIProfile } from '@shared/config/config'
import { parseCodexModelProfileId } from './codexModelCatalog'
import { resolveProfileModelUse } from '@shared/llm/utils'
import { validateProviderBaseUrl } from '@shared/llm/providerEndpointPolicy'

/** Pure eligibility only: no login, discovery, network, credential copying or fallback.
 * Used by both the existing settings card and the MAIN capability factory.
 */
export function resolveCodexImageBackend(
  profile: LLMAPIProfile
): { backend: 'codex-json-oauth' | 'codex-json-api-key' | 'openai-images-api-key'; endpoint: string } | undefined {
  if (['image', 'video', 'ocr'].includes(resolveProfileModelUse(profile))) return undefined
  if (profile.call_type === 'cliproxyapi') {
    if (profile.auth_mode && profile.auth_mode !== 'api_key') return undefined
    if (
      typeof profile.api_key !== 'string' ||
      !profile.api_key.trim() ||
      /[\r\n]/u.test(profile.api_key)
    )
      return undefined
    try {
      const endpoint = validateProviderBaseUrl(profile.base_url).replace(/\/+$/u, '')
      const parsed = new URL(endpoint)
      if (
        parsed.hostname.toLowerCase().replace(/\.$/u, '') === 'api.openai.com' ||
        /\/(responses|chat\/completions|images(?:\/(?:edits|generations))?)$/iu.test(
          decodeURIComponent(parsed.pathname)
        )
      )
        return undefined
      return { backend: /\/v1$/i.test(parsed.pathname) ? 'openai-images-api-key' : 'codex-json-api-key', endpoint }
    } catch {
      return undefined
    }
  }
  if (
    profile.auth_mode === 'codex_oauth' &&
    (!profile.call_type || profile.call_type === 'codex')
  ) {
    return { backend: 'codex-json-oauth', endpoint: 'https://chatgpt.com/backend-api/codex' }
  }
  return undefined
}


/** Resolve a selected LOCAL chat profile to its configured image backend. Returns
 * identifiers and non-secret routing metadata only; never returns profile credentials.
 */
export function resolveCodexThreadImageCapability(
  config: Pick<Config, 'llm_config' | 'use_remote_llm'>,
  profileId: string | null | undefined
): { sourceProfileId: string; imageProfileId: string; backend: NonNullable<ReturnType<typeof resolveCodexImageBackend>>['backend']; endpoint: string } | undefined {
  if (config.use_remote_llm || !profileId) return undefined
  const sourceProfileId = parseCodexModelProfileId(profileId)?.profileId ?? profileId
  const sources = config.llm_config.api_profiles.filter((candidate) => candidate.id === sourceProfileId)
  if (sources.length !== 1 || ['image', 'video', 'ocr'].includes(resolveProfileModelUse(sources[0]))) return undefined
  const selection = sources[0].codex_image_profile_id
  if (selection !== undefined && (typeof selection !== 'string' || !selection.trim() || selection !== selection.trim())) return undefined
  const imageProfileId = selection ?? sourceProfileId
  const targets = config.llm_config.api_profiles.filter((candidate) => candidate.id === imageProfileId)
  if (targets.length !== 1) return undefined
  const backend = resolveCodexImageBackend(targets[0])
  return backend ? { sourceProfileId, imageProfileId, ...backend } : undefined
}
