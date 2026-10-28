import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from '../../shared/llm/clients'

const messages = [{ role: 'user' as const, content: 'Owned streaming fixture.' }]
const encodeEvent = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`
const eventResponse = (events: unknown[]) => {
  const bytes = new TextEncoder().encode(
    ': owned heartbeat\r\n\r\n' + events.map(encodeEvent).join('')
  )
  // Exercise delimiter and UTF-8 boundaries rather than delivering whole JSON events.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7)
        controller.enqueue(bytes.slice(offset, offset + 7))
      controller.close()
    }
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
const client = (mode: 'responses' | 'chat-completions', response: Response) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
  const cli = new OpenAIAPICli(
    '',
    mode === 'responses' ? 'https://owned.example/v1' : 'https://owned.example/v1/chat/completions',
    'owned-model',
    {
      apiMode: mode,
      enableHostedTools: false,
      fetchImpl
    }
  )
  return { cli, fetchImpl }
}
const completion = (text: string | null, finish: string | null = null) => ({
  choices: [{ index: 0, delta: text === null ? {} : { content: text }, finish_reason: finish }]
})
const responseFinal = {
  id: 'resp-owned',
  status: 'completed',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好, owned' }] }
  ],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
}

afterEach(() => vi.restoreAllMocks())

describe('standard OpenAI incremental streaming contract', () => {
  it('streams fragmented chat-completion text and keeps usage arriving after finish_reason', async () => {
    const { cli, fetchImpl } = client(
      'chat-completions',
      eventResponse([
        completion('你好'),
        completion(', owned'),
        completion(null, 'stop'),
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
        '[DONE]'
      ])
    )
    const onDelta = vi.fn()
    await expect(cli.chat({ messages, onDelta })).resolves.toMatchObject({
      content: '你好, owned',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }
    })
    expect(onDelta.mock.calls.map(([event]) => event)).toEqual([
      {
        type: 'text-delta',
        delta: '你好',
        metadata: { streaming: { upstreamProtocol: 'sse', upstreamIncremental: true } }
      },
      {
        type: 'text-delta',
        delta: ', owned',
        metadata: { streaming: { upstreamProtocol: 'sse', upstreamIncremental: true } }
      }
    ])
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('streams Responses text and normalizes the authoritative completed response without replaying deltas', async () => {
    const { cli, fetchImpl } = client(
      'responses',
      eventResponse([
        { type: 'response.created', response: { id: 'resp-owned', status: 'in_progress' } },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-owned',
          output_index: 0,
          content_index: 0,
          delta: '你好'
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-owned',
          output_index: 0,
          content_index: 0,
          delta: ', owned'
        },
        { type: 'response.completed', response: responseFinal }
      ])
    )
    const onDelta = vi.fn()
    await expect(cli.chat({ messages, onDelta })).resolves.toMatchObject({
      content: '你好, owned',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }
    })
    expect(onDelta.mock.calls.map(([event]) => event.delta)).toEqual(['你好', ', owned'])
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).stream).toBe(true)
  })

  it('retains a completed Responses image result when a streaming callback was requested', async () => {
    const { cli } = client(
      'responses',
      eventResponse([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'image_generation_call',
                result: 'aW1hZ2U=',
                output_format: 'png'
              }
            ]
          }
        }
      ])
    )
    await expect(cli.chat({ messages, onDelta: vi.fn() })).resolves.toMatchObject({
      content: '',
      attachments: [
        expect.objectContaining({ type: 'image', url: 'data:image/png;base64,aW1hZ2U=' })
      ]
    })
  })

  it.each(['responses', 'chat-completions'] as const)(
    'rejects truncated %s SSE instead of promoting partial output to success',
    async (mode) => {
      const delta =
        mode === 'responses'
          ? { type: 'response.output_text.delta', delta: 'partial' }
          : completion('partial')
      const { cli } = client(mode, eventResponse([delta]))
      const onDelta = vi.fn()
      await expect(cli.chat({ messages, onDelta })).rejects.toThrow(
        /incomplete|before.*(?:completion|terminal)/i
      )
      expect(onDelta).toHaveBeenCalledWith({
        type: 'text-delta',
        delta: 'partial',
        metadata: { streaming: { upstreamProtocol: 'sse', upstreamIncremental: true } }
      })
    }
  )

  it('propagates a terminal Responses failure after delivering prior text', async () => {
    const { cli } = client(
      'responses',
      eventResponse([
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.failed',
          response: { error: { code: 'owned_error', message: 'owned failure detail' } }
        }
      ])
    )
    const onDelta = vi.fn()
    await expect(cli.chat({ messages, onDelta })).rejects.toThrow('owned failure detail')
    expect(onDelta).toHaveBeenCalledTimes(1)
  })

  it.each(['responses', 'chat-completions'] as const)(
    'supports bounded JSON fallback for a %s endpoint that ignores stream:true',
    async (mode) => {
      const payload =
        mode === 'responses'
          ? responseFinal
          : { choices: [{ message: { content: '你好, owned' } }] }
      const { cli } = client(mode, Response.json(payload))
      const onDelta = vi.fn()
      await expect(cli.chat({ messages, onDelta })).resolves.toMatchObject({
        content: '你好, owned'
      })
      expect(onDelta).toHaveBeenCalledTimes(1)
      expect(onDelta).toHaveBeenCalledWith({
        type: 'text-delta',
        delta: '你好, owned',
        metadata: {
          streaming: {
            upstreamProtocol: 'json',
            upstreamIncremental: false,
            fallbackReason: 'upstream-json'
          }
        }
      })
    }
  )

  it.each([false, true])(
    'retains every image with mixed chat content (stream=%s)',
    async (stream) => {
      const parts = [
        { type: 'text', text: 'Two owned images.' },
        { type: 'image_url', image_url: { url: 'https://owned.example/one.png' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }
      ]
      const response = stream
        ? eventResponse([
            { choices: [{ index: 0, delta: { content: parts }, finish_reason: 'stop' }] },
            '[DONE]'
          ])
        : Response.json({ choices: [{ message: { content: parts } }] })
      const { cli } = client('chat-completions', response)
      const onDelta = stream ? vi.fn() : undefined
      await expect(cli.chat({ messages, onDelta })).resolves.toMatchObject({
        content: 'Two owned images.',
        attachments: [
          { type: 'image', url: 'https://owned.example/one.png' },
          { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }
        ]
      })
      if (onDelta)
        expect(onDelta).toHaveBeenCalledWith({
          type: 'text-delta',
          delta: 'Two owned images.',
          metadata: { streaming: { upstreamProtocol: 'sse', upstreamIncremental: true } }
        })
    }
  )

  it('returns an explicit tool-call finish rather than failing on an empty text result', async () => {
    const { cli } = client(
      'chat-completions',
      eventResponse([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-owned',
                    type: 'function',
                    function: { name: 'owned', arguments: '{}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        },
        '[DONE]'
      ])
    )
    await expect(cli.chat({ messages, onDelta: vi.fn() })).resolves.toMatchObject({
      content: '',
      finishReason: 'tool_call',
      metadata: {
        toolCalls: [
          { id: 'call-owned', type: 'function', function: { name: 'owned', arguments: '{}' } }
        ]
      }
    })
  })

  it.each([false, true])(
    'retains tool invocation data alongside text and optional images (%s)',
    async (images) => {
      const tool = {
        index: 0,
        id: 'call-owned',
        type: 'function',
        function: { name: 'owned', arguments: '{}' }
      }
      const { cli } = client(
        'chat-completions',
        eventResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  content: 'Calling tool.',
                  tool_calls: [tool],
                  ...(images
                    ? {
                        images: [
                          { type: 'image_url', image_url: { url: 'https://owned.example/one.png' } }
                        ]
                      }
                    : {})
                },
                finish_reason: 'tool_calls'
              }
            ]
          },
          '[DONE]'
        ])
      )
      await expect(cli.chat({ messages, onDelta: vi.fn() })).resolves.toMatchObject({
        content: 'Calling tool.',
        finishReason: 'tool_call',
        metadata: {
          toolCalls: [
            { id: 'call-owned', type: 'function', function: { name: 'owned', arguments: '{}' } }
          ]
        },
        ...(images
          ? { attachments: [{ type: 'image', url: 'https://owned.example/one.png' }] }
          : {})
      })
    }
  )

  it('returns empty token-limit Responses output with usage rather than an invalid-content error', async () => {
    const { cli } = client(
      'responses',
      eventResponse([
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
            usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 }
          }
        }
      ])
    )
    await expect(cli.chat({ messages, onDelta: vi.fn() })).resolves.toMatchObject({
      content: '',
      finishReason: 'length',
      usage: { totalTokens: 12 }
    })
  })

  it('preserves a thrown callback error while disposing the real reader', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              encodeEvent({ type: 'response.output_text.delta', delta: 'owned' })
            )
          )
        },
        cancel
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
    const { cli } = client('responses', response)
    const failure = { type: 'owned-callback-failure' }
    await expect(
      cli.chat({
        messages,
        onDelta: () => {
          throw failure
        }
      })
    ).rejects.toBe(failure)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it('keeps ordinary JSON/nonstream behavior when no callback is supplied', async () => {
    const { cli, fetchImpl } = client(
      'chat-completions',
      Response.json({ choices: [{ message: { content: 'owned' } }] })
    )
    await expect(cli.chat({ messages })).resolves.toMatchObject({ content: 'owned' })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).stream).toBe(false)
  })
})
