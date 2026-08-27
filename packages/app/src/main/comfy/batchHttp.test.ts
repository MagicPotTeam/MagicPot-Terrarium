import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ComfyBatchHttpClient,
  COMFY_BATCH_MAX_NETWORK_ATTEMPTS,
  createComfyJsonPostInit
} from './batchHttp'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ComfyBatchHttpClient retry and boundary behavior', () => {
  it('builds the same JSON POST request shape used by ComfyUI endpoints', () => {
    expect(createComfyJsonPostInit({ prompt_id: 'known-prompt-id' })).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"prompt_id":"known-prompt-id"}'
    })
  })

  it('allows at most three retries after the first idempotent read attempt', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188')

    await expect(client.objectInfo()).rejects.toThrow('network down')
    expect(fetchMock).toHaveBeenCalledTimes(COMFY_BATCH_MAX_NETWORK_ATTEMPTS)
  })

  it('preserves a forwarded base path for every ComfyUI endpoint', async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return Response.json({}, { status: 200 })
    })
    const injected = new ComfyBatchHttpClient(
      'https://example.test/autodl/comfy/',
      fetchMock as typeof fetch
    )
    await injected.objectInfo()
    expect(urls).toEqual(['https://example.test/autodl/comfy/object_info'])
  })

  it('does not blindly retry prompt submission and carries an explicit prompt id', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('unknown submit result'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188')

    await expect(client.prompt({} as never, 'client', 'known-prompt-id')).rejects.toThrow(
      'unknown submit result'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt_id: 'known-prompt-id' })
  })

  it('reports only the HTTP status for non-success responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><html><h1>404 Not Found</h1></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' }
      })
    )
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188', fetchMock as typeof fetch)

    const error = await client.objectInfo().catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('ComfyUI HTTP 404')
  })

  it('accepts the server prompt_id even when it differs from the client request value', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ prompt_id: 'server-prompt-id' }, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188')

    await expect(client.prompt({} as never, 'client', 'client-prompt-id')).resolves.toBe(
      'server-prompt-id'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('finds an ambiguously submitted prompt in the pending queue', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json(
          { queue_running: [], queue_pending: [[1, 'known-prompt-id']] },
          { status: 200 }
        )
      )
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188', fetchMock as typeof fetch)

    await expect(client.promptAdmission('known-prompt-id')).resolves.toEqual({
      admitted: true,
      promptId: 'known-prompt-id'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers a server-minted prompt id through the unique submission client id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            queue_running: [],
            queue_pending: [[1, 'server-prompt-id', {}, { client_id: 'submission-client' }]]
          },
          { status: 200 }
        )
      )
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188', fetchMock as typeof fetch)

    await expect(
      client.waitForPromptAdmission('requested-prompt-id', undefined, 100, 'submission-client')
    ).resolves.toEqual({ admitted: true, promptId: 'server-prompt-id' })
  })

  it('cancels queue and running work even when both endpoints return empty bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188', fetchMock as typeof fetch)

    await expect(client.cancelPrompt('known-prompt-id')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps caller cancellation attached while a response body is still loading', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      return new Response(
        new ReadableStream({
          start(streamController) {
            init?.signal?.addEventListener(
              'abort',
              () => streamController.error(new DOMException('Aborted', 'AbortError')),
              { once: true }
            )
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188', fetchMock as typeof fetch)

    const pending = client.objectInfo(controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/i)
  })

  it('does not retry an upload whose submit result is unknown', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('unknown upload result'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188')

    await expect(client.uploadImage('input.png', new Uint8Array([1]))).rejects.toThrow(
      'unknown upload result'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects redirects once instead of following or retrying a changed origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { location: 'http://untrusted.example/object_info' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new ComfyBatchHttpClient('http://127.0.0.1:8188')

    await expect(client.objectInfo()).rejects.toThrow(/redirects are not allowed/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
