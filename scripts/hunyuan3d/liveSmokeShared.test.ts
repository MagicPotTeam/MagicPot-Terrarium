import { describe, expect, it } from 'vitest'
import type { Config } from '../../packages/app/src/shared/config/config'

import {
  getProSmokeConfig,
  getRapidSmokeConfig,
  normalizeSmokePrefix,
  parseHunyuanLiveSmokeMode
} from './liveSmokeShared'

describe('parseHunyuanLiveSmokeMode', () => {
  it('defaults to rapid when no mode is provided', () => {
    expect(parseHunyuanLiveSmokeMode(undefined)).toBe('rapid')
  })

  it('accepts pro and all explicitly', () => {
    expect(parseHunyuanLiveSmokeMode('pro')).toBe('pro')
    expect(parseHunyuanLiveSmokeMode('all')).toBe('all')
  })

  it('rejects unsupported mode values', () => {
    expect(() => parseHunyuanLiveSmokeMode('weird')).toThrow('Unsupported Hunyuan3D smoke mode')
  })
})

describe('normalizeSmokePrefix', () => {
  it('keeps the default prefix when the config is empty', () => {
    expect(normalizeSmokePrefix('')).toBe('magicpot/hunyuan3d')
  })

  it('trims surrounding slashes from configured prefixes', () => {
    expect(normalizeSmokePrefix('/demo/hunyuan/')).toBe('demo/hunyuan')
  })
})

describe('getRapidSmokeConfig', () => {
  it('reads Tencent credentials and COS settings from aigc3d_config', () => {
    expect(
      getRapidSmokeConfig({
        aigc3d_config: {
          tencent_secret_id: 'sid',
          tencent_secret_key: 'skey',
          api_region: '',
          cos_bucket: 'bucket-a',
          cos_region: 'ap-shanghai',
          cos_key_prefix: '/demo/prefix/'
        }
      } as Partial<Config>)
    ).toEqual({
      credentials: {
        secretId: 'sid',
        secretKey: 'skey'
      },
      apiRegion: 'ap-guangzhou',
      cos: {
        bucket: 'bucket-a',
        region: 'ap-shanghai',
        keyPrefix: 'demo/prefix'
      }
    })
  })

  it('throws when Tencent credentials are missing', () => {
    expect(() =>
      getRapidSmokeConfig({
        aigc3d_config: {
          tencent_secret_id: '',
          tencent_secret_key: '',
          api_region: '',
          cos_bucket: 'bucket-a',
          cos_region: 'ap-guangzhou',
          cos_key_prefix: 'demo'
        }
      } as Partial<Config>)
    ).toThrow('Missing Tencent SecretId/SecretKey')
  })
})

describe('getProSmokeConfig', () => {
  it('finds a runnable Hunyuan API-key profile in plugin profiles first', () => {
    expect(
      getProSmokeConfig({
        plugin_config: {
          api_profiles: [
            {
              id: 'hy3d-api',
              model_name: 'hunyuan3d-pro',
              base_url: 'https://api.ai3d.cloud.tencent.com',
              api_key: 'hy-token'
            }
          ]
        }
      } as Partial<Config>)
    ).toEqual({
      apiKey: 'hy-token',
      baseURL: 'https://api.ai3d.cloud.tencent.com',
      profileId: 'hy3d-api',
      modelName: 'hunyuan3d-pro'
    })
  })

  it('throws when no runnable Hunyuan API-key profile is configured', () => {
    expect(() =>
      getProSmokeConfig({
        llm_config: {
          api_profiles: [
            {
              id: 'other',
              model_name: 'gpt-4.1',
              base_url: 'https://api.openai.com/v1',
              api_key: 'sk-test'
            }
          ]
        }
      } as Partial<Config>)
    ).toThrow('Missing a runnable Hunyuan3D API-key profile')
  })
})
