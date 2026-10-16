import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'
import type { ChatMessage } from '@shared/llm'

const formerImageLimit = 10
const localProfile: LLMAPIProfile = {
  id: 'collision',
  api_key: 'fixture-not-a-credential',
  base_url: 'https://api.openai.com/v1',
  model_name: 'opaque',
  provider: 'openai',
  api_mode: 'auto',
  model_use: 'chat',
  attachment_transports: ['request-data-url', 'accessible-url']
}
const config = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: true,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ ...localProfile }] },
  remote_llm_server_config: { server_origin: 'https://fixture-proxy.example', access_token: '' }
})
const message = (count = formerImageLimit + 1): ChatMessage => ({
  role: 'user',
  content: 'Fixture remote route fixture.',
  attachments: Array.from({ length: count }, () => ({
    type: 'image',
    url: 'data:image/png;base64,aW1hZ2U='
  }))
})
const remote = (overrides: Partial<LLMAPIProfile> = {}) => ({
  id: 'collision',
  base_url: 'https://fixture-provider.example/v1',
  model_name: 'opaque',
  provider: 'openai' as const,
  api_mode: 'chat-completions' as const,
  model_use: 'chat' as const,
  ...overrides
})
const fixture = () => {
  const fetchMock = vi.fn().mockImplementation(async (url) => {
    if (url !== 'https://fixture-proxy.example/api/chat')
      throw new Error('Unexpected attachment fetch')
    return new Response(JSON.stringify({ content: 'Fixture remote result.' }), {
      headers: { 'content-type': 'application/json' }
    })
  })
  const chat = vi.fn().mockResolvedValue({ content: 'Fixture local result.' })
  const chatStream = vi.fn(
    async (request: unknown, stream: { onData: (data: unknown) => void }): Promise<void> => {
      const response = await fetchMock('https://fixture-proxy.example/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      })
      const result = (await response.json()) as { content?: string }
      const content = result.content || ''
      stream.onData({
        type: 'text-delta',
        delta: content,
        done: false,
        fullContent: content
      })
      stream.onData({
        type: 'done',
        delta: '',
        done: true,
        content,
        fullContent: content,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
      })
    }
  )
  const materializeForRequest = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  window.api = {
    svcLLMProxy: { chat, chatStream },
    svcManagedMedia: { materializeForRequest }
  } as unknown as Window['api']
  return { fetchMock, chat, chatStream, materializeForRequest }
}
const run = (stream: boolean, input: Parameters<typeof requestChatCompletion>[0]) =>
  stream
    ? requestChatCompletionStream({ ...input, onEvent: vi.fn() })
    : requestChatCompletion(input)
const remoteBody = (f: ReturnType<typeof fixture>) =>
  JSON.parse(f.fetchMock.mock.calls.at(-1)![1].body)
const remoteRequestInit = (f: ReturnType<typeof fixture>) => f.fetchMock.mock.calls.at(-1)![1]

afterEach(() => vi.unstubAllGlobals())

describe('remote image preflight uses selected remote metadata, never a local ID collision', () => {
  it.each([false, true])(
    'allows remote Chat Completions instead of applying local Responses limit (stream=%s)',
    async (stream) => {
      const f = fixture()
      await expect(
        run(stream, {
          config: config(),
          messages: [message()],
          profileId: 'collision',
          remoteProfile: remote()
        })
      ).resolves.toBeDefined()
      expect(f.fetchMock).toHaveBeenCalledTimes(1)
      expect(remoteBody(f).apiMode).toBe('chat-completions')
      expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
      expect(f.chat).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'dispatches remote-only explicit Responses above the former count limit (stream=%s)',
    async (stream) => {
      const f = fixture()
      await expect(
        run(stream, {
          config: config(),
          messages: [message()],
          profileId: 'remote-only',
          remoteProfile: remote({ id: 'remote-only', api_mode: 'responses' })
        })
      ).resolves.toBeDefined()
      if (stream) {
        expect(f.chatStream).toHaveBeenCalledTimes(1)
      } else {
        expect(f.fetchMock).toHaveBeenCalledTimes(1)
        expect(remoteBody(f).apiMode).toBe('responses')
        expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
      }
      expect(f.chat).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
    }
  )

  it('uses JSON fallback for remote non-Responses stream requests', async () => {
    const f = fixture()
    await expect(
      run(true, {
        config: config(),
        messages: [message(1)],
        profileId: 'collision',
        remoteProfile: remote({ api_mode: 'chat-completions' })
      })
    ).resolves.toBeDefined()
    expect(remoteRequestInit(f).body).not.toContain('"stream":true')
    expect(remoteBody(f).apiMode).toBe('chat-completions')
  })

  it('uses remote auto official route, not local Chat Completions route', async () => {
    const f = fixture(),
      cfg = config()
    cfg.llm_config.api_profiles[0].api_mode = 'chat-completions'
    await expect(
      run(false, {
        config: cfg,
        messages: [message()],
        profileId: 'collision',
        remoteProfile: remote({ api_mode: 'auto', base_url: 'https://api.openai.com/v1' })
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(remoteBody(f).apiMode).toBe('responses')
    expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
  })

  it('does not infer Responses for a remote Claude profile with a local OpenAI collision', async () => {
    const f = fixture()
    await expect(
      run(false, {
        config: config(),
        messages: [message()],
        profileId: 'collision',
        remoteProfile: remote({
          provider: 'claude',
          api_mode: 'auto',
          base_url: 'https://api.anthropic.com'
        })
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors an explicit Responses override for a remote-only compatible route', async () => {
    const f = fixture()
    await expect(
      run(false, {
        config: config(),
        messages: [message()],
        profileId: 'remote-only',
        apiMode: 'responses',
        remoteProfile: remote({ id: 'remote-only' })
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(remoteBody(f).apiMode).toBe('responses')
    expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
  })

  it('honors an Images override without inheriting the remote Responses count limit', async () => {
    const f = fixture()
    await expect(
      run(false, {
        config: config(),
        messages: [message()],
        profileId: 'collision',
        apiMode: 'images',
        remoteProfile: remote({ api_mode: 'responses' })
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(remoteBody(f).apiMode).toBe('images')
    expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
  })

  it('pins the remote metadata profile when the caller omits an explicit ID', async () => {
    const f = fixture()
    await expect(
      run(false, {
        config: config(),
        messages: [message()],
        remoteProfile: remote({ id: 'remote-default' })
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(remoteBody(f).profileId).toBe('remote-default')
  })

  it('rejects metadata for another selected remote ID before preparation', async () => {
    const f = fixture()
    await expect(
      run(false, {
        config: config(),
        messages: [message(1)],
        profileId: 'selected',
        remoteProfile: remote({ id: 'other' })
      })
    ).rejects.toThrow('Remote profile metadata does not match the selected profile.')
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('does not infer a local policy or transmit a local API mode when remote metadata is unavailable', async () => {
    const f = fixture(),
      cfg = config()
    cfg.llm_config.api_profiles[0].api_mode = 'responses'
    await expect(
      run(false, { config: cfg, messages: [message(0)], profileId: 'collision' })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(remoteBody(f)).not.toHaveProperty('apiMode')
  })

  it.each([false, true])(
    'rejects unknown remote image routing rather than using a local collision (stream=%s)',
    async (stream) => {
      const f = fixture()
      await expect(
        run(stream, { config: config(), messages: [message()], profileId: 'collision' })
      ).rejects.toThrow('Remote image routing metadata is unavailable.')
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
    }
  )

  it('dispatches explicitly requested Responses without remote discovery metadata', async () => {
    const f = fixture(),
      cfg = config()
    cfg.llm_config.api_profiles = []
    await expect(
      run(false, {
        config: cfg,
        messages: [message()],
        profileId: 'remote-only',
        apiMode: 'responses'
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(remoteBody(f).apiMode).toBe('responses')
    expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
  })

  it('does not serialize metadata or provider credentials into the remote request', async () => {
    const f = fixture(),
      metadata = { ...remote(), api_key: 'fixture-secret-sentinel' },
      before = JSON.stringify(metadata)
    await expect(
      run(false, {
        config: config(),
        messages: [message(1)],
        profileId: 'collision',
        remoteProfile: metadata
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(String(f.fetchMock.mock.calls[0][1].body)).not.toContain('fixture-secret-sentinel')
    expect(String(f.fetchMock.mock.calls[0][1].body)).not.toContain('fixture-provider.example')
    expect(JSON.stringify(metadata)).toBe(before)
  })

  it.each([false, true])(
    'uses sanitized remote override routing instead of recomputing without the hidden base URL (stream=%s)',
    async (stream) => {
      const f = fixture()
      const metadata = {
        ...remote({ base_url: '', api_mode: 'images' }),
        openai_api_modes: {
          default: 'images' as const,
          auto: 'responses' as const,
          responses: 'responses' as const,
          'chat-completions': 'chat-completions' as const,
          images: 'images' as const
        }
      }
      await expect(
        run(stream, {
          config: config(),
          messages: [message()],
          profileId: 'collision',
          apiMode: 'auto',
          remoteProfile: metadata
        })
      ).resolves.toBeDefined()
      if (stream) {
        expect(f.chatStream).toHaveBeenCalledTimes(1)
      } else {
        expect(remoteBody(f).apiMode).toBe('responses')
        expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
      }
    }
  )

  it('preserves Zen Responses routing when its real route ignores an Images override', async () => {
    const f = fixture()
    const metadata = {
      ...remote({ base_url: '', api_mode: 'responses' }),
      openai_api_modes: {
        default: 'responses' as const,
        auto: 'responses' as const,
        responses: 'responses' as const,
        'chat-completions': 'responses' as const,
        images: 'responses' as const
      }
    }
    await expect(
      run(false, {
        config: config(),
        messages: [message()],
        profileId: 'collision',
        apiMode: 'images',
        remoteProfile: metadata
      })
    ).resolves.toMatchObject({ content: 'Fixture remote result.' })
    expect(remoteBody(f).apiMode).toBe('images')
    expect(remoteBody(f).messages[0].attachments).toHaveLength(formerImageLimit + 1)
  })

  it.each([{}, { default: 'responses' }, { default: 'unsupported' }])(
    'rejects malformed override metadata before materialization: %j',
    async (openai_api_modes) => {
      const f = fixture()
      const metadata = { ...remote(), openai_api_modes } as unknown as NonNullable<
        Parameters<typeof requestChatCompletion>[0]['remoteProfile']
      >
      await expect(
        run(false, {
          config: config(),
          messages: [message(1)],
          profileId: 'collision',
          remoteProfile: metadata
        })
      ).rejects.toThrow('Remote image routing metadata is invalid.')
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
    }
  )

  it('rejects a legacy discovery record that has no usable remote route metadata', async () => {
    const f = fixture()
    await expect(
      run(false, {
        config: config(),
        messages: [message()],
        profileId: 'legacy',
        remoteProfile: { id: 'legacy', model_name: 'opaque', base_url: '' }
      })
    ).rejects.toThrow('Remote image routing metadata is unavailable.')
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('dispatches local Responses above the former count limit when remote metadata is ignored in local mode', async () => {
    const f = fixture(),
      cfg = config()
    cfg.use_remote_llm = false
    await expect(
      run(false, {
        config: cfg,
        messages: [message()],
        profileId: 'collision',
        remoteProfile: remote()
      })
    ).resolves.toMatchObject({ content: 'Fixture local result.' })
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(f.chat).toHaveBeenCalledTimes(1)
    expect(f.chat.mock.calls[0][0].messages[0].attachments).toHaveLength(formerImageLimit + 1)
  })
})
