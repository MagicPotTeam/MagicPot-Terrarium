import type { LLMAPIProfile } from '@shared/config/config'
import { isRunnableProfile, resolveProfileCallType, resolveProfileModelUse, resolveProfileProvider } from '@shared/llm'
import { resolveOpenAIClientApiMode } from '@shared/llm/clients'

/** Main-only pure eligibility: NOT consent, execution or a money/token budget.
 * Use the same pinned exact endpoint for validation, client and fetch admission.
 * No alias, extension, provider gateway, query-key or route normalization. */
export function goalDispatchEndpoint(profile: LLMAPIProfile): string {
  if (!isRunnableProfile(profile) || !['api', 'local'].includes(resolveProfileCallType(profile)) || resolveProfileProvider(profile) !== 'openai' || !['chat', 'agent', 'vision', 'multimodal'].includes(resolveProfileModelUse(profile)) || profile.auth_mode === 'codex_oauth' || profile.id.includes('::') || profile.tagger_endpoint || profile.tagger_provider && profile.tagger_provider !== 'default' || resolveOpenAIClientApiMode(profile.base_url, profile.model_name, { apiMode: profile.api_mode, modelUse: resolveProfileModelUse(profile), callType: resolveProfileCallType(profile) }) !== 'chat-completions') throw new Error('Dispatch cap supports only an exact ordinary local OpenAI Chat Completions text profile.')
  const exact = profile.base_url.trim().replace(/\/$/, '').replace(/\/images$/i, ''), url = new URL(exact)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href) || url.href.length > 4096 || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Dispatch cap requires a supported exact endpoint, no query, credentials or redirects.')
  return url.href
}
