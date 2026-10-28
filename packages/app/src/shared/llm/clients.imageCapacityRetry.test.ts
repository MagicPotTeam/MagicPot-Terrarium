import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { LLMChatParams, LLMDeltaEvent } from './types'

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const message = 'Our servers are currently overloaded. Please try again later.'
const progress = [
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'image-request', type: 'image_generation_call', status: 'in_progress' }
  },
  { type: 'response.image_generation_call.in_progress', item_id: 'image-request' },
  { type: 'response.image_generation_call.generating', item_id: 'image-request' }
]
const failed = (output?: unknown) => ({
  type: 'response.failed',
  response: {
    status: 'failed',
    error: { type: 'server_error', code: 'server_overloaded', message },
    ...(output === undefined ? {} : { output })
  }
})
const completed = {
  type: 'response.completed',
  response: {
    status: 'completed',
    output: [{ type: 'image_generation_call', result: pngBase64 }]
  }
}
const sse = (events: unknown[], headers: Record<string, string> = {}) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', ...headers }
  })
const imageClient = (fetchImpl: typeof fetch, imageGeneration = true) =>
  new OpenAIAPICli('owned-key', 'https://owned-proxy.test/v1', 'owned-model', {
    modelUse: imageGeneration ? 'image' : 'agent',
    callType: 'cliproxyapi',
    apiMode: 'responses',
    forceStreaming: true,
    enableHostedTools: false,
    requestTimeoutMs: 1_000,
    fetchImpl
  })
const imageParams = (): LLMChatParams => ({
  retryCapacity: true,
  imageGenerationOptions: { enabled: true, action: 'edit', outputFormat: 'png' },
  messages: [
    {
      role: 'user',
      content: 'Edit these references.',
      attachments: Array.from({ length: 4 }, (_, index) => ({
        type: 'image',
        fileName: `reference-${index}.png`,
        url: `data:image/png;base64,${pngBase64}`
      }))
    }
  ]
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Responses image overload retries', () => {
  it.each(['absent', 'empty'] as const)(
    'keeps retrying after image progress and %s failed output, without losing image context',
    async (outputMode) => {
      const controller = new AbortController()
      let calls = 0
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          ++calls <= 15
            ? sse([...progress, failed(outputMode === 'empty' ? [] : undefined)])
            : sse([completed])
        )
      const events: LLMDeltaEvent[] = []
      const params = imageParams()
      const originalMessages = structuredClone(params.messages)
      const observed = imageClient(fetcher)
        .chat({ ...params, signal: controller.signal, onDelta: (event) => events.push(event) })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        )
      for (let attempt = 0; attempt < 17; attempt++) await vi.advanceTimersByTimeAsync(60_000)
      controller.abort()

      expect(await observed).toMatchObject({
        result: {
          content: '',
          attachments: [
            expect.objectContaining({ type: 'image', url: `data:image/png;base64,${pngBase64}` })
          ]
        }
      })
      expect(fetcher).toHaveBeenCalledTimes(16)
      const bodies = fetcher.mock.calls.map((call) => call[1]?.body)
      expect(new Set(bodies).size).toBe(1)
      const keys = fetcher.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get('idempotency-key')
      )
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      const body = JSON.parse(String(bodies[0]))
      expect(body.tool_choice).toBe('auto')
      expect(body.stream).toBe(true)
      expect(
        body.input[0].content.filter((part: { type?: string }) => part.type === 'input_image')
      ).toHaveLength(4)
      expect(params.messages).toEqual(originalMessages)
      const waits = events.filter((event) => event.type === 'retry' && event.retry!.delayMs > 0)
      expect(waits).toHaveLength(15)
      expect(waits.map((event) => event.retry!.attempt)).toEqual(
        Array.from({ length: 15 }, (_, index) => index + 1)
      )
      expect(
        waits.every(
          (event) =>
            event.retry!.reason === 'server-overloaded' &&
            event.retry!.delayMs >= 2_000 &&
            event.retry!.delayMs <= 60_000
        )
      ).toBe(true)
      expect(events.every((event) => event.type === 'retry')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('honors SSE Retry-After and stops its persistent wait immediately on user cancellation', async () => {
    const controller = new AbortController()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => sse([...progress, failed([])], { 'retry-after': '90' }))
    const events: LLMDeltaEvent[] = []
    const observed = imageClient(fetcher)
      .chat({
        ...imageParams(),
        signal: controller.signal,
        onDelta: (event) => events.push(event)
      })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events[0]?.retry?.delayMs).toBe(90_000)
    expect(fetcher).toHaveBeenCalledOnce()
    const reason = new DOMException('Stopped by user', 'AbortError')
    controller.abort(reason)
    expect(await observed).toBe(reason)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries an agent image request with empty output placeholders but no produced output', async () => {
    const controller = new AbortController()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sse([
          ...progress,
          { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
          {
            type: 'response.output_item.added',
            item: { type: 'message', content: [{ type: 'output_text', text: '' }] }
          },
          failed([])
        ])
      )
      .mockResolvedValueOnce(sse([completed]))
    const observed = imageClient(fetcher, false)
      .chat({ ...imageParams(), signal: controller.signal })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
    await vi.advanceTimersByTimeAsync(2_000)
    controller.abort()
    expect(await observed).toMatchObject({
      result: { attachments: [expect.objectContaining({ type: 'image' })] }
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  const unsafeEvents: Array<[string, Record<string, unknown>]> = [
    ['text delta', { type: 'response.output_text.delta', delta: 'partial answer' }],
    ['text done', { type: 'response.output_text.done', text: 'completed answer' }],
    ['refusal done', { type: 'response.refusal.done', refusal: 'Not permitted' }],
    [
      'refusal part',
      { type: 'response.content_part.done', part: { type: 'refusal', refusal: 'Not permitted' } }
    ],
    [
      'text content part',
      { type: 'response.content_part.done', part: { type: 'output_text', text: 'partial answer' } }
    ],
    [
      'added text part',
      { type: 'response.content_part.added', part: { type: 'output_text', text: 'partial answer' } }
    ],
    [
      'added image part',
      {
        type: 'response.content_part.added',
        part: { type: 'output_image', image_url: `data:image/png;base64,${pngBase64}` }
      }
    ],
    [
      'added refusal part',
      { type: 'response.content_part.added', part: { type: 'refusal', refusal: 'Not permitted' } }
    ],
    [
      'added message with text',
      {
        type: 'response.output_item.added',
        item: { type: 'message', content: [{ type: 'output_text', text: 'partial answer' }] }
      }
    ],
    [
      'added message with image',
      {
        type: 'response.output_item.added',
        item: {
          type: 'message',
          content: [{ type: 'output_image', image_url: `data:image/png;base64,${pngBase64}` }]
        }
      }
    ],
    [
      'added message with refusal',
      {
        type: 'response.output_item.added',
        item: { type: 'message', content: [{ type: 'refusal', refusal: 'Not permitted' }] }
      }
    ],
    [
      'partial image',
      { type: 'response.image_generation_call.partial_image', partial_image_b64: pngBase64 }
    ],
    ['completed image', { type: 'response.image_generation_call.completed' }],
    [
      'completed image item',
      {
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', status: 'completed' }
      }
    ],
    [
      'in-progress image with a result',
      {
        type: 'response.output_item.added',
        item: { type: 'image_generation_call', status: 'in_progress', result: pngBase64 }
      }
    ],
    ['unknown image stage', { type: 'response.image_generation_call.unknown' }],
    ['web search', { type: 'response.web_search_call.in_progress' }],
    ['file search', { type: 'response.file_search_call.in_progress' }],
    ['code interpreter', { type: 'response.code_interpreter_call.in_progress' }],
    [
      'function call',
      { type: 'response.output_item.added', item: { type: 'function_call', name: 'files.write' } }
    ],
    ['function arguments', { type: 'response.function_call_arguments.delta', delta: '{' }],
    ['custom tool input', { type: 'response.custom_tool_call_input.delta', delta: 'write file' }],
    ['MCP call', { type: 'response.mcp_call.in_progress' }]
  ]

  const expectNoReplay = async (
    response: Response,
    params = imageParams(),
    clientImageGeneration = true
  ) => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    const observed = imageClient(fetcher, clientImageGeneration)
      .chat({ ...params, signal: controller.signal, onDelta: () => {} })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_100)
    controller.abort()
    expect(await observed).toMatchObject({ retryBlocked: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  }

  it.each(unsafeEvents)(
    'does not replay failed image generation after %s',
    async (_name, event) => {
      await expectNoReplay(sse([...progress, event, failed([])]))
    }
  )

  it.each([
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'terminal output' }] }] },
    { output: [{ type: 'image_generation_call', result: pngBase64 }] },
    { output: [{ type: 'image_generation_call', status: 'failed' }] },
    { output: [{ type: 'unknown_output', value: 'must not be discarded' }] },
    { output: 'malformed output' }
  ])('does not replay a failed envelope containing output %#', async ({ output }) => {
    await expectNoReplay(sse([...progress, failed(output)]))
  })

  it('does not replay terminal-only output or a direct output_text field', async () => {
    await expectNoReplay(sse([failed([{ type: 'image_generation_call', result: pngBase64 }])]))
    await expectNoReplay(
      sse([
        ...progress,
        {
          ...failed([]),
          response: { ...failed([]).response, output_text: 'terminal output' }
        }
      ])
    )
  })

  it('does not apply the image-progress exception to a non-image request', async () => {
    await expectNoReplay(
      sse([...progress, failed([])]),
      { messages: [], retryCapacity: true },
      false
    )
  })

  it('requires failed status rather than an inconsistent in-progress terminal response', async () => {
    await expectNoReplay(
      sse([
        ...progress,
        { ...failed([]), response: { ...failed([]).response, status: 'in_progress' } }
      ])
    )
  })

  it.each(['bare-error', 'eof', 'timeout'] as const)(
    'does not replay ambiguous %s after image progress',
    async (kind) => {
      const response =
        kind === 'timeout'
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      progress.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
                    )
                  )
                }
              }),
              { headers: { 'content-type': 'text/event-stream' } }
            )
          : sse([
              ...progress,
              ...(kind === 'bare-error'
                ? [{ type: 'error', error: { code: 'server_overloaded', message } }]
                : [])
            ])
      await expectNoReplay(response)
    }
  )

  it.each([
    'invalid_api_key',
    'invalid_request_error',
    'content_policy_violation',
    'insufficient_quota'
  ])('never turns permanent %s into persistent image retries', async (code) => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      sse([
        ...progress,
        {
          type: 'response.failed',
          response: { status: 'failed', error: { type: code, code, message } }
        }
      ])
    )
    const observed = imageClient(fetcher)
      .chat({ ...imageParams(), signal: controller.signal })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_100)
    controller.abort()
    expect(await observed).toMatchObject({ providerError: { code } })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
