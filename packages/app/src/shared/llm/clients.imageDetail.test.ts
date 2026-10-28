import { describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { ChatAttachment, ChatMessage, LLMImageHistoryPolicy } from './types'

const apiModes = ['responses', 'chat-completions'] as const
type ApiMode = (typeof apiModes)[number]
type RequestMessage = { role: string; content: string | Record<string, unknown>[] }

const captureRequest = async (
  apiMode: ApiMode,
  messages: ChatMessage[],
  imageHistoryPolicy: LLMImageHistoryPolicy = 'all'
): Promise<RequestMessage[]> => {
  const response =
    apiMode === 'responses'
      ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }
      : { choices: [{ message: { content: 'ok' } }] }
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' }
    })
  )
  const client = new OpenAIAPICli('', 'https://provider.example.test/v1', 'vision-model', {
    apiMode,
    enableHostedTools: false,
    fetchImpl: fetchMock
  })

  await expect(client.chat({ messages, imageHistoryPolicy })).resolves.toMatchObject({
    content: 'ok'
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
  return apiMode === 'responses' ? body.input : body.messages
}

const imageParts = (messages: RequestMessage[]) =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'input_image' || part.type === 'image_url')
      : []
  )

describe.each(apiModes)('%s input image detail', (apiMode) => {
  it.each(['user', 'assistant'] as const)(
    'serializes only the explicit low opt-in from %s attachments',
    async (role) => {
      const low: ChatAttachment = {
        type: 'image',
        url: 'https://images.example.test/low.png',
        imageDetail: 'low'
      }
      const omitted: ChatAttachment = {
        type: 'image',
        url: 'https://images.example.test/default.png'
      }
      const invalidDetails: unknown[] = [
        undefined,
        null,
        '',
        'auto',
        'high',
        'LOW',
        ' low ',
        false,
        0,
        { detail: 'low' }
      ]
      const invalid = invalidDetails.map((imageDetail, index): ChatAttachment => ({
        type: 'image',
        url: `https://images.example.test/invalid-${index}.png`,
        imageDetail: imageDetail as ChatAttachment['imageDetail']
      }))
      const messages: ChatMessage[] = [
        { role, content: 'Inspect selected elements.', attachments: [low, omitted, ...invalid] }
      ]
      const original = structuredClone(messages)

      const serialized = await captureRequest(apiMode, messages)

      expect(imageParts(serialized)).toEqual([
        apiMode === 'responses'
          ? { type: 'input_image', image_url: low.url, detail: 'low' }
          : { type: 'image_url', image_url: { url: low.url, detail: 'low' } },
        ...[omitted, ...invalid].map((attachment) =>
          apiMode === 'responses'
            ? { type: 'input_image', image_url: attachment.url }
            : { type: 'image_url', image_url: { url: attachment.url } }
        )
      ])
      expect(messages).toEqual(original)
      if (role === 'assistant') {
        expect(serialized[0]).toEqual({
          role: 'assistant',
          content:
            apiMode === 'responses'
              ? [{ type: 'output_text', text: 'Inspect selected elements.' }]
              : 'Inspect selected elements.'
        })
        expect(serialized[1].role).toBe('user')
      }
    }
  )

  it('does not retain a low-detail historical image outside the selected image history', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'Earlier context',
        attachments: [
          { type: 'image', url: 'https://images.example.test/old.png', imageDetail: 'low' }
        ]
      },
      {
        role: 'user',
        content: 'Current context',
        attachments: [{ type: 'image', url: 'https://images.example.test/current.png' }]
      }
    ]

    const serialized = await captureRequest(apiMode, messages, 'latest-user-turn')

    expect(imageParts(serialized)).toEqual([
      apiMode === 'responses'
        ? { type: 'input_image', image_url: 'https://images.example.test/current.png' }
        : { type: 'image_url', image_url: { url: 'https://images.example.test/current.png' } }
    ])
  })
})
