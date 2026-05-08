import { findHunyuan3DQAppProfile } from '../../packages/app/src/shared/config/apiProfileSelectors'
import { DEFAULT_CONFIG, type Config } from '../../packages/app/src/shared/config/config'

export type HunyuanLiveSmokeMode = 'rapid' | 'pro' | 'all'

export type HunyuanRapidSmokeConfig = {
  credentials: {
    secretId: string
    secretKey: string
  }
  apiRegion: string
  cos: {
    bucket: string
    region: string
    keyPrefix: string
  }
}

export type HunyuanProSmokeConfig = {
  apiKey: string
  baseURL: string
  profileId: string
  modelName: string
}

const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'

const normalizeModeValue = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()

const withDefaultConfig = (config: Partial<Config>): Config => ({
  ...DEFAULT_CONFIG,
  ...config,
  aigc3d_config: {
    ...DEFAULT_CONFIG.aigc3d_config,
    ...(config.aigc3d_config || {})
  },
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    ...(config.llm_config || {}),
    api_profiles: config.llm_config?.api_profiles || []
  },
  plugin_config: {
    ...DEFAULT_CONFIG.plugin_config,
    ...(config.plugin_config || {}),
    api_profiles: config.plugin_config?.api_profiles || []
  }
})

export const parseHunyuanLiveSmokeMode = (value: string | undefined): HunyuanLiveSmokeMode => {
  const normalized = normalizeModeValue(value)
  if (!normalized) return 'rapid'
  if (normalized === 'rapid' || normalized === 'pro' || normalized === 'all') {
    return normalized
  }

  throw new Error(`Unsupported Hunyuan3D smoke mode "${value}". Expected one of: rapid, pro, all.`)
}

export const normalizeSmokePrefix = (value: string | undefined): string =>
  String(value || 'magicpot/hunyuan3d')
    .trim()
    .replace(/^\/+|\/+$/g, '')

export const getRapidSmokeConfig = (config: Partial<Config>): HunyuanRapidSmokeConfig => {
  const mergedConfig = withDefaultConfig(config)
  const aigc3dConfig = mergedConfig.aigc3d_config || DEFAULT_CONFIG.aigc3d_config

  const secretId = String(aigc3dConfig?.tencent_secret_id || '').trim()
  const secretKey = String(aigc3dConfig?.tencent_secret_key || '').trim()
  const apiRegion = String(aigc3dConfig?.api_region || '').trim() || DEFAULT_HY3D_API_REGION
  const cosBucket = String(aigc3dConfig?.cos_bucket || '').trim()
  const cosRegion = String(aigc3dConfig?.cos_region || '').trim()
  const cosKeyPrefix = normalizeSmokePrefix(aigc3dConfig?.cos_key_prefix)

  if (!secretId || !secretKey) {
    throw new Error('Missing Tencent SecretId/SecretKey in the configured Hunyuan3D settings.')
  }

  if (!cosBucket || !cosRegion) {
    throw new Error('Missing COS bucket or region in the configured Hunyuan3D settings.')
  }

  return {
    credentials: {
      secretId,
      secretKey
    },
    apiRegion,
    cos: {
      bucket: cosBucket,
      region: cosRegion,
      keyPrefix: cosKeyPrefix
    }
  }
}

export const getProSmokeConfig = (config: Partial<Config>): HunyuanProSmokeConfig => {
  const mergedConfig = withDefaultConfig(config)
  const profile = findHunyuan3DQAppProfile(mergedConfig)

  if (!profile?.api_key || !profile.base_url) {
    throw new Error(
      'Missing a runnable Hunyuan3D API-key profile with both API Key and Base URL in the configured Quick App profiles.'
    )
  }

  return {
    apiKey: profile.api_key.trim(),
    baseURL: profile.base_url.trim(),
    profileId: profile.id,
    modelName: profile.model_name
  }
}
