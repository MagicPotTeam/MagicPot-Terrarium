import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import type { ChatAttachment } from '@shared/llm'
import { createReportBundleRegistryFixture } from './__fixtures__/reportBundleFixtures'
import {
  requestChatCompletion,
  requestChatCompletionStream,
  supportsStreamingChatCompletion,
  type RequestChatCompletionStreamEvent
} from './chatRequestUtils'

const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] }
}

const binding = `rb1.${'F'.repeat(43)}`
const boundPrimary: ChatAttachment = {
  type: 'file',
  url: 'local-media:///synthetic/report.md',
  fileName: 'report.md',
  reportBundleRole: 'primary-report',
  reportBundleId: 'bundle-1',
  reportBundleManifestUrl: 'local-media:///synthetic/manifest.json',
  reportBundleBinding: binding
}
const { reportBundleBinding: _binding, ...unboundPrimary } = boundPrimary

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('report bindings in streamed model or tool attachments', () => {
  it('drops the binding from an IPC stream attachment event and from the final result', async () => {
    const chatStream = vi.fn(
      async (_request: unknown, response: { onData: (chunk: LLMChatStreamResp) => void }) => {
        response.onData({ type: 'text-delta', delta: 'partial', done: false })
        response.onData({ type: 'attachment', delta: '', done: false, attachment: boundPrimary })
        response.onData({
          type: 'done',
          delta: '',
          done: true,
          finishReason: 'stop',
          content: 'partial',
          attachments: [boundPrimary]
        })
      }
    )
    vi.stubGlobal('api', { svcLLMProxy: { chatStream } })
    const events: RequestChatCompletionStreamEvent[] = []
    const result = await requestChatCompletionStream({
      config,
      messages: [{ role: 'user', content: 'Fixture' }],
      onEvent: (event) => events.push(event)
    })
    const attachmentEvents = events.filter((event) => event.type === 'attachment')
    expect(attachmentEvents).toEqual([{ type: 'attachment', attachment: unboundPrimary }])
    expect(result.result.attachments).toEqual([unboundPrimary])
    expect(JSON.stringify(events)).not.toContain(binding)
    expect(JSON.stringify(result)).not.toContain(binding)
  })

  it('drops the binding from attachment events bridged from a unary external agent reply', async () => {
    const externalAgentSkill: CustomSkill = {
      id: 'binding-fixture-agent',
      type: 'agent',
      category: 'fixture',
      skillName: 'Binding fixture agent',
      prompt: 'Reply to the fixture.',
      apiAddress: 'https://fixture.invalid/agent',
      apiKey: ''
    }
    const remoteFetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        body: JSON.stringify({ content: 'unary reply', attachments: [boundPrimary] })
      })
    )
    vi.stubGlobal('api', { svcManagedMedia: {}, svcLLMProxy: { remoteFetch } })
    const input = {
      config,
      messages: [{ role: 'user' as const, content: 'Fixture' }],
      externalAgentSkill
    }
    expect(supportsStreamingChatCompletion(input)).toBe(false)
    const events: RequestChatCompletionStreamEvent[] = []
    await requestChatCompletionStream({ ...input, onEvent: (event) => events.push(event) })
    expect(remoteFetch).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'attachment')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain(binding)
  })
})

describe('a verified bundle image that is also attached explicitly as a managed copy', () => {
  const conversationId = 'bundle-dedupe-owner'
  const ownedManifest = 'local-media:///synthetic/main-snapshot/manifest.json'
  const managedFig = (sizeBytes: number, digit: string) => ({
    version: 1 as const,
    kind: 'managed' as const,
    relativePath: `originals/${digit}${digit}/${digit.repeat(64)}.png`,
    sha256: digit.repeat(64),
    sizeBytes,
    mimeType: 'image/png',
    originalFileName: 'fig-01.png'
  })

  const send = async (explicitSize: number) => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url) === ownedManifest
        ? new Response(
            JSON.stringify({
              version: 1,
              bundleId: 'canvas-target-stage',
              title: 'Stage',
              entries: [
                { role: 'primary-report', fileName: 'report.md', refName: 'report.md' },
                {
                  role: 'report-image',
                  fileName: 'fig-01.png',
                  refName: 'fig-01.png',
                  mimeType: 'image/png',
                  sourceUrl: 'data:image/png;base64,AQID',
                  sizeBytes: 101
                },
                {
                  role: 'report-image',
                  fileName: 'fig-02.png',
                  refName: 'fig-02.png',
                  mimeType: 'image/png',
                  sourceUrl: 'data:image/png;base64,BAUG',
                  sizeBytes: 102
                }
              ]
            })
          )
        : new Response('synthetic report', { headers: { 'content-type': 'text/plain' } })
    )
    vi.stubGlobal('fetch', fetch)
    const chat = vi.fn(async () => ({ content: 'synthetic' }))
    const materializeForRequest = vi.fn(async () => ({
      transport: 'request-data-url',
      dataUrl: 'data:image/png;base64,TUFOQUdFRA==',
      mimeType: 'image/png',
      sizeBytes: explicitSize
    }))
    const reports = createReportBundleRegistryFixture()
    vi.stubGlobal('api', {
      svcManagedMedia: { materializeForRequest },
      svcLLMProxy: { chat, chatStream: vi.fn(), remoteFetch: vi.fn() },
      svcReportBundles: reports.svcReportBundles
    })
    const bound = reports.register(
      {
        type: 'file' as const,
        url: 'data:text/plain;base64,QQ==',
        fileName: 'report.md',
        reportBundleRole: 'primary-report' as const,
        reportBundleId: 'canvas-target-stage',
        reportBundleManifestUrl: ownedManifest
      },
      conversationId,
      { manifestUrl: ownedManifest, imageCount: 2 }
    )
    // A canvas hand-off of the bundle's first image: since the hand-off it has a managed URL.
    const explicit: ChatAttachment = {
      type: 'image',
      url: 'local-media:///managed/originals/aa/fig-01.png',
      fileName: 'fig-01.png',
      mimeType: 'image/png',
      reportBundleId: 'canvas-target-stage',
      reportBundleRole: 'report-image',
      reportBundleRefName: 'fig-01.png',
      media: managedFig(explicitSize, explicitSize === 101 ? 'a' : 'b')
    }
    await requestChatCompletion({
      config: {
        ...config,
        llm_config: {
          ...config.llm_config,
          api_profiles: [
            {
              id: 'fixture-profile',
              provider: 'openai',
              deployment: 'cloud',
              model_use: 'chat',
              model_name: 'fixture-model',
              base_url: 'https://synthetic.invalid/v1',
              api_key: 'synthetic',
              api_mode: 'chat-completions',
              attachment_transports: ['request-data-url']
            } as Config['llm_config']['api_profiles'][number]
          ]
        }
      },
      profileId: 'fixture-profile',
      conversationId,
      messages: [{ role: 'user', content: 'Look at the report', attachments: [bound, explicit] }]
    })
    const sent = (chat.mock.calls.at(-1) as unknown[])[0] as {
      messages: Array<{ attachments?: ChatAttachment[] }>
    }
    return sent.messages
      .flatMap((message) => message.attachments ?? [])
      .filter((attachment) => attachment.type === 'image')
  }

  it('sends the picture once when the managed copy has the verified size', async () => {
    const images = await send(101)
    expect(images.map((image) => image.reportBundleRefName)).toEqual(['fig-01.png', 'fig-02.png'])
    expect(images[0].url).toBe('data:image/png;base64,TUFOQUdFRA==')
  })

  it('keeps the verified picture when the managed copy is of another size', async () => {
    const images = await send(999)
    expect(images.map((image) => image.reportBundleRefName)).toEqual([
      'fig-01.png',
      'fig-01.png',
      'fig-02.png'
    ])
  })
})
