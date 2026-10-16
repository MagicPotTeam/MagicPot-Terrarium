import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import type {
  LLMAPIProfile,
  LLMOpenAIApiMode,
  LLMProfileCallType,
  LLMProvider
} from '@shared/config/config'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
import { resolveOpenAIClientApiMode } from './clients'
import type { ProviderAttachmentTransport } from './profileCapabilities'
import { resolveRemoteProfileRouting } from './remoteProfileRouting'
import { resolveProfileModelUse, usesOpenAIResponsesImagePolicy } from './utils'

const official = 'https://api.openai.com/v1'
const gateway = 'https://gateway.example/v1'
const base: LLMAPIProfile = {
  id: 'remote-profile',
  model_name: 'opaque-model',
  base_url: official,
  api_key: 'private-key'
}
const originalExtensions = [...sharedHostExtensionApiV1.llmProfiles]
const requestModes = [undefined, 'auto', 'responses', 'chat-completions', 'images'] as const
const constantModes = (mode: Exclude<LLMOpenAIApiMode, 'auto'>) => ({
  default: mode,
  auto: mode,
  responses: mode,
  'chat-completions': mode,
  images: mode
})

afterEach(() => {
  sharedHostExtensionApiV1.llmProfiles.splice(
    0,
    sharedHostExtensionApiV1.llmProfiles.length,
    ...originalExtensions
  )
  vi.unstubAllGlobals()
})

describe('credential-free remote profile routing', () => {
  it('adds only optional routing fields to the discovery schema', () => {
    type Profile = LLMListProfilesResp['profiles'][number]
    expectTypeOf<Profile['provider']>().toEqualTypeOf<LLMProvider | undefined>()
    expectTypeOf<Profile['api_mode']>().toEqualTypeOf<
      'responses' | 'chat-completions' | 'images' | undefined
    >()
    expectTypeOf<Profile['call_type']>().toEqualTypeOf<LLMProfileCallType | undefined>()
    expectTypeOf<Profile['auth_mode']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Profile['openai_api_modes']>().toEqualTypeOf<
      Record<'default' | LLMOpenAIApiMode, Exclude<LLMOpenAIApiMode, 'auto'>> | undefined
    >()
    expectTypeOf<Profile['attachment_transports']>().toEqualTypeOf<
      ProviderAttachmentTransport[] | undefined
    >()
    expectTypeOf<Profile['preferred_attachment_transport']>().toEqualTypeOf<
      ProviderAttachmentTransport | undefined
    >()
    expectTypeOf<Profile['supports_session_continuation']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<Extract<'openai_api_modes', keyof LLMAPIProfile>>().toEqualTypeOf<never>()
    const legacy: Profile = { id: 'legacy', model_name: 'opaque' }
    expect(legacy).toEqual({ id: 'legacy', model_name: 'opaque' })
  })

  it.each<{
    name: string
    overrides: Partial<LLMAPIProfile>
    mode: 'responses' | 'chat-completions' | 'images'
  }>([
    { name: 'official opaque auto', overrides: { api_mode: 'auto' }, mode: 'responses' },
    { name: 'official opaque implicit', overrides: {}, mode: 'responses' },
    { name: 'gateway opaque auto', overrides: { base_url: gateway }, mode: 'chat-completions' },
    {
      name: 'gateway GPT spelling is not a route',
      overrides: { base_url: gateway, model_name: 'gpt-5.5' },
      mode: 'chat-completions'
    },
    {
      name: 'explicit Responses on gateway',
      overrides: { base_url: gateway, api_mode: 'responses' },
      mode: 'responses'
    },
    {
      name: 'explicit chat on official',
      overrides: { api_mode: 'chat-completions' },
      mode: 'chat-completions'
    },
    { name: 'explicit images', overrides: { api_mode: 'images' }, mode: 'images' },
    { name: 'implicit image model', overrides: { model_name: 'gpt-image-custom' }, mode: 'images' },
    {
      name: 'explicit chat model use defeats image spelling',
      overrides: { model_name: 'gpt-image-custom', model_use: 'chat' },
      mode: 'responses'
    },
    {
      name: 'default model use resolves to chat',
      overrides: { model_name: 'gpt-image-custom', model_use: 'default' },
      mode: 'responses'
    },
    { name: 'opaque image model use', overrides: { model_use: 'image' }, mode: 'images' },
    {
      name: 'images endpoint beats explicit chat model use',
      overrides: { base_url: `${official}/images/edits?private=1`, model_use: 'chat' },
      mode: 'images'
    },
    {
      name: 'explicit Responses beats images endpoint and model use',
      overrides: {
        base_url: `${official}/images/generations`,
        model_use: 'image',
        api_mode: 'responses'
      },
      mode: 'responses'
    },
    {
      name: 'explicit chat beats images endpoint and model use',
      overrides: {
        base_url: `${official}/images/edits`,
        model_use: 'image',
        api_mode: 'chat-completions'
      },
      mode: 'chat-completions'
    },
    {
      name: 'legacy vision flag resolves model use before image inference',
      overrides: { model_name: 'gpt-image-custom', is_vision_model: true },
      mode: 'responses'
    },
    {
      name: 'legacy OCR flag resolves model use before image inference',
      overrides: { model_name: 'gpt-image-custom', is_ocr_model: true },
      mode: 'responses'
    },
    {
      name: 'keyless local API remains a standard API route',
      overrides: {
        base_url: 'http://localhost:8000/v1',
        deployment: 'local',
        api_key: '',
        api_mode: 'responses'
      },
      mode: 'responses'
    }
  ])('$name', ({ overrides, mode }) => {
    const profile = { ...base, ...overrides }
    const routing = resolveRemoteProfileRouting(profile)
    expect(routing).toEqual({
      call_type: 'api',
      provider: 'openai',
      api_mode: mode,
      openai_api_modes: expect.any(Object)
    })
    expect(Object.keys(routing.openai_api_modes!).sort()).toEqual([
      'auto',
      'chat-completions',
      'default',
      'images',
      'responses'
    ])
    for (const apiMode of requestModes) {
      const effectiveProfile = apiMode ? { ...profile, api_mode: apiMode } : profile
      const mapped = routing.openai_api_modes![apiMode || 'default']
      expect(mapped).toBe(
        resolveOpenAIClientApiMode(profile.base_url, profile.model_name, {
          apiMode: effectiveProfile.api_mode,
          modelUse: resolveProfileModelUse(effectiveProfile)
        })
      )
      expect(mapped === 'responses').toBe(usesOpenAIResponsesImagePolicy(profile, apiMode))
    }
    expect(usesOpenAIResponsesImagePolicy(routing)).toBe(usesOpenAIResponsesImagePolicy(profile))
  })

  it('separates configured Images from forced auto on an official opaque model', () => {
    expect(resolveRemoteProfileRouting({ ...base, api_mode: 'images' }).openai_api_modes).toEqual({
      default: 'images',
      auto: 'responses',
      responses: 'responses',
      'chat-completions': 'chat-completions',
      images: 'images'
    })
  })

  it.each(['gemini', 'claude', 'ollama', 'kling', 'volcengine'] as const)(
    'never copies Responses config onto %s',
    (provider) => {
      const routing = resolveRemoteProfileRouting({
        ...base,
        provider,
        model_use: provider === 'kling' || provider === 'volcengine' ? 'video' : 'chat',
        api_mode: 'responses'
      })
      expect(routing).toEqual({ call_type: 'api', provider })
      expect(usesOpenAIResponsesImagePolicy(routing)).toBe(false)
    }
  )

  it.each([
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
    ['https://api.anthropic.com/v1', 'claude'],
    ['http://localhost:11434', 'ollama']
  ] as const)('resolves provider from %s without disclosing it', (base_url, provider) => {
    expect(
      resolveRemoteProfileRouting({ ...base, base_url, provider: 'default', api_mode: 'responses' })
    ).toEqual({ call_type: 'api', provider })
  })

  it.each(['o3', 'opencode/codex', 'gpt5'])(
    'reports Zen Responses for alias %s despite conflicting config',
    (model_name) => {
      const profile: LLMAPIProfile = {
        ...base,
        model_name,
        base_url: 'https://opencode.ai/zen/v1',
        provider: 'gemini',
        api_mode: 'images',
        model_use: 'image'
      }
      const routing = resolveRemoteProfileRouting(profile)
      expect(routing).toEqual({
        call_type: 'api',
        provider: 'openai',
        api_mode: 'responses',
        openai_api_modes: constantModes('responses')
      })
      for (const apiMode of requestModes) {
        expect(routing.openai_api_modes![apiMode || 'default'] === 'responses').toBe(
          usesOpenAIResponsesImagePolicy(profile, apiMode)
        )
      }
    }
  )

  it.each([
    ['opus', 'claude', undefined],
    ['gemini', 'gemini', undefined],
    ['opaque', 'openai', 'chat-completions']
  ] as const)('does not assign Responses to Zen %s', (model_name, provider, api_mode) => {
    const routing = resolveRemoteProfileRouting({
      ...base,
      model_name,
      base_url: 'https://opencode.ai/zen/v1',
      api_mode: 'responses'
    })
    expect(routing).toEqual({
      call_type: 'api',
      provider,
      ...(api_mode ? { api_mode, openai_api_modes: constantModes(api_mode) } : {})
    })
    expect(usesOpenAIResponsesImagePolicy(routing)).toBe(false)
  })

  it.each(['local', 'codex', 'cliproxyapi', 'extension-route'])(
    'leaves %s runtime routing residual even without an installed extension',
    (call_type) => {
      expect(resolveRemoteProfileRouting({ ...base, call_type, api_mode: 'responses' })).toEqual({
        call_type
      })
    }
  )

  it.each(['codex_oauth', 'extension_oauth'])(
    'only publishes the non-secret auth discriminator for %s',
    (auth_mode) => {
      expect(resolveRemoteProfileRouting({ ...base, auth_mode })).toEqual({
        call_type: 'api',
        auth_mode
      })
    }
  )

  it('honors pure extension route hooks without constructing a client or fetching', () => {
    const createCli = vi.fn()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    sharedHostExtensionApiV1.llmProfiles.push({
      id: 'owned-test-extension',
      resolveProfileCallType: () => 'extension-route',
      resolveProfileProvider: () => 'openai',
      createCli
    })
    expect(resolveRemoteProfileRouting(base)).toEqual({ call_type: 'extension-route' })
    expect(createCli).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses extension model-use resolution for an otherwise standard API route', () => {
    sharedHostExtensionApiV1.llmProfiles.push({
      id: 'owned-test-model-use',
      resolveProfileModelUse: () => 'image'
    })
    expect(resolveRemoteProfileRouting(base)).toEqual({
      call_type: 'api',
      provider: 'openai',
      api_mode: 'images',
      openai_api_modes: {
        default: 'images',
        auto: 'images',
        responses: 'responses',
        'chat-completions': 'chat-completions',
        images: 'images'
      }
    })
  })

  it('does not expose credentials, URLs, account fields or filesystem paths or mutate config', () => {
    const profile = Object.freeze({
      ...base,
      auth_mode: 'api_key',
      base_url: 'https://user:private-password@gateway.example/v1?token=private-query',
      api_secret: 'private-secret',
      backup_api_keys: ['private-backup'],
      local_model_path: 'C:/fixture-data/model.gguf',
      auth_account_email: 'private@example.com',
      auth_connected_at: 'private-time',
      tencent_secret_id: 'private-id',
      tencent_secret_key: 'private-tencent-key',
      api_mode: 'responses' as const
    })
    const before = JSON.stringify(profile)
    const routing = resolveRemoteProfileRouting(profile)
    expect(routing).toEqual({
      call_type: 'api',
      provider: 'openai',
      api_mode: 'responses',
      openai_api_modes: {
        default: 'responses',
        auto: 'chat-completions',
        responses: 'responses',
        'chat-completions': 'chat-completions',
        images: 'images'
      }
    })
    expect(JSON.stringify(profile)).toBe(before)
    expect(JSON.stringify(routing)).not.toMatch(
      /private|gateway|api_key|base_url|secret|backup|path|email/
    )
  })
})
