import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { nativeImage } from 'electron'
import type { ChatAttachment, LLMDeltaEvent, LLMReasoningEffort } from '@shared/llm'

const mocks = vi.hoisted(() => ({
  testUserDataRoot: `${process.cwd()}/.magicpot-test-user-data`,
  createFileSearchSession: vi.fn(),
  readExistingCodexReviewSession: vi.fn(),
  ensureCodexCliAuthTokens: vi.fn(),
  forceRefreshCodexCliAuthTokens: vi.fn(),
  fetch: vi.fn(),
  persistCodexImageArtifacts: vi.fn(),
  imageSizes: [{ width: 1, height: 1 }],
  resize: vi.fn(),
  toJPEG: vi.fn(() => Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(() => {
      const size = mocks.imageSizes.shift() || { width: 1, height: 1 }
      return {
        isEmpty: () => false,
        getSize: () => ({ ...size }),
        resize: mocks.resize.mockImplementation(() => ({
          toJPEG: mocks.toJPEG
        }))
      }
    })
  },
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mocks.testUserDataRoot
      if (name === 'desktop') return 'C:/magicpot-test-desktop'
      if (name === 'temp') return 'C:/magicpot-test-temp'
      return 'C:/magicpot-test'
    })
  }
}))

vi.mock('@shared/llm/openaiFileSearch', async () => {
  const actual = await vi.importActual<typeof import('@shared/llm/openaiFileSearch')>(
    '@shared/llm/openaiFileSearch'
  )

  return {
    ...actual,
    createOpenAIFileSearchSession: mocks.createFileSearchSession
  }
})

vi.mock('../llmProxy/codexAttachmentArtifacts', () => ({
  persistCodexImageArtifacts: mocks.persistCodexImageArtifacts
}))

vi.mock('./codexOAuth', () => ({
  readExistingCodexReviewSession: mocks.readExistingCodexReviewSession,
  ensureCodexCliAuthTokens: mocks.ensureCodexCliAuthTokens,
  forceRefreshCodexCliAuthTokens: mocks.forceRefreshCodexCliAuthTokens
}))

import {
  CodexChatGPTCli,
  buildCodexResponsesInput,
  __getCodexProcessedImageCacheStatsForTests,
  __resetCodexProcessedImageCacheForTests,
  CODEX_IMAGE_TRANSFORM_POLICY,
  parseCodexImageDataUrl,
  resolveCodexImageTargetDimensions
} from './codexChatClient'
import { __resetCodexRequestGovernorForTests } from './codexRequestGovernor'

const createSession = (accessToken: string, accountId = 'acct-123') => ({
  accessToken,
  accountId,
  authFilePath: 'C:/Users/test/.codex/auth.json',
  connectedAt: '2026-04-23T00:00:00.000Z',
  idToken: 'id-token',
  refreshToken: 'refresh-token'
})

const createSseResponse = (
  events: Array<Record<string, unknown> | string>,
  init?: ResponseInit
): Response => {
  const body = [
    ...events.map(
      (event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`
    ),
    'data: [DONE]\n\n'
  ].join('')

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream'
    },
    ...init
  })
}

const requestInitAt = (index: number): RequestInit =>
  (mocks.fetch.mock.calls[index]?.[1] as RequestInit | undefined) || {}

const requestBodyAt = (index: number): Record<string, unknown> =>
  JSON.parse(String(requestInitAt(index).body || '{}')) as Record<string, unknown>

const createControlledSseResponse = (
  chunks: Array<string | Uint8Array>,
  init?: ResponseInit
): { response: Response; cancel: ReturnType<typeof vi.fn> } => {
  const encoder = new TextEncoder()
  let index = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      const chunk = chunks[index++]
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
    },
    cancel
  })

  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      ...init
    }),
    cancel
  }
}

const sseFrame = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}\n\n`

const chatForStreamTest = (
  onDelta?: (event: any) => void
): Parameters<CodexChatGPTCli['chat']>[0] => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...(onDelta ? { onDelta } : {})
})

describe('Codex streaming terminal states', () => {
  beforeEach(() => {
    __resetCodexRequestGovernorForTests()
    mocks.fetch.mockReset()
    mocks.ensureCodexCliAuthTokens.mockReset().mockResolvedValue(createSession('oauth-access'))
    mocks.forceRefreshCodexCliAuthTokens.mockReset()
    mocks.createFileSearchSession.mockReset().mockResolvedValue(null)
    mocks.persistCodexImageArtifacts.mockReset().mockImplementation(async (result: any) => ({
      ...result,
      attachments: result.attachments?.map((attachment: any, index: number) =>
        attachment.type === 'image' && attachment.url.startsWith('data:image/')
          ? { ...attachment, url: `local-media://test-artifact-${index}` }
          : attachment
      )
    }))
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(() => {
    __resetCodexRequestGovernorForTests()
    vi.unstubAllGlobals()
  })

  it.each([
    [
      'failed',
      { type: 'response.failed', message: 'provider failed' },
      'provider failed',
      'failed'
    ],
    ['error', { type: 'error', error: { message: 'stream error' } }, 'stream error', 'failed'],
    [
      'incomplete',
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } }
      },
      'Codex response was incomplete.',
      'incomplete'
    ]
  ] as const)(
    'rejects %s after retaining partial text and does not emit later deltas',
    async (_name, terminalEvent, expectedMessage, expectedState) => {
      const events: any[] = []
      const controlled = createControlledSseResponse([
        sseFrame({ type: 'response.output_text.delta', delta: 'partial' }),
        sseFrame(terminalEvent),
        sseFrame({ type: 'response.output_text.delta', delta: 'after-stop' })
      ])
      mocks.fetch.mockResolvedValue(controlled.response)

      const error = await new CodexChatGPTCli('gpt-5.4')
        .chat(chatForStreamTest((event) => events.push(event)))
        .catch((value: unknown) => value)

      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({
        message: expect.stringContaining(expectedMessage),
        terminalState: expectedState,
        finishReason: expectedState === 'incomplete' ? 'length' : 'error',
        partialResult: {
          content: 'partial',
          finishReason: expectedState === 'incomplete' ? 'length' : 'error',
          metadata: {
            codexStream: {
              complete: false,
              partial: true,
              state: expectedState
            }
          }
        }
      })
      expect(events).toEqual([{ type: 'text-delta', delta: 'partial' }])
      expect(controlled.cancel).toHaveBeenCalled()
    }
  )

  it('rejects EOF after partial text without response.completed', async () => {
    const events: any[] = []
    const controlled = createControlledSseResponse([
      sseFrame({ type: 'response.output_text.delta', delta: 'partial' })
    ])
    mocks.fetch.mockResolvedValue(controlled.response)

    const error = await new CodexChatGPTCli('gpt-5.4')
      .chat(chatForStreamTest((event) => events.push(event)))
      .catch((value: unknown) => value)

    expect(error).toMatchObject({
      message: expect.stringContaining('before response.completed'),
      terminalState: 'truncated',
      finishReason: 'error',
      partialResult: {
        content: 'partial',
        finishReason: 'error',
        metadata: { codexStream: { complete: false, partial: true, state: 'truncated' } }
      }
    })
    expect(events).toEqual([{ type: 'text-delta', delta: 'partial' }])
  })

  it('accepts a UTF-8-split delta followed by response.completed', async () => {
    const events: any[] = []
    const bytes = new TextEncoder().encode(
      sseFrame({ type: 'response.output_text.delta', delta: '部分🙂' }) +
        sseFrame({
          type: 'response.completed',
          response: {
            id: 'resp-complete',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '完成🙂' }] }]
          }
        })
    )
    const splitAt = Math.max(
      1,
      bytes.findIndex((byte) => byte >= 0xf0)
    )
    const controlled = createControlledSseResponse([
      bytes.subarray(0, splitAt),
      bytes.subarray(splitAt, splitAt + 1),
      bytes.subarray(splitAt + 1)
    ])
    mocks.fetch.mockResolvedValue(controlled.response)

    await expect(
      new CodexChatGPTCli('gpt-5.4').chat(chatForStreamTest((event) => events.push(event)))
    ).resolves.toMatchObject({ content: '完成🙂', finishReason: 'stop' })
    expect(events).toEqual([{ type: 'text-delta', delta: '部分🙂' }])
  })

  it('rejects a malformed trailing partial frame while retaining prior deltas', async () => {
    const events: any[] = []
    const controlled = createControlledSseResponse([
      sseFrame({ type: 'response.output_text.delta', delta: 'partial' }),
      'data: {"type":"response.completed","response":'
    ])
    mocks.fetch.mockResolvedValue(controlled.response)

    const error = await new CodexChatGPTCli('gpt-5.4')
      .chat(chatForStreamTest((event) => events.push(event)))
      .catch((value: unknown) => value)

    expect(error).toMatchObject({
      message: expect.stringContaining('malformed JSON'),
      terminalState: 'failed',
      partialResult: { content: 'partial', finishReason: 'error' }
    })
    expect(events).toEqual([{ type: 'text-delta', delta: 'partial' }])
  })

  it('accepts a complete terminal frame at EOF without a trailing separator', async () => {
    const controlled = createControlledSseResponse([
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}'
    ])
    mocks.fetch.mockResolvedValue(controlled.response)

    await expect(new CodexChatGPTCli('gpt-5.4').chat(chatForStreamTest())).resolves.toMatchObject({
      content: 'done',
      finishReason: 'stop'
    })
  })
})

describe('CodexChatGPTCli', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(mocks.testUserDataRoot, '.chat_media'), {
      recursive: true
    })
    __resetCodexProcessedImageCacheForTests()
    mocks.fetch.mockReset()
    mocks.ensureCodexCliAuthTokens.mockReset().mockResolvedValue(createSession('oauth-access'))
    mocks.forceRefreshCodexCliAuthTokens.mockReset()
    mocks.createFileSearchSession.mockReset().mockResolvedValue(null)
    mocks.persistCodexImageArtifacts.mockReset().mockImplementation(async (result: any) => ({
      ...result,
      attachments: result.attachments?.map((attachment: any, index: number) =>
        attachment.type === 'image' && attachment.url.startsWith('data:image/')
          ? { ...attachment, url: `local-media://test-artifact-${index}` }
          : attachment
      )
    }))
    mocks.imageSizes.splice(0, mocks.imageSizes.length, {
      width: 1,
      height: 1
    })
    mocks.resize.mockClear().mockImplementation(() => ({ toJPEG: mocks.toJPEG }))
    mocks.toJPEG.mockClear()
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(async () => {
    __resetCodexRequestGovernorForTests()
    await fs.rm(path.join(mocks.testUserDataRoot, '.chat_media'), {
      recursive: true,
      force: true
    })
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([undefined, 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])(
    'preserves selected reasoning for an opaque OAuth model: %s',
    async (effort) => {
      mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-test-access'))
      mocks.createFileSearchSession.mockResolvedValue(null)
      mocks.fetch.mockResolvedValue(
        createSseResponse([
          {
            type: 'response.completed',
            response: {
              id: 'reasoning-test',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'ok' }]
                }
              ]
            }
          }
        ])
      )
      const modelName = `team/Alias:${effort ?? 'default'}+模型`
      const client = new CodexChatGPTCli(modelName)
      await expect(
        client.chat({
          messages: [{ role: 'user', content: 'hello' }],
          // Include a legacy persisted value to verify canonical wire migration.
          reasoningEffort: effort as LLMReasoningEffort | undefined
        })
      ).resolves.toMatchObject({ content: 'ok' })
      expect(mocks.fetch).toHaveBeenCalledTimes(1)
      expect(requestBodyAt(0).model).toBe(modelName)
      if (effort)
        expect(requestBodyAt(0).reasoning).toEqual({
          effort: effort === 'ultra' ? 'max' : effort
        })
      else expect(requestBodyAt(0)).not.toHaveProperty('reasoning')
    }
  )

  it('uses the Codex backend streaming path and preserves streamed metadata/file-search behavior', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue({
      vectorStoreIds: ['vs-1'],
      cleanup
    })

    const sessionUrl = 'https://chatgpt.com/backend-api/codex/responses/resp-sdk-1'
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.created',
          session_url: sessionUrl,
          response: {
            id: 'resp-sdk-1',
            conversation_id: 'conv-sdk-1'
          }
        },
        {
          type: 'response.output_text.delta',
          delta: 'Hello '
        },
        {
          type: 'response.output_text.delta',
          delta: 'world'
        },
        {
          type: 'response.output_text.done',
          text: 'Hello world'
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-sdk-1',
            conversation_id: 'conv-sdk-1',
            usage: {
              input_tokens: 321,
              output_tokens: 12,
              total_tokens: 333,
              input_tokens_details: { text_tokens: 111, image_tokens: 210 }
            },
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Hello world'
                  }
                ]
              }
            ]
          }
        }
      ])
    )

    const streamedEvents: Array<{ type: string; value?: string }> = []
    const client = new CodexChatGPTCli('gpt-5.4', {
      serviceTier: 'priority'
    })

    const result = await client.chat({
      reasoningEffort: 'medium',
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,SGVsbG8=',
              fileName: 'notes.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      onDelta: (event) => {
        if (event.type === 'session') {
          streamedEvents.push({ type: event.type, value: event.sessionUrl })
          return
        }

        streamedEvents.push({ type: event.type, value: event.delta })
      }
    })

    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(requestInitAt(0)).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer oauth-access'
      }
    })
    expect(requestBodyAt(0)).toMatchObject({
      stream: true,
      model: 'gpt-5.4',
      service_tier: 'priority',
      reasoning: {
        effort: 'medium'
      },
      include: ['web_search_call.action.sources', 'file_search_call.results'],
      tools: [
        {
          type: 'file_search',
          vector_store_ids: ['vs-1']
        },
        expect.objectContaining({
          type: 'web_search'
        })
      ]
    })

    expect(result).toEqual(
      expect.objectContaining({
        content: 'Hello world',
        finishReason: 'stop',
        sessionUrl,
        metadata: expect.objectContaining({
          responseId: 'resp-sdk-1',
          conversationId: 'conv-sdk-1'
        }),
        usage: {
          promptTokens: 321,
          inputTextTokens: 111,
          inputImageTokens: 210,
          completionTokens: 12,
          totalTokens: 333
        }
      })
    )
    expect(streamedEvents).toEqual([
      {
        type: 'session',
        value: sessionUrl
      },
      { type: 'text-delta', value: 'Hello ' },
      { type: 'text-delta', value: 'world' }
    ])
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('omits the model field when Codex should select the model automatically', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.completed',
          response: {
            id: 'resp-auto-model',
            conversation_id: 'conv-auto-model',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'auto model' }]
              }
            ]
          }
        }
      ])
    )

    await expect(
      new CodexChatGPTCli('').chat({
        messages: [{ role: 'user', content: 'hello' }]
      })
    ).resolves.toMatchObject({ content: 'auto model' })

    expect(requestBodyAt(0)).not.toHaveProperty('model')
  })

  it('retries once with refreshed OAuth tokens when the Codex backend returns 401', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-stale'))
    mocks.forceRefreshCodexCliAuthTokens.mockResolvedValue(createSession('oauth-fresh'))
    mocks.createFileSearchSession.mockResolvedValue(null)

    mocks.fetch
      .mockResolvedValueOnce(
        new Response('expired', {
          status: 401,
          statusText: 'Unauthorized'
        })
      )
      .mockResolvedValueOnce(
        createSseResponse([
          {
            type: 'response.created',
            response: {
              id: 'resp-retry',
              conversation_id: 'conv-retry'
            }
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp-retry',
              conversation_id: 'conv-retry',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: 'retried'
                    }
                  ]
                }
              ]
            }
          }
        ])
      )

    const client = new CodexChatGPTCli('gpt-5.4')

    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'hello' }]
      })
    ).resolves.toMatchObject({
      content: 'retried'
    })

    expect(mocks.forceRefreshCodexCliAuthTokens).toHaveBeenCalledTimes(1)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(requestInitAt(0)).toMatchObject({
      headers: {
        Authorization: 'Bearer oauth-stale'
      }
    })
    const firstKey = (requestInitAt(0).headers as Record<string, string>)['Idempotency-Key']
    const secondKey = (requestInitAt(1).headers as Record<string, string>)['Idempotency-Key']
    expect(firstKey).toMatch(/\S+/)
    expect(secondKey).toBe(firstKey)
    expect(requestInitAt(1).body).toBe(requestInitAt(0).body)
    expect(requestInitAt(1)).toMatchObject({
      headers: {
        Authorization: 'Bearer oauth-fresh'
      }
    })
  })

  it('surfaces endpoint and nested cause details when the Codex backend fetch fails', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)
    const injectedFetch = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ETIMEDOUT 198.18.0.12:443'), {
          code: 'ETIMEDOUT'
        })
      })
    )

    const client = new CodexChatGPTCli('gpt-5.4', {
      fetchImpl: injectedFetch as typeof fetch
    })

    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'hello' }]
      })
    ).rejects.toThrow(
      /Codex API request failed for https:\/\/chatgpt\.com\/backend-api\/codex\/responses: .*ETIMEDOUT 198\.18\.0\.12:443.*Fake-IP/
    )
    expect(injectedFetch).toHaveBeenCalledTimes(1)
  })

  it('preserves image-generation attachment streaming and final normalization', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)

    const partialPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
    const finalPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg=='
    const partialAttachmentUrl = `data:image/png;base64,${partialPngBase64}`
    const finalAttachmentUrl = `data:image/png;base64,${finalPngBase64}`
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.created',
          session_url: 'https://chatgpt.com/backend-api/codex/responses/resp-image'
        },
        {
          type: 'response.image_generation_call.partial_image',
          partial_image_b64: partialPngBase64
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-image',
            conversation_id: 'conv-image',
            output: [
              {
                type: 'image_generation_call',
                result: finalPngBase64
              }
            ]
          }
        }
      ])
    )

    const attachmentEvents: ChatAttachment[] = []
    const client = new CodexChatGPTCli('gpt-5.4', {
      modelUse: 'image'
    })

    const result = await client.chat({
      messages: [{ role: 'user', content: 'Generate an image of a city skyline.' }],
      imageGenerationOptions: {
        action: 'generate',
        outputFormat: 'png',
        size: '3840x2160',
        quality: 'high',
        background: 'auto'
      },
      onDelta: (event) => {
        if (event.type === 'attachment' && event.attachment) {
          attachmentEvents.push(event.attachment)
        }
      }
    })

    expect(mocks.createFileSearchSession).not.toHaveBeenCalled()
    expect(requestBodyAt(0)).toMatchObject({
      stream: true,
      tool_choice: {
        type: 'image_generation'
      },
      tools: [
        expect.objectContaining({
          type: 'image_generation',
          action: 'generate',
          output_format: 'png',
          size: '3840x2160',
          quality: 'high',
          background: 'auto'
        })
      ]
    })

    expect(attachmentEvents).toEqual([
      expect.objectContaining({
        type: 'image',
        url: partialAttachmentUrl
      }),
      expect.objectContaining({
        type: 'image',
        url: finalAttachmentUrl
      })
    ])
    expect(mocks.persistCodexImageArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({ type: 'image', url: partialAttachmentUrl }),
          expect.objectContaining({ type: 'image', url: finalAttachmentUrl })
        ])
      }),
      expect.objectContaining({ enabled: true })
    )
    expect(result.content).toBe('')
    expect(result.attachments).toHaveLength(2)
    expect(result.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          url: expect.stringMatching(/^local-media:\/\//)
        }),
        expect.objectContaining({
          type: 'image',
          url: expect.stringMatching(/^local-media:\/\//)
        })
      ])
    )
    expect(result.attachments?.map((attachment) => attachment.url)).not.toContain(
      partialAttachmentUrl
    )
    expect(result.attachments?.map((attachment) => attachment.url)).not.toContain(
      finalAttachmentUrl
    )
    expect(result.metadata).toEqual(
      expect.objectContaining({
        responseId: 'resp-image',
        conversationId: 'conv-image'
      })
    )
  })

  it('deduplicates identical streamed image content across partial and completed envelopes', async () => {
    const samePngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
    const sameImageUrl = `data:image/png;base64,${samePngBase64}`
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.image_generation_call.partial_image',
          partial_image_b64: samePngBase64
        },
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'image_generation_call',
                result: samePngBase64
              }
            ]
          }
        }
      ])
    )

    const attachmentEvents: ChatAttachment[] = []
    const result = await new CodexChatGPTCli('gpt-5.4', {
      modelUse: 'image'
    }).chat({
      messages: [{ role: 'user', content: 'Generate an image.' }],
      onDelta: (event) => {
        if (event.type === 'attachment' && event.attachment) {
          attachmentEvents.push(event.attachment)
        }
      }
    })

    expect(attachmentEvents).toEqual([
      expect.objectContaining({ type: 'image', url: sameImageUrl })
    ])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      type: 'image',
      url: expect.stringMatching(/^local-media:\/\//)
    })
  })

  it('retains non-image attachments with the same URL but different file names', async () => {
    const sharedUrl = 'data:text/plain;base64,SGVsbG8='
    const attachments = [
      { type: 'file' as const, url: sharedUrl, fileName: 'first.txt' },
      { type: 'file' as const, url: sharedUrl, fileName: 'second.txt' }
    ]
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.output_text.done',
          text: JSON.stringify({ content: 'files', attachments })
        },
        { type: 'response.completed', response: {} }
      ])
    )

    const result = await new CodexChatGPTCli('gpt-5.4').chat({
      messages: [{ role: 'user', content: 'List the files.' }]
    })

    expect(result.attachments).toEqual(attachments)
  })

  it('preserves original dimensions without applying an application transform budget', () => {
    expect(resolveCodexImageTargetDimensions(20_000, 1_000)).toEqual({
      width: 20_000,
      height: 1_000
    })
    expect(resolveCodexImageTargetDimensions(8_000, 8_000)).toEqual({
      width: 8_000,
      height: 8_000
    })
    expect(CODEX_IMAGE_TRANSFORM_POLICY.maxBytes).toBe(Infinity)
    expect(CODEX_IMAGE_TRANSFORM_POLICY.maxPixels).toBe(Infinity)
    expect(CODEX_IMAGE_TRANSFORM_POLICY.maxDimension).toBe(Infinity)
    expect(CODEX_IMAGE_TRANSFORM_POLICY.maxPatches).toBe(Infinity)
  })

  const pngDataUrl = (marker = 0): string =>
    `data:image/png;base64,${Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([marker])
    ]).toString('base64')}`

  const jpegDataUrl = (marker = 0): string =>
    `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, marker]).toString('base64')}`

  const webpDataUrl = (marker = 0): string =>
    `data:image/webp;base64,${Buffer.from([
      0x52,
      0x49,
      0x46,
      0x46,
      marker,
      0,
      0,
      0,
      0x57,
      0x45,
      0x42,
      0x50
    ]).toString('base64')}`

  const gifDataUrl = (marker = 0): string =>
    `data:image/gif;base64,${Buffer.concat([
      Buffer.from('GIF89a', 'ascii'),
      Buffer.from([marker])
    ]).toString('base64')}`

  const pngCrcTable = Array.from({ length: 256 }, (_, index) => {
    let crc = index
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return crc >>> 0
  })

  const pngCrc32 = (...chunks: Uint8Array[]): number => {
    let crc = 0xffffffff
    for (const chunk of chunks) {
      for (const byte of chunk) {
        crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  const pngChunk = (type: string, data: Buffer): Buffer => {
    const typeBytes = Buffer.from(type, 'ascii')
    const chunk = Buffer.alloc(12 + data.length)
    chunk.writeUInt32BE(data.length, 0)
    typeBytes.copy(chunk, 4)
    data.copy(chunk, 8)
    chunk.writeUInt32BE(pngCrc32(typeBytes, data), 8 + data.length)
    return chunk
  }

  const createLargeValidPng = (targetBytes: number): Buffer => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(1, 0)
    ihdr.writeUInt32BE(1, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    const ihdrChunk = pngChunk('IHDR', ihdr)
    const idatChunk = pngChunk('IDAT', deflateSync(Buffer.from([0, 0xff, 0, 0, 0xff])))
    const keyword = Buffer.from('Description', 'latin1')
    const fixedBytes =
      signature.length + ihdrChunk.length + idatChunk.length + 12 + keyword.length + 1 + 12
    const textLength = targetBytes - fixedBytes
    if (textLength <= 0) {
      throw new Error('PNG target must exceed its fixed chunk size.')
    }
    const text = Buffer.alloc(keyword.length + 1 + textLength, 0x41)
    keyword.copy(text)
    text[keyword.length] = 0
    return Buffer.concat([
      signature,
      ihdrChunk,
      idatChunk,
      pngChunk('tEXt', text),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  }

  it('accepts a valid structured PNG response whose encoded image exceeds the text budget', async () => {
    const pngBytes = createLargeValidPng(7 * 1024 * 1024)
    const pngBase64 = pngBytes.toString('base64')
    expect(Buffer.byteLength(pngBase64, 'utf8')).toBeGreaterThan(8 * 1024 * 1024)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'image_generation_call', result: pngBase64 }]
          }
        }
      ])
    )

    const result = await new CodexChatGPTCli('gpt-5.4', { modelUse: 'image' }).chat({
      messages: [{ role: 'user', content: 'Generate a large PNG.' }],
      imageGenerationOptions: { action: 'generate', outputFormat: 'png' }
    })

    expect(result.finishReason).toBe('stop')
    expect(result.content).toBe('')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]).toMatchObject({
      type: 'image',
      url: 'local-media://test-artifact-0'
    })
    expect(mocks.persistCodexImageArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            type: 'image',
            url: `data:image/png;base64,${pngBase64}`
          })
        ]
      }),
      expect.objectContaining({ enabled: true })
    )
  })

  it('rejects a completed plain-text response above the 8 MiB text budget', async () => {
    const oversizedText = 'x'.repeat(8 * 1024 * 1024 + 1)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: oversizedText }]
              }
            ]
          }
        }
      ])
    )

    await expect(
      new CodexChatGPTCli('gpt-5.4').chat({
        messages: [{ role: 'user', content: 'Return a large text response.' }]
      })
    ).rejects.toThrow('Codex streamed text exceeds its byte limit.')
  })

  it('returns exact source dimensions when the image already fits every transform budget', () => {
    expect(resolveCodexImageTargetDimensions(1024, 768)).toEqual({
      width: 1024,
      height: 768
    })
  })

  it.each([
    ['latest-user-turn', 1],
    ['all', 3]
  ] as const)('preprocesses only relevant user images for %s', (policy, expectedCalls) => {
    const image = (value: number): ChatAttachment => ({
      type: 'image',
      url: pngDataUrl(value)
    })
    buildCodexResponsesInput(
      [
        {
          role: 'user',
          content: 'historical',
          attachments: [image(1)]
        },
        {
          role: 'assistant',
          content: 'artifact',
          attachments: [image(2)]
        },
        { role: 'user', content: 'current', attachments: [image(3)] }
      ],
      policy
    )
    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(expectedCalls)
    const projectedUrls = (
      buildCodexResponsesInput(
        [
          { role: 'user', content: 'historical', attachments: [image(1)] },
          { role: 'assistant', content: 'artifact', attachments: [image(2)] },
          { role: 'user', content: 'current', attachments: [image(3)] }
        ],
        policy
      ) as Array<{ content?: Array<{ type?: string; image_url?: string }> }>
    )
      .flatMap((message) => message.content || [])
      .filter((part) => part.type === 'input_image')
      .map((part) => part.image_url)
    expect(new Set(projectedUrls)).toEqual(
      new Set(policy === 'all' ? [pngDataUrl(1), pngDataUrl(2), pngDataUrl(3)] : [pngDataUrl(3)])
    )
  })

  it.each([
    ['image/png', pngDataUrl(1)],
    ['image/jpeg', jpegDataUrl(2)],
    ['image/webp', webpDataUrl(3)],
    ['image/gif', gifDataUrl(4)]
  ] as const)(
    'preserves compliant %s bytes, URL, and MIME without transformation',
    (mimeType, url) => {
      const requestInput = buildCodexResponsesInput(
        [
          {
            role: 'user',
            content: 'inspect',
            attachments: [{ type: 'image', url, mimeType }]
          }
        ],
        'all'
      ) as Array<{ content?: Array<{ type?: string; image_url?: string }> }>

      expect(requestInput[0]?.content).toContainEqual({
        type: 'input_image',
        image_url: url
      })
      expect(mocks.resize).not.toHaveBeenCalled()
      expect(mocks.toJPEG).not.toHaveBeenCalled()
    }
  )

  it('does not impose a fixed decoded image cap when the default image policy is unlimited', () => {
    const largeBase64 = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8 * 1024 * 1024)
    ]).toString('base64')

    expect(() => parseCodexImageDataUrl(`data:image/png;base64,${largeBase64}`)).not.toThrow()
    expect(nativeImage.createFromBuffer).not.toHaveBeenCalled()
  })

  it('strictly rejects malformed base64 and MIME or magic mismatches', () => {
    expect(() =>
      buildCodexResponsesInput(
        [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: 'data:image/png;base64,iVB=OR==' }]
          }
        ],
        'all'
      )
    ).toThrow('Image data URL contains invalid base64 data.')

    expect(() =>
      buildCodexResponsesInput(
        [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: pngDataUrl(5), mimeType: 'image/jpeg' }]
          }
        ],
        'all'
      )
    ).toThrow('Image attachment MIME type mismatch')

    expect(() =>
      buildCodexResponsesInput(
        [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'image',
                url: pngDataUrl(6).replace('data:image/png', 'data:image/jpeg')
              }
            ]
          }
        ],
        'all'
      )
    ).toThrow('Image MIME type mismatch: declared image/jpeg, detected image/png.')
  })

  it('preserves a large GIF without resizing or recompressing it', () => {
    mocks.imageSizes.splice(0, mocks.imageSizes.length, {
      width: 5000,
      height: 1000
    })
    const url = gifDataUrl(7)
    const requestInput = buildCodexResponsesInput(
      [
        {
          role: 'user',
          content: '',
          attachments: [{ type: 'image', url, mimeType: 'image/gif' }]
        }
      ],
      'all'
    ) as Array<{ content?: Array<{ type?: string; image_url?: string }> }>

    expect(requestInput[0]?.content).toContainEqual({
      type: 'input_image',
      image_url: url
    })
    expect(mocks.resize).not.toHaveBeenCalled()
    expect(mocks.toJPEG).not.toHaveBeenCalled()
  })

  it('ignores historical image violations omitted by latest-user-turn policy', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        { type: 'response.output_text.done', text: 'ok' },
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
          }
        }
      ])
    )
    const createFromBuffer = vi.mocked(nativeImage.createFromBuffer)
    const invalidImages = Array.from({ length: 12 }, (_, index) => ({
      type: 'image' as const,
      url: `local-media://invalid-${index}`
    }))

    await expect(
      new CodexChatGPTCli('gpt-5.4').chat({
        messages: [
          { role: 'user', content: 'old', attachments: invalidImages },
          { role: 'assistant', content: 'noted' },
          { role: 'user', content: 'current text only' }
        ]
      })
    ).resolves.toMatchObject({ content: 'ok' })
    expect(JSON.stringify(requestBodyAt(0))).not.toContain('invalid-')
    expect(createFromBuffer).not.toHaveBeenCalled()
  })

  it('sends one inline input_image and no hosted or native tools for a tool-free image review', async () => {
    const client = new CodexChatGPTCli('gpt-6.2-astra')
    mocks.readExistingCodexReviewSession.mockResolvedValue({ accessToken: 'review-only', accountId: 'fixture' })
    expect(client.toolFreeImageReviewEndpoint).toBe('https://chatgpt.com/backend-api/codex/responses')
    const image = pngDataUrl(1)
    const prompt = 'Describe this image, do not edit the image.'
    expect(client.supportsToolFreeImageReview).toBe(true)
    mocks.fetch.mockResolvedValue(createSseResponse([{
      type: 'response.completed',
      response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'review' }] }] }
    }]))
    await expect(client.chat({
      messages: [{ role: 'user', content: prompt, attachments: [{ type: 'image', url: image }] }],
      readOnlyImageReview: true,
      disableAutomaticImageGeneration: true,
      disableProviderTools: true,
      imageGenerationOptions: { enabled: false },
      retryCapacity: false
    })).resolves.toMatchObject({ content: 'review' })
    expect(mocks.createFileSearchSession).not.toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch.mock.calls[0][0]).toBe(client.toolFreeImageReviewEndpoint)
    expect(requestInitAt(0).headers).toMatchObject({ Authorization: 'Bearer review-only' })
    expect(mocks.ensureCodexCliAuthTokens).not.toHaveBeenCalled()
    expect(mocks.forceRefreshCodexCliAuthTokens).not.toHaveBeenCalled()
    const body = requestBodyAt(0)
    expect(body.model).toBe('gpt-6.2-astra')
    expect(body.store).toBe(false)
    expect(body.input).toEqual([{ role: 'user', content: [
      { type: 'input_text', text: prompt }, { type: 'input_image', image_url: image }
    ] }])
    for (const field of ['tools', 'tool_choice', 'include', 'previous_response_id']) {
      expect(body).not.toHaveProperty(field)
    }
  })

  it('answers in text when provider tools are off and the prompt asks for a drawing', async () => {
    const client = new CodexChatGPTCli('gpt-5.4')
    mocks.fetch.mockResolvedValue(createSseResponse([{
      type: 'response.completed',
      response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'text only' }] }] }
    }]))
    await expect(client.chat({
      messages: [{ role: 'user', content: '画一张猫的图片' }],
      disableProviderTools: true,
      imageGenerationOptions: { enabled: false }
    })).resolves.toMatchObject({ content: 'text only' })
    const body = requestBodyAt(0)
    expect(body).not.toHaveProperty('tool_choice')
    expect(JSON.stringify(body.tools ?? [])).not.toContain('image_generation')
  })

  it('still refuses hosted image generation for an image model when provider tools are off', async () => {
    const client = new CodexChatGPTCli('gpt-5.4', { modelUse: 'image' })
    await expect(client.chat({
      messages: [{ role: 'user', content: 'A city skyline.' }],
      disableProviderTools: true
    })).rejects.toThrow('Provider tools are disabled for this image generation request.')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does not refresh or replay a rejected review session', async () => {
    mocks.readExistingCodexReviewSession.mockResolvedValue({ accessToken: 'review-only' })
    mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(new CodexChatGPTCli('selected').chat({
      readOnlyImageReview: true, disableAutomaticImageGeneration: true, disableProviderTools: true,
      messages: [{ role: 'user', content: 'inspect' }]
    })).rejects.toThrow(/sign in separately/i)
    expect(mocks.readExistingCodexReviewSession).toHaveBeenCalledOnce()
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.createFileSearchSession).not.toHaveBeenCalled()
    expect(mocks.ensureCodexCliAuthTokens).not.toHaveBeenCalled()
    expect(mocks.forceRefreshCodexCliAuthTokens).not.toHaveBeenCalled()
  })

  it('rejects supplied review tools before reading credentials or dispatching', async () => {
    await expect(new CodexChatGPTCli('selected').chat({
      readOnlyImageReview: true, disableAutomaticImageGeneration: true, disableProviderTools: true,
      tools: [{ name: 'forbidden', description: '', inputSchema: { type: 'object' } }], messages: []
    })).rejects.toThrow(/tool-free/)
    expect(mocks.readExistingCodexReviewSession).not.toHaveBeenCalled()
    expect(mocks.ensureCodexCliAuthTokens).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('rejects a tool-free turn on an image-only profile before OAuth or fetch', async () => {
    const client = new CodexChatGPTCli('opaque', { modelUse: 'image' })
    expect(client.supportsToolFreeImageReview).toBe(false)
    await expect(client.chat({
      messages: [{ role: 'user', content: 'inspect' }], disableProviderTools: true,
      disableAutomaticImageGeneration: true, imageGenerationOptions: { enabled: false }
    })).rejects.toThrow(/disabled/)
    expect(mocks.ensureCodexCliAuthTokens).not.toHaveBeenCalled()
    expect(mocks.createFileSearchSession).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('serializes exact full-history input_image entries into the final Responses HTTP body', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        { type: 'response.output_text.done', text: 'ok' },
        {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
          }
        }
      ])
    )
    const historicalUrl = pngDataUrl(10)
    const currentUrl = pngDataUrl(11)

    await new CodexChatGPTCli('gpt-5.4').chat({
      messages: [
        {
          role: 'user',
          content: 'old',
          attachments: [{ type: 'image', url: historicalUrl }]
        },
        { role: 'assistant', content: 'noted' },
        {
          role: 'user',
          content: 'current',
          attachments: [{ type: 'image', url: currentUrl }]
        }
      ],
      imageHistoryPolicy: 'all'
    })

    const body = requestBodyAt(0) as {
      input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>
    }
    expect(
      (body.input || [])
        .flatMap((message) => message.content || [])
        .filter((part) => part.type === 'input_image')
    ).toEqual([
      { type: 'input_image', image_url: historicalUrl },
      { type: 'input_image', image_url: currentUrl }
    ])
  })

  it('supports explicit full-history image reconstruction and validates every rebuilt image', () => {
    const requestInput = buildCodexResponsesInput(
      [
        {
          role: 'user',
          content: 'old',
          attachments: [{ type: 'image', url: pngDataUrl(8) }]
        },
        { role: 'assistant', content: 'noted' },
        {
          role: 'user',
          content: 'current',
          attachments: [{ type: 'image', url: pngDataUrl(9) }]
        }
      ],
      'all'
    ) as Array<{ content?: Array<{ type?: string }> }>

    expect(
      requestInput
        .flatMap((message) => message.content || [])
        .filter((part) => part.type === 'input_image')
    ).toHaveLength(2)
    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(2)
  })

  it('does not cap valid public HTTP(S) image references, while still rejecting invalid image URLs', () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)
    const requestInput = buildCodexResponsesInput(
      [
        {
          role: 'user',
          content: 'current',
          attachments: Array.from({ length: 10 }, (_, index) => ({
            type: 'image' as const,
            url: `${index % 2 === 0 ? 'https' : 'http'}://example.test/${index}.png`
          }))
        }
      ],
      'all'
    ) as Array<{ content?: Array<{ type?: string; image_url?: string }> }>
    expect(
      requestInput[0]?.content
        ?.filter((part) => part.type === 'input_image')
        .map((part) => part.image_url)
    ).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `${index % 2 === 0 ? 'https' : 'http'}://example.test/${index}.png`
      )
    )
    expect(() =>
      buildCodexResponsesInput(
        [
          {
            role: 'user',
            content: 'current',
            attachments: Array.from({ length: 11 }, (_, index) => ({
              type: 'image' as const,
              url: `${index % 2 === 0 ? 'https' : 'http'}://example.test/${index}.png`
            }))
          }
        ],
        'all'
      )
    ).not.toThrow()
    expect(() =>
      buildCodexResponsesInput(
        [
          {
            role: 'user',
            content: 'current',
            attachments: [{ type: 'image', url: 'local-media://current-invalid' }]
          }
        ],
        'all'
      )
    ).toThrow('Images must be supported base64 data URLs or public HTTP(S) URLs.')
  })

  it('accepts an application request body at the default Responses budget', async () => {
    const oversized = 'x'.repeat(16 * 1024 * 1024)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }]
              }
            ]
          }
        }
      ])
    )
    await expect(
      new CodexChatGPTCli('gpt-5.4').chat({
        messages: [{ role: 'user', content: oversized }]
      })
    ).resolves.toMatchObject({ content: 'ok' })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('reuses duplicate processed images and evicts least-recently-used entries', () => {
    const createFromBuffer = vi.mocked(nativeImage.createFromBuffer)
    const image = (value: number): ChatAttachment => ({
      type: 'image',
      url: pngDataUrl(value)
    })

    buildCodexResponsesInput(
      [{ role: 'user', content: '', attachments: [image(1), image(1)] }],
      'all'
    )
    expect(createFromBuffer).toHaveBeenCalledTimes(1)

    for (let value = 2; value <= 65; value += 1) {
      buildCodexResponsesInput([{ role: 'user', content: '', attachments: [image(value)] }], 'all')
    }
    expect(__getCodexProcessedImageCacheStatsForTests().entries).toBe(64)
    buildCodexResponsesInput([{ role: 'user', content: '', attachments: [image(1)] }], 'all')
    expect(createFromBuffer).toHaveBeenCalledTimes(66)
  })

  it('rejects image-generation responses that only contain text and no image artifact', async () => {
    mocks.ensureCodexCliAuthTokens.mockResolvedValue(createSession('oauth-access'))
    mocks.createFileSearchSession.mockResolvedValue(null)
    mocks.fetch.mockResolvedValue(
      createSseResponse([
        {
          type: 'response.output_text.delta',
          delta: 'changed background'
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-no-image',
            conversation_id: 'conv-no-image',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'changed background'
                  }
                ]
              }
            ]
          }
        }
      ])
    )

    const client = new CodexChatGPTCli('gpt-5.4', {
      modelUse: 'image'
    })

    await expect(
      client.chat({
        messages: [{ role: 'user', content: '换成白色背景' }],
        imageGenerationOptions: {
          action: 'edit',
          outputFormat: 'png',
          background: 'opaque'
        }
      })
    ).rejects.toThrow('Codex API returned empty or invalid image generation content.')
  })
})

describe('Codex interactive persistent capacity retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    __resetCodexRequestGovernorForTests()
    mocks.fetch.mockReset()
    mocks.ensureCodexCliAuthTokens.mockReset().mockResolvedValue(createSession('owned-access'))
    mocks.forceRefreshCodexCliAuthTokens.mockReset()
    mocks.createFileSearchSession.mockReset().mockResolvedValue(null)
    mocks.persistCodexImageArtifacts.mockReset().mockImplementation(async (result) => result)
    vi.stubGlobal('fetch', mocks.fetch)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetCodexRequestGovernorForTests()
  })
  const failed = {
    type: 'response.failed',
    response: {
      error: {
        code: 'server_overloaded',
        message: 'Our servers are currently overloaded. Please try again later.'
      }
    }
  }
  const success = () =>
    createSseResponse([
      { type: 'response.output_text.delta', delta: 'resumed' },
      {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'resumed' }] }]
        }
      }
    ])
  it('survives more than three SSE overloads inside one governor admission with one body, key and file-search session', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)
    mocks.createFileSearchSession.mockResolvedValue({
      vectorStoreIds: ['owned-vector-store'],
      cleanup
    })
    let n = 0
    mocks.fetch.mockImplementation(async () => (++n <= 6 ? createSseResponse([failed]) : success()))
    const events: Array<{
      type: string
      delta?: string
      retry?: { attempt: number; delayMs: number }
    }> = []
    const messages = [
      { role: 'user' as const, content: 'original question' },
      { role: 'assistant' as const, content: '[Tool Result] previously-read file' },
      { role: 'user' as const, content: 'summarize' }
    ]
    const before = structuredClone(messages)
    const promise = new CodexChatGPTCli('owned-model').chat({
      messages,
      retryCapacity: true,
      onDelta: (e) => events.push(e)
    })
    for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(60000)
    await expect(promise).resolves.toMatchObject({ content: 'resumed' })
    expect(n).toBe(7)
    expect(new Set(mocks.fetch.mock.calls.map((_, i) => requestInitAt(i).body)).size).toBe(1)
    expect(
      new Set(
        mocks.fetch.mock.calls.map((_, i) =>
          new Headers(requestInitAt(i).headers).get('Idempotency-Key')
        )
      ).size
    ).toBe(1)
    expect(new Headers(requestInitAt(0).headers).get('Idempotency-Key')).toBeTruthy()
    expect(mocks.createFileSearchSession).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(mocks.ensureCodexCliAuthTokens).toHaveBeenCalledOnce()
    expect(mocks.forceRefreshCodexCliAuthTokens).not.toHaveBeenCalled()
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join('')
    ).toBe('resumed')
    expect(events.filter((e) => e.type === 'retry' && e.retry!.delayMs > 0)).toHaveLength(6)
    expect(messages).toEqual(before)
  })
  it('handles HTTP overload advice and cancellation without a late retry', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response('{"error":{"type":"server_error","code":"server_overloaded"}}', {
          status: 503,
          headers: { 'retry-after': '20' }
        })
    )
    const controller = new AbortController()
    const promise = new CodexChatGPTCli('owned-model').chat({
      messages: [],
      retryCapacity: true,
      signal: controller.signal
    })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(19000)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    controller.abort()
    await rejection
    await vi.advanceTimersByTimeAsync(120000)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.persistCodexImageArtifacts).not.toHaveBeenCalled()
  })
  it.each(['partial-text', 'hosted-tool'])('does not replay after %s has begun', async (mode) => {
    const start =
      mode === 'partial-text'
        ? { type: 'response.output_text.delta', delta: 'partial' }
        : { type: 'response.web_search_call.in_progress', item_id: 'owned' }
    mocks.fetch.mockImplementation(async () => createSseResponse([start, failed]))
    await expect(
      new CodexChatGPTCli('owned-model').chat({
        messages: [],
        retryCapacity: true,
        onDelta: () => {}
      })
    ).rejects.toThrow('overloaded')
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
  it('does not loop on account quota or repeatedly refresh authentication', async () => {
    mocks.fetch
      .mockImplementationOnce(async () => new Response('', { status: 401 }))
      .mockImplementation(
        async () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })
      )
    mocks.forceRefreshCodexCliAuthTokens.mockResolvedValue(createSession('owned-refreshed'))
    await expect(
      new CodexChatGPTCli('owned-model').chat({ messages: [], retryCapacity: true })
    ).rejects.toThrow('429')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.forceRefreshCodexCliAuthTokens).toHaveBeenCalledOnce()
    expect(requestInitAt(0).body).toBe(requestInitAt(1).body)
  })
  it.each(['http500', 'sse-message', 'sse-code'] as const)(
    'retries provider processing failure %s inside the same logical request',
    async (mode) => {
      const message =
        'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 47ea0bfe-e93a-4fdc-adf0-80388e3c427a in your message.'
      let calls = 0
      mocks.fetch.mockImplementation(async () => {
        if (++calls > 4) return success()
        if (mode === 'http500')
          return new Response(JSON.stringify({ error: { type: 'server_error', message } }), {
            status: 500
          })
        return createSseResponse([
          {
            type: 'response.failed',
            response: {
              error:
                mode === 'sse-code' ? { code: 'internal_error', message: 'Try later' } : { message }
            }
          }
        ])
      })
      const events: Array<{ type: string; retry?: { reason: string; delayMs: number } }> = []
      const promise = new CodexChatGPTCli('owned-model').chat({
        messages: [{ role: 'user', content: 'summarize the existing file result' }],
        retryCapacity: true,
        onDelta: (event) => events.push(event)
      })
      const checked = promise.then(
        (result) => result.content,
        (error: Error) => error.message
      )
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60000)
      expect(await checked).toBe('resumed')
      expect(mocks.fetch).toHaveBeenCalledTimes(5)
      expect(
        new Set(mocks.fetch.mock.calls.map((_, index) => requestInitAt(index).body)).size
      ).toBe(1)
      const keys = mocks.fetch.mock.calls.map((_, index) =>
        new Headers(requestInitAt(index).headers).get('Idempotency-Key')
      )
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      expect(mocks.ensureCodexCliAuthTokens).toHaveBeenCalledOnce()
      expect(mocks.forceRefreshCodexCliAuthTokens).not.toHaveBeenCalled()
      expect(mocks.createFileSearchSession).toHaveBeenCalledOnce()
      expect(
        events
          .filter((event) => event.type === 'retry' && event.retry!.delayMs > 0)
          .map((event) => event.retry!.reason)
      ).toEqual(Array(4).fill('server-error'))
    }
  )
})

describe('Codex image processing-error retry safety', () => {
  const message =
    'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 30cfb5c8-2e2b-4672-81a4-7145e209413d in your message.'
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
  const finalImageUrl = `data:image/png;base64,${pngBase64}`
  const inputImages: ChatAttachment[] = Array.from({ length: 4 }, (_, index) => ({
    type: 'image',
    mimeType: 'image/png',
    fileName: `reference-${index + 1}.png`,
    url: `data:image/png;base64,${Buffer.concat([
      Buffer.from(pngBase64, 'base64'),
      Buffer.from([index + 1])
    ]).toString('base64')}`
  }))
  const progress = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'image-owned', type: 'image_generation_call', status: 'in_progress' }
    },
    { type: 'response.image_generation_call.in_progress', item_id: 'image-owned' },
    { type: 'response.image_generation_call.generating', item_id: 'image-owned' }
  ]
  const failure = (output?: unknown[]) => ({
    type: 'response.failed',
    response: {
      status: 'failed',
      error: { type: 'server_error', message },
      ...(output === undefined ? {} : { output })
    }
  })
  const success = () =>
    createSseResponse([
      {
        type: 'response.completed',
        response: {
          id: 'resp-image-recovered',
          status: 'completed',
          output: [{ type: 'image_generation_call', result: pngBase64 }]
        }
      }
    ])
  const imageRequest = (): Parameters<CodexChatGPTCli['chat']>[0] => ({
    messages: [{ role: 'user', content: 'Edit these four references.', attachments: inputImages }],
    imageGenerationOptions: { enabled: true, action: 'edit', outputFormat: 'png' },
    retryCapacity: true
  })
  const imageClient = () =>
    new CodexChatGPTCli('gpt-image-2.5-sunburst', {
      modelUse: 'image',
      requestTimeoutMs: 1000
    })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    __resetCodexRequestGovernorForTests()
    __resetCodexProcessedImageCacheForTests()
    mocks.imageSizes = Array.from({ length: 4 }, () => ({ width: 1, height: 1 }))
    mocks.fetch.mockReset()
    mocks.ensureCodexCliAuthTokens
      .mockReset()
      .mockResolvedValue(createSession('owned-image-access'))
    mocks.forceRefreshCodexCliAuthTokens.mockReset()
    mocks.createFileSearchSession.mockReset().mockResolvedValue(null)
    mocks.persistCodexImageArtifacts.mockReset().mockImplementation(async (result) => result)
    vi.stubGlobal('fetch', mocks.fetch)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetCodexRequestGovernorForTests()
    __resetCodexProcessedImageCacheForTests()
  })

  it.each(['absent', 'empty'] as const)(
    'retries repeated explicit failures with %s output and keeps all four image inputs',
    async (outputMode) => {
      let calls = 0
      mocks.fetch.mockImplementation(async () =>
        ++calls <= 4
          ? createSseResponse([...progress, failure(outputMode === 'empty' ? [] : undefined)])
          : success()
      )
      const events: LLMDeltaEvent[] = []
      const params = imageRequest()
      const originalMessages = structuredClone(params.messages)
      const observed = imageClient()
        .chat({ ...params, onDelta: (event) => events.push(event) })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        )

      for (let attempt = 0; attempt < 5; attempt++) await vi.advanceTimersByTimeAsync(60000)
      expect(await observed).toMatchObject({
        result: {
          content: '',
          attachments: [expect.objectContaining({ type: 'image', url: finalImageUrl })]
        }
      })
      expect(mocks.fetch).toHaveBeenCalledTimes(5)
      expect(
        new Set(mocks.fetch.mock.calls.map((_, index) => requestInitAt(index).body)).size
      ).toBe(1)
      const keys = mocks.fetch.mock.calls.map((_, index) =>
        new Headers(requestInitAt(index).headers).get('Idempotency-Key')
      )
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      const input = requestBodyAt(0).input as Array<{
        content?: Array<{ type: string; image_url?: string }>
      }>
      expect(
        input
          .flatMap((item) => item.content || [])
          .filter((part) => part.type === 'input_image')
          .map((part) => part.image_url)
      ).toEqual(inputImages.map((attachment) => attachment.url))
      expect(params.messages).toEqual(originalMessages)
      expect(
        events
          .filter((event) => event.type === 'retry' && event.retry!.delayMs > 0)
          .map((event) => event.retry!.reason)
      ).toEqual(Array(4).fill('server-error'))
      expect(events.filter((event) => event.type === 'attachment')).toEqual([
        expect.objectContaining({ attachment: expect.objectContaining({ url: finalImageUrl }) })
      ])
      expect(mocks.persistCodexImageArtifacts).toHaveBeenCalledOnce()
      expect(mocks.ensureCodexCliAuthTokens).toHaveBeenCalledOnce()
      expect(mocks.forceRefreshCodexCliAuthTokens).not.toHaveBeenCalled()
      expect(mocks.createFileSearchSession).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('cancels the backoff after repeated image failures without a late submission', async () => {
    mocks.fetch.mockImplementation(async () => createSseResponse([...progress, failure([])]))
    const controller = new AbortController()
    const events: LLMDeltaEvent[] = []
    const observed = imageClient()
      .chat({
        ...imageRequest(),
        signal: controller.signal,
        onDelta: (event) => events.push(event)
      })
      .catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(2001)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.type === 'retry').at(-1)?.retry).toMatchObject({
      attempt: 2,
      reason: 'server-error',
      delayMs: 4000
    })
    const cause = new DOMException('User stopped image retry.', 'AbortError')
    controller.abort(cause)
    expect(await observed).toBe(cause)
    await vi.advanceTimersByTimeAsync(300000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.persistCodexImageArtifacts).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  const expectNoImageRetry = async (
    response: Response,
    terminalState: 'failed' | 'truncated' | 'timeout' = 'failed',
    imageTask = true
  ) => {
    // A second response completes immediately so an unsafe retry fails normally,
    // rather than leaving a fake-timer test waiting on an infinite retry loop.
    mocks.fetch.mockResolvedValueOnce(response).mockImplementation(async () => success())
    const events: LLMDeltaEvent[] = []
    const client = imageTask ? imageClient() : new CodexChatGPTCli('owned-text-model')
    const params = imageTask ? imageRequest() : { messages: [], retryCapacity: true }
    const observed = client.chat({ ...params, onDelta: (event) => events.push(event) }).then(
      () => ({ completed: true }),
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(60000)
    expect(await observed).toMatchObject({ terminalState })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === 'retry')).toHaveLength(0)
    expect(mocks.persistCodexImageArtifacts).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }

  const unsafeEvents: Array<[string, Record<string, unknown>]> = [
    [
      'partial image',
      { type: 'response.image_generation_call.partial_image', partial_image_b64: pngBase64 }
    ],
    ['partial text', { type: 'response.output_text.delta', delta: 'already visible' }],
    [
      'refusal delta',
      { type: 'response.refusal.delta', delta: 'I cannot help with that request.' }
    ],
    [
      'refusal done',
      { type: 'response.refusal.done', refusal: 'I cannot help with that request.' }
    ],
    [
      'refusal content part',
      {
        type: 'response.content_part.done',
        part: { type: 'refusal', refusal: 'I cannot help with that request.' }
      }
    ],
    [
      'message containing refusal',
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          content: [{ type: 'refusal', refusal: 'I cannot help with that request.' }]
        }
      }
    ],
    [
      'image completed',
      { type: 'response.image_generation_call.completed', item_id: 'image-owned' }
    ],
    [
      'image output_item.done',
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'image_generation_call', status: 'completed' }
      }
    ],
    [
      'in-progress image item with a result',
      {
        type: 'response.output_item.added',
        item: { type: 'image_generation_call', status: 'in_progress', result: pngBase64 }
      }
    ],
    [
      'unknown image stage',
      { type: 'response.image_generation_call.unknown', item_id: 'image-owned' }
    ],
    ['web search', { type: 'response.web_search_call.in_progress', item_id: 'tool-owned' }],
    ['file search', { type: 'response.file_search_call.in_progress', item_id: 'tool-owned' }],
    [
      'code interpreter',
      { type: 'response.code_interpreter_call.in_progress', item_id: 'tool-owned' }
    ],
    [
      'native function call',
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call-owned', name: 'files.write' }
      }
    ],
    [
      'native function arguments',
      { type: 'response.function_call_arguments.delta', item_id: 'call-owned', delta: '{"path":' }
    ],
    [
      'custom tool input',
      { type: 'response.custom_tool_call_input.delta', item_id: 'call-owned', delta: 'write file' }
    ],
    ['MCP call', { type: 'response.mcp_call.in_progress', item_id: 'call-owned' }]
  ]
  it.each(unsafeEvents)('does not retry an image failure after %s', async (_name, event) => {
    await expectNoImageRetry(createSseResponse([...progress, event, failure([])]))
  })

  it('does not retry a refusal followed by failure without image progress', async () => {
    await expectNoImageRetry(
      createSseResponse([
        { type: 'response.refusal.delta', delta: 'I cannot help with that request.' },
        failure([])
      ])
    )
  })

  const terminalOutputs: Array<[string, Record<string, unknown>]> = [
    ['text', { type: 'message', content: [{ type: 'output_text', text: 'terminal text' }] }],
    ['image', { type: 'image_generation_call', result: pngBase64 }],
    ['failed image placeholder', { type: 'image_generation_call', status: 'failed' }],
    ['unknown', { type: 'unknown_output', value: 'must not be discarded' }]
  ]
  it.each(terminalOutputs)(
    'does not retry a failed terminal envelope containing %s output',
    async (_name, output) => {
      await expectNoImageRetry(createSseResponse([...progress, failure([output])]))
    }
  )
  it.each(terminalOutputs)(
    'does not retry terminal-only %s output without preceding progress',
    async (_name, output) => {
      await expectNoImageRetry(createSseResponse([failure([output])]))
    }
  )

  it('keeps image-progress replay protection for a non-image client', async () => {
    await expectNoImageRetry(createSseResponse([...progress, failure([])]), 'failed', false)
  })

  it('does not retry a failed envelope with a direct output_text field', async () => {
    await expectNoImageRetry(
      createSseResponse([
        ...progress,
        {
          ...failure([]),
          response: { ...failure([]).response, output_text: 'terminal field text' }
        }
      ])
    )
  })

  it('does not treat a bare error event as a confirmed failed image response', async () => {
    await expectNoImageRetry(
      createSseResponse([...progress, { type: 'error', code: 'server_error', message }])
    )
  })

  it('does not retry image progress followed by EOF without a terminal failure', async () => {
    await expectNoImageRetry(
      new Response(progress.map(sseFrame).join(''), {
        headers: { 'content-type': 'text/event-stream' }
      }),
      'truncated'
    )
  })

  it('does not retry an image stream timeout after progress without output', async () => {
    await expectNoImageRetry(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(progress.map(sseFrame).join('')))
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      ),
      'timeout'
    )
  })
})

describe('Codex interactive timeout recovery', () => {
  it.each([408, 504])('does not replay ambiguous HTTP %i image submissions', async (status) => {
    mocks.fetch.mockImplementation(
      async () => new Response('{"error":{"message":"owned gateway timeout"}}', { status })
    )
    const task = new CodexChatGPTCli('owned-image-model', {
      modelUse: 'image',
      requestTimeoutMs: 1000
    }).chat({
      messages: [{ role: 'user', content: 'owned image request' }],
      imageGenerationOptions: { enabled: true },
      retryCapacity: true,
      onDelta: () => {}
    })
    await expect(task).rejects.toMatchObject({ statusCode: status, retryBlocked: true })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    __resetCodexRequestGovernorForTests()
    mocks.fetch.mockReset()
    mocks.ensureCodexCliAuthTokens
      .mockReset()
      .mockResolvedValue(createSession('owned-timeout-access'))
    mocks.forceRefreshCodexCliAuthTokens.mockReset()
    mocks.createFileSearchSession.mockReset().mockResolvedValue(null)
    mocks.persistCodexImageArtifacts.mockReset().mockImplementation(async (result) => result)
    vi.stubGlobal('fetch', mocks.fetch)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetCodexRequestGovernorForTests()
  })
  const completion = {
    type: 'response.completed',
    response: {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }]
    }
  }
  it.each(['headers', 'stream'] as const)(
    'recovers a %s stall with the same payload/key',
    async (stage) => {
      let calls = 0
      const cancelled = vi.fn()
      mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
        if (++calls > 1) return createSseResponse([completion])
        if (stage === 'headers')
          return new Promise((_res, rej) =>
            init.signal!.addEventListener('abort', () => rej(init.signal!.reason), { once: true })
          )
        return new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { 'content-type': 'text/event-stream' }
        })
      })
      const events: Array<{ type: string; retry?: { reason: string } }> = []
      const promise = new CodexChatGPTCli('owned-model', { requestTimeoutMs: 1000 }).chat({
        messages: [{ role: 'user', content: 'test' }],
        retryCapacity: true,
        onDelta: (e) => events.push(e)
      })
      const observed = promise.then(
        (v) => ({ value: v.content }),
        (e) => ({ error: String(e) })
      )
      await vi.advanceTimersByTimeAsync(3100)
      expect(await observed).toEqual({ value: 'recovered' })
      expect(mocks.fetch).toHaveBeenCalledTimes(2)
      expect(requestInitAt(0).body).toBe(requestInitAt(1).body)
      expect(new Headers(requestInitAt(0).headers).get('Idempotency-Key')).toBe(
        new Headers(requestInitAt(1).headers).get('Idempotency-Key')
      )
      expect(events.some((e) => e.type === 'retry' && e.retry?.reason === 'request-timeout')).toBe(
        true
      )
      if (stage === 'stream') expect(cancelled).toHaveBeenCalledOnce()
    }
  )
  it('keeps a live stream past its total elapsed timeout without restarting it', async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>
    mocks.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            wire = c
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    )
    const promise = new CodexChatGPTCli('owned-model', { requestTimeoutMs: 1000 }).chat({
      messages: [],
      retryCapacity: true,
      onDelta: () => {}
    })
    const observed = promise.then(
      (v) => ({ value: v.content }),
      (e) => ({ error: String(e) })
    )
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(700)
      wire.enqueue(
        new TextEncoder().encode(
          sseFrame({ type: 'response.reasoning_summary_text.delta', delta: 'working' })
        )
      )
    }
    wire.enqueue(new TextEncoder().encode(sseFrame(completion)))
    expect(await observed).toEqual({ value: 'recovered' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
  it.each(['partial', 'hosted-tool'] as const)(
    'does not replay a timeout after %s',
    async (stage) => {
      const event =
        stage === 'partial'
          ? { type: 'response.output_text.delta', delta: 'partial' }
          : { type: 'response.web_search_call.in_progress', item_id: 'owned' }
      mocks.fetch.mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(sseFrame(event)))
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      )
      const promise = new CodexChatGPTCli('owned-model', { requestTimeoutMs: 1000 }).chat({
        messages: [],
        retryCapacity: true,
        onDelta: () => {}
      })
      const observed = promise.catch((e) => e)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await observed).toMatchObject({ terminalState: 'timeout', retryBlocked: true })
      await vi.advanceTimersByTimeAsync(60000)
      expect(mocks.fetch).toHaveBeenCalledOnce()
    }
  )
  it('stops waiting and never submits a late retry when cancelled', async () => {
    mocks.fetch.mockResolvedValue(
      new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    )
    const controller = new AbortController()
    const promise = new CodexChatGPTCli('owned-model', { requestTimeoutMs: 1000 }).chat({
      messages: [],
      retryCapacity: true,
      signal: controller.signal
    })
    const observed = promise.catch((e) => e)
    await vi.advanceTimersByTimeAsync(1001)
    controller.abort()
    expect(await observed).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })
  it('returns native tool-only SSE output and keeps opaque reasoning for the followup', async () => {
    const tools = [
      {
        name: 'files.read',
        description: 'Read',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    ]
    const items = [
      { type: 'reasoning', id: 'rs_owned', summary: [], encrypted_content: 'owned-opaque' },
      {
        type: 'function_call',
        id: 'fc_owned',
        call_id: 'call_owned',
        name: 'mp_tool_0',
        arguments: '{"path":"notes/a.txt"}'
      }
    ]
    mocks.fetch.mockImplementation(async () =>
      createSseResponse([
        { type: 'response.output_item.done', output_index: 0, item: items[0] },
        { type: 'response.output_item.done', output_index: 1, item: items[1] },
        { type: 'response.completed', response: { output: [] } }
      ])
    )
    const client = new CodexChatGPTCli('owned-model')
    expect(client.supportsNativeTools).toBe(true)
    const first = await client.chat({ messages: [{ role: 'user', content: 'read' }], tools })
    expect(first.content).toBe('')
    expect(first.finishReason).toBe('tool_call')
    expect(first.toolCalls?.[0]).toMatchObject({
      id: 'call_owned',
      name: 'files.read',
      wireName: 'mp_tool_0'
    })
    expect(first.toolResponseItems).toEqual(items)
    mocks.fetch.mockImplementation(async () => createSseResponse([completion]))
    await client.chat({
      messages: [{ role: 'user', content: 'read' }],
      tools,
      toolTurns: [
        {
          content: '',
          calls: first.toolCalls!,
          responseItems: first.toolResponseItems,
          results: [{ callId: 'call_owned', output: 'actual docx body' }]
        }
      ]
    })
    const body = JSON.parse(String(requestInitAt(1).body))
    expect(body.tools.find((tool: any) => tool.type === 'function')).toMatchObject({
      name: 'mp_tool_0',
      strict: false
    })
    expect(body.input.slice(-3)).toEqual([
      ...items,
      { type: 'function_call_output', call_id: 'call_owned', output: 'actual docx body' }
    ])
    expect(body.include).toContain('reasoning.encrypted_content')
  })
})
