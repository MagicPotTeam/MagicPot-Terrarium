import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { buildCodexModelProfileId } from '@shared/llm/modelCatalog'
import {
  buildRemoteLlmServerErrorMessage,
  buildRemoteLlmServerHeaders,
  buildChatAvailableProfiles,
  getProfileDisplayName,
  isChatProfileDiscoveryCandidate,
  getRemoteLlmServerAccessToken,
  getRemoteLlmServerOrigin,
  disconnectExternalProfile,
  normalizeRemoteLlmProfiles,
  resolveAvailableChatProfileId,
  stripProviderMetadataProfile,
  stripExternalAuthProfile,
  upsertLlmProfile
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
  it('keeps generic profiles out of discovery unless an extension claims them', () => {
    const profile: LLMAPIProfile = {
      id: 'openai-profile',
      model_name: '',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test'
    }
    expect(isChatProfileDiscoveryCandidate(profile)).toBe(false)
  })

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

  it('expands Codex OAuth profiles from the same discovered model catalog as CLIProxyAPI', () => {
    const config = createConfig()
    config.use_remote_llm = false
    config.llm_config.api_profiles = [
      {
        id: 'codex-profile',
        model_name: '',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
        auth_mode: 'codex_oauth'
      }
    ]

    expect(
      buildChatAvailableProfiles(config, [], {
        'codex-profile': ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.6-sol']
      }).map((profile) => ({
        id: profile.id,
        model_name: profile.model_name
      }))
    ).toEqual([
      {
        id: buildCodexModelProfileId('codex-profile', 'gpt-5.6-sol'),
        model_name: 'gpt-5.6-sol'
      },
      {
        id: buildCodexModelProfileId('codex-profile', 'gpt-5.5'),
        model_name: 'gpt-5.5'
      }
    ])
  })

  it('expands CLIProxyAPI/Codex profiles from discovered endpoint models', () => {
    const config = createConfig()
    config.use_remote_llm = false
    config.llm_config.api_profiles = [
      {
        id: 'cli-proxy',
        model_name: '',
        base_url: 'https://example.test/v1',
        api_key: 'secret',
        call_type: 'cliproxyapi'
      }
    ]

    expect(
      buildChatAvailableProfiles(config, [], {
        'cli-proxy': ['gpt-5.6-custom-a', 'gpt-5.5', 'gpt-5.6-custom-a']
      }).map((profile) => ({ id: profile.id, model_name: profile.model_name }))
    ).toEqual([
      {
        id: buildCodexModelProfileId('cli-proxy', 'gpt-5.6-custom-a'),
        model_name: 'gpt-5.6-custom-a'
      },
      {
        id: buildCodexModelProfileId('cli-proxy', 'gpt-5.5'),
        model_name: 'gpt-5.5'
      }
    ])
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
  it('upserts a matching profile without mutating the source array', () => {
    const original: LLMAPIProfile[] = [
      { id: 'first', model_name: 'one', base_url: '', api_key: '' },
      { id: 'second', model_name: 'two', base_url: '', api_key: '' }
    ]
    const replacement: LLMAPIProfile = {
      id: 'second',
      model_name: 'updated',
      base_url: 'https://example.test/v1',
      api_key: 'key'
    }

    const result = upsertLlmProfile(original, 'second', replacement)

    expect(result).toEqual([original[0], replacement])
    expect(result).not.toBe(original)
    expect(original[1].model_name).toBe('two')
  })

  it('strips external auth and provider metadata without mutating profiles', () => {
    const profile: LLMAPIProfile = {
      id: 'codex',
      model_name: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret',
      auth_mode: 'codex_oauth',
      auth_account_email: 'user@example.test',
      auth_connected_at: '2026-07-11T00:00:00.000Z',
      codex_fast_mode: true
    }

    expect(stripExternalAuthProfile(profile)).not.toHaveProperty('auth_mode')
    expect(stripProviderMetadataProfile(profile)).not.toHaveProperty('codex_fast_mode')
    expect(profile).toMatchObject({ auth_mode: 'codex_oauth', codex_fast_mode: true })
  })

  it('disconnects Codex OAuth profiles and clears all reusable credentials', () => {
    const profile: LLMAPIProfile = {
      id: 'codex',
      model_name: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret',
      api_secret: 'secret-2',
      backup_api_keys: ['backup'],
      auth_mode: 'codex_oauth',
      auth_account_email: 'user@example.test',
      auth_connected_at: '2026-07-11T00:00:00.000Z',
      codex_fast_mode: true,
      provider: 'openai'
    }

    expect(disconnectExternalProfile(profile)).toEqual({
      id: 'codex',
      model_name: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      api_secret: undefined,
      backup_api_keys: undefined,
      provider: 'openai'
    })
    expect(profile.api_key).toBe('secret')
  })

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

  it('injects supported auth token headers for remote server requests when configured', () => {
    const config = createConfig()
    config.remote_llm_server_config.access_token = 'proxy-secret'

    expect(buildRemoteLlmServerHeaders(config)).toEqual({
      Authorization: 'Bearer proxy-secret',
      'X-MagicPot-Proxy-Token': 'proxy-secret',
      'X-MagicPot-Bot-Secret': 'proxy-secret',
      'X-Bot-Secret': 'proxy-secret'
    })
    expect(
      buildRemoteLlmServerHeaders(config, {
        'Content-Type': 'application/json'
      })
    ).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer proxy-secret',
      'X-MagicPot-Proxy-Token': 'proxy-secret',
      'X-MagicPot-Bot-Secret': 'proxy-secret',
      'X-Bot-Secret': 'proxy-secret'
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

  it('normalizes current and legacy remote profile response shapes', () => {
    expect(
      normalizeRemoteLlmProfiles({
        profiles: [
          { id: 'agent-gpt', model_name: 'GPT', deployment: 'cloud' },
          { profileId: 'agent-claude', modelName: 'Claude' },
          'agent-gemini',
          { id: '' },
          null
        ]
      })
    ).toEqual([
      {
        id: 'agent-gpt',
        model_name: 'GPT',
        base_url: '',
        api_key: '',
        deployment: 'cloud'
      },
      { id: 'agent-claude', model_name: 'Claude', base_url: '', api_key: '' },
      { id: 'agent-gemini', model_name: 'agent-gemini', base_url: '', api_key: '' }
    ])

    expect(
      normalizeRemoteLlmProfiles({
        availableProfiles: {
          remoteOne: { modelName: 'Remote One' },
          remoteTwo: 'Remote Two'
        }
      })
    ).toEqual([
      { id: 'remoteOne', model_name: 'Remote One', base_url: '', api_key: '' },
      { id: 'remoteTwo', model_name: 'Remote Two', base_url: '', api_key: '' }
    ])
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

  it('limits discovery to runnable Codex or CLIProxyAPI and retains a restored catalog model only for its configured base', () => {
    const ordinary: LLMAPIProfile = {
      id: 'ordinary',
      model_name: 'model',
      base_url: 'https://example.test',
      api_key: 'synthetic'
    }
    const codex: LLMAPIProfile = {
      ...ordinary,
      id: 'codex',
      base_url: 'https://api.openai.com/v1',
      auth_mode: 'codex_oauth',
      api_key: ''
    }
    expect(isChatProfileDiscoveryCandidate(ordinary)).toBe(false)
    expect(isChatProfileDiscoveryCandidate(codex)).toBe(true)
    expect(isChatProfileDiscoveryCandidate({ ...ordinary, call_type: 'cliproxyapi' })).toBe(true)
    const selected = buildCodexModelProfileId('codex', 'owned-unlisted')
    expect(resolveAvailableChatProfileId([{ id: 'codex' }], selected, [codex])).toBe(selected)
    expect(
      resolveAvailableChatProfileId([{ id: 'codex' }], selected, [
        { ...codex, auth_mode: 'api_key' }
      ])
    ).toBe('codex')
  })

  it('normalizes composite ids against the available profile list', () => {
    expect(resolveAvailableChatProfileId([{ id: 'foo' }], 'foo::variant')).toBe('foo')
    expect(
      resolveAvailableChatProfileId([{ id: 'foo' }, { id: 'foo::variant' }], 'foo::variant')
    ).toBe('foo::variant')
    expect(resolveAvailableChatProfileId([{ id: 'foo' }], 'bar')).toBeNull()
  })

  it('preserves Codex virtual profile ids while profiles are still loading', () => {
    const profileId = buildCodexModelProfileId('codex-profile', 'gpt-5.4')

    expect(resolveAvailableChatProfileId([], profileId)).toBe(profileId)
  })
})
