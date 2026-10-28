import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderFileIdCache } from '../providerFileIdCache'
import { createOpenAIFileSearchSession } from './openaiFileSearch'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createOpenAIFileSearchSession', () => {
  it.each([
    'https://attacker.example/file.txt',
    'file:///C:/outside/file.txt',
    'local-media:///C:/outside/file.txt'
  ])('rejects unmaterialized source %s before any provider request', async (url) => {
    const fetchMock = vi.fn()
    await expect(
      createOpenAIFileSearchSession({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        messages: [
          {
            role: 'user',
            content: 'Analyze this file.',
            attachments: [
              {
                type: 'file',
                url,
                fileName: 'file.txt',
                mimeType: 'text/plain',
                media: {
                  version: 1,
                  kind: 'managed',
                  relativePath: 'outside/file.txt',
                  sha256: 'a'.repeat(64)
                }
              }
            ]
          }
        ],
        fetchImpl: fetchMock as typeof fetch,
        fileIdCache: new ProviderFileIdCache()
      })
    ).rejects.toThrow('requires materialized base64 data URLs')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the injected fetch implementation for file-search network operations', async () => {
    const injectedFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'file-injected' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-injected' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-file-injected' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'file-injected', status: 'completed' }]
        })
      })

    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    const session = await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        {
          role: 'user',
          content: 'Analyze this file.',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,aGVsbG8=',
              fileName: 'note.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      fetchImpl: injectedFetch as typeof fetch,
      fileIdCache: new ProviderFileIdCache()
    })

    expect(session?.vectorStoreIds).toEqual(['vs-injected'])
    expect(injectedFetch).toHaveBeenCalledTimes(4)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('cleans up uploaded resources even after the caller aborts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'file-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-file-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'file-1', status: 'completed' }]
        })
      })
      .mockResolvedValueOnce({
        ok: true
      })
      .mockResolvedValueOnce({
        ok: true
      })

    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const session = await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        {
          role: 'user',
          content: 'Analyze this file.',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,aGVsbG8=',
              fileName: 'note.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      signal: controller.signal,
      fileIdCache: new ProviderFileIdCache()
    })

    expect(session).not.toBeNull()

    controller.abort('user cancelled')
    await session?.cleanup()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/vector_stores/vs-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer sk-test'
        },
        signal: expect.any(AbortSignal)
      })
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/files/file-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer sk-test'
        },
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('reuses a cached upload without deleting it as session-owned', async () => {
    const cache = new ProviderFileIdCache()
    const messages = [
      {
        role: 'user' as const,
        content: 'Analyze this file.',
        attachments: [
          {
            type: 'file' as const,
            url: 'data:text/plain;base64,aGVsbG8=',
            fileName: 'note.txt',
            mimeType: 'text/plain',
            metadata: { mediaId: 'managed-media-1' }
          }
        ]
      }
    ]
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'file-cached' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'vs-1' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'file-cached', status: 'completed' }] })
      })
    await createOpenAIFileSearchSession({
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.com/v1/',
      accountIdentifier: 'org-stable',
      messages,
      fetchImpl: firstFetch as typeof fetch,
      fileIdCache: cache
    })

    const secondFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'vs-2' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'file-cached', status: 'completed' }] })
      })
      .mockResolvedValueOnce({ ok: true })
    const session = await createOpenAIFileSearchSession({
      apiKey: 'sk-different-secret',
      baseUrl: 'https://api.openai.com/v1',
      accountIdentifier: 'org-stable',
      messages,
      fetchImpl: secondFetch as typeof fetch,
      fileIdCache: cache
    })
    await session?.cleanup()

    expect(secondFetch).toHaveBeenCalledTimes(4)
    expect(
      secondFetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/files') && init?.method === 'POST' && init.body instanceof FormData
      )
    ).toBe(false)
    expect(secondFetch.mock.calls.some(([url]) => String(url).includes('/files/file-cached'))).toBe(
      false
    )
  })

  it('reuses one upload for materialized managed content at different paths', async () => {
    const cache = new ProviderFileIdCache()
    const sha256 = 'ABCDEF0123456789'.repeat(4)
    const createMessages = (relativePath: string, hash: string) => [
      {
        role: 'user' as const,
        content: 'Analyze this file.',
        attachments: [
          {
            type: 'file' as const,
            url: 'data:text/plain;base64,aGVsbG8=',
            fileName: 'note.txt',
            mimeType: 'text/plain',
            media: {
              version: 1 as const,
              kind: 'managed' as const,
              relativePath,
              sha256: hash
            }
          }
        ]
      }
    ]
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'file-by-content' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'vs-1' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'file-by-content', status: 'completed' }] })
      })
    await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: createMessages('uploads/first/note.txt', sha256),
      fetchImpl: firstFetch as typeof fetch,
      fileIdCache: cache
    })

    const secondFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'vs-2' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'file-by-content', status: 'completed' }] })
      })
    await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: createMessages('uploads/second/note.txt', sha256.toLowerCase()),
      fetchImpl: secondFetch as typeof fetch,
      fileIdCache: cache
    })

    const uploadCalls = [...firstFetch.mock.calls, ...secondFetch.mock.calls].filter(
      ([url, init]) =>
        String(url).endsWith('/files') && init?.method === 'POST' && init.body instanceof FormData
    )
    expect(uploadCalls).toHaveLength(1)
    expect(secondFetch.mock.calls.some(([url]) => String(url).startsWith('local-media://'))).toBe(
      false
    )
  })

  it('bounds provider JSON body reads when a body ignores abort', async () => {
    vi.useFakeTimers()
    let resolveFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve
    })
    const neverEndingBody = {
      getReader: () => ({
        read: () => {
          resolveFetchStarted()
          return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined)
        },
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn()
      })
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        body: null,
        json: async () => ({ id: 'file-json' })
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, body: neverEndingBody } as unknown as Response)
    const pending = createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        {
          role: 'user',
          content: 'Analyze this file.',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,aGVsbG8=',
              fileName: 'note.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      fetchImpl: fetchMock as typeof fetch,
      fileIdCache: new ProviderFileIdCache()
    })
    const pendingOutcome = pending.catch((error) => error)
    await fetchStarted
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pendingOutcome).resolves.toMatchObject({ name: 'TimeoutError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects cancellation before source validation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const fetchMock = vi.fn()
    await expect(
      createOpenAIFileSearchSession({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        signal: controller.signal,
        messages: [
          {
            role: 'user',
            content: 'Analyze this file.',
            attachments: [
              {
                type: 'file',
                url: 'https://attacker.example/file.txt',
                fileName: 'file.txt',
                mimeType: 'text/plain'
              }
            ]
          }
        ],
        fetchImpl: fetchMock as typeof fetch,
        fileIdCache: new ProviderFileIdCache()
      })
    ).rejects.toThrow('caller cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds setup when an injected provider fetch ignores abort', async () => {
    vi.useFakeTimers()
    let resolveFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve
    })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      resolveFetchStarted()
      return new Promise<Response>(() => undefined)
    })

    const pending = createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        {
          role: 'user',
          content: 'Analyze this file.',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,aGVsbG8=',
              fileName: 'note.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      fetchImpl: fetchMock as typeof fetch,
      fileIdCache: new ProviderFileIdCache()
    })

    const pendingOutcome = pending.catch((error) => error)
    await fetchStarted
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pendingOutcome).resolves.toMatchObject({ name: 'TimeoutError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates a cached ID when OpenAI reports it missing', async () => {
    const cache = new ProviderFileIdCache()
    const messages = [
      {
        role: 'user' as const,
        content: 'Analyze this file.',
        attachments: [
          {
            type: 'file' as const,
            url: 'data:text/plain;base64,aGVsbG8=',
            fileName: 'note.txt',
            mimeType: 'text/plain',
            metadata: { mediaId: 'missing-media' }
          }
        ]
      }
    ]
    const populateFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'file-missing' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'vs-populate' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'file-missing', status: 'completed' }] })
      })
    await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages,
      fetchImpl: populateFetch as typeof fetch,
      fileIdCache: cache
    })

    const missingFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'vs-missing' }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'file not found'
      })
      .mockResolvedValueOnce({ ok: true })
    await expect(
      createOpenAIFileSearchSession({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        messages,
        fetchImpl: missingFetch as typeof fetch,
        fileIdCache: cache
      })
    ).rejects.toThrow('file not found')

    const retryFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Upload attempted',
      text: async () => ''
    })
    await expect(
      createOpenAIFileSearchSession({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        messages,
        fetchImpl: retryFetch as typeof fetch,
        fileIdCache: cache
      })
    ).rejects.toThrow('OpenAI file upload failed')
  })
})
