import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComfyBatchHttpClient, COMFY_BATCH_MAX_NETWORK_ATTEMPTS } from './batchHttp'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ComfyBatchHttpClient retry and boundary behavior', () => {
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
