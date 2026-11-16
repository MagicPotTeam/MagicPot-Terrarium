import { resolveProfileCallType, resolveProfileProvider } from '@shared/llm'
import type { LLMAPIProfile } from '@shared/config/config'

/** Fields of a model profile that tell where its model runs. */
export type ChatModelSwitcherSource = Partial<
  Pick<LLMAPIProfile, 'provider' | 'base_url' | 'call_type' | 'model_use' | 'model_name'>
>

const hostOf = (url: string | undefined) => {
  if (!url?.trim()) return ''
  try {
    return new URL(url.trim()).host
  } catch {
    return ''
  }
}

/**
 * The second line of a model row: "local" for a local model, the provider chosen in Settings
 * ("openai", "claude", …), else the API host, else the provider the profile resolves to.
 * Profile ids are random UUIDs and are never shown.
 */
export const getModelSwitcherDetail = (profile: ChatModelSwitcherSource): string => {
  if (resolveProfileCallType(profile) === 'local') return 'local'
  const explicit = profile.provider && profile.provider !== 'default' ? profile.provider : ''
  return explicit || hostOf(profile.base_url) || resolveProfileProvider(profile) || ''
}
