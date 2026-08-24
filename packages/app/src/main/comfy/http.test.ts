import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from 'undici'

const { webSocketCtor, testConfig, testBuildEnv } = vi.hoisted(() => ({
  webSocketCtor: vi.fn(function MockWebSocket() {
    return {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      once: vi.fn(),
      emit: vi.fn()
    }
  }),
  testConfig: {
    client_id: 'legacy-client',
    use_remote_comfyui: false,
    local_comfyui_config: {
      comfyui_port: '8188',
      comfyui_dir: '',
      python_cmd: '',
      comfyui_args: []
    },
    remote_comfyui_config: {
      comfyui_origin: 'http://remote-host:8188',
      mapping_comfyui_dir: ''
    }
  },
  testBuildEnv: {
    env: {
      buildMode: 'embedded'
    },
    pathMap: {
      file: 'C:/MagicPot',
      data: 'C:/MagicPot/data',
      resources: 'C:/MagicPot/resources'
    },
    embeddedDefaults: {
      pythonCmd: '',
      comfyuiDir: '',
      comfyuiArgs: []
    }
  }
}))

vi.mock('ws', () => ({
  WebSocket: webSocketCtor
}))

vi.mock('../config/config', () => ({
  getConfig: vi.fn(() => testConfig)
}))

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: vi.fn(() => testBuildEnv)
}))

import { COMFY_PROCESS_TRANSPORT_CLIENT_ID, ComfyHttpCli } from './http'

describe('ComfyHttpCli', () => {
  beforeEach(() => {
    vi.useRealTimers()
    webSocketCtor.mockClear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds canonical view params and disables redirect following', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    await cli.viewResponse(
      { filename: 'result #1.png', subfolder: 'batch/nested dir', type: 'output' },
      undefined
    )

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/view')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      filename: 'result #1.png',
      subfolder: 'batch/nested dir',
      type: 'output'
    })
    expect(options).toEqual({ signal: expect.any(AbortSignal), redirect: 'manual' })
  })

  it.each(['file:///tmp/comfy', 'ftp://example.test', 'http://user:secret@example.test'])(
    'rejects an unsafe ComfyUI base URL %s',
    async (origin) => {
      const config = structuredClone(testConfig)
      config.use_remote_comfyui = true
      config.remote_comfyui_config.comfyui_origin = origin
      const cli = new ComfyHttpCli(config as never, testBuildEnv as never)
      const fetchMock = vi.spyOn(globalThis, 'fetch')

      await expect(
        cli.viewResponse({ filename: 'x.png', subfolder: '', type: 'output' })
      ).rejects.toThrow('Invalid ComfyUI base URL')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('uses a process-scoped websocket client id by default', () => {
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    cli.connect()

    const firstConnectCall = webSocketCtor.mock.calls[0] as unknown[] | undefined
    const connectUrl = String(firstConnectCall?.[0] ?? '')
    expect(connectUrl).toContain(`clientId=${COMFY_PROCESS_TRANSPORT_CLIENT_ID}`)
    expect(connectUrl).not.toContain('legacy-client')
    expect(webSocketCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        perMessageDeflate: true,
        followRedirects: false,
        handshakeTimeout: 30_000
      })
    )
  })

  it('pins remote websocket DNS and rejects unsafe resolved destinations', async () => {
    const safeCli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }]
    })
    safeCli.connect()
    const safeOptions = (webSocketCtor.mock.calls[0] as unknown[] | undefined)?.[1] as
      { lookup?: (...args: unknown[]) => void } | undefined
    const lookup = safeOptions?.lookup
    expect(lookup).toBeTypeOf('function')
    await expect(
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup?.('comfy.example.com', {}, (error: unknown, address: string, family?: number) => {
          if (error) reject(error)
          else resolve({ address, family })
        })
      })
    ).resolves.toEqual({ address: '8.8.8.8', family: 4 })
    const allLookupCli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://all.example.com/',
      resolveHostname: async () => [{ address: '8.8.4.4', family: 4 }]
    })
    webSocketCtor.mockClear()
    allLookupCli.connect()
    const allLookup = (
      (webSocketCtor.mock.calls[0] as unknown[] | undefined)?.[1] as
        { lookup?: (...args: unknown[]) => void } | undefined
    )?.lookup
    await expect(
      new Promise<unknown>((resolve, reject) => {
        allLookup?.('all.example.com', { all: true }, (error: unknown, addresses: unknown) => {
          if (error) reject(error)
          else resolve(addresses)
        })
      })
    ).resolves.toEqual([{ address: '8.8.4.4', family: 4 }])

    webSocketCtor.mockClear()
    const unsafeCli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://unsafe.example.com/',
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }]
    })
    unsafeCli.connect()
    const unsafeLookup = (
      (webSocketCtor.mock.calls[0] as unknown[] | undefined)?.[1] as
        { lookup?: (...args: unknown[]) => void } | undefined
    )?.lookup
    await expect(
      new Promise<void>((resolve, reject) => {
        unsafeLookup?.('unsafe.example.com', {}, (error: unknown) => {
          if (error) reject(error)
          else resolve()
        })
      })
    ).rejects.toThrow('Unsafe ComfyUI DNS destination')
  })

  it('honors an explicit websocket client id override', () => {
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      clientId: 'renderer-session'
    })

    cli.connect()

    const firstConnectCall = webSocketCtor.mock.calls[0] as unknown[] | undefined
    expect(String(firstConnectCall?.[0] ?? '')).toContain('clientId=renderer-session')
  })

  it('retries transient endpoint failures up to the configured extra-attempt limit', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ LoadImage: {} }), { status: 200 }))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      networkRetries: 3,
      retryBaseDelayMs: 0
    })

    await expect(cli.objectInfo()).resolves.toEqual({ LoadImage: {} })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-transient 500 responses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('server bug', { status: 500 }))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      networkRetries: 3,
      retryBaseDelayMs: 0
    })

    await expect(cli.objectInfo()).rejects.toThrow('status: 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries only the exact transient HTTP status allowlist', async () => {
    const retryable = new Set([408, 425, 429, 502, 503, 504])
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    for (let status = 400; status <= 599; status += 1) {
      fetchMock.mockReset().mockImplementation(async () => new Response('error', { status }))
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 1,
        retryBaseDelayMs: 0
      })

      await expect(cli.objectInfo()).rejects.toThrow(`status: ${status}`)
      expect(fetchMock, `HTTP ${status}`).toHaveBeenCalledTimes(retryable.has(status) ? 2 : 1)
    }
  })

  it('retries only explicitly transient fetch transport codes', async () => {
    const retryableCodes = [
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ETIMEDOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET'
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    for (const code of retryableCodes) {
      const cause = Object.assign(new Error(code), { code })
      fetchMock.mockReset().mockRejectedValue(new TypeError('fetch failed', { cause }))
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 1,
        retryBaseDelayMs: 0
      })

      await expect(cli.objectInfo()).rejects.toThrow()
      expect(fetchMock, code).toHaveBeenCalledTimes(2)
    }
  })

  it('does not retry unclassified fetch or body failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const failures = [
      new TypeError('generic fetch failure'),
      new TypeError('host not found', {
        cause: Object.assign(new Error('host not found'), { code: 'ENOTFOUND' })
      }),
      new TypeError('certificate expired', {
        cause: Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' })
      })
    ]

    for (const failure of failures) {
      fetchMock.mockReset().mockRejectedValue(failure)
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 3,
        retryBaseDelayMs: 0
      })

      await expect(cli.objectInfo()).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }

    for (const cause of [
      new Error('arbitrary stream failure'),
      Object.assign(new Error('tls'), { code: 'CERT_HAS_EXPIRED' })
    ]) {
      fetchMock.mockReset().mockImplementation(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(cause)
              }
            })
          )
      )
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 3,
        retryBaseDelayMs: 0
      })

      await expect(cli.objectInfo()).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('retries transient DNS EAI_AGAIN but not deterministic resolution failures', async () => {
    const transient = Object.assign(new Error('try again'), { code: 'EAI_AGAIN' })
    const resolveHostname = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname,
      networkRetries: 1,
      retryBaseDelayMs: 0
    })

    await expect(cli.objectInfo()).resolves.toEqual({})
    expect(resolveHostname).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { retryAfter: '1', delayMs: 1_000 },
    { retryAfter: 'Thu, 01 Jan 1970 00:00:01 GMT', delayMs: 1_000 },
    { retryAfter: '1.5', delayMs: 200 },
    { retryAfter: 'not-a-date', delayMs: 200 }
  ])('uses a bounded Retry-After delay for $retryAfter', async ({ retryAfter, delayMs }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('busy', { status: 503, headers: { 'retry-after': retryAfter } })
      )
      .mockResolvedValueOnce(new Response('{}'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      networkRetries: 1,
      retryBaseDelayMs: 200,
      requestTimeoutMs: 5_000
    })

    const request = cli.objectInfo()
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(request).resolves.toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['999999999999999999999999', 'Fri, 01 Jan 2100 00:00:00 GMT'])(
    'lets the absolute deadline expire instead of immediately retrying oversized Retry-After %s',
    async (retryAfter) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('busy', { status: 503, headers: { 'retry-after': retryAfter } })
        )
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 3,
        retryBaseDelayMs: 0,
        requestTimeoutMs: 50
      })

      const request = cli.objectInfo()
      const rejected = expect(request).rejects.toThrow('timed out after 50 ms')
      await vi.advanceTimersByTimeAsync(51)
      await rejected
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('honors Retry-After without extending the absolute request deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('busy', { status: 503, headers: { 'retry-after': '1' } }))
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 3,
        retryBaseDelayMs: 0,
        requestTimeoutMs: 50
      })

      const request = cli.objectInfo()
      const rejected = expect(request).rejects.toThrow('timed out after 50 ms')
      await vi.advanceTimersByTimeAsync(51)
      await rejected
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient buffered response-body read failure', async () => {
    const encoder = new TextEncoder()
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"Load'))
        controller.error(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
      }
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(firstBody))
      .mockResolvedValueOnce(new Response('{"LoadImage":{}}'))
    const destroySpy = vi.spyOn(Agent.prototype, 'destroy')
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
      networkRetries: 1,
      retryBaseDelayMs: 0
    })

    await expect(cli.objectInfo()).resolves.toEqual({ LoadImage: {} })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(destroySpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('retries buffered body failures only for every explicitly transient code', async () => {
    const retryableCodes = [
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ETIMEDOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET'
    ]
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    for (const code of retryableCodes) {
      let attempt = 0
      fetchMock.mockReset().mockImplementation(async () => {
        attempt += 1
        if (attempt === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(Object.assign(new Error(code), { code }))
              }
            })
          )
        }
        return new Response('{}')
      })
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        networkRetries: 1,
        retryBaseDelayMs: 0
      })

      await expect(cli.objectInfo()).resolves.toEqual({})
      expect(fetchMock, code).toHaveBeenCalledTimes(2)
    }
  })

  it('does not retry a complete but invalid JSON response body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      networkRetries: 3,
      retryBaseDelayMs: 0
    })

    await expect(cli.objectInfo()).rejects.toBeInstanceOf(SyntaxError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry hostname-resolution failures', async () => {
    const resolveHostname = vi.fn().mockRejectedValue(new Error('resolver unavailable'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname,
      networkRetries: 3,
      retryBaseDelayMs: 0
    })

    await expect(cli.objectInfo()).rejects.toThrow('hostname resolution failed')
    expect(resolveHostname).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one deadline across DNS, retryable headers, backoff, and the retried body', async () => {
    vi.useFakeTimers()
    try {
      const resolveHostname = vi.fn(
        () =>
          new Promise<readonly [{ address: '8.8.8.8'; family: 4 }]>((resolve) => {
            setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 10)
          })
      )
      let fetchAttempt = 0
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              fetchAttempt += 1
              if (fetchAttempt === 1) {
                resolve(new Response('busy', { status: 503 }))
                return
              }
              let bodyTimer: ReturnType<typeof setTimeout> | undefined
              resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      bodyTimer = setTimeout(() => {
                        controller.enqueue(new TextEncoder().encode('{"LoadImage":{}}'))
                        controller.close()
                      }, 70)
                    },
                    cancel() {
                      if (bodyTimer) clearTimeout(bodyTimer)
                    }
                  })
                )
              )
            }, 10)
          })
      )
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'https://comfy.example.com/',
        resolveHostname,
        networkRetries: 1,
        retryBaseDelayMs: 10,
        requestTimeoutMs: 100
      })

      const request = cli.objectInfo()
      const rejected = expect(request).rejects.toThrow('timed out after 100 ms')
      await vi.advanceTimersByTimeAsync(101)
      await rejected
      expect(resolveHostname).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry non-idempotent prompt submissions after an ambiguous server failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('temporary', { status: 503 }))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      networkRetries: 3,
      retryBaseDelayMs: 0
    })

    await expect(cli.prompt({ prompt: {}, client_id: 'batch' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry prompt transport or successful-response body failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      networkRetries: 3,
      retryBaseDelayMs: 0
    })

    const reset = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: reset }))
    await expect(cli.prompt({ prompt: {}, client_id: 'batch' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockReset().mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(reset)
          }
        })
      )
    )
    await expect(cli.prompt({ prompt: {}, client_id: 'batch' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses an explicit instance origin without changing the global config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/'
    })

    await cli.objectInfo()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://8.8.4.4:8189/object_info')

    cli.connect()
    const connectUrl = String((webSocketCtor.mock.calls[0] as unknown[] | undefined)?.[0] ?? '')
    expect(connectUrl).toContain('ws://8.8.4.4:8189/ws?clientId=')
  })

  it.each([
    'file:///tmp/comfy',
    'ftp://example.test',
    'http://user:secret@example.test',
    'http://example.test/api',
    'http://example.test/?token=x',
    'http://example.test/#fragment'
  ])('rejects an invalid explicit instance origin %s', async (origin) => {
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, { origin })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(cli.objectInfo()).rejects.toThrow('Invalid ComfyUI base URL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'http://0.0.0.0:8188',
    'http://169.254.169.254/latest/meta-data',
    'http://224.0.0.1:8188',
    'http://[::]:8188',
    'http://[fe80::1]:8188',
    'http://[ff02::1]:8188',
    'http://[::8.8.8.8]:8188',
    'http://192.31.196.1:8188',
    'http://192.52.193.1:8188',
    'http://192.88.99.1:8188',
    'http://192.175.48.1:8188',
    'http://[64:ff9b::7f00:1]:8188',
    'http://[2001::1]:8188',
    'http://[2001:10::1]:8188',
    'http://[2001:20::1]:8188',
    'http://[2002:7f00:1::]:8188',
    'http://[fec0::1]:8188',
    'http://[3fff::1]:8188',
    'http://[::ffff:169.254.169.254]:8188',
    'http://[::ffff:192.88.99.1]:8188'
  ])('rejects an unsafe literal IP destination %s', async (origin) => {
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, { origin })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(cli.objectInfo()).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'http://localhost:8188',
    'http://127.0.0.1:8188',
    'http://10.0.0.10:8188',
    'http://172.16.1.10:8188',
    'http://192.168.1.10:8188',
    'http://[::1]:8188'
  ])('retains private destination support only for a trusted local instance %s', async (origin) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin,
      remote: false
    })

    await expect(cli.objectInfo()).resolves.toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    '169.254.169.254',
    '192.88.99.1',
    '::ffff:192.88.99.1',
    '64:ff9b::7f00:1',
    '2001::1',
    '2001:10::1',
    '2001:20::1',
    '2620:4f:8000::1',
    '2002:7f00:1::',
    'fec0::1',
    '3fff::1'
  ])('rejects a remote hostname when DNS resolves to unsafe destination %s', async (address) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname: async () => [{ address, family: address.includes(':') ? 6 : 4 }]
    })

    await expect(cli.objectInfo()).rejects.toThrow('Unsafe ComfyUI DNS destination')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pins a validated public DNS result into the HTTP dispatcher', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }]
    })

    await expect(cli.objectInfo()).resolves.toEqual({})
    expect(fetchMock).toHaveBeenCalledWith(
      'https://comfy.example.com/object_info',
      expect.objectContaining({ dispatcher: expect.any(Object), redirect: 'manual' })
    )
  })

  it('rejects redirects instead of following them', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } })
      )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/'
    })

    await expect(cli.objectInfo()).rejects.toThrow('redirect rejected')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' })
    )
  })

  it('bounds response body size even without content-length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"long":"payload"}'))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      responseMaxBytes: 4
    })

    await expect(cli.objectInfo()).rejects.toThrow('response body exceeds')
  })

  it('times out while reading a response body that never finishes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
          }
        })
      )
    )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      requestTimeoutMs: 5
    })

    await expect(cli.objectInfo()).rejects.toThrow('response body timed out')
  })

  it('bounds hanging response cancellation by the absolute deadline', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    let destroySpy: ReturnType<typeof vi.spyOn> | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const dispatcher = (init as (RequestInit & { dispatcher?: Agent }) | undefined)?.dispatcher
      if (!dispatcher) throw new Error('expected a pinned dispatcher')
      destroySpy = vi.spyOn(dispatcher, 'destroy').mockResolvedValue(undefined)
      return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 })
    })
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
      networkRetries: 3,
      retryBaseDelayMs: 0,
      requestTimeoutMs: 50
    })

    const request = cli.objectInfo()
    const rejected = expect(request).rejects.toThrow('timed out after 50 ms')
    await vi.advanceTimersByTimeAsync(51)
    await rejected

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(destroySpy).toBeDefined()
    expect(destroySpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a request after the configured timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      requestTimeoutMs: 5
    })

    await expect(cli.objectInfo()).rejects.toThrow()
  })

  it.each([
    ['object_info', (cli: ComfyHttpCli, signal?: AbortSignal) => cli.objectInfo(signal)],
    ['queue', (cli: ComfyHttpCli, signal?: AbortSignal) => cli.getQueue(signal)],
    ['history', (cli: ComfyHttpCli, signal?: AbortSignal) => cli.historyAll(signal)]
  ] as const)(
    'enforces the deadline when %s headers never resolve and fetch ignores AbortSignal',
    async (_name, invoke) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
      const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
        origin: 'http://8.8.4.4:8189/',
        requestTimeoutMs: 5,
        networkRetries: 0
      })

      await expect(invoke(cli)).rejects.toThrow('response body timed out after 5 ms')
    }
  )

  it('honors a caller AbortSignal when headers never resolve and fetch ignores the signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
    const controller = new AbortController()
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      requestTimeoutMs: 30_000,
      networkRetries: 0
    })
    const request = cli.getQueue(controller.signal)
    controller.abort(new DOMException('caller stopped', 'AbortError'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError', message: 'caller stopped' })
  })

  it('cancels viewResponse body when the caller aborts before its first read', async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Keep the underlying response pending until the caller aborts.
      }
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    const destroySpy = vi.spyOn(Agent.prototype, 'destroy')
    const controller = new AbortController()
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }]
    })

    const response = await cli.viewResponse(
      { filename: 'x.png', subfolder: '', type: 'output' },
      controller.signal
    )
    controller.abort()

    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' })
    expect(destroySpy).toHaveBeenCalled()
  })

  it('cancels a response body when content-length validation fails', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { headers: { 'content-length': '999' } })
    )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      responseMaxBytes: 4
    })

    await expect(cli.objectInfo()).rejects.toThrow('response body exceeds')
    expect(cancel).toHaveBeenCalled()
  })

  it('uses one deadline while DNS resolution is pending', async () => {
    vi.useFakeTimers()
    let resolveDns!: (addresses: readonly { address: string; family: 4 }[]) => void
    const resolveHostname = vi.fn(
      () =>
        new Promise<readonly { address: string; family: 4 }[]>((resolve) => {
          resolveDns = resolve
        })
    )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'https://comfy.example.com/',
      requestTimeoutMs: 10,
      resolveHostname
    })
    const request = cli.objectInfo()
    const requestError = expect(request).rejects.toThrow('response body timed out')

    await vi.advanceTimersByTimeAsync(11)
    await requestError
    expect(resolveHostname).toHaveBeenCalledTimes(1)
    resolveDns([{ address: '8.8.8.8', family: 4 }])
  })

  it('does not reset the deadline before retry backoff', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('temporary', { status: 503 }))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      origin: 'http://8.8.4.4:8189/',
      requestTimeoutMs: 10,
      networkRetries: 3,
      retryBaseDelayMs: 100
    })
    const request = cli.objectInfo()
    const requestError = expect(request).rejects.toThrow('response body timed out')

    await vi.advanceTimersByTimeAsync(11)
    await requestError
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
