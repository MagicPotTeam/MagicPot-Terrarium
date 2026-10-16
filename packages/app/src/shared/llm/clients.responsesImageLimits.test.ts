import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import {
  buildOpenAIResponsesInput,
  DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY,
  validateOpenAIResponsesImages
} from './openaiResponses'
import type { ChatMessage } from './types'

const formerImageLimit = 10
const formerDecodedBytesPerImage = 8 * 1024 * 1024
const formerAggregateDecodedBytes = 11 * 1024 * 1024
const formerRequestBodyBytes = 16 * 1024 * 1024
const image = (index: number) => ({
  type: 'image' as const,
  url: `https://owned.example/reference-${index}.png`
})
const turn = (count: number): ChatMessage => ({
  role: 'user',
  content: 'Analyze the selected references.',
  attachments: Array.from({ length: count }, (_, index) => image(index))
})
const providerResponse = () =>
  new Response(
    JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Owned fixture answer.' }] }
      ]
    }),
    { headers: { 'content-type': 'application/json' } }
  )

afterEach(() => vi.unstubAllGlobals())

describe('Responses image count preflight before every provider operation', () => {
  it('defaults all application image limits to unlimited', () => {
    expect(DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY).toEqual({
      maxImages: Infinity,
      maxDecodedBytesPerImage: Infinity,
      maxAggregateDecodedBytes: Infinity,
      maxPixelsPerImage: Infinity,
      maxRequestBodyBytes: Infinity
    })
    expect(() => buildOpenAIResponsesInput([turn(formerImageLimit + 1)])).not.toThrow()
  })

  it.each(['responses', 'auto'] as const)(
    'rejects %s before the model fetch or reference loader',
    async (apiMode) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse())
      const imageAttachmentLoader = vi.fn(async () => ({ blob: new Blob(['owned']) }))
      const client = new OpenAIAPICli(
        'owned-no-credential',
        'https://api.openai.com/v1',
        'opaque',
        {
          apiMode,
          fetchImpl,
          imageAttachmentLoader
        }
      )
      await expect(client.chat({ messages: [turn(formerImageLimit + 1)] })).resolves.toMatchObject({
        content: 'Owned fixture answer.'
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(imageAttachmentLoader).not.toHaveBeenCalled()
    }
  )

  it('rejects before hosted file search can upload or fetch a file', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('Owned denied network probe'))
    const globalFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('Owned denied global fetch'))
    vi.stubGlobal('fetch', globalFetch)
    const message = turn(formerImageLimit + 1)
    message.attachments!.push({
      type: 'file',
      url: 'https://owned.example/context.txt',
      fileName: 'context.txt',
      mimeType: 'text/plain'
    })
    const client = new OpenAIAPICli('owned-no-credential', 'https://api.openai.com/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl,
      enableHostedTools: true
    })
    await expect(client.chat({ messages: [message] })).rejects.toThrow(
      'OpenAI file search requires materialized base64 data URLs'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('validates selected Responses image bytes before hosted file search', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('Owned network probe'))
    const message = turn(2)
    for (const attachment of message.attachments || []) {
      attachment.sizeBytes = formerDecodedBytesPerImage
    }
    message.attachments!.push({
      type: 'file',
      url: 'https://owned.example/context.txt',
      fileName: 'context.txt',
      mimeType: 'text/plain'
    })
    const client = new OpenAIAPICli('owned-no-credential', 'https://api.openai.com/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl,
      enableHostedTools: true
    })

    await expect(client.chat({ messages: [message] })).rejects.toThrow(
      'OpenAI file search requires materialized base64 data URLs'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows a selected data URL above the former 8 MiB download cap', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    const imageAttachmentLoader = vi.fn(async () => ({
      blob: new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/png' })
    }))
    const client = new OpenAIAPICli('', 'https://owned.example/v1', 'opaque', {
      apiMode: 'images',
      fetchImpl,
      imageAttachmentLoader
    })
    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: 'Edit this large selected image.',
            attachments: [{ type: 'image', url: 'https://owned.example/large.png' }]
          }
        ],
        imageGenerationOptions: { action: 'edit' }
      })
    ).resolves.toMatchObject({ attachments: [expect.objectContaining({ type: 'image' })] })
    expect(imageAttachmentLoader).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized final Responses body before provider fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse())
    const client = new OpenAIAPICli('', 'https://owned.example/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl,
      enableHostedTools: false
    })
    const content = 'x'.repeat(formerRequestBodyBytes)

    await expect(client.chat({ messages: [{ role: 'user', content }] })).resolves.toMatchObject({
      content: 'Owned fixture answer.'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('allows an oversized Responses input through the default body preflight', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse())
    const client = new OpenAIAPICli('', 'https://owned.example/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl,
      enableHostedTools: false
    })
    const content = 'x'.repeat(formerRequestBodyBytes)
    await expect(client.chat({ messages: [{ role: 'user', content }] })).resolves.toMatchObject({
      content: 'Owned fixture answer.'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('preserves Responses HTTP reference serialization without downloading it locally', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse())
    const imageAttachmentLoader = vi.fn()
    const client = new OpenAIAPICli('', 'https://owned.example/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl,
      imageAttachmentLoader
    })
    await client.chat({
      messages: [
        {
          role: 'user',
          content: 'Describe.',
          attachments: [
            {
              type: 'image',
              url: 'http://owned.example/reference.png'
            }
          ]
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(imageAttachmentLoader).not.toHaveBeenCalled()
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.input[0].content).toContainEqual({
      type: 'input_image',
      image_url: 'http://owned.example/reference.png'
    })
  })

  it('counts the selected history together instead of allowing maxImages per turn', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse())
    const client = new OpenAIAPICli('', 'https://owned.example/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl
    })
    await expect(
      client.chat({ messages: [turn(formerImageLimit), turn(1)], imageHistoryPolicy: 'all' })
    ).resolves.toMatchObject({ content: 'Owned fixture answer.' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('checks the whole image count before inspecting any reference URL', () => {
    const messages = [turn(formerImageLimit + 1)]
    messages[0].attachments![0].url = 'owned-not-an-image-url'
    expect(() => buildOpenAIResponsesInput(messages)).toThrow(
      'OpenAI Responses image attachments must use an HTTP(S) URL or a base64 data:image URL.'
    )
    expect(() => validateOpenAIResponsesImages(messages)).toThrow(
      'Images must be supported base64 data URLs or public HTTP(S) URLs.'
    )
  })

  it('accepts the exact boundary and sends all permitted references once', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse())
    const client = new OpenAIAPICli('', 'https://owned.example/v1', 'opaque', {
      apiMode: 'responses',
      fetchImpl
    })
    await expect(client.chat({ messages: [turn(formerImageLimit)] })).resolves.toMatchObject({
      content: 'Owned fixture answer.'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(
      body.input[0].content.filter((item: { type: string }) => item.type === 'input_image')
    ).toHaveLength(formerImageLimit)
  })

  it('preserves assistant text and exposes assistant images as a user reference block', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Generated image result',
        attachments: [{ type: 'image', url: 'https://owned.example/generated.png' }]
      }
    ]
    const result = buildOpenAIResponsesInput(messages, { imageHistory: 'all' })
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Generated image result' }]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Reference image(s) from the previous assistant response:' },
          { type: 'input_image', image_url: 'https://owned.example/generated.png' }
        ]
      }
    ])
  })

  it('does not count omitted old or non-user images, and leaves source messages unchanged', () => {
    const messages: ChatMessage[] = [
      turn(formerImageLimit + 1),
      { ...turn(formerImageLimit + 1), role: 'assistant' },
      { ...turn(formerImageLimit + 1), role: 'system' },
      turn(1)
    ]
    const before = JSON.stringify(messages)
    const result = buildOpenAIResponsesInput(messages, { imageHistory: 'latest-user-turn' })
    expect(
      result.flatMap((message) => message.content).filter((item) => item.type === 'input_image')
    ).toHaveLength(1)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it.each([NaN, -1, 1.5])('rejects invalid maxImages policy %s without a bypass', (maxImages) => {
    expect(() =>
      validateOpenAIResponsesImages([turn(1)], {
        ...DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY,
        maxImages
      })
    ).toThrow('Invalid image count limit.')
  })

  it('respects an explicit zero-image policy', () => {
    const policy = { ...DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY, maxImages: 0 }
    expect(validateOpenAIResponsesImages([turn(0)], policy)).toEqual({
      imageCount: 0,
      decodedBytes: 0
    })
    expect(() => validateOpenAIResponsesImages([turn(1)], policy)).toThrow(
      'Too many images; the limit is 0.'
    )
  })
})
