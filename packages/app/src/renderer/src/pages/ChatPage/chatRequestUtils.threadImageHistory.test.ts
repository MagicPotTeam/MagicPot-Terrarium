import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatReq, LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import {
  collectThreadImageHistory,
  selectMessagesForImageHistoryPolicy
} from '@shared/llm/imageHistory'
import { isThreadImageReviewPrompt } from '@shared/llm/threadImageReviewIntent'
import type { ChatMessage } from '@shared/llm'
import {
  preflightChatRequestImages,
  requestChatCompletion,
  requestChatCompletionStream
} from './chatRequestUtils'
import { resolveChatPageRequestExecutionImagePolicy } from './imageRequestPolicy'

const profileId = 'thread-fixture'
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'fixture-project',
  threadId: 'fixture-pane'
} as const
const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: profileId,
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'chat',
        model_name: 'fixture',
        base_url: 'https://fixture.invalid/v1',
        api_key: '',
        api_mode: 'responses',
        max_input_images: 1,
        attachment_transports: ['request-data-url']
      }
    ]
  }
}
const image = (digit: string) => ({
  type: 'image' as const,
  url: `local-media:///fixture/${digit}.png`,
  media: {
    version: 1 as const,
    kind: 'managed' as const,
    sha256: digit.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 1,
    relativePath: `originals/${digit.repeat(2)}/${digit.repeat(64)}.png`,
    originalFileName: `${digit}.png`
  }
})
const current = image('c')
const output = {
  transport: 'request-data-url',
  dataUrl: 'data:image/png;base64,Qw==',
  mimeType: 'image/png',
  sizeBytes: 1
}
const send = (stream: boolean, input: Parameters<typeof requestChatCompletion>[0]) =>
  stream
    ? requestChatCompletionStream({ ...input, onEvent: vi.fn() })
    : requestChatCompletion(input)
const done = (stream: ServerStreaming<LLMChatStreamResp>) =>
  stream.onData({ type: 'done', done: true, delta: '', content: 'ok', finishReason: 'stop' })
afterEach(() => vi.unstubAllGlobals())

it('projects only an eligible local last-output review hint and preserves the newest unavailable slot', async () => {
  const history: ChatMessage[] = [
    { role: 'assistant', content: 'Generated output', attachments: [image('a')] }
  ]
  const messages: ChatMessage[] = [
    ...history,
    { role: 'user', content: 'What is wrong with this picture?' }
  ]
  const sent: LLMChatReq[] = []
  window.api = {
    svcManagedMedia: {},
    svcLLMProxy: {
      chat: async (req: LLMChatReq) => {
        sent.push(req)
        return { content: 'ok' }
      },
      chatStream: async (req: LLMChatReq, res: ServerStreaming<LLMChatStreamResp>) => {
        sent.push(req)
        done(res)
      }
    }
  } as unknown as Window['api']
  const input = {
    config,
    messages: selectMessagesForImageHistoryPolicy(messages, 'latest-user-turn'),
    profileId,
    route,
    imageHistoryPolicy: 'latest-user-turn' as const,
    threadImageHistory: [null],
    threadImageReview: 'last-output' as const
  }
  await requestChatCompletion(input)
  expect(sent).toHaveLength(1)
  expect(sent[0].threadImageReview).toBe('last-output')
  expect(sent[0].threadImageHistory).toEqual([null])

  for (const extra of [
    { isEdit: true },
    { teamMessageHop: 1 as const },
    { teamMember: { scope: 'test', thread: 'test', lead: 'test', member: 'test' } },
    { skillRuntime: { skillId: 'local-fixture', bindings: [] } }
  ]) {
    const count = sent.length
    await requestChatCompletion({ ...input, ...extra })
    expect(sent).toHaveLength(count + 1)
    expect(sent.at(-1)).not.toHaveProperty('threadImageReview')
  }
  expect(isThreadImageReviewPrompt('你能自己找出问题吗', { previousAssistantImage: true })).toBe(
    true
  )
  expect(
    isThreadImageReviewPrompt('What is wrong with this picture?', { previousAssistantImage: false })
  ).toBe(false)
  expect(
    isThreadImageReviewPrompt('Find issues and redraw it', { previousAssistantImage: true })
  ).toBe(false)
  expect(
    isThreadImageReviewPrompt('Check packages/app/image.png', { previousAssistantImage: true })
  ).toBe(false)
})

it('does not include review intent in remote or external wire bodies (unary and stream)', async () => {
  for (const transport of ['remote', 'external'] as const) {
    for (const stream of [false, true]) {
      const bodies: string[] = []
      const fetchMock = vi.fn(async (_url, init) => {
        bodies.push(init.body)
        return new Response(JSON.stringify({ content: 'ok' }), { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)
      window.api = {
        svcManagedMedia: {},
        svcLLMProxy: {
          remoteFetch: async (req: { body: string }) => {
            bodies.push(req.body)
            return { status: 200, body: JSON.stringify({ content: 'ok' }) }
          },
          externalAgentStream: async (
            req: { body: string },
            res: ServerStreaming<LLMChatStreamResp>
          ) => {
            bodies.push(req.body)
            done(res)
          }
        }
      } as unknown as Window['api']
      await send(stream, {
        config: { ...config, use_remote_llm: transport === 'remote' },
        route,
        profileId,
        messages: [{ role: 'user', content: 'What is wrong with this picture?' }],
        threadImageHistory: [null],
        threadImageReview: 'last-output',
        ...(transport === 'external'
          ? {
              externalAgentSkill: {
                id: 'fixture',
                type: 'agent',
                category: 'fixture',
                skillName: 'fixture',
                prompt: 'fixture',
                apiAddress: 'https://fixture.invalid',
                apiKey: ''
              }
            }
          : {})
      })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).not.toContain('threadImageReview')
      expect(bodies[0]).not.toContain('threadImageHistory')
    }
  }
})

it.each([false, true])(
  'charges and materializes only the current upload; retains text, files and a local edit sidecar (stream=%s)',
  async (stream) => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Earlier upload', attachments: [image('a')] },
      {
        role: 'assistant',
        content: 'Earlier result',
        attachments: [
          image('b'),
          { type: 'file', url: 'data:application/octet-stream;base64,QQ==', fileName: 'notes.bin' }
        ]
      }
    ]
    const messages: ChatMessage[] = [
      ...history,
      { role: 'user', content: 'Current upload', attachments: [current] }
    ]
    const before = structuredClone(messages)
    const materializeForRequest = vi.fn(async ({ reference }) => {
      expect(reference.sha256).toBe(current.media.sha256)
      return output
    })
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const sent: LLMChatReq[] = []
    window.api = {
      svcManagedMedia: { materializeForRequest },
      svcLLMProxy: {
        chat: async (req: LLMChatReq) => {
          sent.push(req)
          return { content: 'ok' }
        },
        chatStream: async (req: LLMChatReq, res: ServerStreaming<LLMChatStreamResp>) => {
          sent.push(req)
          done(res)
        }
      }
    } as unknown as Window['api']
    const { imageHistoryPolicy } = resolveChatPageRequestExecutionImagePolicy({
      currentTurnImagesOnly: true,
      hasUsableSessionContinuation: false,
      supportsSessionContinuation: false,
      shouldResetContinuation: false
    })
    const input = {
      config,
      messages,
      profileId,
      route,
      imageHistoryPolicy,
      threadImageHistory: collectThreadImageHistory(history)
    }
    expect(preflightChatRequestImages(input)).toBe(1)
    expect(() => preflightChatRequestImages({ ...input, imageHistoryPolicy: 'all' })).toThrow(
      /limit is 1/
    )
    await send(stream, input)
    expect(materializeForRequest).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    const [request] = sent
    expect(request.threadImageHistory).toStrictEqual([
      { sha256: 'b'.repeat(64), mimeType: 'image/png', sizeBytes: 1 },
      null
    ])
    expect(request.messages.map((m) => m.content)).toEqual([
      'Earlier upload',
      'Earlier result\n\n[Attached file] notes.bin\nMetadata: fileName="notes.bin"\nfile attached: notes.bin',
      'Current upload\n\n[Attached image] unnamed-image\nMetadata: mimeType="image/png"; sizeBytes=1\nimage attached: unnamed-image (image/png)'
    ])
    expect(request.messages[0].attachments ?? []).toEqual([])
    expect(request.messages[1].attachments).toEqual([
      expect.objectContaining({ type: 'file', fileName: 'notes.bin' })
    ])
    expect(request.messages[2].attachments).toEqual([
      expect.objectContaining({ type: 'image', url: output.dataUrl })
    ])
    expect(messages).toEqual(before)
  }
)

it.each([
  ['remote', false],
  ['remote', true],
  ['external', false],
  ['external', true]
] as const)(
  'keeps local edit candidates out of %s request bodies (stream=%s)',
  async (transport, stream) => {
    const bodies: string[] = []
    const reply = JSON.stringify({ content: 'ok' })
    const fetchMock = vi.fn(async (_url, init) => {
      bodies.push(init.body)
      return new Response(reply, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    window.api = {
      svcManagedMedia: {},
      svcLLMProxy: {
        remoteFetch: async (req: { body: string }) => {
          bodies.push(req.body)
          return { status: 200, body: reply }
        },
        externalAgentStream: async (
          req: { body: string },
          res: ServerStreaming<LLMChatStreamResp>
        ) => {
          bodies.push(req.body)
          done(res)
        }
      }
    } as unknown as Window['api']
    const sha256 = 'f'.repeat(64)
    await send(stream, {
      config: { ...config, use_remote_llm: transport === 'remote' },
      route,
      profileId,
      messages: [{ role: 'user', content: 'Next turn' }],
      threadImageHistory: [{ sha256, mimeType: 'image/png', sizeBytes: 7 }, null],
      ...(transport === 'external'
        ? {
            externalAgentSkill: {
              id: 'fixture',
              type: 'agent',
              category: 'fixture',
              skillName: 'fixture',
              prompt: 'fixture',
              apiAddress: 'https://fixture.invalid',
              apiKey: ''
            }
          }
        : {})
    })
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]).messages).toEqual([{ role: 'user', content: 'Next turn' }])
    expect(JSON.parse(bodies[0])).not.toHaveProperty('threadImageHistory')
    expect(bodies[0]).not.toContain(sha256)
    expect(fetchMock).toHaveBeenCalledTimes(transport === 'remote' ? 1 : 0)
  }
)
