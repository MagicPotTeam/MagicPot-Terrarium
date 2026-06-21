import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from './config'
import {
  findHunyuan3DQAppProfile,
  findTripo3DQAppProfile,
  getQAppApiProfiles,
  isConfiguredApiProfile,
  isConfiguredHunyuan3DProfile,
  isHunyuan3DCompatibleProfile,
  isTripo3DCompatibleProfile,
  isVisionCapableApiProfile
} from './apiProfileSelectors'

describe('apiProfileSelectors', () => {
  it('prefers quick app api profiles when they exist', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent',
            model_name: 'agent-model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin',
            model_name: 'plugin-model',
            base_url: 'https://plugin.example/v1',
            api_key: 'plugin-key'
          }
        ]
      }
    }

    expect(getQAppApiProfiles(config).map((profile) => profile.id)).toEqual(['plugin'])
  })

  it('keeps quick app profiles isolated from agent api profiles when quick app profiles are empty', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent',
            model_name: 'agent-model',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: []
      }
    }

    expect(getQAppApiProfiles(config).map((profile) => profile.id)).toEqual(['agent'])
  })

  it('keeps keyless quick app profiles isolated from matching agent profiles', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-openai',
            model_name: 'gpt-5.5',
            base_url: 'https://api.openai.com/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-openai',
            model_name: 'gpt-5.4',
            base_url: '',
            api_key: '',
            backup_api_keys: ['stale-key']
          }
        ]
      }
    }

    expect(getQAppApiProfiles(config)[0]).toEqual({
      id: 'quick-openai',
      model_name: 'gpt-5.4',
      base_url: '',
      api_key: '',
      backup_api_keys: ['stale-key']
    })
  })

  it('keeps explicitly keyed quick app profiles separate from matching agent profiles', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-openai',
            model_name: 'gpt-5.5',
            base_url: 'https://api.openai.com/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-openai',
            model_name: 'gpt-5.5',
            base_url: 'https://api.openai.com/v1',
            api_key: 'quick-key'
          }
        ]
      }
    }

    expect(getQAppApiProfiles(config)[0]).toEqual({
      id: 'quick-openai',
      model_name: 'gpt-5.5',
      base_url: 'https://api.openai.com/v1',
      api_key: 'quick-key'
    })
  })

  it('prefers hunyuan profiles from quick app api config', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-hunyuan',
            model_name: 'Hunyuan3D Agent',
            base_url: 'https://agent.example/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-hunyuan',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://ai3d.cloud.tencent.com/v1',
            api_key: 'plugin-key'
          }
        ]
      }
    }

    expect(findHunyuan3DQAppProfile(config)?.id).toBe('plugin-hunyuan')
  })

  it('falls back to agent hunyuan profiles when quick app profiles are empty', () => {
    const config = {
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        api_profiles: [
          {
            id: 'agent-hunyuan',
            model_name: 'Hunyuan3D Agent',
            base_url: 'https://ai3d.cloud.tencent.com/v1',
            api_key: 'agent-key'
          }
        ]
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: []
      }
    }

    expect(findHunyuan3DQAppProfile(config)?.id).toBe('agent-hunyuan')
  })

  it('treats Hunyuan3D Tencent credential profiles as configured without an API key', () => {
    const profile = {
      id: 'plugin-hunyuan-sdk',
      model_name: 'Hunyuan3D Pro',
      base_url: 'https://api.ai3d.cloud.tencent.com',
      api_key: '',
      tencent_secret_id: 'secret-id',
      tencent_secret_key: 'secret-key'
    }
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [profile]
      }
    }

    expect(isConfiguredHunyuan3DProfile(profile)).toBe(true)
    expect(findHunyuan3DQAppProfile(config)?.id).toBe('plugin-hunyuan-sdk')
  })

  it('detects Tripo profiles for the 3D quick app', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'plugin-tripo',
            model_name: 'Tripo v3.1',
            base_url: 'https://api.tripo3d.ai/v2/openapi',
            api_key: 'tripo-key'
          }
        ]
      }
    }

    expect(findTripo3DQAppProfile(config)?.id).toBe('plugin-tripo')
    expect(
      isTripo3DCompatibleProfile({
        id: 'proxy-tripo',
        model_name: '3D Model',
        base_url: 'https://api.302.ai/tripo3d/v2/openapi',
        api_key: 'proxy-key'
      })
    ).toBe(true)
    expect(
      isTripo3DCompatibleProfile({
        id: 'mainland-tripo',
        model_name: 'Tripo China',
        base_url: 'https://api.tripo3d.com/v2/openapi',
        api_key: 'tripo-cn-key'
      })
    ).toBe(true)
    expect(
      isTripo3DCompatibleProfile({
        id: 'not-tripo',
        model_name: 'Generic 3D',
        base_url: 'https://example.com/v1',
        api_key: 'key'
      })
    ).toBe(false)
  })

  it('matches Hunyuan3D Tencent endpoints by hostname only', () => {
    expect(
      isHunyuan3DCompatibleProfile({
        id: 'hunyuan',
        model_name: 'hunyuan',
        base_url: 'https://ai3d.cloud.tencent.com/v1',
        api_key: 'secret'
      })
    ).toBe(true)
    expect(
      isHunyuan3DCompatibleProfile({
        id: 'spoofed',
        model_name: 'hunyuan',
        base_url: 'https://gateway.example/ai3d.cloud.tencent.com/v1',
        api_key: 'secret'
      })
    ).toBe(false)
  })

  it('treats explicit vision profiles as vision-capable for quick app prompt helpers', () => {
    expect(
      isVisionCapableApiProfile({
        id: 'openai-vision',
        model_name: 'gpt-5.4',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test',
        model_use: 'vision'
      })
    ).toBe(true)
  })

  it('treats configured video profiles as runnable without marking them as vision-capable', () => {
    const profile = {
      id: 'kling-video',
      model_name: 'kling-v3',
      base_url: 'https://api-beijing.klingai.com',
      api_key: 'access-id',
      api_secret: 'secret-key',
      provider: 'kling' as const,
      model_use: 'video' as const
    }

    expect(isConfiguredApiProfile(profile)).toBe(true)
    expect(isVisionCapableApiProfile(profile)).toBe(false)
  })
})
