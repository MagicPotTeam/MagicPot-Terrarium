import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { buildRemoteLlmServerErrorMessage } from '@renderer/utils/llmProfileUtils'
import {
  isInvalidSessionContinuationError,
  requestChatCompletion,
  requestChatCompletionStream
} from './chatRequestUtils'

const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: true,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] },
  remote_llm_server_config: { server_origin: 'https://fixture-proxy.example', access_token: '' }
}
const run = (stream = false, signal?: AbortSignal, sessionUrl = '') => {
  const input = {
    config,
    profileId: 'remote-only',
    sessionUrl: sessionUrl || undefined,
    signal,
    messages: [{ role: 'user' as const, content: 'Continue the fixture session.' }]
  }
  return stream
    ? requestChatCompletionStream({ ...input, onEvent: vi.fn() })
    : requestChatCompletion(input)
}
beforeEach(() => {
  window.api = { svcManagedMedia: {} } as unknown as Window['api']
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const unavailable = 'Session endpoint is unavailable; use the legacy API'

describe('statusText and server-detail separation', () => {
  it.each([
    [false, 2],
    [true, 2],
    [false, 4],
    [true, 4]
  ] as const)(
    'resolves a legacy response after a 404 Not Found session endpoint (stream=%s, requests=%s)',
    async (stream, requests) => {
      const responses = [new Response(unavailable, { status: 404, statusText: 'Not Found' })]
      if (requests === 4) {
        responses.push(
          new Response('route unavailable', { status: 405, statusText: 'Method Not Allowed' }),
          new Response('route unavailable', { status: 410, statusText: 'Gone' })
        )
      }
      const reads = responses.map((response) => vi.spyOn(response, 'text'))
      const success = new Response('{"content":"Fixture legacy result."}')
      const successRead = vi.spyOn(success, 'json')
      responses.push(success)
      const fetchMock = vi.fn()
      for (const response of responses) fetchMock.mockResolvedValueOnce(response)
      vi.stubGlobal('fetch', fetchMock)
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const result = await run(stream, controller.signal)
      expect(stream ? (result as { result: unknown }).result : result).toMatchObject({
        content: 'Fixture legacy result.'
      })
      expect(fetchMock).toHaveBeenCalledTimes(requests)
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
        ['/api/chat', '/api/bot/chat', '/api/bot/message', '/api/message']
          .slice(0, requests)
          .map((endpoint) => 'https://fixture-proxy.example' + endpoint)
      )
      for (const read of reads) expect(read).toHaveBeenCalledTimes(1)
      expect(successRead).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledTimes(requests)
      expect(responses.every((response) => response.bodyUsed)).toBe(true)
    }
  )

  it.each([
    [404, 'Not Found', unavailable],
    [404, 'Not Found', JSON.stringify({ error: unavailable })],
    [410, 'expired session continuation', 'route unavailable'],
    [404, 'session', 'route not found']
  ])('does not borrow evidence from statusText (%s %s; %s)', (status, statusText, body) => {
    const message = buildRemoteLlmServerErrorMessage(
      'chat',
      { status: Number(status), statusText: String(statusText) },
      String(body)
    )
    const error = Object.assign(new Error(message), { status: Number(status), body: String(body) })
    for (const hasSession of [false, true]) {
      expect(isInvalidSessionContinuationError(error, hasSession)).toBe(false)
    }
  })

  it.each([404, 405, 410])(
    'preserves definitive structured server details with status %s',
    (status) => {
      for (const detail of ['previous_response not found', 'expired session continuation']) {
        const body = JSON.stringify({
          error: {
            code:
              detail === 'previous_response not found'
                ? 'previous_response_not_found'
                : 'session_expired',
            message: detail
          }
        })
        const message = buildRemoteLlmServerErrorMessage(
          'chat',
          { status, statusText: 'Fixture reason phrase' },
          body
        )
        expect(
          isInvalidSessionContinuationError(
            Object.assign(new Error(message), {
              status,
              body: JSON.stringify({
                error: {
                  code:
                    detail === 'previous_response not found'
                      ? 'previous_response_not_found'
                      : 'session_expired',
                  message: detail
                }
              })
            }),
            true
          )
        ).toBe(true)
        expect(
          isInvalidSessionContinuationError(
            Object.assign(new Error(`${status} ${detail}`), {
              status,
              body: JSON.stringify({
                error: {
                  code:
                    detail === 'previous_response not found'
                      ? 'previous_response_not_found'
                      : 'session_expired'
                }
              })
            }),
            true
          )
        ).toBe(true)
      }
    }
  )

  it.each([
    'expired session continuation',
    'previous_response not found',
    '500 expired session continuation',
    '405 previous_response not found',
    '503 Not Found. Server message: expired session continuation',
    'Server message: previous_response not found',
    '404 Not Found',
    '410 expired session',
    '404 session continuation',
    '410 expired session continuation',
    '404 previous_response not found'
  ])('never treats unstructured wording as replay evidence: %s', (message) => {
    for (const hasSession of [false, true]) {
      expect(isInvalidSessionContinuationError(new Error(message), hasSession)).toBe(false)
    }
  })

  it.each([undefined, '404', 200, 401, 403, 429, 500, 503])(
    'does not infer status from message digits when structured status is %s',
    (status) => {
      const error = Object.assign(new Error('404 previous_response not found'), {
        status,
        body: JSON.stringify({ error: { code: 'previous_response_not_found' } })
      })
      for (const hasSession of [false, true]) {
        expect(isInvalidSessionContinuationError(error, hasSession)).toBe(false)
      }
    }
  )

  it.each([
    'expired session continuation',
    '{malformed',
    JSON.stringify({ error: 'previous_response_not_found' }),
    JSON.stringify({ error: { message: 'expired session continuation' } }),
    JSON.stringify({ continuation: true }),
    JSON.stringify({ error: { is_continuation: true } }),
    JSON.stringify({ error: { code: 'upstream_failure', continuation: true } })
  ])('rejects body without an allowlisted structured code/type: %s', (body) => {
    const error = Object.assign(new Error('410 expired session continuation'), {
      status: 410,
      body
    })
    for (const hasSession of [false, true]) {
      expect(isInvalidSessionContinuationError(error, hasSession)).toBe(false)
    }
  })

  it.each(['code', 'type'])(
    'recognizes structured %s without relying on error wording',
    (field) => {
      const error = Object.assign(new Error('Fixture failure'), {
        status: 410,
        body: JSON.stringify({ error: { [field]: 'session_expired' } })
      })
      expect(isInvalidSessionContinuationError(error, false)).toBe(false)
      expect(isInvalidSessionContinuationError(error, true)).toBe(true)
    }
  )

  it.each([
    [false, 404, 'Not Found', 'previous_response not found'],
    [true, 404, 'Not Found', 'previous_response not found'],
    [false, 410, 'Gone', 'expired session continuation'],
    [true, 410, 'Gone', 'expired session continuation']
  ] as const)(
    'does not fall back for explicit detail (stream=%s, status=%s %s, detail=%s)',
    async (stream, status, statusText, detail) => {
      const response = new Response(
        JSON.stringify({
          error: {
            code:
              detail === 'previous_response not found'
                ? 'previous_response_not_found'
                : 'session_expired',
            message: detail
          }
        }),
        { status, statusText }
      )
      const read = vi.spyOn(response, 'text')
      const fetchMock = vi.fn().mockResolvedValueOnce(response)
      fetchMock.mockResolvedValueOnce(new Response('{"content":"Must not reach legacy"}'))
      vi.stubGlobal('fetch', fetchMock)
      const error = await run(stream, undefined, 'expired-fixture-session').catch(
        (reason: unknown) => reason
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(detail)
      expect(isInvalidSessionContinuationError(error, true)).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
    }
  )
})

describe('remote endpoint fallback preserves application continuation errors', () => {
  it.each([404, 410])(
    'preserves streamed continuation diagnostics from the main callback at status %s',
    async (status) => {
      const localConfig: Config = {
        ...config,
        use_remote_llm: false,
        llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] },
        local_llm_server_config: {
          ...DEFAULT_CONFIG.local_llm_server_config
        }
      }
      const onEvent = vi.fn()
      window.api = {
        svcManagedMedia: {},
        svcLLMProxy: {
          chatStream: vi.fn(async (_request, stream) => {
            stream.onData({
              type: 'error',
              delta: '',
              done: false,
              error: `${status} stale continuation`,
              status,
              body: JSON.stringify({ error: { code: 'session_expired', continuation: true } })
            })
            stream.onData({
              type: 'done',
              delta: '',
              done: true,
              error: `${status} stale continuation`,
              status,
              body: JSON.stringify({ error: { code: 'session_expired', continuation: true } })
            })
          })
        }
      } as unknown as Window['api']

      const error = await requestChatCompletionStream({
        config: localConfig,
        profileId: 'local-fixture',
        sessionUrl: 'real-fixture-session',
        messages: [{ role: 'user', content: 'Continue the fixture session.' }],
        onEvent
      }).catch((reason: unknown) => reason)

      expect(onEvent).toHaveBeenCalledWith({
        type: 'error',
        error: `${status} stale continuation`
      })
      expect(error).toBeInstanceOf(Error)
      expect(isInvalidSessionContinuationError(error, true)).toBe(true)
      expect(error).toMatchObject({
        status,
        body: JSON.stringify({ error: { code: 'session_expired', continuation: true } })
      })
    }
  )

  it('does not classify a streamed generic error without continuation evidence', async () => {
    const onEvent = vi.fn()
    window.api = {
      svcManagedMedia: {},
      svcLLMProxy: {
        chatStream: vi.fn(async (_request, stream) => {
          stream.onData({
            type: 'error',
            delta: '',
            done: false,
            error: '404 generic upstream failure',
            status: 404,
            body: JSON.stringify({ error: { code: 'upstream_failure' } })
          })
          stream.onData({
            type: 'done',
            delta: '',
            done: true,
            error: '404 generic upstream failure',
            status: 404,
            body: JSON.stringify({ error: { code: 'upstream_failure' } })
          })
        })
      }
    } as unknown as Window['api']

    const error = await requestChatCompletionStream({
      config: { ...config, use_remote_llm: false },
      profileId: 'local-fixture',
      sessionUrl: 'real-fixture-session',
      messages: [{ role: 'user', content: 'Continue the fixture session.' }],
      onEvent
    }).catch((reason: unknown) => reason)

    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      error: '404 generic upstream failure'
    })
    expect(isInvalidSessionContinuationError(error, true)).toBe(false)
  })

  it('never classifies a continuation-shaped error without a session URL', () => {
    const error = Object.assign(new Error('Remote chat request failed (404 Not Found)'), {
      status: 404,
      body: JSON.stringify({ code: 'session_not_found', continuation: true })
    })
    expect(isInvalidSessionContinuationError(error)).toBe(false)
  })

  it('classifies structured stale continuation only with a session URL', () => {
    const error = Object.assign(new Error('Remote chat request failed (410 Gone)'), {
      status: 410,
      body: JSON.stringify({ error: { code: 'session_expired' } })
    })
    expect(isInvalidSessionContinuationError(error)).toBe(false)
    expect(isInvalidSessionContinuationError(error, true)).toBe(true)
  })

  it.each([404, 410])(
    'does not replace a %s continuation failure with legacy endpoint errors',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ error: 'legacy route missing' }), { status: 404 })
        )
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'session_expired', message: 'expired session continuation' }
          }),
          { status }
        )
      )
      vi.stubGlobal('fetch', fetchMock)
      const error = await run(false, undefined, 'expired-fixture-session').catch(
        (reason: unknown) => reason
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('expired session continuation')
      expect(isInvalidSessionContinuationError(error, true)).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([false, true])(
    'propagates continuation failure after one genuinely missing endpoint (stream=%s)',
    async (stream) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ error: 'missing' }), { status: 404 })
        )
      fetchMock.mockResolvedValueOnce(new Response('{"error":"missing"}', { status: 404 }))
      fetchMock.mockResolvedValueOnce(
        new Response(
          '{"error":{"code":"previous_response_not_found","message":"previous_response not found"}}',
          { status: 404 }
        )
      )
      vi.stubGlobal('fetch', fetchMock)
      const error = await run(stream, undefined, 'expired-fixture-session').catch(
        (reason: unknown) => reason
      )
      expect(isInvalidSessionContinuationError(error, true)).toBe(true)
      expect(String(error)).toContain('previous_response not found')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it('still falls back on endpoint-level 404/405/410 and reads the successful response once', async () => {
    const fetchMock = vi.fn()
    for (const status of [404, 405, 410]) {
      fetchMock.mockResolvedValueOnce(new Response('{"error":"route unavailable"}', { status }))
    }
    const response = new Response('{"content":"Fixture legacy result."}')
    const read = vi.spyOn(response, 'json')
    fetchMock.mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(run()).resolves.toMatchObject({ content: 'Fixture legacy result.' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('retains the last endpoint error without reading a consumed body twice', async () => {
    const responses = [404, 405, 410, 404].map(
      (status) => new Response('{"error":"last route missing"}', { status })
    )
    const reads = responses.map((response) => vi.spyOn(response, 'text'))
    const fetchMock = vi.fn()
    for (const response of responses) fetchMock.mockResolvedValueOnce(response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(run()).rejects.toThrow('last route missing')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    for (const read of reads) expect(read).toHaveBeenCalledTimes(1)
  })

  it.each(['timeout', 'cancel'] as const)(
    'bounds reading a fallback body and releases its resources on %s',
    async (kind) => {
      vi.useFakeTimers()
      const cancel = vi.fn(async () => undefined)
      const text = vi.fn(() => new Promise<string>(() => undefined))
      const response = { ok: false, status: 404, text, body: { cancel } }
      const fetchMock = vi.fn().mockResolvedValue(response)
      vi.stubGlobal('fetch', fetchMock)
      const controller = new AbortController()
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = run(false, controller.signal).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      expect(text).toHaveBeenCalledTimes(1)
      if (kind === 'timeout') {
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(await pending).toMatchObject({ name: 'TimeoutError' })
      } else {
        controller.abort(new DOMException('Fixture cancel', 'AbortError'))
        expect(await pending).toMatchObject({ name: 'AbortError' })
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('settles an uncertain POST failure without queuing a retry or replacing it on later abort', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const failure = new Error('fixture response lost after POST acceptance')
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetchMock)

    let settled = false
    const pending = run(false, controller.signal).catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    await expect(pending).resolves.toBe(failure)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://fixture-proxy.example/api/chat',
      expect.objectContaining({ method: 'POST' })
    )
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)

    controller.abort(new Error('fixture cancellation after settlement'))
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    await expect(pending).resolves.toBe(failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses one absolute deadline across retry attempts instead of restarting it', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetchMock)

    const pending = run(false).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toMatchObject({ name: 'TimeoutError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
