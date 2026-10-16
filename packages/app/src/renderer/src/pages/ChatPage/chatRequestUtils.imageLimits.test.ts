import { DEFAULT_CONFIG, type Config, type LLMOpenAIApiMode } from '@shared/config/config'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY } from '@shared/llm/openaiResponses'
import {
  preflightChatRequestImages,
  requestChatCompletion,
  requestChatCompletionStream
} from './chatRequestUtils'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

const formerImageLimit = 10
const imageDataUrl = 'data:image/png;base64,aW1hZ2U='
const makeConfig = (apiMode: LLMOpenAIApiMode = 'responses'): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'fixture-profile',
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'chat',
        model_name: 'fixture-opaque-model',
        base_url: 'https://fixture.example/v1',
        api_key: 'fixture-not-a-credential',
        api_mode: apiMode,
        attachment_transports: ['request-data-url', 'accessible-url']
      }
    ]
  },
  plugin_config: { ...DEFAULT_CONFIG.plugin_config, api_profiles: [], light_adjustment_prompt: '' },
  remote_llm_server_config: {
    ...DEFAULT_CONFIG.remote_llm_server_config,
    server_origin: 'http://127.0.0.1:1',
    access_token: ''
  }
})
const image = (index: number): ChatAttachment => ({
  type: 'image',
  url: `local-media:///fixture/reference-${index}.png`,
  mimeType: 'image/png',
  fileName: `reference-${index}.png`
})
const turn = (count: number): ChatMessage => ({
  role: 'user',
  content: 'Analyze selected references.',
  attachments: Array.from({ length: count }, (_, index) => image(index))
})
const inlineTurn = (count: number): ChatMessage => ({
  ...turn(count),
  attachments: Array.from({ length: count }, (_, index) => ({ ...image(index), url: imageDataUrl }))
})
const managedImage = (sizeBytes = 5): NonNullable<ChatAttachment['media']> => ({
  version: 1,
  kind: 'managed',
  relativePath: `originals/aa/${'a'.repeat(64)}.png`,
  mimeType: 'image/png',
  sizeBytes,
  sha256: 'a'.repeat(64),
  originalFileName: 'fixture.png'
})
const fixture = () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error('Owned fetch sentinel'))
  const materializeForRequest = vi.fn().mockRejectedValue(new Error('Owned IPC sentinel'))
  const chat = vi
    .fn<
      (payload: {
        messages: ChatMessage[]
        apiMode?: LLMOpenAIApiMode
      }) => Promise<{ content: string }>
    >()
    .mockResolvedValue({ content: 'Owned fixture answer.' })
  const chatStream = vi.fn().mockImplementation(async (payload: { messages: ChatMessage[] }) => {
    await chat(payload)
  })
  const remoteFetch = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  window.api = {
    svcManagedMedia: { materializeForRequest },
    svcLLMProxy: { chat, chatStream, remoteFetch }
  } as unknown as Window['api']
  return { fetchMock, materializeForRequest, chat, chatStream, remoteFetch }
}
const request = (stream: boolean, config: Config, messages: ChatMessage[], extras = {}) =>
  stream
    ? requestChatCompletionStream({
        config,
        messages,
        profileId: 'fixture-profile',
        onEvent: vi.fn(),
        ...extras
      })
    : requestChatCompletion({ config, messages, profileId: 'fixture-profile', ...extras })
const dispatchedImages = (f: ReturnType<typeof fixture>) =>
  f.chat.mock.calls
    .at(-1)![0]
    .messages.flatMap((message) => message.attachments || [])
    .filter((attachment) => attachment.type === 'image')
const imageResponse = () => ({
  ok: true,
  headers: { get: () => 'image/png' },
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
})

describe('default Responses image policy', () => {
  it('defaults count, decoded bytes, aggregate bytes, body bytes and pixels to unlimited', () => {
    expect(DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxImages).toBe(Infinity)
  })

  it.each([false, true])(
    'allows report manifest preparation alongside more than ten images (stream=%s)',
    async (stream) => {
      const f = fixture()
      const message = inlineTurn(formerImageLimit + 1)
      const manifestUrl = 'local-media:///fixture/report.manifest.json'
      message.attachments!.push({
        type: 'file',
        url: 'data:text/plain;base64,b3duZWQ=',
        fileName: 'report.txt',
        reportBundleRole: 'primary-report',
        reportBundleManifestUrl: manifestUrl
      })
      f.fetchMock.mockImplementation(async (url) => {
        if (url === manifestUrl)
          return {
            ok: true,
            text: async () =>
              JSON.stringify({ version: 1, bundleId: 'fixture', title: 'fixture', entries: [] })
          }
        if (url === 'data:text/plain;base64,b3duZWQ=')
          return {
            ok: true,
            text: async () => 'fixture',
            headers: { get: () => 'text/plain' }
          }
        throw new Error('Unexpected attachment fetch')
      })
      await expect(request(stream, makeConfig(), [message])).resolves.toBeDefined()
      expect(f.fetchMock).toHaveBeenCalledWith(manifestUrl)
      expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
      expect(f.remoteFetch).not.toHaveBeenCalled()
    }
  )

  it('dispatches explicit Responses to a remote proxy with more than ten images', async () => {
    const f = fixture(),
      config = makeConfig()
    config.use_remote_llm = true
    f.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ content: 'Owned remote result.' }), {
        headers: { 'content-type': 'application/json' }
      })
    )
    await expect(
      request(false, config, [inlineTurn(formerImageLimit + 1)], {
        remoteProfile: config.llm_config.api_profiles[0]
      })
    ).resolves.toMatchObject({ content: 'Owned remote result.' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(f.fetchMock.mock.calls[0][1].body)
    expect(payload.apiMode).toBe('responses')
    expect(payload.messages[0].attachments).toHaveLength(formerImageLimit + 1)
    expect(f.chat).not.toHaveBeenCalled()
  })

  it('dispatches the aggregate selected history above the former count limit', async () => {
    const f = fixture()
    const messages = [inlineTurn(formerImageLimit), inlineTurn(1)]
    const before = JSON.stringify(messages)
    await expect(
      request(false, makeConfig(), messages, { imageHistoryPolicy: 'all' })
    ).resolves.toMatchObject({ content: 'Owned fixture answer.' })
    expect(f.chat).toHaveBeenCalledTimes(1)
    expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('keeps omitted history and source data intact for an explicit continuation policy', async () => {
    const f = fixture(),
      messages = [turn(formerImageLimit + 1), inlineTurn(1)]
    const before = JSON.stringify(messages)
    await expect(
      request(false, makeConfig(), messages, { imageHistoryPolicy: 'latest-user-turn' })
    ).resolves.toMatchObject({ content: 'Owned fixture answer.' })
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(f.chat).toHaveBeenCalledTimes(1)
    expect(dispatchedImages(f)).toHaveLength(1)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('uses the runnable default Responses profile when the caller omits a profile ID', async () => {
    const f = fixture()
    const input = { config: makeConfig(), messages: [inlineTurn(formerImageLimit + 1)] }
    expect(preflightChatRequestImages(input)).toBe(Infinity)
    await expect(requestChatCompletion(input)).resolves.toMatchObject({
      content: 'Owned fixture answer.'
    })
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(f.chat).toHaveBeenCalledTimes(1)
    expect(f.chat.mock.calls[0][0].apiMode).toBe('responses')
    expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
  })

  it('proves a permitted managed reference reaches the materialization IPC sentinel', async () => {
    const f = fixture(),
      message = turn(1)
    message.attachments![0].media = managedImage()
    await expect(request(false, makeConfig(), [message])).rejects.toThrow('Owned IPC sentinel')
    expect(f.materializeForRequest).toHaveBeenCalledTimes(1)
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
  })

  it.each(['official', 'zen'] as const)(
    'recognizes automatic %s Responses routing without a default count cap',
    async (route) => {
      const f = fixture(),
        config = makeConfig('auto')
      config.llm_config.api_profiles[0].base_url =
        route === 'official' ? 'https://api.openai.com/v1' : 'https://opencode.ai/zen/v1'
      if (route === 'zen') config.llm_config.api_profiles[0].model_name = 'gpt-5.1'
      const messages = [inlineTurn(formerImageLimit + 1)]
      expect(preflightChatRequestImages({ config, messages, profileId: 'fixture-profile' })).toBe(
        Infinity
      )
      await expect(request(false, config, messages)).resolves.toMatchObject({
        content: 'Owned fixture answer.'
      })
      expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
      expect(f.fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each(['images', 'chat-completions'] as const)(
    'does not apply the Responses policy to explicit %s',
    async (apiMode) => {
      const f = fixture(),
        config = makeConfig(apiMode),
        messages = [inlineTurn(formerImageLimit + 1)]
      expect(
        preflightChatRequestImages({ config, messages, profileId: 'fixture-profile' })
      ).toBeUndefined()
      await expect(request(false, config, messages)).resolves.toMatchObject({
        content: 'Owned fixture answer.'
      })
      expect(f.chat).toHaveBeenCalledTimes(1)
      expect(f.chat.mock.calls[0][0].apiMode).toBe(apiMode)
      expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
    }
  )

  it.each([false, true])('honors per-request Responses overrides (stream=%s)', async (stream) => {
    const f = fixture(),
      config = makeConfig('images'),
      messages = [inlineTurn(formerImageLimit + 1)]
    expect(
      preflightChatRequestImages({
        config,
        messages,
        profileId: 'fixture-profile',
        apiMode: 'responses'
      })
    ).toBe(Infinity)
    await expect(request(stream, config, messages, { apiMode: 'responses' })).resolves.toBeDefined()
    expect(f.chat.mock.calls[0][0].apiMode).toBe('responses')
    expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'materializes and dispatches bundle-discovered images above the former limit (stream=%s)',
    async (stream) => {
      const f = fixture(),
        message = turn(1)
      const manifestUrl = 'local-media:///fixture/report.manifest.json'
      message.attachments!.push({
        type: 'file',
        url: 'data:text/plain;base64,b3duZWQ=',
        fileName: 'report.txt',
        reportBundleRole: 'primary-report',
        reportBundleManifestUrl: manifestUrl
      })
      f.fetchMock.mockImplementation(async (url) => {
        if (url === 'data:text/plain;base64,b3duZWQ=')
          return {
            ok: true,
            text: async () => 'fixture',
            headers: { get: () => 'text/plain' }
          }
        if (url !== manifestUrl) return imageResponse()
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              version: 1,
              bundleId: 'fixture',
              title: 'fixture',
              entries: Array.from({ length: formerImageLimit }, (_, i) => ({
                role: 'report-image',
                fileName: `extra-${i}.png`,
                sourceUrl: `local-media:///fixture/extra-${i}.png`
              }))
            })
        }
      })
      await expect(request(stream, makeConfig(), [message])).resolves.toBeDefined()
      expect(f.fetchMock.mock.calls[0][0]).toBe(manifestUrl)
      expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('.png'))).toHaveLength(
        formerImageLimit + 1
      )
      expect(dispatchedImages(f)).toHaveLength(formerImageLimit + 1)
      expect(
        dispatchedImages(f).every((attachment) => attachment.url.startsWith('data:image/'))
      ).toBe(true)
      expect(f.materializeForRequest).not.toHaveBeenCalled()
    }
  )

  it('reapplies latest-user history after manifest expansion without resurrecting omitted images', async () => {
    const f = fixture(),
      old = turn(0),
      latest = inlineTurn(1)
    const manifestUrl = 'local-media:///fixture/old.manifest.json'
    old.attachments!.push({
      type: 'file',
      url: 'data:text/plain;base64,b3duZWQ=',
      fileName: 'report.txt',
      reportBundleRole: 'primary-report',
      reportBundleManifestUrl: manifestUrl
    })
    const messages = [old, latest],
      before = JSON.stringify(messages)
    f.fetchMock.mockImplementation(async (url) => {
      if (url === 'data:text/plain;base64,b3duZWQ=')
        return { ok: true, text: async () => 'fixture' }
      if (url !== manifestUrl) throw new Error('Omitted image was fetched')
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            version: 1,
            bundleId: 'fixture-old',
            title: 'fixture-old',
            entries: Array.from({ length: formerImageLimit + 1 }, (_, i) => ({
              role: 'report-image',
              fileName: `old-${i}.png`,
              sourceUrl: `local-media:///fixture/old-${i}.png`
            }))
          })
      }
    })
    await expect(
      request(false, makeConfig(), messages, { imageHistoryPolicy: 'latest-user-turn' })
    ).resolves.toMatchObject({ content: 'Owned fixture answer.' })
    expect(f.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      manifestUrl,
      'data:text/plain;base64,b3duZWQ='
    ])
    expect(JSON.stringify(messages)).toBe(before)
    expect(dispatchedImages(f)).toHaveLength(1)
  })

  it('does not treat automatic Images endpoints as Responses just because the host is official', async () => {
    const f = fixture(),
      config = makeConfig('auto'),
      messages = [inlineTurn(formerImageLimit + 1)]
    config.llm_config.api_profiles[0].base_url = 'https://api.openai.com/v1/images/edits'
    expect(
      preflightChatRequestImages({ config, messages, profileId: 'fixture-profile' })
    ).toBeUndefined()
    await expect(request(false, config, messages)).resolves.toMatchObject({
      content: 'Owned fixture answer.'
    })
    expect(f.chat).toHaveBeenCalledTimes(1)
  })
})

const finiteConfig = (limit: number): Config => {
  const config = makeConfig()
  config.llm_config.api_profiles[0].max_input_images = limit
  return config
}

describe('provider-declared finite Responses image limits', () => {
  it.each([false, true])(
    'accepts the exact limit without counting twice (stream=%s)',
    async (stream) => {
      const f = fixture()
      const config = finiteConfig(2)
      const messages = [inlineTurn(2)]
      expect(preflightChatRequestImages({ config, messages, imageHistoryPolicy: 'all' })).toBe(2)
      await expect(
        request(stream, config, messages, { imageHistoryPolicy: 'all' })
      ).resolves.toBeDefined()
      expect(f.chat).toHaveBeenCalledTimes(1)
      expect(dispatchedImages(f)).toHaveLength(2)
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'rejects over-limit managed inputs before IPC or fetch (stream=%s)',
    async (stream) => {
      const f = fixture()
      const message = turn(3)
      message.attachments![0].media = managedImage()
      await expect(
        request(stream, finiteConfig(2), [message], { imageHistoryPolicy: 'all' })
      ).rejects.toThrow('Too many images; the limit is 2.')
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
      expect(f.chat).not.toHaveBeenCalled()
      expect(f.chatStream).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'counts selected assistant references before any materialization (stream=%s)',
    async (stream) => {
      const f = fixture()
      const messages: ChatMessage[] = [{ ...turn(2), role: 'assistant' }, inlineTurn(1)]
      const before = JSON.stringify(messages)
      await expect(
        request(stream, finiteConfig(2), messages, { imageHistoryPolicy: 'all' })
      ).rejects.toThrow('Too many images; the limit is 2.')
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.materializeForRequest).not.toHaveBeenCalled()
      expect(f.chat).not.toHaveBeenCalled()
      expect(JSON.stringify(messages)).toBe(before)
    }
  )

  it.each([false, true])(
    'checks known over-limit inputs before reading report manifests (stream=%s)',
    async (stream) => {
      const f = fixture()
      const message = turn(3)
      message.attachments!.push({
        type: 'file',
        url: 'data:text/plain;base64,b3duZWQ=',
        fileName: 'report.txt',
        reportBundleRole: 'primary-report',
        reportBundleManifestUrl: 'local-media:///fixture/report.manifest.json'
      })
      await expect(
        request(stream, finiteConfig(2), [message], { imageHistoryPolicy: 'all' })
      ).rejects.toThrow('Too many images; the limit is 2.')
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.chat).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'rechecks newly discovered report images before probes and image fetch (stream=%s)',
    async (stream) => {
      const f = fixture()
      const manifestUrl = 'local-media:///fixture/report.manifest.json'
      const message = turn(1)
      message.attachments!.push({
        type: 'file',
        url: 'data:text/plain;base64,b3duZWQ=',
        fileName: 'report.txt',
        reportBundleRole: 'primary-report',
        reportBundleManifestUrl: manifestUrl
      })
      f.fetchMock.mockImplementation(async (url) => {
        if (url !== manifestUrl) throw new Error('Image materialized before count validation')
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              version: 1,
              bundleId: 'fixture',
              title: 'Owned report',
              entries: [0, 1].map((index) => ({
                role: 'report-image',
                fileName: `discovered-${index}.png`,
                sourceUrl: `local-media:///fixture/discovered-${index}.png`
              }))
            })
        }
      })
      await expect(
        request(stream, finiteConfig(2), [message], { imageHistoryPolicy: 'all' })
      ).rejects.toThrow('Too many images; the limit is 2.')
      expect(f.fetchMock.mock.calls.map(([url]) => url)).toEqual([manifestUrl])
      expect(f.materializeForRequest).not.toHaveBeenCalled()
      expect(f.chat).not.toHaveBeenCalled()
      expect(f.remoteFetch).not.toHaveBeenCalled()
    }
  )

  it('takes a finite remote capability from discovery, not a colliding unlimited local profile', async () => {
    const f = fixture()
    const config = makeConfig()
    config.use_remote_llm = true
    const remoteProfile = { ...config.llm_config.api_profiles[0], max_input_images: 2 }
    await expect(
      request(false, config, [turn(3)], { remoteProfile, imageHistoryPolicy: 'all' })
    ).rejects.toThrow('Too many images; the limit is 2.')
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
  })

  it('does not inherit a colliding local finite limit when the remote advertises unlimited', async () => {
    const f = fixture()
    const config = finiteConfig(0)
    config.use_remote_llm = true
    const remoteProfile = { ...config.llm_config.api_profiles[0], max_input_images: undefined }
    f.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ content: 'Remote unlimited.' }), {
        headers: { 'content-type': 'application/json' }
      })
    )
    await expect(
      request(false, config, [inlineTurn(2)], { remoteProfile, imageHistoryPolicy: 'all' })
    ).resolves.toMatchObject({ content: 'Remote unlimited.' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(f.chat).not.toHaveBeenCalled()
  })

  it('does not double-count a report image against its primary report imageCount metadata', () => {
    const config = finiteConfig(1)
    const message: ChatMessage = {
      role: 'user',
      content: 'Use the report image.',
      attachments: [
        {
          type: 'file',
          url: imageDataUrl,
          fileName: 'report.md',
          reportBundleId: 'fixture-bundle',
          reportBundleRole: 'primary-report',
          reportBundleImageCount: 1
        },
        {
          ...image(0),
          reportBundleId: 'fixture-bundle',
          reportBundleRole: 'report-image'
        }
      ]
    }

    expect(
      preflightChatRequestImages({ config, messages: [message], imageHistoryPolicy: 'all' })
    ).toBe(1)
  })
})
