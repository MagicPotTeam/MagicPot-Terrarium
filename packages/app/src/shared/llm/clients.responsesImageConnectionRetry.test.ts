import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli } from './clients'
import type { LLMChatParams, LLMDeltaEvent } from './types'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const closed = () => new Error('net::ERR_CONNECTION_CLOSED')
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
const payload = { status: 'completed', output: [{ type: 'image_generation_call', result: png }] }
const success = (stream: boolean) =>
  stream
    ? new Response(frame({ type: 'response.completed', response: payload }), {
        headers: { 'content-type': 'text/event-stream' }
      })
    : Response.json(payload)
const params = (): LLMChatParams => ({
  retryCapacity: true,
  imageGenerationOptions: { enabled: true, action: 'edit', outputFormat: 'png' },
  messages: [
    {
      role: 'user',
      content: 'Remove the two marked characters.',
      attachments: [
        { type: 'image', fileName: 'reference.png', url: `data:image/png;base64,${png}` }
      ]
    }
  ]
})
const client = (fetchImpl: typeof fetch, stream = true) =>
  new OpenAIAPICli('owned-key', 'https://owned-image-gateway.test/v1', 'owned-image-model', {
    modelUse: 'image',
    apiMode: 'responses',
    enableHostedTools: false,
    forceStreaming: stream,
    fetchImpl,
    requestTimeoutMs: 1000
  })
const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Responses image edit connection retry', () => {
  it.each([true, false])(
    'keeps the original image and request identity after twelve closes (stream=%s)',
    async (stream) => {
      let calls = 0
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (++calls <= 12) throw closed()
        return success(stream)
      })
      const input = params()
      const original = structuredClone(input)
      const events: LLMDeltaEvent[] = []
      const result = observe(
        client(fetcher, stream).chat({
          ...input,
          ...(stream ? { onDelta: (event: LLMDeltaEvent) => events.push(event) } : {})
        })
      )
      for (let index = 0; index < 13; index++) await vi.advanceTimersByTimeAsync(60000)
      expect((await result).error).toBeUndefined()
      expect((await result).value?.attachments).toEqual([
        expect.objectContaining({ type: 'image', url: `data:image/png;base64,${png}` })
      ])
      expect(fetcher).toHaveBeenCalledTimes(13)
      const bodies = fetcher.mock.calls.map((call) => String(call[1]?.body))
      expect(new Set(bodies).size).toBe(1)
      const body = JSON.parse(bodies[0])
      expect(body.input[0].content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'input_image',
            image_url: `data:image/png;base64,${png}`
          })
        ])
      )
      expect(body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'image_generation', action: 'edit' })
        ])
      )
      const keys = fetcher.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get('Idempotency-Key')
      )
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      expect(input).toEqual(original)
      if (stream) {
        const waits = events.filter((event) => event.type === 'retry' && event.retry!.delayMs > 0)
        expect(waits).toHaveLength(12)
        expect(waits.every((event) => event.retry?.reason === 'connection-error')).toBe(true)
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not stop after a finite retry budget and cancels without another submission', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(closed())
    let settled = false
    const result = observe(client(fetcher).chat({ ...params(), signal: controller.signal })).then(
      (value) => {
        settled = true
        return value
      }
    )
    await vi.advanceTimersByTimeAsync(600000)
    expect(settled).toBe(false)
    expect(fetcher.mock.calls.length).toBeGreaterThan(10)
    const count = fetcher.mock.calls.length
    controller.abort()
    expect((await result).error).toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(600000)
    expect(fetcher).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['no-output', 'image-started', 'partial-image', 'text', 'hosted-tool'] as const)(
    'preserves the no-replay boundary after %s in a broken stream',
    async (kind) => {
      let source!: ReadableStreamDefaultController<Uint8Array>
      const initial =
        kind === 'image-started'
          ? { type: 'response.image_generation_call.in_progress', item_id: 'owned-image' }
          : kind === 'partial-image'
            ? { type: 'response.image_generation_call.partial_image', partial_image_b64: png }
            : kind === 'text'
              ? { type: 'response.output_text.delta', delta: 'already visible' }
              : kind === 'hosted-tool'
                ? { type: 'response.web_search_call.in_progress', item_id: 'owned-search' }
                : undefined
      const first = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller
            if (initial) controller.enqueue(frame(initial))
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(first)
        .mockImplementation(async () => success(true))
      const result = observe(client(fetcher).chat({ ...params(), onDelta: () => {} }))
      await vi.advanceTimersByTimeAsync(1)
      source.error(closed())
      await vi.advanceTimersByTimeAsync(60000)
      if (kind === 'no-output') {
        expect((await result).error).toBeUndefined()
        expect((await result).value?.attachments?.[0].type).toBe('image')
        expect(fetcher).toHaveBeenCalledTimes(2)
      } else {
        expect((await result).error).toMatchObject({ retryBlocked: true })
        expect(fetcher).toHaveBeenCalledOnce()
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps ambiguous image timeouts non-replayable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true
          })
        )
    )
    const result = observe(client(fetcher).chat(params()))
    await vi.advanceTimersByTimeAsync(60000)
    expect((await result).error).toMatchObject({ name: 'TimeoutError', retryBlocked: true })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([401, 403])(
    'does not retry HTTP %s even if its body mentions a connection close',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('net::ERR_CONNECTION_CLOSED', { status }))
      const result = observe(client(fetcher).chat(params()))
      await vi.advanceTimersByTimeAsync(60000)
      expect((await result).error).toBeInstanceOf(Error)
      expect(fetcher).toHaveBeenCalledOnce()
    }
  )
})
