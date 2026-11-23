import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import { buildCodexModelProfileId } from '@shared/extensions/codexModelCatalog'

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() }
}))

// This suite verifies profile selection/transport, not Electron config persistence.
vi.mock('../config/config', () => ({ getConfig: vi.fn() }))

const oauthMocks = vi.hoisted(() => ({ discover: vi.fn(), chat: vi.fn() }))
vi.mock('../api/codexModelDiscovery', () => ({
  createCodexBackendModelDiscoveryProvider: () => oauthMocks.discover
}))
vi.mock('../api/codexChatClient', () => ({
  CodexChatGPTCli: class {
    readonly supportsNativeTools = true
    constructor(private modelName: string) {}
    chat(params: unknown) {
      return oauthMocks.chat(this.modelName, params)
    }
  }
}))

import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig } from '../config/config'
import { codexMainLlmProxyExtension } from './codexMainExtension'
import { __resetCodexRequestGovernorForTests } from '../api/codexRequestGovernor'

const profile: LLMAPIProfile = {
  id: 'cli-proxy',
  model_name: '',
  base_url: 'https://example.test/v1',
  api_key: 'secret',
  call_type: 'cliproxyapi'
}

const context = (rawProfileId: string, fetchImpl: typeof fetch) => ({
  config: {} as Config,
  rawProfileId,
  requestedProfileId: profile.id,
  fetchImpl
})

describe('codexMainLlmProxyExtension CLIProxy model selection', () => {
  beforeEach(() => {
    __resetCodexRequestGovernorForTests()
    vi.clearAllMocks()
    oauthMocks.discover.mockReset()
    oauthMocks.chat.mockReset().mockResolvedValue({ content: 'ok' })
  })

  it('preserves isolated capability through the governor and disables hosted tools for a child', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.tools).toEqual([expect.objectContaining({ type: 'function' })])
      expect(body.max_output_tokens).toBe(2048)
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'bounded report' }] }] })
    })
    const cli = codexMainLlmProxyExtension.createCli?.({ ...profile, model_name: 'selected-model' }, context(profile.id, fetchImpl))
    expect(cli?.supportsIsolatedReadOnlyTurns).toBe(true)
    await expect(cli?.chat({ messages: [{ role: 'user', content: 'inspect' }], maxOutputTokens: 2048, retryCapacity: false, disableProviderTools: true, imageGenerationOptions: { enabled: false }, tools: [{ name: 'files.read', description: 'read', inputSchema: { type: 'object' } }] })).resolves.toMatchObject({ content: 'bounded report' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    'http://public-proxy.example.test/v1',
    'https://user:password@proxy.example.test/v1',
    'https://proxy.example.test/v1?token=secret'
  ])('fails closed before creating a CLIProxy client for unsafe endpoint %s', (baseUrl) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(() =>
      codexMainLlmProxyExtension.createCli?.(
        { ...profile, base_url: baseUrl },
        context(profile.id, fetchImpl)
      )
    ).toThrow(/CLIProxyAPI|Provider endpoint|HTTPS/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { saved: '', selected: '', expected: 'first-scanned', discovers: true },
    {
      saved: 'saved-model',
      selected: '',
      expected: 'saved-model',
      discovers: false
    },
    {
      saved: 'saved-model',
      selected: 'thread-selected',
      expected: 'thread-selected',
      discovers: false
    }
  ])(
    'resolves OAuth models dynamically with explicit selection precedence: $expected',
    async ({ saved, selected, expected, discovers }) => {
      oauthMocks.discover.mockResolvedValue({
        models: ['first-scanned', 'another-deployment']
      })
      const oauthProfile: LLMAPIProfile = {
        ...profile,
        auth_mode: 'codex_oauth',
        call_type: 'codex',
        model_name: saved
      }
      const rawId = selected ? buildCodexModelProfileId(profile.id, selected) : profile.id
      const cli = codexMainLlmProxyExtension.createCli?.(oauthProfile, context(rawId, vi.fn()))
      await expect(
        cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
      ).resolves.toMatchObject({ content: 'ok' })
      expect(oauthMocks.discover).toHaveBeenCalledTimes(discovers ? 1 : 0)
      expect(oauthMocks.chat).toHaveBeenCalledWith(expected, expect.anything())
    }
  )

  it('does not send an OAuth inference request if model discovery fails', async () => {
    oauthMocks.discover.mockRejectedValue(new Error('model discovery offline'))
    const oauthProfile: LLMAPIProfile = {
      ...profile,
      auth_mode: 'codex_oauth',
      call_type: 'codex',
      model_name: ''
    }
    const cli = codexMainLlmProxyExtension.createCli?.(oauthProfile, context(profile.id, vi.fn()))
    await expect(cli?.chat({ messages: [] })).rejects.toThrow('model discovery offline')
    expect(oauthMocks.chat).not.toHaveBeenCalled()
  })

  // Opaque ID shapes, not supported model versions. Selection must not depend on names.
  it.each(['vendor/model-a', 'Vendor/Model-A', 'custom alias:revision+test', '模型_部署'])(
    'uses the explicitly selected %s model without requesting /models',
    async (modelName) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }]
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ) as unknown as typeof fetch
      const rawProfileId = buildCodexModelProfileId(profile.id, modelName)
      const cli = codexMainLlmProxyExtension.createCli?.(profile, context(rawProfileId, fetchImpl))

      await expect(
        cli?.chat({
          messages: [{ role: 'user', content: 'hello' }],
          reasoningEffort: 'high'
        })
      ).resolves.toMatchObject({ content: 'ok' })

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://example.test/v1/responses',
        expect.objectContaining({ method: 'POST' })
      )
      const requestBody = JSON.parse(
        String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body)
      )
      expect(requestBody.model).toBe(modelName)
      expect(requestBody.reasoning).toEqual({ effort: 'high' })
      expect(requestBody.service_tier).toBe('priority')
      expect(requestBody.stream).toBe(true)
    }
  )

  it.each([false, true])('keeps CLIProxy image reviews tool-free through the governor (discover=%s)', async (discover) => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/models')
        ? Response.json({ data: [{ id: 'review-model' }] })
        : Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'review' }] }] })
    )
    const cli = codexMainLlmProxyExtension.createCli?.(
      { ...profile, model_name: discover ? '' : 'review-model' }, context(profile.id, fetchImpl)
    )
    expect(cli?.supportsToolFreeImageReview).toBe(true)
    expect(cli?.toolFreeImageReviewEndpoint).toBe(discover ? undefined : `${profile.base_url}/responses`)
    await expect(cli?.chat({
      ...(!discover ? { readOnlyImageReview: true as const } : {}),
      messages: [{ role: 'user', content: 'inspect', attachments: [{ type: 'image', url: image }] }],
      disableProviderTools: true, disableAutomaticImageGeneration: true,
      imageGenerationOptions: { enabled: false }, retryCapacity: false
    })).resolves.toMatchObject({ content: 'review' })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      ...(discover ? ['https://example.test/v1/models'] : []), 'https://example.test/v1/responses'
    ])
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body))
    expect(body.input).toEqual([{ role: 'user', content: [
      { type: 'input_text', text: 'inspect' }, { type: 'input_image', image_url: image }
    ] }])
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  })

  it.each(['explicit CLIProxy', 'lazy CLIProxy', 'lazy OAuth'])('rejects unauthorized marked review before %s work', async (mode) => {
    const fetchImpl = vi.fn<typeof fetch>()
    const lazy = mode.startsWith('lazy')
    const candidate: LLMAPIProfile = {
      ...profile, model_name: lazy ? '' : 'selected',
      ...(mode === 'lazy OAuth' ? { call_type: 'codex', auth_mode: 'codex_oauth' } as const : {})
    }
    const cli = codexMainLlmProxyExtension.createCli?.(candidate, context(profile.id, fetchImpl))
    if (lazy) expect(cli?.toolFreeImageReviewEndpoint).toBeUndefined()
    await expect(cli?.chat({
      readOnlyImageReview: true, disableProviderTools: true, disableAutomaticImageGeneration: true,
      ...(!lazy ? { tools: [{ name: 'forbidden', description: '', inputSchema: { type: 'object' as const } }] } : {}), messages: []
    })).rejects.toThrow(lazy ? /select a model/i : /tool-free/i)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(oauthMocks.discover).not.toHaveBeenCalled()
    expect(oauthMocks.chat).not.toHaveBeenCalled()
  })

  it('discovers a model for a model-less Quick App profile and sends the image to Responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'discovered-deployment' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'prompt' }]
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ) as unknown as typeof fetch
    const quickAppProfile = {
      ...profile,
      id: 'quick-app-cli-proxy',
      base_url: 'https://quick-app.example.test/v1'
    }
    const quickAppContext = {
      ...context(quickAppProfile.id, fetchImpl),
      requestedProfileId: quickAppProfile.id
    }
    const cli = codexMainLlmProxyExtension.createCli?.(quickAppProfile, quickAppContext)

    await expect(
      cli?.chat({
        messages: [
          {
            role: 'user',
            content: 'describe this image',
            attachments: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }]
          }
        ]
      })
    ).resolves.toMatchObject({ content: 'prompt' })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://quick-app.example.test/v1/models',
      expect.objectContaining({ redirect: 'error' })
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://quick-app.example.test/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    const responseRequestBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body)
    )
    expect(responseRequestBody.model).toBe('discovered-deployment')
    expect(responseRequestBody.service_tier).toBe('priority')
    expect(responseRequestBody.stream).toBe(true)
    expect(responseRequestBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ type: 'input_image' })])
        })
      ])
    )
  })

  it.each([
    { ids: ['z-last-alphabetically', 'a-first-alphabetically'] },
    { ids: ['a-first-alphabetically', 'z-last-alphabetically'] }
  ])('uses channel order rather than sorting model names: $ids', async ({ ids }) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: ids.map((id) => ({ id }))
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }]
              }
            ]
          }),
          { status: 200 }
        )
      )
    const futureProfile = {
      ...profile,
      base_url: `https://order-${ids[0]}.example.test/v1`
    }
    const cli = codexMainLlmProxyExtension.createCli?.(
      futureProfile,
      context(profile.id, fetchImpl)
    )

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const body = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))
    expect(body.model).toBe(ids[0])
  })

  it('preserves the configured model when no per-thread model was selected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
        })
      )
    )
    const configuredProfile = {
      ...profile,
      model_name: 'my-selected-deployment'
    }
    const cli = codexMainLlmProxyExtension.createCli?.(
      configuredProfile,
      context(profile.id, fetchImpl)
    )

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe(
      'my-selected-deployment'
    )
  })

  it('enables the hosted web-search tool for explicit CLIProxyAPI/Codex models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'searched' }] }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const configuredProfile = {
      ...profile,
      model_name: 'proxy-search-model'
    }
    const cli = codexMainLlmProxyExtension.createCli?.(
      configuredProfile,
      context(profile.id, fetchImpl)
    )

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'search the web' }] })
    ).resolves.toMatchObject({ content: 'searched' })

    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([expect.objectContaining({ type: 'web_search' })])
    expect(requestBody.include).toEqual(['web_search_call.action.sources'])
  })

  it('does not start hosted file-search resources when CLIProxy receives an attachment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'searched' }] }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const cli = codexMainLlmProxyExtension.createCli?.(
      { ...profile, model_name: 'proxy-search-with-file' },
      context(profile.id, fetchImpl)
    )

    await expect(
      cli?.chat({
        messages: [
          {
            role: 'user',
            content: 'search the web and use this note',
            attachments: [
              { type: 'file', url: 'data:text/plain;base64,aGVsbG8=', fileName: 'note.txt' }
            ]
          }
        ]
      })
    ).resolves.toMatchObject({ content: 'searched' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([expect.objectContaining({ type: 'web_search' })])
    expect(requestBody.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'file_search' })])
    )
    expect(requestBody.include).toEqual(['web_search_call.action.sources'])
  })

  it.each(['discovered', 'configured'] as const)(
    'keeps CLIProxy image tool_choice compatible for the %s model path',
    async (selection) => {
      const imageProfile: LLMAPIProfile = {
        ...profile,
        base_url: `https://image-${selection}.example.test/v1`,
        model_use: 'agent',
        model_name: selection === 'configured' ? 'selected-image-model' : ''
      }
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'selected-image-model' }] }), {
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                { type: 'image_generation_call', result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }
              ]
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
      const cli = codexMainLlmProxyExtension.createCli?.(
        imageProfile,
        context(imageProfile.id, fetchImpl)
      )
      await expect(
        cli?.chat({
          messages: [{ role: 'user', content: 'Edit the image.' }],
          imageGenerationOptions: { enabled: true, action: 'edit', outputFormat: 'png' },
          retryCapacity: true
        })
      ).resolves.toMatchObject({ attachments: [expect.objectContaining({ type: 'image' })] })

      const requests = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/responses'))
      expect(requests).toHaveLength(1)
      const requestBody = JSON.parse(String(requests[0][1]?.body))
      expect(requestBody.model).toBe('selected-image-model')
      expect(requestBody.tool_choice).toBe('auto')
      expect(requestBody.tools).toEqual([expect.objectContaining({ type: 'image_generation' })])
      expect(requestBody.stream).toBe(true)
      expect(requestBody.service_tier).toBe('priority')
      expect(fetchImpl).toHaveBeenCalledTimes(selection === 'discovered' ? 2 : 1)
    }
  )

  it('surfaces a provider rejection without retrying with a hardcoded model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'This deployment does not support the requested operation.'
          }
        }),
        { status: 400 }
      )
    )
    const selectedId = buildCodexModelProfileId(profile.id, 'team/unsupported-operation')
    const cli = codexMainLlmProxyExtension.createCli?.(profile, context(selectedId, fetchImpl))

    await expect(cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe(
      'team/unsupported-operation'
    )
  })

  it('does not apply a virtual model that belongs to another profile', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/models')) {
        return Response.json({ data: [{ id: 'this-channel-model' }] })
      }
      const body = JSON.parse(String(init?.body))
      return Response.json({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: body.model }]
          }
        ]
      })
    })
    const rawProfileId = buildCodexModelProfileId('other-profile', 'other-channel-model')
    const isolatedProfile = { ...profile, base_url: 'https://virtual-profile-fixture.example.test/v1' }
    const cli = codexMainLlmProxyExtension.createCli?.(isolatedProfile, context(rawProfileId, fetchImpl))

    await expect(
      cli?.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'this-channel-model' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://virtual-profile-fixture.example.test/v1/models',
      expect.objectContaining({ redirect: 'error' })
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://virtual-profile-fixture.example.test/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    const responseRequestBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body)
    )
    expect(responseRequestBody.model).toBe('this-channel-model')
    expect(responseRequestBody.model).not.toBe('other-channel-model')
  })
})

describe('existing private registry supplies an explicitly selected ordinary-thread image backend', () => {
  it('connects factory to client without auth/model discovery during tool discovery', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.use_remote_llm = false
    config.llm_config.api_profiles = [{ ...profile, model_name: 'selected-model' }]
    vi.mocked(getConfig).mockReturnValue(config)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: 'QUJD' }], output_format: 'png' }))
    const generator = codexMainLlmProxyExtension.createThreadImageGenerator?.({ profileId: profile.id, messages: [] }, { config, fetchImpl })
    expect(generator?.approval).toMatchObject({ backend: 'openai-images-api-key', endpoint: profile.base_url, profileId: profile.id })
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(generator?.generate('one fixture', { transparentBackground: false, signal: new AbortController().signal })).resolves.toMatchObject({ attachments: [{ type: 'image', url: 'data:image/png;base64,QUJD' }] })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][0]).toBe(`${profile.base_url}/images/generations`)
  })
})

describe('native tool capability through automatic model selection', () => {
  it.each(['codex-oauth', 'cliproxy'] as const)(
    'preserves capability before %s model discovery',
    (mode) => {
      const candidate: LLMAPIProfile = {
        ...profile,
        model_name: '',
        ...(mode === 'codex-oauth'
          ? { auth_mode: 'codex_oauth' as const, call_type: 'codex' as const }
          : {})
      }
      const cli = codexMainLlmProxyExtension.createCli?.(candidate, context(profile.id, vi.fn()))
      expect(cli?.supportsNativeTools).toBe(true)
    }
  )
})
