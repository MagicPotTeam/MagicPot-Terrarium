import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAPICli, type OpenAIClientApiMode } from '../../shared/llm/clients'
import {
  OPENAI_CHAT_DEADLINE_MS,
  OPENAI_IMAGE_DEADLINE_MS
} from '../../shared/llm/openaiRequestControl'

const messages = [{ role: 'user' as const, content: 'Owned bounded request.' }]
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const payload = (mode: OpenAIClientApiMode) =>
  mode === 'images'
    ? { data: [{ b64_json: 'aW1hZ2U=' }] }
    : mode === 'responses'
      ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'owned' }] }] }
      : { choices: [{ message: { content: 'owned' } }] }
const endpoint = (mode: OpenAIClientApiMode) =>
  mode === 'chat-completions'
    ? 'https://owned.example/v1/chat/completions'
    : 'https://owned.example/v1'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('standard OpenAI actual-client deadline and cancellation contract', () => {
  it.each(['responses', 'chat-completions', 'images'] as const)(
    'bounds an ignored-abort %s transport using its finite default deadline',
    async (mode) => {
      vi.useFakeTimers()
      const started = gate()
      let resolve!: (response: Response) => void
      let outcome: unknown
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
        started.resolve()
        return new Promise<Response>((done) => {
          resolve = done
        })
      })
      const client = new OpenAIAPICli('', endpoint(mode), 'owned', {
        apiMode: mode,
        enableHostedTools: false,
        fetchImpl
      })
      const pending = client.chat({ messages }).then(
        (value) => {
          outcome = value
        },
        (error) => {
          outcome = error
        }
      )
      try {
        await started.promise
        await vi.advanceTimersByTimeAsync(
          mode === 'images' ? OPENAI_IMAGE_DEADLINE_MS : OPENAI_CHAT_DEADLINE_MS
        )
        expect(outcome).toMatchObject({ name: 'TimeoutError' })
        expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
      } finally {
        // Also settle the pre-fix ignored-abort transport after the RED assertion.
        resolve(Response.json(payload(mode)))
        await pending
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('bounds a provider JSON method that ignores cancellation after headers arrive', async () => {
    vi.useFakeTimers()
    const started = gate()
    let resolve!: (value: unknown) => void
    const response = {
      ok: true,
      json: () => {
        started.resolve()
        return new Promise((done) => {
          resolve = done
        })
      }
    } as Response
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const client = new OpenAIAPICli('', endpoint('responses'), 'owned', {
      apiMode: 'responses',
      enableHostedTools: false,
      fetchImpl
    })
    let outcome: unknown
    const pending = client.chat({ messages }).then(
      (value) => {
        outcome = value
      },
      (error) => {
        outcome = error
      }
    )
    try {
      await started.promise
      await vi.advanceTimersByTimeAsync(OPENAI_CHAT_DEADLINE_MS)
      expect(outcome).toMatchObject({ name: 'TimeoutError' })
    } finally {
      resolve(payload('responses'))
      await pending
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['responses', 'chat-completions', 'images'] as const)(
    'preserves exact caller cancellation in %s instead of wrapping it as a network failure',
    async (mode) => {
      const caller = new AbortController()
      const reason = new Error('owned cancellation identity')
      const started = gate()
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
        started.resolve()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      })
      const client = new OpenAIAPICli('', endpoint(mode), 'owned', {
        apiMode: mode,
        enableHostedTools: false,
        fetchImpl
      })
      const pending = client.chat({ messages, signal: caller.signal }).catch((error) => error)
      await started.promise
      caller.abort(reason)
      expect(await pending).toBe(reason)
    }
  )

  it.each(['responses', 'chat-completions', 'images'] as const)(
    'preserves received 502 status when the %s error body stalls or resets',
    async (mode) => {
      vi.useFakeTimers()
      for (const stall of [true, false]) {
        const started = gate()
        const reset = new Error('owned body reset')
        const cancel = vi.fn(async () => undefined)
        let pulls = 0
        const response = new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (++pulls === 1) {
                  controller.enqueue(new TextEncoder().encode('owned-prefix'))
                  return
                }
                started.resolve()
                if (!stall) controller.error(reset)
              },
              cancel
            },
            { highWaterMark: 0 }
          ),
          { status: 502 }
        )
        const cli = new OpenAIAPICli('', endpoint(mode), 'owned', {
          apiMode: mode,
          enableHostedTools: false,
          requestTimeoutMs: 1_000,
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response)
        })
        const outcome = cli.chat({ messages }).catch((error) => error)
        await started.promise
        if (stall) await vi.advanceTimersByTimeAsync(1_000)
        const failure = await outcome
        expect(failure).toMatchObject({
          name: 'UpstreamHttpError',
          statusCode: 502,
          body: 'owned-prefix'
        })
        expect(failure.cause).toEqual(
          stall ? expect.objectContaining({ name: 'TimeoutError' }) : reset
        )
        if (stall) expect(cancel).toHaveBeenCalledTimes(1)
        expect(response.body?.locked).toBe(false)
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['cancel', 'http-error', 'bad-json', 'provider-failed'] as const)(
    'uses independent hosted cleanup after %s and preserves the original outcome',
    async (failureMode) => {
      vi.useFakeTimers()
      const caller = new AbortController()
      const started = gate(),
        deleting = gate()
      const cleanupSignals: AbortSignal[] = []
      const reason = { type: 'owned-cancel' }
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input)
        if (init?.method === 'DELETE') {
          cleanupSignals.push(init.signal as AbortSignal)
          if (cleanupSignals.length === 2) deleting.resolve()
          return new Promise<Response>(() => undefined)
        }
        if (url.endsWith('/responses')) {
          started.resolve()
          if (failureMode === 'http-error') return new Response('owned 502 detail', { status: 502 })
          if (failureMode === 'bad-json') return new Response('{invalid-json')
          if (failureMode === 'provider-failed')
            return new Response(
              'data: {"type":"response.failed","response":{"error":{"message":"owned terminal failure"}}}\n\n',
              { headers: { 'content-type': 'text/event-stream' } }
            )
          return new Promise<Response>(() => undefined)
        }
        if (url.endsWith('/vector_stores')) return Response.json({ id: 'vs-owned' })
        if (url.includes('/vector_stores/'))
          return Response.json(
            init?.method === 'POST'
              ? { id: 'file-owned', status: 'in_progress' }
              : { data: [{ id: 'file-owned', status: 'completed' }] }
          )
        return Response.json({ id: 'file-owned' })
      })
      const client = new OpenAIAPICli('', endpoint('responses'), 'owned', {
        apiMode: 'responses',
        enableHostedTools: true,
        requestTimeoutMs: 1_000,
        fetchImpl
      })
      const pending = client
        .chat({
          messages: [
            {
              ...messages[0],
              attachments: [
                { type: 'file', fileName: 'owned.txt', url: 'data:text/plain;base64,b3duZWQ=' }
              ]
            }
          ],
          signal: caller.signal,
          onDelta: failureMode === 'provider-failed' ? vi.fn() : undefined
        })
        .catch((error) => error)
      await started.promise
      if (failureMode === 'cancel') caller.abort(reason)
      await deleting.promise
      expect(cleanupSignals.every((signal) => !signal.aborted && signal !== caller.signal)).toBe(
        true
      )
      await vi.advanceTimersByTimeAsync(5_000)
      if (failureMode === 'cancel') expect(await pending).toBe(reason)
      else if (failureMode === 'bad-json') expect(await pending).toBeInstanceOf(SyntaxError)
      else if (failureMode === 'provider-failed')
        expect(await pending).toMatchObject({ message: 'owned terminal failure' })
      else
        expect(await pending).toMatchObject({
          name: 'UpstreamHttpError',
          statusCode: 502,
          body: 'owned 502 detail'
        })
      expect(cleanupSignals.every((signal) => signal.aborted)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('bounds an injected image loader that ignores abort before posting the edit', async () => {
    vi.useFakeTimers()
    const started = gate()
    let resolve!: (value: { blob: Blob }) => void
    const imageAttachmentLoader = vi.fn().mockImplementation(() => {
      started.resolve()
      return new Promise<{ blob: Blob }>((done) => {
        resolve = done
      })
    })
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new OpenAIAPICli('', endpoint('images'), 'owned', {
      apiMode: 'images',
      requestTimeoutMs: 1_000,
      fetchImpl,
      imageAttachmentLoader
    })
    const pending = client
      .chat({
        messages: [
          {
            ...messages[0],
            attachments: [{ type: 'image', url: 'https://owned.example/image.png' }]
          }
        ],
        imageGenerationOptions: { action: 'edit' }
      })
      .catch((error) => error)
    await started.promise
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toMatchObject({ name: 'TimeoutError' })
    resolve({ blob: new Blob(['owned'], { type: 'image/png' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an already-cancelled request without calling the provider', async () => {
    const caller = new AbortController()
    const reason = { type: 'owned-cancel' }
    caller.abort(reason)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload('responses')))
    const client = new OpenAIAPICli('', endpoint('responses'), 'owned', {
      apiMode: 'responses',
      enableHostedTools: false,
      fetchImpl
    })
    const outcome = await client.chat({ messages, signal: caller.signal }).catch((error) => error)
    expect(outcome).toBe(reason)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
