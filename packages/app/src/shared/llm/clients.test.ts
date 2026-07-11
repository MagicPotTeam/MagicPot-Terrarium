import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAPICli, GeminiAPICli, OpencodeZenAPICli, OpenAIAPICli } from './clients'

describe('shared llm endpoint normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('routes official OpenAI requests through the Responses API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli(
      'sk-test',
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini'
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([expect.objectContaining({ type: 'web_search' })])
    expect(requestBody.include).toEqual(['web_search_call.action.sources'])
  })

  it('rewrites CLIProxy GPT-5.6 Ultra reasoning to the max wire value', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
      })
    })

    const client = new OpenAIAPICli('sk-test', 'https://example.test/v1', 'gpt-5.6-sol', {
      apiMode: 'responses',
      enableHostedTools: false,
      reasoningProfile: { model_name: 'gpt-5.6-sol', call_type: 'cliproxyapi' },
      fetchImpl: fetchMock
    })

    await client.chat({
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'ultra'
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.reasoning).toEqual({ effort: 'max' })
  })

  it('keeps local OpenAI-compatible gateways on /chat/completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('', 'http://127.0.0.1:8000/v1/chat/completions', 'qwen2.5-vl')

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('uses the configured OpenAI images endpoint with a prompt body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'aW1hZ2U=' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli(
      'sk-test',
      'https://codexapis.com/v1/images/generations',
      'gpt-image-2'
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'draw an image' }] })
    ).resolves.toMatchObject({
      content: '',
      attachments: [expect.objectContaining({ type: 'image' })]
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://codexapis.com/v1/images/generations',
      expect.objectContaining({ method: 'POST' })
    )
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'draw an image'
    })
    expect(requestBody).not.toHaveProperty('messages')
  })

  it('forces the OpenAI image generation tool for image profiles', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4', {
      modelUse: 'image'
    })

    const result = await client.chat({
      messages: [{ role: 'user', content: 'Generate an image of a cat.' }],
      imageGenerationOptions: {
        outputFormat: 'png',
        size: '3840x2160',
        quality: 'high',
        background: 'auto'
      }
    })

    expect(result).toMatchObject({
      content: '',
      attachments: [
        expect.objectContaining({
          type: 'image'
        })
      ]
    })
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({
      model: 'gpt-5.4',
      tool_choice: {
        type: 'image_generation'
      }
    })
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'generate',
        output_format: 'png',
        size: '3840x2160',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('forces image editing from explicit action and keeps an explicit output size', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'image',
                url: 'data:image/png;base64,cmVmZXJlbmNl',
                sourceWidth: 2508,
                sourceHeight: 1295
              }
            ]
          }
        ],
        imageGenerationOptions: {
          action: 'edit',
          outputFormat: 'png',
          size: '3840x2160',
          quality: 'high',
          background: 'auto'
        }
      })
    ).resolves.toMatchObject({
      attachments: [expect.objectContaining({ type: 'image' })]
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({
      tool_choice: {
        type: 'image_generation'
      },
      tools: [
        expect.objectContaining({
          type: 'image_generation',
          action: 'edit',
          output_format: 'png',
          size: '3840x2160',
          quality: 'high',
          background: 'auto'
        })
      ]
    })
  })

  it('uses the aligned reference image size when requested size is auto', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await client.chat({
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,cmVmZXJlbmNl',
              sourceWidth: 2508,
              sourceHeight: 1295
            }
          ]
        }
      ],
      imageGenerationOptions: {
        enabled: true,
        outputFormat: 'png',
        size: 'auto',
        quality: 'high',
        background: 'auto'
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'auto',
        output_format: 'png',
        size: '2512x1296',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('pads wide reference image sizes to the image generation tool aspect and pixel budget limits', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await client.chat({
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,cmVmZXJlbmNl',
              sourceWidth: 1152,
              sourceHeight: 208
            }
          ]
        }
      ],
      imageGenerationOptions: {
        enabled: true,
        outputFormat: 'png',
        size: 'auto',
        quality: 'high',
        background: 'auto'
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'auto',
        output_format: 'png',
        size: '1776x592',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('uses auto image size when no dimensions are set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await client.chat({
      messages: [{ role: 'user', content: 'Generate an image of a cat.' }],
      imageGenerationOptions: {
        enabled: true,
        outputFormat: 'png',
        quality: 'high',
        background: 'auto'
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'generate',
        output_format: 'png',
        size: 'auto',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('pads explicit image generation sizes to the image generation tool aspect and pixel budget limits', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await client.chat({
      messages: [{ role: 'user', content: 'Generate a wide title banner.' }],
      imageGenerationOptions: {
        enabled: true,
        outputFormat: 'png',
        size: '1248x304',
        quality: 'high',
        background: 'auto'
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'generate',
        output_format: 'png',
        size: '1776x592',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('downscales square reference image sizes to the image generation tool pixel budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await client.chat({
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,cmVmZXJlbmNl',
              sourceWidth: 3840,
              sourceHeight: 3840
            }
          ]
        }
      ],
      imageGenerationOptions: {
        enabled: true,
        outputFormat: 'png',
        size: 'auto',
        quality: 'high',
        background: 'auto'
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'auto',
        output_format: 'png',
        size: '2880x2880',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('downscales explicit square image generation sizes to the image generation tool pixel budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await client.chat({
      messages: [{ role: 'user', content: 'Generate a square reference sheet.' }],
      imageGenerationOptions: {
        enabled: true,
        outputFormat: 'png',
        size: '3840x3840',
        quality: 'high',
        background: 'auto'
      }
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'generate',
        output_format: 'png',
        size: '2880x2880',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('forces image generation when the chat image mode is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'image_generation_call',
            result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'Please refine this design prompt.' }],
        imageGenerationOptions: {
          enabled: true,
          outputFormat: 'png',
          size: '3840x2160',
          quality: 'high',
          background: 'auto'
        }
      })
    ).resolves.toMatchObject({
      attachments: [expect.objectContaining({ type: 'image' })]
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'image_generation',
        action: 'generate',
        output_format: 'png',
        size: '3840x2160',
        quality: 'high',
        background: 'auto'
      })
    ])
  })

  it('appends web citations returned by the OpenAI Responses API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'latest answer',
                annotations: [
                  {
                    type: 'url_citation',
                    title: 'OpenAI Docs',
                    url: 'https://developers.openai.com/api/docs/guides/tools-web-search'
                  }
                ]
              }
            ]
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'today news' }] })
    ).resolves.toMatchObject({
      content: [
        'latest answer',
        'Sources:',
        '- OpenAI Docs: https://developers.openai.com/api/docs/guides/tools-web-search'
      ].join('\n')
    })
  })

  it('uploads attached files and enables OpenAI file search for official responses requests', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === 'https://api.openai.com/v1/files') {
        return {
          ok: true,
          json: async () => ({ id: 'file-1' })
        }
      }

      if (url === 'https://api.openai.com/v1/vector_stores') {
        return {
          ok: true,
          json: async () => ({ id: 'vs-1' })
        }
      }

      if (
        url === 'https://api.openai.com/v1/vector_stores/vs-1/files' &&
        String(init?.method || 'GET').toUpperCase() === 'POST'
      ) {
        return {
          ok: true,
          json: async () => ({ id: 'vsf-1', file_id: 'file-1', status: 'in_progress' })
        }
      }

      if (
        url === 'https://api.openai.com/v1/vector_stores/vs-1/files' &&
        String(init?.method || 'GET').toUpperCase() === 'GET'
      ) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'vsf-1', file_id: 'file-1', status: 'completed' }]
          })
        }
      }

      if (url === 'https://api.openai.com/v1/responses') {
        return {
          ok: true,
          json: async () => ({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'answer from files',
                    annotations: [
                      {
                        type: 'file_citation',
                        file_id: 'file-1',
                        filename: 'notes.md'
                      }
                    ]
                  }
                ]
              }
            ]
          })
        }
      }

      if (url === 'https://api.openai.com/v1/vector_stores/vs-1') {
        return {
          ok: true,
          json: async () => ({ id: 'vs-1', deleted: true })
        }
      }

      if (url === 'https://api.openai.com/v1/files/file-1') {
        return {
          ok: true,
          json: async () => ({ id: 'file-1', deleted: true })
        }
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'file',
                url: 'data:text/markdown;base64,IyBOb3Rlcwo=',
                fileName: 'notes.md',
                mimeType: 'text/markdown'
              }
            ]
          }
        ]
      })
    ).resolves.toMatchObject({
      content: ['answer from files', 'Sources:', '- File: notes.md'].join('\n')
    })

    const uploadCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === 'https://api.openai.com/v1/files'
    )
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData)

    const responsesCall = fetchMock.mock.calls.find(
      (call) => String(call[0]) === 'https://api.openai.com/v1/responses'
    )
    const requestBody = JSON.parse(String(responsesCall?.[1]?.body))
    expect(requestBody.input).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please analyze the attached files.'
          }
        ]
      }
    ])
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: 'file_search',
        vector_store_ids: ['vs-1']
      }),
      expect.objectContaining({
        type: 'web_search'
      })
    ])
    expect(requestBody.include).toEqual([
      'web_search_call.action.sources',
      'file_search_call.results'
    ])

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/vector_stores/vs-1',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/files/file-1',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('keeps Claude requests on a single /v1/messages endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'ok' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new ClaudeAPICli(
      'sk-test',
      'https://api.anthropic.com/v1/messages',
      'claude-3-5-sonnet'
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('keeps Gemini requests on a single generateContent endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new GeminiAPICli(
      'sk-test',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      'gemini-2.0-flash'
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(requestedUrl).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
    )
    expect(requestedUrl).not.toContain(':generateContent/models/')
  })

  it('normalizes Gemini model endpoints that omit :generateContent before appending the method', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new GeminiAPICli(
      'sk-test',
      'https://opencode.ai/zen/v1/models/gemini-3.1-pro',
      'gemini-3.1-pro'
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({
      content: 'ok'
    })
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain(
      'https://opencode.ai/zen/v1/models/gemini-3.1-pro:generateContent'
    )
  })

  it('routes OpenCode Zen GPT models to Responses without OpenAI-hosted tools', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ]
      })
    })

    const client = new OpencodeZenAPICli('zen-key', 'opencode.ai/zen/v1', 'opencode/gpt-5.5', {
      fetchImpl: fetchMock as typeof fetch
    })

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    const requestInit = fetchMock.mock.calls[0]?.[1]
    const requestBody = JSON.parse(String(requestInit?.body))
    expect(requestBody).toMatchObject({ model: 'gpt-5.5' })
    expect(requestBody).not.toHaveProperty('tools')
    expect(requestInit?.headers).toMatchObject({ Authorization: 'Bearer zen-key' })
  })

  it('routes OpenCode Zen Claude and Qwen models to Anthropic Messages with x-api-key auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'ok' }] })
    })

    const client = new OpencodeZenAPICli(
      'zen-key',
      'https://opencode.ai/zen/v1/messages',
      'qwen3.6-plus',
      {
        fetchImpl: fetchMock as typeof fetch
      }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/messages',
      expect.objectContaining({ method: 'POST' })
    )
    const requestInit = fetchMock.mock.calls[0]?.[1]
    expect(requestInit?.headers).toMatchObject({
      'x-api-key': 'zen-key',
      'anthropic-version': '2023-06-01'
    })
    expect(requestInit?.headers).not.toHaveProperty('Authorization')
  })

  it('routes OpenCode Zen Gemini models to Google generateContent with x-goog-api-key auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    })

    const client = new OpencodeZenAPICli(
      'zen-key',
      'https://opencode.ai/zen/v1/models/gemini-3.1-pro',
      'gemini-3.1-pro',
      { fetchImpl: fetchMock as typeof fetch }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })

    const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(requestedUrl).toBe('https://opencode.ai/zen/v1/models/gemini-3.1-pro:generateContent')
    expect(requestedUrl).not.toContain('key=')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-goog-api-key': 'zen-key' })
  })

  it('routes OpenCode Zen OpenAI-compatible models to chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    })

    const client = new OpencodeZenAPICli(
      'zen-key',
      'https://opencode.ai/zen/v1/chat/completions',
      'glm-5.1',
      {
        fetchImpl: fetchMock as typeof fetch
      }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] })
    ).resolves.toMatchObject({ content: 'ok' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('collects included web-search sources even when the message has no annotations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'web_search_call',
            action: {
              sources: [
                {
                  title: 'OpenAI Docs',
                  url: 'https://developers.openai.com/api/docs/guides/tools-web-search'
                }
              ]
            }
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'latest answer' }]
          }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli('sk-test', 'https://api.openai.com/v1', 'gpt-5.4')

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'today news' }] })
    ).resolves.toMatchObject({
      content: [
        'latest answer',
        'Sources:',
        '- OpenAI Docs: https://developers.openai.com/api/docs/guides/tools-web-search'
      ].join('\n')
    })
  })

  it('surfaces nested fetch failure details for OpenAI-compatible requests', async () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT 198.18.0.221:443'), {
      code: 'ETIMEDOUT'
    })
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenAIAPICli(
      'sk-test',
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini'
    )

    await expect(client.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(
      /ETIMEDOUT/
    )
    await expect(client.chat({ messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(
      /198\.18\.0\.221/
    )
  })
})
