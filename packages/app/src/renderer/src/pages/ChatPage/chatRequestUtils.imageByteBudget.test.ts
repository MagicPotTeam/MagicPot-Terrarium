import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import {
  MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES,
  MAX_CHAT_IMAGE_PREPARATION_SOURCE_BYTES,
  MAX_REMOTE_CHAT_STREAM_REQUEST_BYTES
} from '@shared/llm/chatAttachmentTransportLimits'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES } from '@shared/llm/providerJsonBudget'
import {
  preflightChatRequestImages,
  preflightChatRequestReports,
  requestChatCompletion,
  requestChatCompletionStream
} from './chatRequestUtils'
import { createReportBundleRegistryFixture } from './__fixtures__/reportBundleFixtures'
import {
  ChatRequestImageBudgetError,
  CHAT_REQUEST_IMAGE_BUDGET_EXCEEDED,
  describeRequestImageSize
} from './chatRequestImageBudget'

const MiB = 1024 * 1024
const REPORT_JPEG_BYTES = Math.floor(6_828_020 / 8)

const profile = (overrides: Partial<LLMAPIProfile> = {}): LLMAPIProfile =>
  ({
    id: 'fixture',
    provider: 'openai',
    deployment: 'cloud',
    model_use: 'chat',
    model_name: 'fixture',
    base_url: 'https://provider.invalid/v1',
    api_key: 'fixture',
    api_mode: 'responses',
    call_type: 'api',
    attachment_transports: ['request-data-url'],
    ...overrides
  }) as LLMAPIProfile

const localConfig = (overrides: Partial<LLMAPIProfile> = {}): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [profile(overrides)] }
})

let imageSerial = 0
const managedImage = (sizeBytes: number, hash?: string): ChatAttachment => {
  const sha256 = hash ?? (imageSerial++).toString(16).padStart(64, '0')
  return {
    type: 'image',
    url: `local-media:///fixture/${sha256}.png`,
    fileName: 'fixture.png',
    media: {
      version: 1,
      kind: 'managed',
      relativePath: `originals/${sha256.slice(0, 2)}/${sha256}.png`,
      sha256,
      sizeBytes,
      mimeType: 'image/png',
      originalFileName: 'fixture.png'
    }
  } as ChatAttachment
}

const turns = (count: number, imagesPerTurn: number, sizeBytes: number, content = 'look'): ChatMessage[] =>
  Array.from({ length: count }, (_, turn): ChatMessage[] => [
    {
      role: 'user',
      content,
      attachments: Array.from({ length: imagesPerTurn }, () => managedImage(sizeBytes))
    },
    ...(turn < count - 1 ? [{ role: 'assistant' as const, content: 'ok' }] : [])
  ]).flat()

const output = {
  transport: 'request-data-url' as const,
  dataUrl: 'data:image/png;base64,YQ==',
  mimeType: 'image/png',
  sizeBytes: 1
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function installBridge() {
  const materializeForRequest = vi.fn(async () => output)
  const chat = vi.fn(async () => ({ content: 'ok' }))
  const chatStream = vi.fn(async (_request: unknown, response: ServerStreaming<LLMChatStreamResp>) => {
    response.onData({ type: 'done', delta: '', done: true, content: 'ok', finishReason: 'stop' })
  })
  const fetchMock = vi.fn(async (_url?: unknown) => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetchMock)
  window.api = {
    svcManagedMedia: { materializeForRequest },
    svcLLMProxy: { chat, chatStream, remoteFetch: vi.fn() }
  } as unknown as Window['api']
  const nothingRead = () => {
    expect(materializeForRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(chatStream).not.toHaveBeenCalled()
  }
  return { materializeForRequest, chat, chatStream, fetchMock, nothingRead }
}

describe.each([false, true])('request image byte budget, stream=%s', (stream) => {
  type SendInput = Parameters<typeof requestChatCompletion>[0]
  const send = (input: Omit<SendInput, 'profileId'> & { profileId?: string | null }) => {
    const options = { profileId: 'fixture', ...input } as SendInput
    return stream
      ? requestChatCompletionStream({ ...options, onEvent: vi.fn() })
      : requestChatCompletion(options)
  }

  it('refuses the fifth 8-image turn of the report shape before reading any image (built-in Responses route)', async () => {
    const bridge = installBridge()
    const messages = turns(5, 8, REPORT_JPEG_BYTES)
    const snapshot = structuredClone(messages)
    const error = await send({ config: localConfig(), messages, imageHistoryPolicy: 'all' }).catch((value) => value)
    expect(error).toBeInstanceOf(ChatRequestImageBudgetError)
    expect(error.code).toBe(CHAT_REQUEST_IMAGE_BUDGET_EXCEEDED)
    bridge.nothingRead()
    expect(messages).toEqual(snapshot)
  })

  it('still sends the fourth turn, which MAIN accepts', async () => {
    const bridge = installBridge()
    await expect(
      send({ config: localConfig(), messages: turns(4, 8, REPORT_JPEG_BYTES), imageHistoryPolicy: 'all' })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(32)
    expect(stream ? bridge.chatStream : bridge.chat).toHaveBeenCalledOnce()
  })

  it('applies the preparation limits, not the provider JSON budget, to original bytes MAIN re-encodes', async () => {
    const bridge = installBridge()
    // 31 MiB of originals: their base64 (41 MiB) is far above 28 MiB, but MAIN re-encodes
    // them below 512 KB each on this route and accepts the request.
    const fits = MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES - MiB
    expect(Math.ceil(fits / 3) * 4).toBeGreaterThan(DEFAULT_PROVIDER_JSON_MAX_BYTES)
    await expect(
      send({ config: localConfig(), messages: [{ role: 'user', content: 'look', attachments: [managedImage(fits / 2), managedImage(fits / 2)] }] })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(2)
  })

  it('refuses at exactly one byte over the batch limit and accepts the limit itself', async () => {
    const limit = MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES
    let bridge = installBridge()
    await expect(
      send({ config: localConfig(), messages: [{ role: 'user', content: 'look', attachments: [managedImage(limit / 2), managedImage(limit / 2 + 1)] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    bridge.nothingRead()
    bridge = installBridge()
    await expect(
      send({ config: localConfig(), messages: [{ role: 'user', content: 'look', attachments: [managedImage(limit / 2), managedImage(limit / 2)] }] })
    ).resolves.toBeDefined()
  })

  it('refuses one image above the per-image preparation limit', async () => {
    const bridge = installBridge()
    await expect(
      send({ config: localConfig(), messages: [{ role: 'user', content: 'look', attachments: [managedImage(MAX_CHAT_IMAGE_PREPARATION_SOURCE_BYTES + 1)] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    bridge.nothingRead()
  })

  it('counts the same image delivered twice as two occurrences, as MAIN does', async () => {
    const bridge = installBridge()
    const hash = 'a'.repeat(64)
    const half = MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES / 2 + 1
    await expect(
      send({ config: localConfig(), messages: [{ role: 'user', content: 'look', attachments: [managedImage(half, hash), managedImage(half, hash)] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    bridge.nothingRead()
  })

  it('does not count history images the history policy leaves out', async () => {
    const bridge = installBridge()
    await expect(
      send({ config: localConfig(), messages: turns(5, 8, REPORT_JPEG_BYTES), imageHistoryPolicy: 'latest-user-turn' })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(8)
  })

  it('does not count history images when a continuation is sent', async () => {
    const bridge = installBridge()
    await expect(
      send({ config: localConfig(), messages: turns(5, 8, REPORT_JPEG_BYTES), imageHistoryPolicy: 'all', sessionUrl: 'resp_fixture' })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(40)
  })

  it.each([
    ['explicit image generation', { imageGenerationOptions: { enabled: true } }, 'look'],
    ['an image-generation request contract', { imageRequest: { kind: 'generate' } }, 'look'],
    ['automatic image generation from the text', {}, '帮我生成图片'],
    ['a skill runtime', { skillRuntime: { skillId: 'fixture' } }, 'look']
  ])('leaves %s exempt', async (_label, extra, content) => {
    const bridge = installBridge()
    await expect(
      send({
        config: localConfig(),
        messages: turns(5, 8, REPORT_JPEG_BYTES, content),
        imageHistoryPolicy: 'all',
        ...(extra as Partial<SendInput>)
      })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(40)
  })

  it('leaves external agents exempt', async () => {
    installBridge()
    const result = await send({
      config: localConfig(),
      messages: turns(5, 8, REPORT_JPEG_BYTES),
      imageHistoryPolicy: 'all',
      externalAgentSkill: { id: 'agent', type: 'agent', category: 'owned', skillName: 'agent', prompt: 'x', apiAddress: 'https://agent.invalid' } as SendInput['externalAgentSkill']
    }).catch((value) => value)
    expect(result).not.toBeInstanceOf(ChatRequestImageBudgetError)
  })

  it('leaves a request exempt when the image file names make MAIN choose hosted image generation', async () => {
    const bridge = installBridge()
    const messages = turns(5, 8, REPORT_JPEG_BYTES, 'look')
    // "image ... design" in the attachment summary MAIN appends to the text.
    for (const attachment of messages.at(-1)!.attachments!) attachment.fileName = 'design-v2.png'
    await expect(send({ config: localConfig(), messages, imageHistoryPolicy: 'all' })).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(40)
  })

  it('keeps today’s behaviour for images whose size is not known from a managed reference or a data URL', async () => {
    const bridge = installBridge()
    const attachments: ChatAttachment[] = [
      { type: 'image', url: 'local-media:///fixture/a.png', fileName: 'a.png', sizeBytes: 40 * MiB },
      { type: 'image', url: 'local-media:///fixture/b.png', fileName: 'b.png', sizeBytes: 40 * MiB }
    ]
    await expect(send({ config: localConfig(), messages: [{ role: 'user', content: 'look', attachments }] })).resolves.toBeDefined()
    expect(bridge.fetchMock).toHaveBeenCalledTimes(2)
  })

  it('applies no budget on the chat-completions route, which MAIN does not limit this way', async () => {
    const bridge = installBridge()
    await expect(
      send({ config: localConfig({ api_mode: 'chat-completions' }), messages: turns(5, 8, REPORT_JPEG_BYTES), imageHistoryPolicy: 'all' })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledTimes(40)
  })

  it.each(['gemini', 'claude'] as const)('refuses base64 above the provider JSON budget on the %s route', async (provider) => {
    let bridge = installBridge()
    const config = localConfig({ provider, api_mode: undefined, base_url: 'https://provider.invalid' })
    const over = Math.floor((DEFAULT_PROVIDER_JSON_MAX_BYTES / 4) * 3) + 3
    await expect(
      send({ config, messages: [{ role: 'user', content: 'look', attachments: [managedImage(over)] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    bridge.nothingRead()
    bridge = installBridge()
    await expect(
      send({ config, messages: [{ role: 'user', content: 'look', attachments: [managedImage(over - 3)] }] })
    ).resolves.toBeDefined()
    expect(bridge.materializeForRequest).toHaveBeenCalledOnce()
  })
})

describe('remote route', () => {
  const remoteProfile = {
    id: 'remote-fixture',
    provider: 'openai',
    model_name: 'fixture',
    model_use: 'chat',
    base_url: 'https://provider.invalid/v1',
    api_mode: 'responses',
    call_type: 'api',
    auth_mode: 'api_key',
    attachment_transports: ['request-data-url']
  } as unknown as LLMAPIProfile
  const remoteConfig: Config = {
    ...DEFAULT_CONFIG,
    use_remote_llm: true,
    remote_llm_server_config: { server_origin: 'https://fixture-proxy.invalid', access_token: '' }
  } as Config
  const over = Math.floor((MAX_REMOTE_CHAT_STREAM_REQUEST_BYTES / 4) * 3) + 3

  it('refuses a streamed request whose inline images exceed the remote request limit', async () => {
    const bridge = installBridge()
    await expect(
      requestChatCompletionStream({
        config: remoteConfig,
        remoteProfile,
        profileId: 'remote-fixture',
        messages: [{ role: 'user', content: 'look', attachments: [managedImage(over)] }],
        onEvent: vi.fn()
      })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    bridge.nothingRead()
  })

  it('checks the new message in the composer preflight and leaves the unary route alone', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'look', attachments: [managedImage(over)] }]
    const input = { config: remoteConfig, remoteProfile, profileId: 'remote-fixture', messages }
    expect(() => preflightChatRequestImages({ ...input, checkNewMessageImageBytes: true })).toThrow(ChatRequestImageBudgetError)
    expect(() => preflightChatRequestImages(input)).not.toThrow()
  })
})

describe('composer preflight', () => {
  it('refuses an oversized new message on a provider JSON route only when asked to', () => {
    const config = localConfig({ provider: 'gemini', api_mode: undefined, base_url: 'https://provider.invalid' })
    const messages: ChatMessage[] = [{ role: 'user', content: 'look', attachments: [managedImage(DEFAULT_PROVIDER_JSON_MAX_BYTES)] }]
    expect(() => preflightChatRequestImages({ config, messages, profileId: 'fixture', checkNewMessageImageBytes: true })).toThrow(ChatRequestImageBudgetError)
    expect(() => preflightChatRequestImages({ config, messages, profileId: 'fixture' })).not.toThrow()
  })

  it('leaves history and the Responses preparation limit to the request entry', () => {
    const history = turns(5, 8, REPORT_JPEG_BYTES)
    const gemini = localConfig({ provider: 'gemini', api_mode: undefined, base_url: 'https://provider.invalid' })
    expect(() => preflightChatRequestImages({ config: gemini, messages: history, profileId: 'fixture', imageHistoryPolicy: 'all', checkNewMessageImageBytes: true })).not.toThrow()
    const single: ChatMessage[] = [{ role: 'user', content: 'look', attachments: [managedImage(MAX_CHAT_IMAGE_PREPARATION_SOURCE_BYTES + 1)] }]
    expect(preflightChatRequestImages({ config: localConfig(), messages: single, profileId: 'fixture', checkNewMessageImageBytes: true })).toBeDefined()
  })
})

describe('describeRequestImageSize', () => {
  it('reads sizes only from managed references and well-formed base64 data URLs', () => {
    expect(describeRequestImageSize(managedImage(10))).toEqual({ sourceBytes: 10, base64Chars: 16 })
    expect(describeRequestImageSize({ type: 'image', url: 'data:image/png;base64,YWJj' })).toEqual({ sourceBytes: 3, base64Chars: 4 })
    expect(describeRequestImageSize({ type: 'image', url: 'data:image/png;base64,YQ==' })).toEqual({ sourceBytes: 1, base64Chars: 4 })
    expect(describeRequestImageSize({ type: 'image', url: 'data:image/png;base64,YW Jj' })).toBeUndefined()
    expect(describeRequestImageSize({ type: 'image', url: 'data:image/png,abc' })).toBeUndefined()
    expect(describeRequestImageSize({ type: 'image', url: 'blob:fixture', sizeBytes: 5 })).toBeUndefined()
    expect(describeRequestImageSize({ type: 'file', url: 'data:image/png;base64,YWJj' })).toBeUndefined()
  })
})

describe.each([false, true])('images of a report bundle MAIN verified, stream=%s', (stream) => {
  type SendInput = Parameters<typeof requestChatCompletion>[0]
  const conversationId = 'conversation-fixture'
  const manifestUrl = 'local-media:///synthetic/main-snapshot/manifest.json'
  const gemini = () => localConfig({ provider: 'gemini', api_mode: undefined, base_url: 'https://provider.invalid' })
  const send = (input: Omit<SendInput, 'profileId'>) => {
    const options = { profileId: 'fixture', conversationId, ...input } as SendInput
    return stream
      ? requestChatCompletionStream({ ...options, onEvent: vi.fn() })
      : requestChatCompletion(options)
  }
  const manifestEntry = (index: number, sizeBytes?: number) => ({
    role: 'report-image',
    fileName: `fig-${index}.png`,
    mimeType: 'image/png',
    refName: `fig-${index}`,
    sourceUrl: `local-media:///synthetic/bundle/fig-${index}.png`,
    ...(sizeBytes !== undefined ? { sizeBytes } : {})
  })

  // MAIN's snapshot manifest records the size it measured of every bundle image.
  function installBundle(imageSizes: Array<number | undefined>) {
    const bridge = installBridge()
    const reports = createReportBundleRegistryFixture()
    ;(window.api as unknown as Record<string, unknown>).svcReportBundles = reports.svcReportBundles
    const manifest = JSON.stringify({
      version: 1,
      bundleId: 'bundle-fixture',
      title: 'Bundle',
      entries: imageSizes.map((size, index) => manifestEntry(index, size))
    })
    bridge.fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === manifestUrl
        ? new Response(manifest)
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    )
    const primary = reports.register(
      {
        type: 'file' as const,
        url: 'data:text/plain;base64,QQ==',
        fileName: 'report.txt',
        reportBundleRole: 'primary-report' as const,
        reportBundleId: 'bundle-fixture',
        reportBundleManifestUrl: 'local-media:///synthetic/descriptor/manifest.json'
      },
      conversationId,
      { manifestUrl, imageCount: imageSizes.length }
    ) as ChatAttachment
    const fetchedUrls = () => bridge.fetchMock.mock.calls.map(([url]) => String(url))
    const imageReads = () => fetchedUrls().filter((url) => url.includes('/synthetic/bundle/'))
    return { ...bridge, reports, primary, fetchedUrls, imageReads }
  }

  it('refuses a request whose bundle images exceed the provider JSON budget before reading any image', async () => {
    const bundle = installBundle([6 * MiB, 6 * MiB, 6 * MiB, 6 * MiB])
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [bundle.primary] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    expect(bundle.reports.verify).toHaveBeenCalledOnce()
    // Only MAIN's manifest copy was read, never the descriptor's manifest or an image.
    expect(bundle.fetchedUrls()).toEqual([manifestUrl])
    expect(bundle.chat).not.toHaveBeenCalled()
    expect(bundle.chatStream).not.toHaveBeenCalled()
    expect(bundle.materializeForRequest).not.toHaveBeenCalled()
  })

  it('sends the same bundle when its images fit', async () => {
    const bundle = installBundle([4 * MiB, 4 * MiB, 4 * MiB, 4 * MiB])
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [bundle.primary] }] })
    ).resolves.toBeDefined()
    expect(bundle.imageReads()).toHaveLength(4)
    expect(stream ? bundle.chatStream : bundle.chat).toHaveBeenCalled()
  })

  it('refuses oversized bundle images already in the page preflight, before the draft is given up', async () => {
    const bundle = installBundle([6 * MiB, 6 * MiB, 6 * MiB, 6 * MiB])
    const route = { config: gemini(), profileId: 'fixture', conversationId }
    const messages: ChatMessage[] = [{ role: 'user', content: 'look', attachments: [bundle.primary] }]
    await expect(preflightChatRequestReports({ ...route, messages })).rejects.toBeInstanceOf(
      ChatRequestImageBudgetError
    )
    expect(bundle.fetchedUrls()).toEqual([manifestUrl])
    expect(bundle.imageReads()).toEqual([])
    // The same bundle within the budget passes the page preflight.
    const fits = installBundle([4 * MiB, 4 * MiB, 4 * MiB, 4 * MiB])
    await expect(
      preflightChatRequestReports({
        ...route,
        messages: [{ role: 'user', content: 'look', attachments: [fits.primary] }]
      })
    ).resolves.toBeUndefined()
    expect(fits.imageReads()).toEqual([])
  })

  it('adds the bundle images to the other images of the request', async () => {
    // 4 x 4 MiB of bundle images fit alone, with one 6 MiB managed image they do not.
    const bundle = installBundle([4 * MiB, 4 * MiB, 4 * MiB, 4 * MiB])
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [bundle.primary, managedImage(6 * MiB)] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    expect(bundle.imageReads()).toEqual([])
    expect(bundle.materializeForRequest).not.toHaveBeenCalled()
  })

  it('counts a history bundle under the all-history policy before the report probe and any image read', async () => {
    const bundle = installBundle([6 * MiB, 6 * MiB, 6 * MiB, 6 * MiB])
    await expect(
      send({
        config: gemini(),
        imageHistoryPolicy: 'all',
        messages: [
          { role: 'user', content: 'old', attachments: [bundle.primary] },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'new' }
        ]
      })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    expect(bundle.fetchedUrls()).toEqual([manifestUrl])
    expect(bundle.chat).not.toHaveBeenCalled()
    expect(bundle.chatStream).not.toHaveBeenCalled()
  })

  it('counts history bundle images against the Responses preparation limit', async () => {
    const history = (sizes: number[]) => {
      const bundle = installBundle(sizes)
      const messages: ChatMessage[] = [
        { role: 'user', content: 'old', attachments: [bundle.primary] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'look', attachments: [managedImage(3 * MiB)] }
      ]
      return { bundle, messages }
    }
    // 3 x 10 MiB + 3 MiB is above the 32 MiB MAIN accepts before re-encoding.
    let run = history([10 * MiB, 10 * MiB, 10 * MiB])
    await expect(send({ config: localConfig(), imageHistoryPolicy: 'all', messages: run.messages })).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    expect(run.bundle.imageReads()).toEqual([])
    expect(run.bundle.materializeForRequest).not.toHaveBeenCalled()
    expect(run.bundle.chatStream).not.toHaveBeenCalled()
    run = history([10 * MiB, 10 * MiB])
    await expect(send({ config: localConfig(), imageHistoryPolicy: 'all', messages: run.messages })).resolves.toBeDefined()
    expect(run.bundle.imageReads()).toHaveLength(2)
  })

  it('does not count bundle images whose size MAIN did not record', async () => {
    const bundle = installBundle([undefined, undefined, undefined, undefined])
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [bundle.primary] }] })
    ).resolves.toBeDefined()
    expect(bundle.imageReads()).toHaveLength(4)
  })

  it('counts an image the message carries itself and the bundle repeats once, as it is sent once', async () => {
    // 3 x 6 MiB is 24 MiB as base64 and fits; fig-0 counted twice (32 MiB) would not.
    const bundle = installBundle([6 * MiB, 6 * MiB, 6 * MiB])
    // The explicit copy of fig-0 (same bundle, reference and size) replaces the manifest entry.
    const explicit = {
      ...managedImage(6 * MiB),
      reportBundleId: 'bundle-fixture',
      reportBundleRole: 'report-image',
      reportBundleRefName: 'fig-0'
    } as ChatAttachment
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [bundle.primary, explicit] }] })
    ).resolves.toBeDefined()
    const sent = ((stream ? bundle.chatStream : bundle.chat).mock.calls.at(-1) as unknown[])[0] as { messages: ChatMessage[] }
    expect(sent.messages.at(-1)!.attachments!.filter((attachment) => attachment.type === 'image')).toHaveLength(3)
    expect(bundle.imageReads()).toHaveLength(2)
    expect(bundle.materializeForRequest).toHaveBeenCalledOnce()
  })

  it('never trusts the size a descriptor itself claims for a bundle image', async () => {
    const bridge = installBridge()
    const forged: ChatAttachment = {
      type: 'image',
      url: 'local-media:///synthetic/bundle/forged.png',
      fileName: 'forged.png',
      reportBundleId: 'bundle-fixture',
      reportBundleRole: 'report-image',
      reportBundleManifestUrl: manifestUrl,
      sizeBytes: 40 * MiB
    }
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [forged] }] })
    ).resolves.toBeDefined()
    expect(bridge.fetchMock).toHaveBeenCalledOnce()
  })

  it('checks the descriptors before asking MAIN to verify the bundle', async () => {
    const bundle = installBundle([MiB])
    await expect(
      send({ config: gemini(), messages: [{ role: 'user', content: 'look', attachments: [bundle.primary, managedImage(DEFAULT_PROVIDER_JSON_MAX_BYTES)] }] })
    ).rejects.toBeInstanceOf(ChatRequestImageBudgetError)
    expect(bundle.reports.verify).not.toHaveBeenCalled()
    expect(bundle.fetchMock).not.toHaveBeenCalled()
  })
})

describe('refusal message', () => {
  it('has a short fallback where i18next is not initialised', async () => {
    const i18next = (await import('i18next')).default
    vi.spyOn(i18next, 't').mockReturnValue(undefined as never)
    const message = new ChatRequestImageBudgetError().message
    expect(message).toBe('The images are too large for one request.')
  })

  it('is the one short localized line for the conversation images', async () => {
    const { default: i18n } = await import('@renderer/i18n')
    const en = (await import('@shared/locales/en-US/renderer.json')).default
    const zh = (await import('@shared/locales/zh-CN/renderer.json')).default
    await i18n.changeLanguage('zh-CN')
    expect(new ChatRequestImageBudgetError().message).toBe(zh.chat.request_images_too_large)
    await i18n.changeLanguage('en-US')
    expect(new ChatRequestImageBudgetError().message).toBe(en.chat.request_images_too_large)
    expect(en.chat.request_images_too_large.length).toBeLessThan(140)
  })
})
