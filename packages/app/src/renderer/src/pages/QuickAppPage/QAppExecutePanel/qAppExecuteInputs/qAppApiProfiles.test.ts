import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { findQAppApiProfile, getQAppApiProfiles } from './qAppApiProfiles'

describe('getQAppApiProfiles', () => {
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

  it('falls back to agent api profiles when quick app profiles are empty', () => {
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

  it('selects the requested quick app profile id when it is configured', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-text',
            model_name: 'quick-text-model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-text-key'
          },
          {
            id: 'quick-vision',
            model_name: 'quick-vision-model',
            base_url: 'https://quick-vision.example/v1',
            api_key: 'quick-vision-key',
            is_vision_model: true
          }
        ]
      }
    }

    expect(findQAppApiProfile(config, { profileId: 'quick-text' })?.id).toBe('quick-text')
  })

  it('falls back to a configured vision quick app profile when the selected profile cannot satisfy vision', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-text',
            model_name: 'quick-text-model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-text-key'
          },
          {
            id: 'quick-vision',
            model_name: 'quick-vision-model',
            base_url: 'https://quick-vision.example/v1',
            api_key: 'quick-vision-key',
            is_vision_model: true
          }
        ]
      }
    }

    expect(
      findQAppApiProfile(config, {
        profileId: 'quick-text',
        needVisionModel: true
      })?.id
    ).toBe('quick-vision')
  })

  it('prefers a non-video text quick app profile for generic quick app execution', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'kling-access-key',
            api_secret: 'kling-secret-key',
            provider: 'kling' as const,
            model_use: 'video' as const
          },
          {
            id: 'quick-vision',
            model_name: 'quick-vision-model',
            base_url: 'https://quick-vision.example/v1',
            api_key: 'quick-vision-key',
            is_vision_model: true
          },
          {
            id: 'quick-text',
            model_name: 'quick-text-model',
            base_url: 'https://quick.example/v1',
            api_key: 'quick-text-key'
          }
        ]
      }
    }

    expect(findQAppApiProfile(config)?.id).toBe('quick-text')
  })

  it('does not use video-only quick app profiles for generic text execution', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'kling-access-key',
            api_secret: 'kling-secret-key',
            provider: 'kling' as const,
            model_use: 'video' as const
          }
        ]
      }
    }

    expect(findQAppApiProfile(config)).toBeUndefined()
  })

  it('still selects video quick app profiles when explicitly requested by id', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-video',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'kling-access-key',
            api_secret: 'kling-secret-key',
            provider: 'kling' as const,
            model_use: 'video' as const
          }
        ]
      }
    }

    expect(findQAppApiProfile(config, { profileId: 'quick-video' })?.id).toBe('quick-video')
  })

  it('treats Ollama quick app profiles without API keys as configured', () => {
    const config = {
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        api_profiles: [
          {
            id: 'quick-ollama',
            model_name: 'llama3.2',
            base_url: 'http://localhost:11434',
            api_key: '',
            is_ollama: true
          }
        ]
      }
    }

    expect(findQAppApiProfile(config)?.id).toBe('quick-ollama')
  })
})
