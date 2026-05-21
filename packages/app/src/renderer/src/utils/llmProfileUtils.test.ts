import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import {
  buildRemoteLlmServerErrorMessage,
  buildRemoteLlmServerHeaders,
  buildChatAvailableProfiles,
  getProfileDisplayName,
  getRemoteLlmServerAccessToken,
  getRemoteLlmServerOrigin,
  resolveAvailableChatProfileId
} from './llmProfileUtils'

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: []
  },
  local_llm_server_config: {
    ...DEFAULT_CONFIG.local_llm_server_config
  },
  remote_llm_server_config: {
    ...DEFAULT_CONFIG.remote_llm_server_config
  },
  aigc3d_config: {
    ...DEFAULT_CONFIG.aigc3d_config!
  }
})

describe('buildChatAvailableProfiles', () => {
  it('keeps only configured agent profiles even when Tencent credentials are configured', () => {
    const localProfile: LLMAPIProfile = {
      id: 'gemini',
      model_name: 'Gemini 2.5 Pro',
      base_url: 'https://example.com/v1',
      api_key: 'sk-test'
    }
    const config = createConfig()
    config.use_remote_llm = false
    config.llm_config.api_profiles = [localProfile]
    config.aigc3d_config = {
      ...DEFAULT_CONFIG.aigc3d_config!,
      tencent_secret_id: 'secret-id',
      tencent_secret_key: 'secret-key'
    }

    expect(buildChatAvailableProfiles(config, [])).toEqual([localProfile])
  })

  it('does not inject Hunyuan from quick app profiles', () => {
    const config = createConfig()
    config.use_remote_llm = false
    const localProfile: LLMAPIProfile = {
      id: 'glm',
      model_name: 'GLM-4.6V-Flash',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      api_key: 'agent-key'
    }
    config.llm_config.api_profiles = [localProfile]
    config.plugin_config = {
      ...DEFAULT_CONFIG.plugin_config!,
      api_profiles: [
        {
          id: 'plugin-hunyuan',
          model_name: 'Hunyuan3D Pro',
          base_url: 'https://ai3d.cloud.tencent.com/api',
          api_key: 'quick-app-key'
        }
      ]
    }

    expect(buildChatAvailableProfiles(config, [])).toEqual([localProfile])
  })

  it('does not inject the built-in Hunyuan entry from agent api profiles alone', () => {
    const localProfile: LLMAPIProfile = {
      id: 'agent-hunyuan',
      model_name: 'Hunyuan3D-Test',
      base_url: 'https://ai3d.cloud.tencent.com/api',
      api_key: 'sk-test'
    }
    const config = createConfig()
    config.use_remote_llm = false
    config.llm_config.api_profiles = [localProfile]

    expect(buildChatAvailableProfiles(config, [])).toEqual([localProfile])
  })

  it('keeps local OpenAI-compatible profiles without keys when they are marked local', () => {
    const config = createConfig()
    config.use_remote_llm = false
    const localProfile: LLMAPIProfile = {
      id: 'local-openai',
      model_name: 'qwen2.5-vl',
      base_url: 'http://127.0.0.1:8000/v1',
      api_key: '',
      provider: 'openai',
      deployment: 'local'
    }
    config.llm_config.api_profiles = [localProfile]

    expect(buildChatAvailableProfiles(config, [])).toEqual([localProfile])
  })

  it('keeps remote profiles', () => {
    const config = createConfig()
    config.use_remote_llm = true
    const remoteProfiles: LLMAPIProfile[] = [
      { id: 'claude', model_name: 'Claude', base_url: '', api_key: '' }
    ]

    expect(buildChatAvailableProfiles(config, remoteProfiles)).toEqual([...remoteProfiles])
  })
})

describe('llmProfileUtils helpers', () => {
  it('reads the remote server origin with a safe default', () => {
    expect(getRemoteLlmServerOrigin(undefined)).toBe('http://localhost:3721')
    expect(getRemoteLlmServerOrigin(createConfig())).toBe('http://127.0.0.1:3721')
  })

  it('reads the remote server access token with a safe default', () => {
    expect(getRemoteLlmServerAccessToken(undefined)).toBe('')
    expect(getRemoteLlmServerAccessToken(createConfig())).toBe('')

    const config = createConfig()
    config.remote_llm_server_config.access_token = '  proxy-secret  '

    expect(getRemoteLlmServerAccessToken(config)).toBe('proxy-secret')
  })

  it('injects a bearer token for remote server requests when configured', () => {
    const config = createConfig()
    config.remote_llm_server_config.access_token = 'proxy-secret'

    expect(buildRemoteLlmServerHeaders(config)).toEqual({
      Authorization: 'Bearer proxy-secret'
    })
    expect(
      buildRemoteLlmServerHeaders(config, {
        'Content-Type': 'application/json'
      })
    ).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer proxy-secret'
    })
    expect(
      buildRemoteLlmServerHeaders(config, {
        Authorization: 'Bearer existing-token'
      })
    ).toEqual({
      Authorization: 'Bearer existing-token'
    })
  })

  it('formats unauthorized remote errors with a token hint', () => {
    expect(
      buildRemoteLlmServerErrorMessage(
        'chat',
        { status: 401, statusText: 'Unauthorized' } as Pick<Response, 'status' | 'statusText'>,
        JSON.stringify({
          error:
            'Unauthorized LLM proxy request. Provide Authorization: Bearer <token>, X-MagicPot-Proxy-Token, or legacy X-MagicPot-Bot-Secret/X-Bot-Secret.'
        })
      )
    ).toContain('access token matches the server configuration')
  })

  it('includes server details in general remote error messages', () => {
    expect(
      buildRemoteLlmServerErrorMessage(
        'profiles',
        { status: 500, statusText: 'Internal Server Error' } as Pick<
          Response,
          'status' | 'statusText'
        >,
        '{"message":"upstream exploded"}'
      )
    ).toContain('Server message: upstream exploded')
  })

  it('returns a readable profile name fallback', () => {
    const profiles: LLMAPIProfile[] = [{ id: 'foo', model_name: 'Foo', base_url: '', api_key: '' }]

    expect(getProfileDisplayName(profiles, 'foo')).toBe('Foo')
    expect(getProfileDisplayName(profiles, 'missing')).toBe('Gemini')
    expect(getProfileDisplayName(profiles, 'missing', 'Unknown')).toBe('Unknown')
  })

  it('clears a stale Hunyuan selection when no profile is available', () => {
    expect(resolveAvailableChatProfileId([], 'hunyuan3d-pro')).toBeNull()
  })

  it('keeps ordinary restored profile ids while the profile list is still empty', () => {
    expect(resolveAvailableChatProfileId([], 'gemini-pro')).toBe('gemini-pro')
  })

  it('normalizes composite ids against the available profile list', () => {
    expect(resolveAvailableChatProfileId([{ id: 'foo' }], 'foo::variant')).toBe('foo')
    expect(
      resolveAvailableChatProfileId([{ id: 'foo' }, { id: 'foo::variant' }], 'foo::variant')
    ).toBe('foo::variant')
    expect(resolveAvailableChatProfileId([{ id: 'foo' }], 'bar')).toBeNull()
  })
})
