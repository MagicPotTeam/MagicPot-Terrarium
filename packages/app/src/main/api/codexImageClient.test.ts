import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ ensure: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }))
vi.mock('./codexOAuth', () => ({
  ensureCodexCliAuthTokens: h.ensure,
  forceRefreshCodexCliAuthTokens: h.refresh
}))
import { CodexImageClient, type CodexImageAuth, type CodexImageOptions } from './codexImageClient'
import { __resetCodexRequestGovernorForTests } from './codexRequestGovernor'

type ClientConfig = ConstructorParameters<typeof CodexImageClient>[0]
const session = (accessToken: string) => ({
  accessToken,
  accountId: 'account-fixture',
  refreshToken: 'refresh',
  idToken: 'id',
  authFilePath: 'fixture only',
  connectedAt: '2026-01-01T00:00:00Z'
})
// QUJD is intentionally a structural transport fixture, not a decoded PNG.
const ok = (extra: object = {}) =>
  Response.json({
    data: [{ b64_json: 'QUJD', generation_id: 'g-1' }],
    output_format: 'png',
    ...extra
  })
const oauth = (extra: Partial<ClientConfig> = {}) =>
  new CodexImageClient({ auth: { mode: 'oauth' }, fetchImpl: h.fetch, ...extra })
const custom = (extra: Partial<ClientConfig> = {}) =>
  new CodexImageClient({
    auth: { mode: 'api-key', baseUrl: 'https://corp.test/codex/', apiKey: 'custom-fixture' },
    fetchImpl: h.fetch,
    ...extra
  })
const request = (index = 0): RequestInit => h.fetch.mock.calls[index][1]
const body = (index = 0) => JSON.parse(String(request(index).body))

beforeEach(() => {
  __resetCodexRequestGovernorForTests()
  h.fetch.mockReset()
  h.ensure.mockReset().mockResolvedValue(session('oauth-fixture'))
  h.refresh.mockReset().mockResolvedValue(session('fresh-fixture'))
  h.fetch.mockImplementation(async () => ok())
})
afterEach(() => {
  __resetCodexRequestGovernorForTests()
  vi.useRealTimers()
})

describe('standalone Codex JSON Images contract (not public multipart or hosted Responses)', () => {
  it('posts generation to the pinned OAuth backend with fixed model/auto options and normal attachments', async () => {
    const result = await oauth().generate('  a frog  ', { transparentBackground: true })
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.fetch.mock.calls[0][0]).toBe(
      'https://chatgpt.com/backend-api/codex/images/generations'
    )
    expect(request()).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer oauth-fixture',
        'chatgpt-account-id': 'account-fixture',
        'Content-Type': 'application/json'
      }
    })
    expect(body()).toEqual({
      prompt: 'a frog',
      background: 'transparent',
      model: 'gpt-image-2',
      quality: 'auto',
      size: 'auto'
    })
    expect(result).toMatchObject({
      content: '',
      finishReason: 'stop',
      attachments: [
        {
          type: 'image',
          url: 'data:image/png;base64,QUJD',
          mimeType: 'image/png',
          metadata: { generationId: 'g-1' }
        }
      ]
    })
    expect(result).not.toHaveProperty('sessionUrl')
  })

  it.each([
    ['parse', () => new Response('broken private body', { status: 200 }), 'decode', 200],
    ['empty', () => Response.json({ data: [] }), 'decode', 200],
    [
      'broken stream',
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('fixture truncation'))
            }
          })
        ),
      'receive',
      200
    ],
    ['gateway error', () => new Response('', { status: 502 }), 'request', 502]
  ] as const)('reports %s without redispatch', async (_name, reply, phase, http) => {
    h.fetch.mockImplementationOnce(async () => reply())
    await expect(custom().generate('fixture')).rejects.toMatchObject({
      retryBlocked: true,
      imageHttpStatus: http,
      imageFailureStage: phase,
      imageClientRequestId: expect.stringMatching(/^[a-f0-9-]{36}$/i)
    })
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('uses JSON inline edit images instead of multipart and detaches input before auth awaits', async () => {
    let release!: (value: ReturnType<typeof session>) => void
    h.ensure.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const images = ['data:image/png;base64,QUJD']
    const options = { transparentBackground: true }
    const pending = oauth().edit('cut out', images, options)
    images[0] = 'https://changed.test/image'
    options.transparentBackground = false
    release(session('oauth-fixture'))
    await pending
    expect(h.fetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/images/edits')
    expect(body()).toEqual({
      images: [{ image_url: 'data:image/png;base64,QUJD' }],
      prompt: 'cut out',
      background: 'transparent',
      model: 'gpt-image-2',
      quality: 'auto',
      size: 'auto'
    })
    expect(typeof request().body).toBe('string')
  })

  it('custom base URL/key neither reads nor refreshes OAuth and never falls back on 401', async () => {
    h.fetch.mockResolvedValue(
      Response.json(
        { detail: 'key denied' },
        {
          status: 401,
          headers: { 'x-codex-imagegen-request-id': 'req-9' }
        }
      )
    )
    await expect(custom().generate('x')).rejects.toMatchObject({
      statusCode: 401,
      message: 'Codex image generation failed (HTTP 401): key denied [imagegen request req-9]',
      retryBlocked: true
    })
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.fetch.mock.calls[0][0]).toBe('https://corp.test/codex/images/generations')
    expect(request().headers).toMatchObject({ Authorization: 'Bearer custom-fixture' })
    expect(request().headers).not.toHaveProperty('chatgpt-account-id')
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('refreshes only an OAuth 401 once with the exact same body and idempotency key', async () => {
    h.fetch
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockImplementationOnce(async () => ok())
    await oauth().generate('x')
    expect(h.refresh).toHaveBeenCalledOnce()
    expect(h.ensure).toHaveBeenCalledOnce()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(request(1).headers).toMatchObject({ Authorization: 'Bearer fresh-fixture' })
    expect(request(1).body).toBe(request(0).body)
    expect((request(1).headers as Record<string, string>)['Idempotency-Key']).toBe(
      (request(0).headers as Record<string, string>)['Idempotency-Key']
    )
  })

  it('never refreshes again after a second OAuth 401', async () => {
    h.fetch.mockImplementation(async () => new Response('', { status: 401 }))
    await expect(oauth().generate('x')).rejects.toMatchObject({
      statusCode: 401,
      retryBlocked: true
    })
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it.each([302, 429, 500])('does not auto-retry or fallback after HTTP %s', async (status) => {
    h.fetch.mockImplementation(
      async () =>
        new Response('', {
          status,
          headers: { location: 'https://elsewhere.test', 'retry-after': '1' }
        })
    )
    await expect(oauth().generate('x')).rejects.toMatchObject({
      statusCode: status,
      retryBlocked: true
    })
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('sends flat GIF controls only when the factory supplies the trusted backend capability', async () => {
    await expect(oauth().generate('loop', { gif: {} })).rejects.toThrow('GIF output is not enabled')
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
    h.fetch.mockImplementation(async () => ok({ output_format: 'gif' }))
    const result = await oauth({ enableGif: true }).generate('loop', {
      gif: { frameCount: 4, frameDurationMs: 100 }
    })
    expect(body()).toEqual({
      prompt: 'loop',
      background: 'opaque',
      model: 'gpt-image-2',
      quality: 'auto',
      size: 'auto',
      output_format: 'gif',
      frame_count: 4,
      frame_duration_ms: 100
    })
    expect(result.attachments?.[0].mimeType).toBe('image/gif')
  })

  it.each([
    { frameCount: 1 },
    { frameCount: 17 },
    { frameCount: true },
    { frameDurationMs: 19 },
    { frameDurationMs: 2001 },
    { frameDurationMs: 1.5 },
    { bogus: 1 }
  ])('rejects malformed GIF controls before auth/fetch (%j)', async (gif) => {
    await expect(
      oauth({ enableGif: true }).generate('loop', {
        gif: gif as unknown as CodexImageOptions['gif']
      })
    ).rejects.toThrow()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each(['', '  ', 7])(
    'rejects invalid prompts without coercion or auth (%j)',
    async (prompt) => {
      await expect(oauth().generate(prompt as string)).rejects.toThrow('prompt')
      expect(h.ensure).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it.each([
    [],
    Array(6).fill('data:image/png;base64,AA=='),
    ['file:///private.png'],
    ['http://public.test/a.png'],
    ['data:text/html;base64,QUJD'],
    ['data:image/svg+xml;base64,QUJD']
  ])('rejects invalid edit inputs without fetch/auth (%j)', async (images) => {
    await expect(oauth().edit('x', images)).rejects.toThrow()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'api-key', baseUrl: 'https://corp.test/codex', apiKey: '' },
    { mode: 'api-key', baseUrl: 'https://user:pass@corp.test', apiKey: 'key' },
    { mode: 'api-key', baseUrl: 'https://corp.test?key=secret', apiKey: 'key' },
    { mode: 'api-key', baseUrl: 'http://public.test', apiKey: 'key' },
    { mode: 'api-key', baseUrl: 'https://api.openai.com/v1', apiKey: 'key' },
    { mode: 'oauth', baseUrl: 'https://corp.test' },
    { mode: 'oauth', apiKey: 'key' }
  ])('rejects mixed/misconfigured auth before login or dispatch (%j)', async (auth) => {
    await expect(
      new CodexImageClient({
        auth: auth as CodexImageAuth,
        fetchImpl: h.fetch
      }).generate('x')
    ).rejects.toThrow()
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { data: [] },
    { content: 'submitted', task_id: 't' },
    { data: [{ url: 'https://unrequested.test/result.png' }] },
    { data: [{ b64_json: '<html>' }] },
    { data: [{ b64_json: 'QUJD' }], output_format: 'svg' },
    { data: [{ b64_json: 'QUJD' }], output_format: 'gif' }
  ])(
    'requires allowed structural inline data, not tasks/text/URLs or unsupported format (%j)',
    async (payload) => {
      h.fetch.mockImplementation(async () => Response.json(payload))
      await expect(oauth().generate('x')).rejects.toThrow()
      expect(h.fetch).toHaveBeenCalledOnce()
      expect(h.refresh).not.toHaveBeenCalled()
    }
  )

  it('redacts stale and refreshed credentials before truncation and from request IDs', async () => {
    h.fetch
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockImplementationOnce(async () =>
        Response.json(
          {
            detail: 'oauth-fixture fresh-fixture ' + 'x'.repeat(1000) + 'fresh-fixture'
          },
          { status: 400, headers: { 'x-codex-imagegen-request-id': 'oauth-fixture' } }
        )
      )
    const error = await oauth()
      .generate('failure redaction fixture')
      .catch((error) => error)
    expect(error.message).not.toContain('oauth-fixture')
    expect(error.message).not.toContain('fresh-fixture')
  })

  it('carries no raw HTTP error body/headers/cause and redacts active credentials in its message', async () => {
    h.fetch.mockImplementation(async () =>
      Response.json(
        {
          detail: 'bad oauth-fixture custom-fixture prompt-secret'
        },
        { status: 400 }
      )
    )
    const error = await oauth()
      .generate('prompt-secret')
      .catch((error) => error)
    expect(error.message).not.toContain('oauth-fixture')
    expect(error).not.toHaveProperty('body')
    expect(error).not.toHaveProperty('headers')
    expect(error).not.toHaveProperty('cause')
  })

  it('preserves caller abort reason before dispatch and aborts a noncooperative fetch without retry', async () => {
    const controller = new AbortController()
    const reason = new Error('Stop fixture')
    controller.abort(reason)
    await expect(oauth().generate('x', { signal: controller.signal })).rejects.toBe(reason)
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
    const running = new AbortController()
    let started!: () => void
    const latch = new Promise<void>((resolve) => {
      started = resolve
    })
    h.fetch.mockImplementation(() => {
      started()
      return new Promise(() => undefined)
    })
    const pending = oauth().generate('x', { signal: running.signal })
    await latch
    running.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect((request().signal as AbortSignal).aborted).toBe(true)
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('uses one absolute deadline including auth waits and never retries unknown outcomes', async () => {
    vi.useFakeTimers()
    h.ensure.mockImplementation(() => new Promise(() => undefined))
    const pending = oauth({ timeoutMs: 1000 })
      .generate('x')
      .catch((error) => error)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toMatchObject({ name: 'TimeoutError' })
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('rejects sparse edit arrays rather than serializing holes as null images', async () => {
    await expect(oauth().edit('x', new Array(1))).rejects.toThrow('image input')
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('bounds edit bytes before any authentication and rejects more than the documented input budget', async () => {
    await expect(
      oauth().edit('x', ['data:image/png;base64,' + 'A'.repeat(28 * 1024 * 1024)])
    ).rejects.toThrow('byte limit')
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://api.openai.com./v1',
    'https://api.openai.com:443/v1',
    'https://corp.test/v1/%69mages/%65dits'
  ])(
    'rejects alternate public/protocol operation URLs before custom credentials dispatch (%s)',
    async (baseUrl) => {
      await expect(
        new CodexImageClient({
          auth: { mode: 'api-key', baseUrl, apiKey: 'custom-fixture' },
          fetchImpl: h.fetch
        }).generate('x')
      ).rejects.toThrow()
      expect(h.ensure).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
    }
  )

  it.each([1, 8])(
    'accepts a %s-MiB structural image payload without regex stack exhaustion',
    async (mib) => {
      const b64 = 'A'.repeat(mib * 1024 * 1024)
      h.fetch.mockImplementation(async () => ok({ data: [{ b64_json: b64 }] }))
      const result = await oauth().generate('large transport fixture')
      expect(result.attachments?.[0].sizeBytes).toBe(mib * 786432)
      expect(h.fetch).toHaveBeenCalledOnce()
    }
  )

  it('retains the caller signal snapshot across auth and ignores later option mutation', async () => {
    const controller = new AbortController()
    const replacement = new AbortController()
    const reason = new Error('original Stop')
    let release!: (value: ReturnType<typeof session>) => void
    h.ensure.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const options = { signal: controller.signal }
    const pending = oauth().generate('signal fixture', options)
    options.signal = replacement.signal
    controller.abort(reason)
    release(session('oauth-fixture'))
    await expect(pending).rejects.toBe(reason)
    expect(reason).not.toHaveProperty('retryBlocked')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('does not dispatch after cancellation during the single OAuth refresh', async () => {
    const controller = new AbortController()
    const reason = new Error('Stop during refresh')
    let started!: () => void
    let release!: (value: ReturnType<typeof session>) => void
    const latch = new Promise<void>((resolve) => {
      started = resolve
    })
    h.fetch.mockResolvedValueOnce(new Response('', { status: 401 }))
    h.refresh.mockImplementation(() => {
      started()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const pending = oauth().generate('refresh fixture', { signal: controller.signal })
    await latch
    controller.abort(reason)
    release(session('fresh-fixture'))
    await expect(pending).rejects.toBe(reason)
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.refresh).toHaveBeenCalledOnce()
  })

  it('bounds the response stream during reading, not only after a whole JSON allocation', async () => {
    const cancel = vi.fn()
    h.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(128 * 1024 * 1024 + 1))
            },
            cancel
          })
        )
    )
    await expect(oauth().generate('bounded stream fixture')).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it.each(['QUJD=', 'A===', 'QU=J', 'AB-_', '   ', '', 5])(
    'rejects malformed base64 structure (%j)',
    async (b64_json) => {
      h.fetch.mockImplementation(async () => ok({ data: [{ b64_json }] }))
      await expect(oauth().generate('bad base64 fixture')).rejects.toThrow()
    }
  )

  it('keeps caller cancellation authoritative through response parsing without publishing late image data', async () => {
    const controller = new AbortController()
    const reason = new Error('Stop reading image')
    let started!: () => void
    const latch = new Promise<void>((resolve) => {
      started = resolve
    })
    const cancel = vi.fn()
    h.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              started()
            },
            cancel
          })
        )
    )
    const pending = oauth().generate('cancel image body', { signal: controller.signal })
    await latch
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reuses the existing duplicate governor, without refunding failed attempts or adding a new ledger', async () => {
    h.fetch.mockImplementation(async () => new Response('', { status: 500 }))
    const client = oauth()
    for (let index = 0; index < 3; index++) {
      await expect(client.generate('repeat fixture')).rejects.toMatchObject({ statusCode: 500 })
    }
    await expect(client.generate('repeat fixture')).rejects.toMatchObject({
      code: 'CODEX_REQUEST_DUPLICATE'
    })
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })
})
