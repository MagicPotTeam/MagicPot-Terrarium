import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  net: { fetch: undefined }
}))
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import * as configModule from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))

const remoteConfig: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: true,
  remote_llm_server_config: {
    server_origin: 'https://remote.example',
    access_token: 'remote-token'
  },
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: []
  }
}

const streamResponse = (
  frames: unknown[],
  contentType = 'application/x-ndjson',
  init: ResponseInit = {}
): Response =>
  new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''), {
    ...init,
    status: init.status ?? 200,
    headers: { 'content-type': contentType, ...init.headers }
  })

const responseWithReader = (
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'>
): Response => {
  const response = new Response(null, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
  Object.defineProperty(response, 'body', {
    configurable: true,
    value: { getReader: () => reader }
  })
  return response
}

const deferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(predicate()).toBe(true)
}

const request = {
  profileId: 'remote-profile',
  comparisonRouting: 'configured' as const,
  apiMode: 'responses' as const,
  imageHistoryPolicy: 'all' as const,
  stream: true,
  messages: [
    {
      role: 'user' as const,
      content: 'Draw this',
      attachments: [{ type: 'image' as const, url: 'data:image/png;base64,ref' }]
    }
  ]
}

const useRemoteOrigin = (serverOrigin: string): void => {
  vi.mocked(configModule.getConfig).mockReturnValue({
    ...remoteConfig,
    remote_llm_server_config: {
      ...remoteConfig.remote_llm_server_config,
      server_origin: serverOrigin
    }
  })
}

beforeEach(() => {
  vi.mocked(configModule.getConfig).mockReturnValue(remoteConfig)
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LLMProxySvcImpl remote stream branch', () => {
  it('exposes a focused contract for remote SSE/NDJSON stream forwarding and request payload', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        { type: 'text-delta', delta: 'hello' },
        {
          type: 'attachment',
          attachment: { type: 'image', url: 'https://remote.example/generated.png' }
        },
        { type: 'session', sessionUrl: 'https://remote.example/session/1' },
        {
          type: 'done',
          done: true,
          fullContent: 'hello',
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 }
        }
      ])
    )

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const service = new LLMProxySvcImpl()

    await service.chatStream(request, { onData })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://remote.example/api/chat')
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer remote-token' })
    })
    const payload = JSON.parse(String(init?.body))
    expect(payload).toMatchObject({
      stream: true,
      apiMode: 'responses',
      imageHistoryPolicy: 'all',
      profileId: 'remote-profile',
      messages: request.messages
    })
    expect(payload.attachments ?? payload.messages[0].attachments).toEqual(
      request.messages[0].attachments
    )
    expect(onData.mock.calls.map(([event]) => event.type)).toEqual([
      'text-delta',
      'attachment',
      'session',
      'done'
    ])
    expect(onData).toHaveBeenNthCalledWith(1, expect.objectContaining({ delta: 'hello' }))
    expect(onData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'done',
        done: true,
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 }
      })
    )
  })

  it('accepts configured HTTP LAN media, opaque sessions, and nested OCR URLs', async () => {
    const serverOrigin = 'http://192.168.1.20:8123'
    useRemoteOrigin(serverOrigin)
    const scopedImageUrl = `${serverOrigin}/api/images/generated.png`
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        {
          type: 'attachment',
          delta: '',
          done: false,
          attachment: {
            type: 'image',
            url: scopedImageUrl,
            ocrResult: { kind: 'document', text: 'attachment OCR', sourceImageUrl: scopedImageUrl }
          }
        },
        { type: 'session', delta: '', done: false, sessionUrl: 'codex:thread_123' },
        {
          type: 'session',
          delta: '',
          done: false,
          sessionUrl: `${serverOrigin}/api/sessions/123`
        },
        {
          type: 'done',
          delta: '',
          done: true,
          imageUrl: scopedImageUrl,
          ocrResult: { kind: 'document', text: 'event OCR', sourceImageUrl: scopedImageUrl }
        }
      ])
    )

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual([
      'attachment',
      'session',
      'session',
      'done'
    ])
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attachment: expect.objectContaining({
          url: scopedImageUrl,
          ocrResult: expect.objectContaining({ sourceImageUrl: scopedImageUrl })
        })
      })
    )
    expect(onData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionUrl: 'codex:thread_123' })
    )
    expect(onData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        imageUrl: scopedImageUrl,
        ocrResult: expect.objectContaining({ sourceImageUrl: scopedImageUrl })
      })
    )
  })

  it('accepts trusted HTTP LAN URLs in JSON fallback response and nested attachment OCR', async () => {
    const serverOrigin = 'http://192.168.1.20:8123'
    useRemoteOrigin(serverOrigin)
    const scopedImageUrl = `${serverOrigin}/api/images/generated.png`
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: 'LAN result',
          imageUrl: scopedImageUrl,
          sessionUrl: 'resp_opaque_1',
          ocrResult: { kind: 'document', sourceImageUrl: `${serverOrigin}/api/images/result.png` },
          attachments: [
            {
              type: 'image',
              url: scopedImageUrl,
              ocrResult: { kind: 'document', sourceImageUrl: `${serverOrigin}/api/images/ocr.png` }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual([
      'text-delta',
      'attachment',
      'session',
      'done'
    ])
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'text-delta',
        delta: 'LAN result'
      })
    )
    expect(onData.mock.calls[0]?.[0]).not.toHaveProperty('attachments')
    expect(onData.mock.calls[0]?.[0]).not.toHaveProperty('imageUrl')
    expect(onData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attachment: expect.objectContaining({
          ocrResult: expect.objectContaining({
            sourceImageUrl: `${serverOrigin}/api/images/ocr.png`
          })
        })
      })
    )
  })

  it.each([
    [
      'a different private image origin',
      {
        type: 'done',
        delta: '',
        done: true,
        imageUrl: 'http://192.168.1.21:8123/api/images/other.png'
      }
    ],
    [
      'a localhost attachment',
      {
        type: 'done',
        delta: '',
        done: true,
        attachment: { type: 'image', url: 'http://127.0.0.1:8123/api/images/local.png' }
      }
    ],
    [
      'a file OCR source',
      {
        type: 'done',
        delta: '',
        done: true,
        ocrResult: { kind: 'document', sourceImageUrl: 'file:///tmp/ocr.png' }
      }
    ],
    [
      'an untrusted absolute HTTP session',
      {
        type: 'session',
        delta: '',
        done: false,
        sessionUrl: 'http://192.168.1.21:8123/api/sessions/other'
      }
    ],
    [
      'credentials on the configured origin',
      {
        type: 'done',
        delta: '',
        done: true,
        imageUrl: 'http://user:pass@192.168.1.20:8123/api/images/secret.png'
      }
    ],
    [
      'a fragment on the configured origin',
      {
        type: 'done',
        delta: '',
        done: true,
        imageUrl: 'http://192.168.1.20:8123/api/images/fragment.png#unsafe'
      }
    ]
  ] as const)('rejects %s from streamed output fields', async (_label, event) => {
    useRemoteOrigin('http://192.168.1.20:8123')
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(streamResponse([event]))
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()

    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([item]) => item.type)).toEqual(['error', 'done'])
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ error: expect.stringContaining('unsafe') })
    )
  })

  it('rejects control characters in opaque streamed session references', async () => {
    useRemoteOrigin('https://remote.example')
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        {
          type: 'session',
          delta: '',
          done: false,
          sessionUrl: 'opaque-session\u0000suffix'
        }
      ])
    )
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()

    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['error', 'done'])
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ error: expect.stringContaining('unsafe') })
    )
  })

  it.each([
    {
      imageUrl: 'http://192.168.1.21:8123/api/images/other.png'
    },
    {
      sessionUrl: 'http://127.0.0.1:8123/api/sessions/local'
    },
    {
      ocrResult: { kind: 'document', sourceImageUrl: 'data:image/png;base64,AAAA' }
    },
    {
      attachments: [
        {
          type: 'image',
          url: 'http://192.168.1.20:8123/api/images/a.png',
          ocrResult: { kind: 'document', sourceImageUrl: 'file:///tmp/ocr.png' }
        }
      ]
    }
  ] as const)('rejects unsafe JSON fallback URL fields: %s', async (fields) => {
    useRemoteOrigin('http://192.168.1.20:8123')
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(fields), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()

    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['error', 'done'])
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ error: expect.stringContaining('unsafe') })
    )
  })

  it('forwards JSON fallback text and attachments exactly once without media on synthetic text', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: '',
          imageUrl: 'https://remote.example/generated.png',
          attachments: [{ type: 'image', url: 'https://remote.example/generated.png' }],
          sessionUrl: 'resp_opaque_1'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual([
      'attachment',
      'session',
      'done'
    ])
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'attachment',
        attachment: { type: 'image', url: 'https://remote.example/generated.png' }
      })
    )
    expect(
      onData.mock.calls.flatMap(([event]) => (event.type === 'text-delta' ? [event] : []))
    ).toEqual([])
    expect(onData).toHaveBeenCalledTimes(3)
  })

  it.each([404, 410])(
    'falls back through remote aliases after %s while retaining the first body in terminal error frames',
    async (status) => {
      const fetchMock = vi.mocked(globalThis.fetch)
      const body = JSON.stringify({ error: `remote body ${status}` })
      fetchMock.mockImplementation(
        async () =>
          new Response(body, {
            status,
            statusText: status === 404 ? 'Not Found' : 'Gone',
            headers: { 'content-type': 'application/json' }
          })
      )

      const service = new LLMProxySvcImpl()
      const onData = vi.fn<(event: LLMChatStreamResp) => void>()

      await service.chatStream(request, { onData })

      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'https://remote.example/api/chat',
        'https://remote.example/api/bot/chat',
        'https://remote.example/api/bot/message',
        'https://remote.example/api/message'
      ])
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer remote-token' })
      })
      expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['error', 'done'])
      expect(onData).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: 'error',
          done: false,
          error: expect.stringContaining(`remote body ${status}`)
        })
      )
      expect(onData).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'done',
          done: true,
          error: expect.stringContaining(`remote body ${status}`)
        })
      )
    }
  )

  it('cancels and releases the reader after a [DONE] terminal frame', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    let cancelCalls = 0
    let releaseCalls = 0
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"hi"}\n\ndata: [DONE]\n\n'
          ),
          done: false
        })
        .mockResolvedValue({ value: undefined, done: true }),
      cancel: vi.fn(() => {
        cancelCalls += 1
        return Promise.resolve()
      }),
      releaseLock: vi.fn(() => {
        releaseCalls += 1
      })
    }
    fetchMock.mockResolvedValueOnce(responseWithReader(reader))

    await new LLMProxySvcImpl().chatStream(request, { onData: vi.fn() })

    expect(cancelCalls).toBe(1)
    expect(releaseCalls).toBe(1)
    expect(reader.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      reader.releaseLock.mock.invocationCallOrder[0]
    )
  })

  it('emits a terminal error when the remote stream reaches EOF without done', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode('data: {"type":"text-delta","delta":"partial"}\n\n'),
          done: false
        })
        .mockResolvedValueOnce({ value: undefined, done: true }),
      cancel: vi.fn(() => Promise.resolve()),
      releaseLock: vi.fn()
    }
    fetchMock.mockResolvedValueOnce(responseWithReader(reader))

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['text-delta', 'error', 'done'])
    expect(onData).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'done', done: true, finishReason: 'error' })
    )
    expect(reader.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      reader.releaseLock.mock.invocationCallOrder[0]
    )
  })

  it('stops dispatching after a typed done event and releases the reader', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            'data: {"type":"done","done":true,"delta":"","finishReason":"stop"}\n\n' +
              'data: {"type":"text-delta","delta":"late"}\n\n'
          ),
          done: false
        })
        .mockResolvedValue({ value: undefined, done: true }),
      cancel: vi.fn(() => Promise.resolve()),
      releaseLock: vi.fn()
    }
    fetchMock.mockResolvedValueOnce(responseWithReader(reader))

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['done'])
    expect(onData).toHaveBeenCalledTimes(1)
    expect(reader.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      reader.releaseLock.mock.invocationCallOrder[0]
    )
  })

  it('settles renderer abort when reader cancellation never resolves', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    const readStarted = deferred<void>()
    const reader = {
      read: vi.fn(async () => {
        readStarted.resolve()
        return await new Promise<never>(() => undefined)
      }),
      cancel: vi.fn(() => new Promise<void>(() => undefined)),
      releaseLock: vi.fn()
    }
    fetchMock.mockResolvedValueOnce(responseWithReader(reader))
    const abortController = new AbortController()
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    const streamPromise = new LLMProxySvcImpl().chatStream(request, {
      onData,
      abortReceiver: {
        isAborted: () => abortController.signal.aborted,
        onAbort: (handler) =>
          abortController.signal.addEventListener('abort', handler, { once: true })
      }
    })

    await readStarted.promise
    abortController.abort()
    await expect(streamPromise).resolves.toBeUndefined()
    expect(reader.cancel).toHaveBeenCalled()
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
    expect(onData).not.toHaveBeenCalled()
  })

  it('settles a hanging reader at the two-minute deadline without writes after abort', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.mocked(globalThis.fetch)
      const readStarted = deferred<void>()
      const reader = {
        read: vi.fn(async () => {
          readStarted.resolve()
          return await new Promise<never>(() => undefined)
        }),
        cancel: vi.fn(() => new Promise<void>(() => undefined)),
        releaseLock: vi.fn()
      }
      fetchMock.mockResolvedValueOnce(responseWithReader(reader))
      const onData = vi.fn<(event: LLMChatStreamResp) => void>()
      const streamPromise = new LLMProxySvcImpl().chatStream(request, { onData })

      await readStarted.promise
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
      await expect(streamPromise).resolves.toBeUndefined()
      expect(reader.cancel).toHaveBeenCalled()
      expect(reader.releaseLock).toHaveBeenCalledTimes(1)
      expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['error', 'done'])
      expect(onData).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'done', done: true, finishReason: 'error' })
      )
      const writesAtDeadline = onData.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(onData).toHaveBeenCalledTimes(writesAtDeadline)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves one text event and one media attachment for JSON fallback output', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: 'generated text',
          imageUrl: 'https://remote.example/generated.png',
          attachments: [{ type: 'image', url: 'https://remote.example/generated.png' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(onData.mock.calls.map(([event]) => event.type)).toEqual([
      'text-delta',
      'attachment',
      'done'
    ])
    expect(onData).toHaveBeenCalledTimes(3)
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'text-delta', delta: 'generated text' })
    )
    expect(onData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'attachment',
        attachment: { type: 'image', url: 'https://remote.example/generated.png' }
      })
    )
  })

  it('cancels a pending reader when the caller aborts', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    const readStarted = deferred<void>()
    const readReleased = deferred<void>()
    const reader = {
      read: vi.fn(async () => {
        readStarted.resolve()
        await readReleased.promise
        return { value: undefined, done: true as const }
      }),
      cancel: vi.fn(async () => {
        readReleased.resolve()
      }),
      releaseLock: vi.fn()
    }
    fetchMock.mockResolvedValueOnce(responseWithReader(reader))
    const abortController = new AbortController()
    const streamPromise = new LLMProxySvcImpl().chatStream(request, {
      onData: vi.fn(),
      abortReceiver: {
        isAborted: () => abortController.signal.aborted,
        onAbort: (handler) => abortController.signal.addEventListener('abort', handler)
      }
    })

    await readStarted.promise
    abortController.abort()
    await streamPromise

    expect(reader.cancel).toHaveBeenCalled()
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('does not forward raw upstream error bodies', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    const secret = 'Authorization: Bearer secret-token'
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: secret, code: 'SESSION_EXPIRED', status: 410 }), {
          status: 410,
          headers: { 'content-type': 'application/json' }
        })
    )
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()

    await new LLMProxySvcImpl().chatStream(request, { onData })

    expect(JSON.stringify(onData.mock.calls)).not.toContain(secret)
    expect(onData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'error',
        status: 410,
        body: expect.stringContaining('SESSION_EXPIRED'),
        error: expect.not.stringContaining(secret)
      })
    )
    expect(onData).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'done',
        status: 410,
        body: expect.stringContaining('SESSION_EXPIRED'),
        error: expect.stringContaining('SESSION_EXPIRED')
      })
    )
  })
})
