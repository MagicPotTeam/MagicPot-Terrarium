import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import {
  normalizeChatAttachmentsForRequest,
  requestChatCompletion,
  requestChatCompletionStream,
  resolveAttachmentBatchCapability,
  supportsStreamingChatCompletion
} from './chatRequestUtils'
import { HUNYUAN_3D_PROFILE_ID } from './chatPageShared'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

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

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('normalizeChatAttachmentsForRequest', () => {
  it('converts local image attachments into data URLs', async () => {
    const imageBlob = new Blob(['image-bytes'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => imageBlob
    })
    vi.stubGlobal('fetch', fetchMock)

    const attachments: ChatAttachment[] = [
      {
        type: 'image',
        url: 'file:///C:/magicpot/lv1.png',
        fileName: 'lv1.png',
        mimeType: 'image/png'
      }
    ]

    const normalized = await normalizeChatAttachmentsForRequest(attachments)

    expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/magicpot/lv1.png')
    expect(normalized).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'lv1.png',
        mimeType: 'image/png',
        sizeBytes: imageBlob.size,
        url: expect.stringMatching(/^data:image\/png;base64,/)
      })
    ])
  })

  it('converts local file attachments into data URLs', async () => {
    const fileBlob = new Blob(['# Notes'], { type: 'text/markdown' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => fileBlob
    })
    vi.stubGlobal('fetch', fetchMock)

    const attachments: ChatAttachment[] = [
      {
        type: 'file',
        url: 'file:///C:/magicpot/notes.md',
        fileName: 'notes.md',
        mimeType: 'text/markdown'
      }
    ]

    const normalized = await normalizeChatAttachmentsForRequest(attachments)

    expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/magicpot/notes.md')
    expect(normalized).toEqual([
      expect.objectContaining({
        type: 'file',
        fileName: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: fileBlob.size,
        url: expect.stringMatching(/^data:text\/markdown;base64,/)
      })
    ])
  })
})

describe('requestChatCompletion', () => {
  it('uses the local IPC proxy when remote mode is disabled', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: 'local reply', sessionUrl: 'session-1' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(requestChatCompletion({ config, messages, profileId: 'foo' })).resolves.toEqual({
      content: 'local reply',
      sessionUrl: 'session-1'
    })

    expect(chat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello', attachments: undefined }],
      profileId: 'foo',
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('cancels local IPC chat requests when the caller aborts the conversation signal', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    let rejectChat: ((reason?: unknown) => void) | null = null
    const chat = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectChat = reject
        })
    )
    const cancelConversation = vi.fn(async ({ conversationId }: { conversationId: string }) => {
      const error = new Error(`cancelled ${conversationId}`)
      error.name = 'AbortError'
      rejectChat?.(error)
      return { cancelled: true }
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat, cancelConversation }
    } as unknown as Window['api']

    const controller = new AbortController()
    const completion = requestChatCompletion({
      config,
      messages,
      profileId: 'foo',
      conversationId: 'conversation-local',
      signal: controller.signal
    })

    controller.abort('user cancelled')

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelConversation).toHaveBeenCalledWith({ conversationId: 'conversation-local' })
  })

  it('normalizes image attachments before sending local requests', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const imageBlob = new Blob(['image-bytes'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => imageBlob
    })
    vi.stubGlobal('fetch', fetchMock)

    const chat = vi.fn().mockResolvedValue({ content: 'local reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await requestChatCompletion({
      config,
      messages: [
        {
          role: 'user',
          content: 'tag these',
          attachments: [
            {
              type: 'image',
              url: 'file:///C:/magicpot/lv1.png',
              fileName: 'lv1.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/magicpot/lv1.png')
    expect(chat).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content: expect.stringContaining('tag these'),
          attachments: [
            expect.objectContaining({
              type: 'image',
              fileName: 'lv1.png',
              mimeType: 'image/png',
              sizeBytes: imageBlob.size,
              url: expect.stringContaining('data:image/png;base64,')
            })
          ]
        }
      ],
      profileId: undefined,
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('skips inline file previews for official OpenAI file-search profiles', async () => {
    const config = createConfig()
    config.use_remote_llm = false
    config.llm_config.api_profiles = [
      {
        id: 'openai-file-search',
        model_name: 'gpt-5.4',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test',
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'chat'
      }
    ]

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const chat = vi.fn().mockResolvedValue({ content: 'local reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await requestChatCompletion({
      config,
      profileId: 'openai-file-search',
      messages: [
        {
          role: 'user',
          content: '请分析这个文件。',
          attachments: [
            {
              type: 'file',
              url: 'https://assets.example.com/spec.md',
              fileName: 'spec.md',
              mimeType: 'text/markdown'
            }
          ]
        }
      ]
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content: '请分析这个文件。',
          attachments: [
            {
              type: 'file',
              url: 'https://assets.example.com/spec.md',
              fileName: 'spec.md',
              mimeType: 'text/markdown'
            }
          ]
        }
      ],
      profileId: 'openai-file-search',
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('keeps image-only Hy3D requests free of auto-generated attachment summary text', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: 'local reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await requestChatCompletion({
      config,
      profileId: HUNYUAN_3D_PROFILE_ID,
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
              fileName: 'reference.png',
              mimeType: 'image/png'
            }
          ]
        }
      ]
    })

    expect(chat).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            expect.objectContaining({
              type: 'image',
              fileName: 'reference.png',
              mimeType: 'image/png',
              url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM='
            })
          ]
        }
      ],
      profileId: HUNYUAN_3D_PROFILE_ID,
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('injects hidden message context into the request without changing visible content', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: 'local reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await requestChatCompletion({
      config,
      messages: [
        {
          role: 'user',
          content: 'tag these images',
          hiddenContext: 'Canvas asset manifest:\n- type=image; order=1; fileName="lv1.png"'
        }
      ]
    })

    expect(chat).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content:
            'Canvas asset manifest:\n- type=image; order=1; fileName="lv1.png"\n\ntag these images',
          attachments: undefined
        }
      ],
      profileId: undefined,
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('fails fast when a normal custom skill is incomplete', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn()
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        externalAgentSkill: {
          id: 'skill-normal',
          category: '   ',
          skillName: '   ',
          prompt: '   ',
          type: 'normal'
        }
      })
    ).rejects.toThrow(
      'Custom skill "skill-normal" is incomplete: missing category, skillName, prompt.'
    )

    expect(chat).not.toHaveBeenCalled()
  })

  it('uses the remote endpoint when remote mode is enabled', async () => {
    const config = createConfig()
    config.use_remote_llm = true
    config.remote_llm_server_config.server_origin = 'http://example.com:3721/'
    config.remote_llm_server_config.access_token = 'proxy-secret'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'remote reply', sessionUrl: 'remote-session' })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestChatCompletion({
        config,
        messages,
        profileId: 'bar',
        conversationId: 'conversation-1'
      })
    ).resolves.toEqual({
      content: 'remote reply',
      sessionUrl: 'remote-session'
    })

    expect(fetchMock).toHaveBeenCalledWith('http://example.com:3721/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer proxy-secret'
      },
      signal: expect.any(AbortSignal),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello', attachments: undefined }],
        profileId: 'bar',
        systemPrompt: undefined,
        sessionUrl: undefined,
        conversationId: 'conversation-1',
        isEdit: undefined
      })
    })
  })

  it('does not derive remote canvas access from storageScope and only sends explicit attachments', async () => {
    const config = createConfig()
    config.use_remote_llm = true
    config.remote_llm_server_config.server_origin = 'http://example.com:3721/'
    config.remote_llm_server_config.access_token = 'proxy-secret'

    const imageBlob = new Blob(['image-bytes'], { type: 'image/png' })
    let chatBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url ===
        'local-media:///C:/client-user-data/renderer-state/project-canvas/.Canvas-Project__canvas-1/assets/images/sprite.png'
      ) {
        return {
          ok: true,
          blob: async () => imageBlob
        }
      }

      if (url === 'http://example.com:3721/api/chat') {
        chatBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        return {
          ok: true,
          json: async () => ({ content: 'remote reply' })
        }
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestChatCompletion({
        config,
        messages: [
          {
            role: 'user',
            content: 'inspect this canvas',
            attachments: [
              {
                type: 'image',
                url: 'local-media:///C:/client-user-data/renderer-state/project-canvas/.Canvas-Project__canvas-1/assets/images/sprite.png',
                fileName: 'sprite.png',
                mimeType: 'image/png'
              }
            ]
          }
        ],
        profileId: 'bar',
        conversationId: 'conversation-1',
        storageScope: 'canvas-1.agent-2'
      })
    ).resolves.toEqual({
      content: 'remote reply',
      sessionUrl: undefined
    })

    if (!chatBody) {
      throw new Error('Expected remote chat request body')
    }

    const requestBody = chatBody as unknown as {
      route?: unknown
      messages?: Array<{ content?: string; attachments?: ChatAttachment[] }>
    }

    expect(chatBody).toMatchObject({
      profileId: 'bar',
      conversationId: 'conversation-1'
    })
    expect(requestBody.route).toBeUndefined()
    expect(requestBody.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('inspect this canvas'),
        attachments: [
          expect.objectContaining({
            url: expect.stringMatching(/^data:image\/png;base64,/),
            fileName: 'sprite.png',
            mimeType: 'image/png',
            sizeBytes: imageBlob.size
          })
        ]
      })
    ])
    expect(requestBody.messages?.[0]?.content || '').not.toContain('Server canvas root:')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://example.com:3721/api/canvas/sync',
      expect.anything()
    )
  })

  it('forwards an explicit canvas route in remote mode without syncing or rewriting attachments', async () => {
    const config = createConfig()
    config.use_remote_llm = true
    config.remote_llm_server_config.server_origin = 'http://example.com:3721/'
    config.remote_llm_server_config.access_token = 'proxy-secret'

    let chatBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://example.com:3721/api/chat') {
        chatBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        return {
          ok: true,
          json: async () => ({ content: 'remote reply' })
        }
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const route = {
      channel: 'canvas' as const,
      scopeType: 'thread' as const,
      scopeId: 'canvas-1',
      threadId: 'agent-2'
    }

    await expect(
      requestChatCompletion({
        config,
        messages: [{ role: 'user', content: 'inspect just this request' }],
        route,
        storageScope: 'canvas-1.agent-2',
        profileId: 'bar',
        conversationId: 'conversation-2'
      })
    ).resolves.toEqual({
      content: 'remote reply',
      sessionUrl: undefined
    })

    if (!chatBody) {
      throw new Error('Expected remote chat request body')
    }

    const requestBody = chatBody as unknown as {
      route?: unknown
      messages?: Array<{ content?: string }>
    }

    expect(chatBody).toMatchObject({
      route,
      profileId: 'bar',
      conversationId: 'conversation-2',
      messages: [{ role: 'user', content: 'inspect just this request' }]
    })
    expect(requestBody.messages?.[0]?.content || '').not.toContain(
      'Current canvas files have been mirrored to the server'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://example.com:3721/api/canvas/sync',
      expect.anything()
    )
  })

  it('surfaces a clear token mismatch error for unauthorized remote chat requests', async () => {
    const config = createConfig()
    config.use_remote_llm = true
    config.remote_llm_server_config.server_origin = 'http://example.com:3721/'
    config.remote_llm_server_config.access_token = 'wrong-token'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () =>
        JSON.stringify({
          error:
            'Unauthorized LLM proxy request. Provide Authorization: Bearer <token>, X-MagicPot-Proxy-Token, or legacy X-MagicPot-Bot-Secret/X-Bot-Secret.'
        })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestChatCompletion({
        config,
        messages,
        profileId: 'bar'
      })
    ).rejects.toThrow(
      'Remote chat request was rejected (401 Unauthorized). Check that the remote LLM proxy access token matches the server configuration.'
    )
  })

  it('preserves an explicit system prompt for normal skill requests', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: 'local reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']
    await expect(
      requestChatCompletion({
        config,
        messages,
        profileId: 'foo',
        systemPrompt: 'Use this instruction set.'
      })
    ).resolves.toEqual({ content: 'local reply', sessionUrl: undefined })

    expect(chat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello', attachments: undefined }],
      profileId: 'foo',
      systemPrompt: 'Use this instruction set.',
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('forwards a structured skillRuntime payload alongside normal chat requests', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: 'local reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        systemPrompt: 'Use this instruction set.',
        skillRuntime: {
          skillId: 'builtin-tagging',
          instructions: {
            systemPrompt: 'Use this instruction set.',
            userPrompt: 'Return only sidecar text.'
          },
          execution: {
            mode: 'isolated',
            allowHistory: false,
            outputMode: 'sidecar',
            fallbackStrategy: 'smaller-batches',
            persistSessionUrl: false
          },
          bindings: [
            {
              appId: 'qapp.image-interrogation',
              resourceUris: [
                'qapp.imageInterrogation.systemPrompt',
                'qapp.imageInterrogation.userPrompt'
              ]
            }
          ]
        }
      })
    ).resolves.toEqual({ content: 'local reply', sessionUrl: undefined })

    expect(chat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hello', attachments: undefined }],
      profileId: undefined,
      systemPrompt: 'Use this instruction set.',
      skillRuntime: {
        skillId: 'builtin-tagging',
        instructions: {
          systemPrompt: 'Use this instruction set.',
          userPrompt: 'Return only sidecar text.'
        },
        execution: {
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'sidecar',
          fallbackStrategy: 'smaller-batches',
          persistSessionUrl: false
        },
        bindings: [
          {
            appId: 'qapp.image-interrogation',
            resourceUris: [
              'qapp.imageInterrogation.systemPrompt',
              'qapp.imageInterrogation.userPrompt'
            ]
          }
        ]
      },
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: undefined
    })
  })

  it('forces image output mode to return only image attachments', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({
      content: 'Here is the generated image.',
      attachments: [
        {
          type: 'image',
          url: 'https://cdn.example.com/result.png',
          fileName: 'result.png'
        },
        {
          type: 'video',
          url: 'https://cdn.example.com/result.mp4',
          fileName: 'result.mp4'
        }
      ]
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        skillRuntime: {
          skillId: 'image-skill',
          execution: {
            outputMode: 'image'
          }
        }
      })
    ).resolves.toEqual({
      content: '',
      sessionUrl: undefined,
      attachments: [
        {
          type: 'image',
          url: 'https://cdn.example.com/result.png',
          fileName: 'result.png',
          mimeType: 'image/png'
        }
      ]
    })

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        imageGenerationOptions: expect.objectContaining({ enabled: true })
      })
    )
  })

  it('rejects forced media output when the model returns only text', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: 'I cannot make a video.' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        skillRuntime: {
          skillId: 'video-skill',
          execution: {
            outputMode: 'video'
          }
        }
      })
    ).rejects.toThrow('该模型不支持该输出方式')
  })

  it('strips generated media when forced text output has usable text', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({
      content: 'caption text\n![generated](https://cdn.example.com/result.png)',
      attachments: [
        {
          type: 'image',
          url: 'https://cdn.example.com/result.png'
        }
      ]
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        skillRuntime: {
          skillId: 'text-skill',
          execution: {
            outputMode: 'text'
          }
        }
      })
    ).resolves.toEqual({
      content: 'caption text',
      sessionUrl: undefined
    })
  })

  it('routes agent skills only through their configured external API', async () => {
    const config = createConfig()
    config.use_remote_llm = true

    const remoteFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ content: 'agent reply', sessionUrl: 'skill-session' })
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { remoteFetch }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        profileId: 'ignored-profile',
        systemPrompt: 'Caller-supplied prompt should be ignored.',
        conversationId: 'conversation-2',
        externalAgentSkill: {
          id: 'skill-1',
          category: 'Ops',
          skillName: 'Pipeline Agent',
          prompt: 'Follow the workflow prompt.',
          type: 'agent',
          apiKey: 'secret-key',
          apiAddress: 'https://skills.example.com/api/chat'
        }
      })
    ).resolves.toEqual({
      content: 'agent reply',
      sessionUrl: 'skill-session'
    })

    expect(remoteFetch).toHaveBeenCalledWith({
      url: 'https://skills.example.com/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-key'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello', attachments: undefined }],
        profileId: undefined,
        systemPrompt: 'Follow the workflow prompt.',
        sessionUrl: undefined,
        conversationId: 'conversation-2',
        isEdit: undefined
      }),
      conversationId: 'conversation-2'
    })
  })

  it('binds the selected agent skill prompt into the outbound request payload', async () => {
    const config = createConfig()

    const remoteFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ content: 'agent reply' })
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { remoteFetch }
    } as unknown as Window['api']

    await requestChatCompletion({
      config,
      messages,
      externalAgentSkill: {
        id: 'skill-4',
        category: 'Ops',
        skillName: 'Prompt Carrier',
        prompt: 'Use the attached system instructions exactly.',
        type: 'agent',
        apiAddress: 'https://skills.example.com/agent'
      }
    })

    expect(remoteFetch).toHaveBeenCalledWith({
      url: 'https://skills.example.com/agent',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello', attachments: undefined }],
        profileId: undefined,
        systemPrompt: 'Use the attached system instructions exactly.',
        sessionUrl: undefined,
        conversationId: undefined,
        isEdit: undefined
      }),
      conversationId: undefined
    })
  })

  it('adds file attachment summaries before sending agent skill requests', async () => {
    const config = createConfig()

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'Attachment preview from note.txt'
    })
    const remoteFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ content: 'agent reply' })
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { remoteFetch }
    } as unknown as Window['api']
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestChatCompletion({
        config,
        messages: [
          {
            role: 'user',
            content: 'Please analyze the attachment.',
            attachments: [
              {
                type: 'file',
                url: 'https://assets.example.com/note.txt',
                fileName: 'note.txt',
                mimeType: 'text/plain'
              }
            ]
          }
        ],
        externalAgentSkill: {
          id: 'skill-4',
          category: 'Ops',
          skillName: 'Attachment Agent',
          prompt: 'Review attached files carefully.',
          type: 'agent',
          apiKey: '',
          apiAddress: 'https://skills.example.com/agent'
        }
      })
    ).resolves.toEqual({
      content: 'agent reply',
      sessionUrl: undefined
    })

    expect(fetchMock).toHaveBeenCalledWith('https://assets.example.com/note.txt')
    const requestBody = JSON.parse(remoteFetch.mock.calls[0][0].body as string)
    expect(requestBody.messages[0].content).toContain('Please analyze the attachment.')
    expect(requestBody.messages[0].content).toContain('[Attached file] note.txt')
    expect(requestBody.messages[0].content).toContain('Attachment preview from note.txt')
    expect(requestBody.messages[0].attachments).toHaveLength(1)
  })

  it('adds image metadata summaries and preserves structured image fields for agent skills', async () => {
    const config = createConfig()
    const imageBlob = new Blob(['image-bytes'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => imageBlob
    })
    vi.stubGlobal('fetch', fetchMock)

    const remoteFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ content: 'agent reply' })
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { remoteFetch }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages: [
          {
            role: 'user',
            content: 'Please label this image.',
            attachments: [
              {
                type: 'image',
                url: 'local-media:///demo/reference.png',
                fileName: 'reference.png',
                mimeType: 'image/png',
                sizeBytes: 2048,
                sourceWidth: 1536,
                sourceHeight: 1024
              }
            ]
          }
        ],
        externalAgentSkill: {
          id: 'skill-image-label',
          category: 'Ops',
          skillName: 'Image Label Agent',
          prompt: 'Label the attached images.',
          type: 'agent',
          apiAddress: 'https://skills.example.com/agent'
        }
      })
    ).resolves.toEqual({
      content: 'agent reply',
      sessionUrl: undefined
    })

    const requestBody = JSON.parse(remoteFetch.mock.calls[0][0].body as string)
    expect(requestBody.messages[0].content).toContain('Please label this image.')
    expect(requestBody.messages[0].content).toContain('[Attached image] reference.png')
    expect(requestBody.messages[0].content).toContain('sizeBytes=2048')
    expect(requestBody.messages[0].content).toContain('resolution=1536x1024')
    expect(requestBody.messages[0].attachments).toEqual([
      {
        type: 'image',
        url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
        fileName: 'reference.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        sourceWidth: 1536,
        sourceHeight: 1024
      }
    ])
  })

  it('keeps agent skills on their external API even when remote mode is disabled', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn()
    const remoteFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: 'plain text agent reply'
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat, remoteFetch }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        externalAgentSkill: {
          id: 'skill-2',
          category: 'Ops',
          skillName: 'Fallback Agent',
          prompt: 'Handle this externally.',
          type: 'agent',
          apiKey: '   ',
          apiAddress: 'https://skills.example.com/agent'
        }
      })
    ).resolves.toEqual({
      content: 'plain text agent reply',
      sessionUrl: undefined
    })

    expect(chat).not.toHaveBeenCalled()
    expect(remoteFetch).toHaveBeenCalledWith({
      url: 'https://skills.example.com/agent',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello', attachments: undefined }],
        profileId: undefined,
        systemPrompt: 'Handle this externally.',
        sessionUrl: undefined,
        conversationId: undefined,
        isEdit: undefined
      }),
      conversationId: undefined
    })
  })

  it('preserves structured attachments from agent responses', async () => {
    const config = createConfig()

    const remoteFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({
        content: 'OCR completed',
        attachments: [
          {
            type: 'file',
            url: 'https://assets.example.com/result.xlsx',
            fileName: 'result.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        ],
        ocrResult: {
          kind: 'table',
          text: 'A1'
        }
      })
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { remoteFetch }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        externalAgentSkill: {
          id: 'skill-ocr',
          category: 'Ops',
          skillName: 'OCR Agent',
          prompt: 'Read the table.',
          type: 'agent',
          apiAddress: 'https://skills.example.com/ocr'
        }
      })
    ).resolves.toEqual({
      content: 'OCR completed',
      sessionUrl: undefined,
      attachments: [
        {
          type: 'file',
          url: 'https://assets.example.com/result.xlsx',
          fileName: 'result.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ocrResult: {
            kind: 'table',
            text: 'A1'
          }
        }
      ],
      ocrResult: {
        kind: 'table',
        text: 'A1'
      }
    })
  })

  it('fails fast when an agent skill has no API address', async () => {
    const config = createConfig()

    const chat = vi.fn()
    const remoteFetch = vi.fn()
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat, remoteFetch }
    } as unknown as Window['api']

    await expect(
      requestChatCompletion({
        config,
        messages,
        externalAgentSkill: {
          id: 'skill-3',
          category: 'Ops',
          skillName: 'Broken Agent',
          prompt: 'This should fail.',
          type: 'agent',
          apiKey: '',
          apiAddress: '   '
        }
      })
    ).rejects.toThrow('Custom skill "Broken Agent" is incomplete: missing apiAddress.')

    expect(chat).not.toHaveBeenCalled()
    expect(remoteFetch).not.toHaveBeenCalled()
  })

  it('turns imageUrl responses into image attachments instead of plain text content', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({
      content: 'Here is the rendered image.',
      imageUrl: 'https://assets.example.com/report.png'
    })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(requestChatCompletion({ config, messages, profileId: 'foo' })).resolves.toEqual({
      content: 'Here is the rendered image.',
      sessionUrl: undefined,
      attachments: [
        {
          type: 'image',
          url: 'https://assets.example.com/report.png'
        }
      ]
    })
  })

  it('probes report inline capability once and expands bundle images before sending', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '15000' })
      .mockResolvedValueOnce({ content: 'bundle reply' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'local-media:///cache/report-bundles/bundle-1/manifest.json') {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              version: 1,
              bundleId: 'bundle-1',
              title: 'Canvas Check',
              createdAt: '2026-04-09T00:00:00.000Z',
              entries: [
                {
                  role: 'primary-report',
                  fileName: 'canvas-target-report.md',
                  relativePath: 'canvas-target-report.md'
                },
                {
                  role: 'report-image',
                  fileName: 'fig-01-overview.png',
                  relativePath: 'images/fig-01-overview.png',
                  mimeType: 'image/png'
                }
              ]
            })
        }
      }

      if (url === 'local-media:///cache/report-bundles/bundle-1/canvas-target-report.md') {
        const reportText = '# Canvas Check Report\n\n## Overview\n\n' + 'A'.repeat(6000)
        return {
          ok: true,
          text: async () => reportText,
          blob: async () => new Blob([reportText], { type: 'text/markdown' })
        }
      }

      if (url.startsWith('data:text/markdown;base64,')) {
        return {
          ok: true,
          text: async () => '# Canvas Check Report\n\n## Overview\n\n' + 'A'.repeat(6000)
        }
      }

      if (url === 'local-media:///cache/report-bundles/bundle-1/images/fig-01-overview.png') {
        return {
          ok: true,
          blob: async () => new Blob(['image-bytes'], { type: 'image/png' })
        }
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestChatCompletion({
        config,
        profileId: 'profile-report',
        messages: [
          {
            role: 'user',
            content: 'Please review this report bundle.',
            attachments: [
              {
                type: 'file',
                url: 'local-media:///cache/report-bundles/bundle-1/canvas-target-report.md',
                fileName: 'canvas-target-report.md',
                mimeType: 'text/markdown',
                reportBundleId: 'bundle-1',
                reportBundleRole: 'primary-report',
                reportBundleRefName: 'canvas-target-report.md',
                reportBundleManifestUrl:
                  'local-media:///cache/report-bundles/bundle-1/manifest.json'
              }
            ]
          }
        ]
      })
    ).resolves.toEqual({
      content: 'bundle reply',
      sessionUrl: undefined
    })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[0][0].messages).toEqual([
      {
        role: 'user',
        content:
          'Reply with one integer only. What is the largest pure-text character count you can reliably accept in one request right now? Digits only.',
        attachments: undefined
      }
    ])

    const actualRequest = chat.mock.calls[1][0]
    expect(actualRequest.messages[0].content).toContain('Please review this report bundle.')
    expect(actualRequest.messages[0].content).toContain('[Attached report] canvas-target-report.md')
    expect(actualRequest.messages[0].attachments).toEqual([
      expect.objectContaining({
        type: 'file',
        reportBundleRole: 'primary-report'
      }),
      expect.objectContaining({
        type: 'image',
        fileName: 'fig-01-overview.png',
        reportBundleRole: 'report-image'
      })
    ])
  })

  it('probes and caches attachment batch capability per profile', async () => {
    const config = createConfig()
    config.use_remote_llm = false

    const chat = vi.fn().mockResolvedValue({ content: '4' })
    ;(window as typeof window & { api: unknown }).api = {
      svcLLMProxy: { chat }
    } as unknown as Window['api']

    await expect(
      resolveAttachmentBatchCapability({
        config,
        profileId: 'profile-batch'
      })
    ).resolves.toBe(4)

    await expect(
      resolveAttachmentBatchCapability({
        config,
        profileId: 'profile-batch'
      })
    ).resolves.toBe(4)

    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content:
            'Ignore any previous task instructions and reply with one integer only. What is the maximum number of attachments (images, videos, 3D models, or generic files) you can reliably analyze in one request right now? Digits only.',
          attachments: undefined
        }
      ],
      profileId: 'profile-batch',
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: false
    })
  })
})
