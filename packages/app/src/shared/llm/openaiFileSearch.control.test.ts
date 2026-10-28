import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderFileIdCache } from '../providerFileIdCache'
import { createOpenAIFileSearchSession } from './openaiFileSearch'
import type { ChatMessage } from './types'

const messages: ChatMessage[] = [
  {
    role: 'user',
    content: 'Analyze this owned fixture.',
    attachments: [
      {
        type: 'file',
        url: 'data:text/plain;base64,aGVsbG8=',
        fileName: 'owned-note.txt',
        mimeType: 'text/plain'
      }
    ]
  }
]
const options = (fetchImpl: typeof fetch, signal?: AbortSignal) => ({
  apiKey: 'owned-test-not-a-credential',
  baseUrl: 'https://api.openai.com/v1',
  messages,
  fileIdCache: new ProviderFileIdCache(),
  fetchImpl,
  signal
})
const ready = () => Response.json({ data: [{ id: 'file-owned', status: 'completed' }] })
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('file-search bounded control and resource ownership', () => {
  it('does not reuse a file ID for different bytes with matching untrusted media metadata', async () => {
    const cache = new ProviderFileIdCache()
    const tagged = (url: string): ChatMessage[] => [
      {
        ...messages[0],
        attachments: [
          {
            ...messages[0].attachments![0],
            url,
            metadata: { mediaId: 'same-untrusted-id' },
            media: { version: 1, kind: 'managed', relativePath: 'same.txt', sha256: 'a'.repeat(64) }
          }
        ]
      }
    ]
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-owned' }))
      .mockResolvedValueOnce(Response.json({ id: 'vs-owned' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(ready())
      .mockResolvedValue(new Response(null, { status: 204 }))
    const session = await createOpenAIFileSearchSession({
      ...options(firstFetch),
      fileIdCache: cache,
      messages: tagged('data:text/plain;base64,aGVsbG8=')
    })
    const secondFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('owned sentinel', { status: 502 }))
    try {
      await expect(
        createOpenAIFileSearchSession({
          ...options(secondFetch),
          fileIdCache: cache,
          messages: tagged('data:text/plain;base64,d29ybGQ=')
        })
      ).rejects.toThrow('owned sentinel')
      expect(secondFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/files',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData)
        })
      )
    } finally {
      await session?.cleanup()
    }
  })

  it('bounds an injected bodyless JSON response too', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      body: null,
      json: async () => ({ id: 'x'.repeat(1024 * 1024) })
    } as Response)
    await expect(createOpenAIFileSearchSession(options(fetchImpl))).rejects.toThrow('1048576-byte')
  })

  it('bounds asynchronous cache-key hashing before provider I/O', async () => {
    vi.useFakeTimers()
    const started = gate()
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(() => {
      started.resolve()
      return new Promise<ArrayBuffer>(() => undefined)
    })
    const fetchImpl = vi.fn<typeof fetch>()
    const outcome = createOpenAIFileSearchSession(options(fetchImpl)).catch((error) => error)
    await started.promise
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await outcome).toMatchObject({ name: 'TimeoutError' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects JSON overflow without awaiting a never-settling stream cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
      cancel
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    await expect(createOpenAIFileSearchSession(options(fetchImpl))).rejects.toThrow('1048576-byte')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized declared JSON before reading and cancels the response', async () => {
    const cancel = vi.fn(async () => undefined)
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: { 'content-length': String(1024 * 1024 + 1) }
      })
    )
    await expect(createOpenAIFileSearchSession(options(fetchImpl))).rejects.toThrow('1048576-byte')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels a successful attach body that the caller does not consume', async () => {
    const cancel = vi.fn(async () => undefined)
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-owned' }))
      .mockResolvedValueOnce(Response.json({ id: 'vs-owned' }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })))
      .mockResolvedValueOnce(ready())
      .mockResolvedValue(new Response(null, { status: 204 }))
    const session = await createOpenAIFileSearchSession(options(fetchImpl))
    try {
      expect(session?.vectorStoreIds).toEqual(['vs-owned'])
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      await session?.cleanup()
    }
  })

  it('disposes a late response after deadline without changing the original timeout', async () => {
    vi.useFakeTimers()
    const started = gate()
    let finishFetch!: (response: Response) => void
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      started.resolve()
      return new Promise<Response>((resolve) => {
        finishFetch = resolve
      })
    })
    const outcome = createOpenAIFileSearchSession(options(fetchImpl)).catch((error) => error)
    await started.promise
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await outcome
    expect(error).toMatchObject({ name: 'TimeoutError' })
    const cancel = vi.fn(async () => undefined)
    finishFetch(new Response(new ReadableStream<Uint8Array>({ cancel })))
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await outcome).toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds rollback DELETE requests independently and preserves the upload error', async () => {
    vi.useFakeTimers()
    const deleteStarted = gate()
    let cleanupSignal: AbortSignal | null | undefined
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-owned' }))
      .mockResolvedValueOnce(
        new Response('owned upstream failure', { status: 502, statusText: 'Bad Gateway' })
      )
      .mockImplementation((_input, init) => {
        cleanupSignal = init?.signal
        deleteStarted.resolve()
        return new Promise<Response>(() => undefined)
      })
    let settled = false
    const outcome = createOpenAIFileSearchSession(options(fetchImpl)).catch((error) => {
      settled = true
      return error
    })
    await deleteStarted.promise
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    expect(cleanupSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('502 Bad Gateway owned upstream failure')
    })
    expect(cleanupSignal?.aborted).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds concurrent session cleanup and does not inherit caller cancellation', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const cleanupSignals: AbortSignal[] = []
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-owned' }))
      .mockResolvedValueOnce(Response.json({ id: 'vs-owned' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(ready())
      .mockImplementation((_input, init) => {
        cleanupSignals.push(init?.signal as AbortSignal)
        return new Promise<Response>(() => undefined)
      })
    const session = await createOpenAIFileSearchSession(options(fetchImpl, caller.signal))
    caller.abort(new Error('owned user cancellation'))
    const cleanup = session!.cleanup()
    expect(cleanupSignals).toHaveLength(2)
    expect(cleanupSignals.every((signal) => !signal.aborted && signal !== caller.signal)).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    await cleanup
    expect(cleanupSignals.every((signal) => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the caller reason during a provider JSON read and releases its listener', async () => {
    vi.useFakeTimers()
    const started = gate()
    const cancel = vi.fn(async () => undefined)
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve()
        },
        cancel
      },
      { highWaterMark: 0 }
    )
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const caller = new AbortController()
    const add = vi.spyOn(caller.signal, 'addEventListener')
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    const error = new Error('owned caller reason')
    const outcome = createOpenAIFileSearchSession(options(fetchImpl, caller.signal)).catch(
      (reason) => reason
    )
    await started.promise
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    caller.abort(error)
    expect(await outcome).toBe(error)
    expect(cancel).toHaveBeenCalledTimes(1)
    const listener = add.mock.calls.find(([type]) => type === 'abort')?.[1]
    expect(remove).toHaveBeenCalledWith('abort', listener)
    expect(vi.getTimerCount()).toBe(0)
  })
})
