import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type LLMAPIProfile } from '@shared/config/config'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
const h = vi.hoisted(() => ({ ensure: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }))
vi.mock('./codexOAuth', () => ({
  ensureCodexCliAuthTokens: h.ensure,
  forceRefreshCodexCliAuthTokens: h.refresh
}))
import { createCodexThreadImageGenerator } from './codexThreadImageGenerator'
import { __resetCodexRequestGovernorForTests } from './codexRequestGovernor'
const profile: LLMAPIProfile = {
  id: 'chosen',
  model_name: 'text-fixture',
  call_type: 'cliproxyapi',
  base_url: 'https://custom.fixture/codex',
  api_key: 'configured-fixture-key'
}
const request: LLMChatReq = {
  profileId: 'chosen',
  messages: [{ role: 'user', content: 'make a picture' }]
}
let config = structuredClone(DEFAULT_CONFIG)
const factory = (req = request) =>
  createCodexThreadImageGenerator(req, { config, currentConfig: () => config, fetchImpl: h.fetch })
const generate = (generator: NonNullable<ReturnType<typeof factory>>) =>
  generator.generate('frog', {
    transparentBackground: true,
    signal: new AbortController().signal
  })
const edit = (generator: NonNullable<ReturnType<typeof factory>>) =>
  generator.edit('fixture edit', ['data:image/png;base64,QUJD'], {
    transparentBackground: true,
    signal: new AbortController().signal
  })
beforeEach(() => {
  config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.llm_config.api_profiles = [{ ...profile }]
  h.fetch
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ data: [{ b64_json: 'QUJD' }], output_format: 'png' })
    )
  h.ensure
    .mockReset()
    .mockResolvedValue({ accessToken: 'oauth-fixture', accountId: 'account-fixture' })
  h.refresh.mockReset()
  __resetCodexRequestGovernorForTests()
})
afterEach(() => __resetCodexRequestGovernorForTests())

describe('MAIN-only selected Codex image backend capability, no provider work in discovery', () => {
  it.each([undefined, false, null, 'true', 1, {}])(
    'GIF capability is default-off and requires the source profile literal true (%j)',
    (value) => {
      Object.assign(config.llm_config.api_profiles[0], { codex_image_gif_enabled: value })
      expect(factory()).toHaveProperty('gifEnabled', false)
      expect(h.ensure).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it('GIF source opt-in enables generation/edit flat wire, but target opt-in is never inherited', async () => {
    const req = useSeparateTextProfile()
    Object.assign(config.llm_config.api_profiles[0], { codex_image_gif_enabled: true })
    expect(factory(req)).toHaveProperty('gifEnabled', false)
    Object.assign(config.llm_config.api_profiles[1], { codex_image_gif_enabled: true })
    const generator = factory(req)!
    expect(generator).toHaveProperty('gifEnabled', true)
    const params = {
      transparentBackground: false,
      gif: { frameCount: 2, frameDurationMs: 100 },
      signal: new AbortController().signal
    }
    // A GIF request gets a GIF back; the client refuses a still answer to it.
    h.fetch.mockImplementation(async () =>
      Response.json({ data: [{ b64_json: 'R0lGODlhAQABAAAAACw=' }], output_format: 'gif' })
    )
    await generator.generate('GIF fixture', params)
    await generator.edit('GIF edit', ['data:image/png;base64,QUJD'], params)
    for (const [, init] of h.fetch.mock.calls) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        output_format: 'gif',
        frame_count: 2,
        frame_duration_ms: 100
      })
    }
    Object.assign(config.llm_config.api_profiles[1], { codex_image_gif_enabled: false })
    await expect(generator.generate('stale', params)).rejects.toThrow('changed')
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })
  it('GIF opt-in cannot be enabled by the renderer request and is revoked during OAuth preparation', async () => {
    Object.assign(config.llm_config.api_profiles[0], {
      call_type: 'codex',
      auth_mode: 'codex_oauth'
    })
    expect(
      factory({ ...request, codex_image_gif_enabled: true, gifEnabled: true } as LLMChatReq)
    ).toHaveProperty('gifEnabled', false)
    Object.assign(config.llm_config.api_profiles[0], { codex_image_gif_enabled: true })
    const generator = factory()!
    h.ensure.mockImplementation(async () => {
      config.llm_config.api_profiles[0].codex_image_gif_enabled = false
      return { accessToken: 'oauth-fixture', accountId: 'account-fixture' }
    })
    await expect(
      generator.generate('GIF must not dispatch', {
        transparentBackground: false,
        gif: {},
        signal: new AbortController().signal
      })
    ).rejects.toThrow('changed')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })
  const useSeparateTextProfile = (selection: unknown = 'chosen') => {
    const text = {
      id: 'text-only',
      model_name: 'ordinary-text',
      call_type: 'api',
      base_url: 'https://text.fixture/v1',
      api_key: 'text-key-must-not-upload'
    } as LLMAPIProfile & { codex_image_profile_id?: unknown }
    Object.assign(text, { codex_image_profile_id: selection })
    config.llm_config.api_profiles.push(text as LLMAPIProfile)
    return { ...request, profileId: text.id }
  }

  it.each(['key', 'oauth'] as const)(
    'uses only a user-linked %s image profile for a non-Codex text model',
    async (mode) => {
      if (mode === 'oauth')
        config.llm_config.api_profiles[0] = {
          ...profile,
          call_type: 'codex',
          auth_mode: 'codex_oauth'
        }
      const generator = factory(useSeparateTextProfile())
      expect(generator?.approval.profileId).toBe('chosen')
      expect(h.ensure).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
      await generate(generator!)
      await edit(generator!)
      expect(h.fetch).toHaveBeenCalledTimes(2)
      for (const [url, init] of h.fetch.mock.calls) {
        expect(String(url)).toContain(
          mode === 'key'
            ? 'https://custom.fixture/codex/images/'
            : 'https://chatgpt.com/backend-api/codex/images/'
        )
        expect(init.headers.Authorization).toBe(
          mode === 'key' ? 'Bearer configured-fixture-key' : 'Bearer oauth-fixture'
        )
        expect(JSON.stringify(init)).not.toContain('text-key-must-not-upload')
      }
    }
  )

  it.each([undefined, null, '', ' ', false, 42, 'unknown', 'chosen::codex-model::model'])(
    'does not infer a backend for a non-Codex text model from invalid/missing selection %j',
    (selection) => {
      const req = useSeparateTextProfile(selection)
      if (selection === undefined)
        Reflect.deleteProperty(config.llm_config.api_profiles[1], 'codex_image_profile_id')
      expect(factory(req)).toBeUndefined()
      expect(h.fetch).not.toHaveBeenCalled()
      expect(h.ensure).not.toHaveBeenCalled()
    }
  )

  it('does not fall back to the source Codex login when its explicit image link is invalid', () => {
    Object.assign(config.llm_config.api_profiles[0], { codex_image_profile_id: 'missing' })
    expect(factory()).toBeUndefined()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it.each([
    'duplicate-image',
    'duplicate-text',
    'unsupported-image',
    'mixed-image-auth',
    'image-source'
  ] as const)('declines an invalid linked configuration: %s', (mutation) => {
    const req = useSeparateTextProfile()
    if (mutation === 'duplicate-image') config.llm_config.api_profiles.push({ ...profile })
    if (mutation === 'duplicate-text')
      config.llm_config.api_profiles.push({ ...config.llm_config.api_profiles[1] })
    if (mutation === 'unsupported-image') config.llm_config.api_profiles[0].call_type = 'api'
    if (mutation === 'mixed-image-auth') config.llm_config.api_profiles[0].auth_mode = 'codex_oauth'
    if (mutation === 'image-source') config.llm_config.api_profiles[1].model_use = 'image'
    expect(factory(req)).toBeUndefined()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it.each([
    'source-deleted',
    'source-duplicate',
    'source-key',
    'link-deleted',
    'link-changed',
    'image-key',
    'image-deleted'
  ] as const)('revokes the linked capability after %s', async (mutation) => {
    const generator = factory(useSeparateTextProfile())!
    expect(generator).toBeDefined()
    if (mutation === 'source-deleted') config.llm_config.api_profiles.splice(1, 1)
    if (mutation === 'source-duplicate')
      config.llm_config.api_profiles.push({ ...config.llm_config.api_profiles[1] })
    if (mutation === 'source-key') config.llm_config.api_profiles[1].api_key = 'changed-text-key'
    if (mutation === 'link-deleted')
      Reflect.deleteProperty(config.llm_config.api_profiles[1], 'codex_image_profile_id')
    if (mutation === 'link-changed')
      Object.assign(config.llm_config.api_profiles[1], { codex_image_profile_id: 'other' })
    if (mutation === 'image-key') config.llm_config.api_profiles[0].api_key = 'changed-image-key'
    if (mutation === 'image-deleted') config.llm_config.api_profiles.splice(0, 1)
    expect(() => generator.assertCurrent()).toThrow('changed')
    await expect(generate(generator)).rejects.toThrow('changed')
    await expect(edit(generator)).rejects.toThrow('changed')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it('does not follow transitive profile links or try another credential', async () => {
    Object.assign(config.llm_config.api_profiles[0], { codex_image_profile_id: 'never-follow' })
    config.llm_config.api_profiles.push({ ...profile, id: 'never-follow', api_key: 'must-not-use' })
    const generator = factory(useSeparateTextProfile())!
    await generate(generator)
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer configured-fixture-key')
  })

  it('discards late output after the text-to-image selection changes', async () => {
    const generator = factory(useSeparateTextProfile())!
    expect(generator).toBeDefined()
    h.fetch.mockImplementation(async () => {
      Reflect.deleteProperty(config.llm_config.api_profiles[1], 'codex_image_profile_id')
      return Response.json({ data: [{ b64_json: 'QUJD' }], output_format: 'png' })
    })
    await expect(generate(generator)).rejects.toThrow('changed')
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('does not accept model/renderer request fields as an image-profile selection', () => {
    const req = useSeparateTextProfile()
    Reflect.deleteProperty(config.llm_config.api_profiles[1], 'codex_image_profile_id')
    expect(factory({ ...req, codex_image_profile_id: 'chosen' } as LLMChatReq)).toBeUndefined()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('ignores changes to an unrelated profile without selecting its credentials', async () => {
    const generator = factory(useSeparateTextProfile())!
    config.llm_config.api_profiles.push({
      ...profile,
      id: 'unrelated',
      api_key: 'not-for-this-request'
    })
    generator.assertCurrent()
    await generate(generator)
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer configured-fixture-key')
  })

  it('does not dispatch linked OAuth after the relation is cleared during auth', async () => {
    config.llm_config.api_profiles[0] = { ...profile, call_type: 'codex', auth_mode: 'codex_oauth' }
    const generator = factory(useSeparateTextProfile())!
    let release!: (value: { accessToken: string }) => void
    h.ensure.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = generate(generator)
    Reflect.deleteProperty(config.llm_config.api_profiles[1], 'codex_image_profile_id')
    release({ accessToken: 'oauth-fixture' })
    await expect(pending).rejects.toThrow('changed')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { profileScope: 'qapp' },
    { comparisonRouting: 'configured' },
    { imageGenerationOptions: { enabled: true } },
    { skillRuntime: { skillId: 'explicit' } }
  ])('does not enable linked images for a non-ordinary request %j', (patch) => {
    expect(factory({ ...useSeparateTextProfile(), ...patch } as LLMChatReq)).toBeUndefined()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('uses native Images on a /v1 gateway: JSON generation, multipart editing, no OAuth or Responses fallback', async () => {
    config.llm_config.api_profiles[0].base_url = 'https://gateway.fixture/v1/'
    const generator = factory()!
    expect(generator.approval.backend).toBe('openai-images-api-key')
    expect(h.fetch).not.toHaveBeenCalled()
    await generate(generator)
    await edit(generator)
    expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.fixture/v1/images/generations', 'https://gateway.fixture/v1/images/edits'
    ])
    expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-image-2', prompt: 'frog' })
    const init = h.fetch.mock.calls[1][1]
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.body.get('model')).toBe('gpt-image-2')
    expect(init.body.get('image').type).toBe('image/png')
    expect(init.headers['Content-Type']).toBeUndefined()
    expect(h.ensure).not.toHaveBeenCalled()
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(generate(generator)).rejects.toMatchObject({ retryBlocked: true })
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })

  it('uses only explicit CLIProxy endpoint/key, not another profile, key rotation, model discovery or OAuth', async () => {
    config.llm_config.api_profiles.push({ ...profile, id: 'unselected', api_key: 'different-key' })
    config.llm_config.api_profiles[0].backup_api_keys = ['must-not-use']
    const generator = factory()!
    expect(generator.approval).toEqual({
      backend: 'codex-json-api-key',
      endpoint: 'https://custom.fixture/codex',
      profileId: 'chosen'
    })
    expect(JSON.stringify(generator.approval)).not.toContain(profile.api_key)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
    await generate(generator)
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.fetch.mock.calls[0][0]).toBe('https://custom.fixture/codex/images/generations')
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer configured-fixture-key')
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('binds OAuth to fixed origin and never sends a configured placeholder key/base URL', async () => {
    config.llm_config.api_profiles[0] = { ...profile, call_type: 'codex', auth_mode: 'codex_oauth' }
    const generator = factory()!
    expect(generator.approval.backend).toBe('codex-json-oauth')
    expect(h.ensure).not.toHaveBeenCalled()
    await generate(generator)
    expect(h.ensure).toHaveBeenCalledOnce()
    expect(h.fetch.mock.calls[0][0]).toBe(
      'https://chatgpt.com/backend-api/codex/images/generations'
    )
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer oauth-fixture')
    expect(h.fetch.mock.calls[0][1].body).not.toContain(profile.api_key)
  })

  it('resolves a selected Codex-model suffix without scanning other credentials', () => {
    expect(
      factory({ ...request, profileId: 'chosen::codex-model::opaque%2Fmodel' })?.approval.profileId
    ).toBe('chosen')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { profileId: undefined },
    { profileId: 'unknown' },
    { profileScope: 'qapp' },
    { comparisonRouting: 'configured' },
    { imageGenerationOptions: { enabled: true } },
    { imageGenerationOptions: { enabled: false, action: 'edit' } },
    { imageGenerationOptions: { enabled: false, quality: 'high' } },
    { skillRuntime: { skillId: 'explicit' } }
  ])('declines non-ordinary/implicit selection %j', (patch) => {
    expect(factory({ ...request, ...patch } as LLMChatReq)).toBeUndefined()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { call_type: 'api' },
    { call_type: 'codex' },
    { call_type: 'cliproxyapi', auth_mode: 'codex_oauth' },
    { call_type: 'api', auth_mode: 'codex_oauth' },
    { model_use: 'video' },
    { model_use: 'image' },
    { model_use: 'ocr' },
    { api_key: '' },
    { api_key: 'bad\r\nkey' },
    { base_url: 'https://api.openai.com./v1' },
    { base_url: 'https://custom.fixture/v1/%69mages/%65dits' },
    { base_url: 'https://user:pass@custom.fixture/v1' },
    { base_url: 'https://custom.fixture?token=key' },
    { base_url: 'http://public.fixture/v1' }
  ])('does not offer mixed, unsupported or invalid credential configuration %j', (patch) => {
    config.llm_config.api_profiles[0] = { ...profile, ...patch } as LLMAPIProfile
    expect(factory()).toBeUndefined()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it.each([
    'remote',
    'duplicate',
    'missing',
    'changed-key',
    'changed-endpoint',
    'changed-auth'
  ] as const)('rejects %s configuration mutation before dispatch', async (mutation) => {
    const generator = factory()!
    if (mutation === 'remote') config.use_remote_llm = true
    if (mutation === 'duplicate') config.llm_config.api_profiles.push({ ...profile })
    if (mutation === 'missing') config.llm_config.api_profiles = []
    if (mutation === 'changed-key') config.llm_config.api_profiles[0].api_key = 'new-key'
    if (mutation === 'changed-endpoint')
      config.llm_config.api_profiles[0].base_url = 'https://new.fixture'
    if (mutation === 'changed-auth') config.llm_config.api_profiles[0].auth_mode = 'codex_oauth'
    expect(() => generator.assertCurrent()).toThrow('changed')
    await expect(generate(generator)).rejects.toThrow('changed')
    await expect(edit(generator)).rejects.toThrow('changed')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it('declines discovery on remote or duplicated selected IDs', () => {
    config.use_remote_llm = true
    expect(factory()).toBeUndefined()
    config.use_remote_llm = false
    config.llm_config.api_profiles.push({ ...profile })
    expect(factory()).toBeUndefined()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('does not dispatch stale OAuth credentials after settings change during auth', async () => {
    config.llm_config.api_profiles[0] = { ...profile, call_type: 'codex', auth_mode: 'codex_oauth' }
    let release!: (value: { accessToken: string }) => void
    h.ensure.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = generate(factory()!)
    config.llm_config.api_profiles[0].auth_mode = undefined
    release({ accessToken: 'oauth-fixture' })
    await expect(pending).rejects.toThrow('changed')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('rechecks settings before the single OAuth 401 resend', async () => {
    config.llm_config.api_profiles[0] = { ...profile, call_type: 'codex', auth_mode: 'codex_oauth' }
    h.fetch.mockResolvedValueOnce(new Response('', { status: 401 }))
    h.refresh.mockImplementation(async () => {
      config.llm_config.api_profiles[0].auth_mode = undefined
      return { accessToken: 'refreshed-fixture' }
    })
    await expect(generate(factory()!)).rejects.toThrow('changed')
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it.each(['key', 'oauth'] as const)(
    'forwards only exact selected %s auth to JSON edits',
    async (mode) => {
      if (mode === 'oauth')
        config.llm_config.api_profiles[0] = {
          ...profile,
          call_type: 'codex',
          auth_mode: 'codex_oauth'
        }
      await edit(factory()!)
      expect(h.fetch).toHaveBeenCalledOnce()
      const [url, init] = h.fetch.mock.calls[0]
      expect(url).toBe(
        `${mode === 'key' ? 'https://custom.fixture/codex' : 'https://chatgpt.com/backend-api/codex'}/images/edits`
      )
      expect(init.headers.Authorization).toBe(
        mode === 'key' ? 'Bearer configured-fixture-key' : 'Bearer oauth-fixture'
      )
      expect(JSON.parse(init.body)).toEqual({
        prompt: 'fixture edit',
        background: 'transparent',
        model: 'gpt-image-2',
        size: 'auto',
        quality: 'auto',
        images: [{ image_url: 'data:image/png;base64,QUJD' }]
      })
    }
  )

  it('does not hand late edit output to a changed configuration', async () => {
    h.fetch.mockImplementation(async () => {
      config.use_remote_llm = true
      return Response.json({ data: [{ b64_json: 'QUJD' }], output_format: 'png' })
    })
    await expect(edit(factory()!)).rejects.toThrow('changed')
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('does not resolve auth or dispatch an already-aborted edit', async () => {
    const controller = new AbortController()
    controller.abort(Error('stop edit'))
    await expect(
      factory()!.edit('fixture', ['data:image/png;base64,QUJD'], {
        transparentBackground: true,
        signal: controller.signal
      })
    ).rejects.toThrow('stop edit')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it('does not hand late output to a changed configuration', async () => {
    h.fetch.mockImplementation(async () => {
      config.llm_config.api_profiles[0].api_key = 'new-key'
      return Response.json({ data: [{ b64_json: 'QUJD' }], output_format: 'png' })
    })
    await expect(generate(factory()!)).rejects.toThrow('changed')
    expect(h.fetch).toHaveBeenCalledOnce()
  })
})
