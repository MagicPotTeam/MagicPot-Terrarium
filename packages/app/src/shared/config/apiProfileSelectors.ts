import { isRunnableProfile, resolveProfileModelUse } from '@shared/llm'
import type { Config, LLMAPIProfile } from './config'

export const getQAppApiProfiles = (config: Config): LLMAPIProfile[] => {
  const pluginProfiles = config.plugin_config?.api_profiles ?? []
  if (pluginProfiles.length > 0) {
    return pluginProfiles
  }
  return config.llm_config?.api_profiles ?? []
}

export const isConfiguredApiProfile = (profile: LLMAPIProfile): boolean =>
  isRunnableProfile(profile)

const hasConfiguredHunyuan3DSecretCredentials = (profile: LLMAPIProfile): boolean =>
  Boolean(profile.tencent_secret_id?.trim() && profile.tencent_secret_key?.trim())

const getProfileBaseHostname = (value: string): string | null => {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null

  const parseHostname = (candidate: string): string | null => {
    try {
      return new URL(candidate).hostname.toLowerCase()
    } catch {
      return null
    }
  }

  return (
    parseHostname(normalized) ||
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? null : parseHostname(`https://${normalized}`))
  )
}

const hostnameMatchesDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`)

const isTencentHunyuan3DHostname = (hostname: string): boolean =>
  hostnameMatchesDomain(hostname, 'ai3d.cloud.tencent.com') ||
  hostnameMatchesDomain(hostname, 'hunyuan.cloud.tencent.com')

export const isVisionCapableApiProfile = (profile: LLMAPIProfile): boolean => {
  const modelUse = resolveProfileModelUse(profile)
  return (
    Boolean(profile.is_vision_model) ||
    modelUse === 'agent' ||
    modelUse === 'multimodal' ||
    modelUse === 'vision' ||
    modelUse === 'ocr'
  )
}

export const isHunyuan3DCompatibleProfile = (profile: LLMAPIProfile): boolean => {
  if (!profile.model_name || !profile.base_url) return false
  const modelName = profile.model_name.toLowerCase()
  const baseHostname = getProfileBaseHostname(profile.base_url)
  const isTencentHunyuan3DBaseUrl = Boolean(
    baseHostname && isTencentHunyuan3DHostname(baseHostname)
  )
  return (
    modelName.includes('hunyuan3d') ||
    (modelName.includes('hunyuan') && isTencentHunyuan3DBaseUrl) ||
    isTencentHunyuan3DBaseUrl
  )
}

export const isConfiguredHunyuan3DProfile = (profile: LLMAPIProfile): boolean =>
  isHunyuan3DCompatibleProfile(profile) &&
  (isConfiguredApiProfile(profile) || hasConfiguredHunyuan3DSecretCredentials(profile))

export const findHunyuan3DQAppProfile = (config: Config): LLMAPIProfile | undefined =>
  getQAppApiProfiles(config).find(isConfiguredHunyuan3DProfile)
