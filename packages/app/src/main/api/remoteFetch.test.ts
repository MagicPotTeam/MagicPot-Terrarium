import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMRemoteFetchReq, LLMRemoteFetchResp } from '@shared/api/svcLLMProxy'
import { DEFAULT_CONFIG } from '@shared/config/config'

const { lookupMock, requestMock, configMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  requestMock: vi.fn(),
  configMock: vi.fn()
}))
vi.mock('node:dns/promises', () => ({ default: { lookup: lookupMock } }))
vi.mock('node:https', () => ({ default: { request: requestMock }, request: requestMock }))
vi.mock('node:http', () => ({
  request: () => {
    throw new Error('Unexpected HTTP transport')
  }
}))
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/config', () => ({ getConfig: configMock, onConfigCommitted: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
vi.mock('../llmProxy/hunyuan3dCos', () => ({
  clearHy3dCosPrefix: vi.fn(),
  signHy3dCosModel: vi.fn(),
  uploadBufferedHy3dModel: vi.fn(),
  uploadLocalHy3dModel: vi.fn()
}))

import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { MAX_REMOTE_FETCH_RESPONSE_BYTES } from './remoteFetchPolicy'
import { remoteFetch } from './remoteFetch'

class MockRequest extends EventEmitter {
  destroyed = false
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn(() => {
    this.destroyed = true
    return this
  })
}
class MockResponse extends EventEmitter {
  statusCode = 200
  statusMessage = 'OK'
  headers: Record<string, string> = {}
  complete = false
  destroyed = false
  destroy = vi.fn(() => {
    this.destroyed = true
    return this
  })
}
const networkError = (code = 'ECONNRESET') => Object.assign(new Error(code), { code })
const endpoint = 'https://skills.example.com/agent?mode=raw'
const requests: MockRequest[] = []
const responders: Array<(response: MockResponse) => void> = []
let service: LLMProxySvcImpl
let outcome: { value?: LLMRemoteFetchResp; error?: Error }
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0)
}
const start = async (overrides: Partial<LLMRemoteFetchReq> = {}) => {
  outcome = {}
  void service
    .remoteFetch({
      url: endpoint,
      method: 'GET',
      timeoutMs: 2000,
      conversationId: 'fetch',
      ...overrides
    })
    .then(
      (value) => {
        outcome.value = value
      },
      (error) => {
        outcome.error = error
      }
    )
  await flush()
}
const respond = (headers: Record<string, string> = {}) => {
  const response = new MockResponse()
  response.headers = headers
  requests.at(-1)!.emit('response', response)
  return response
}
const finish = (response: MockResponse, body = 'done') => {
  response.emit('data', Buffer.from(body))
  response.complete = true
  response.emit('end')
}
const closed = (emitter: EventEmitter) => {
  emitter.emit('close')
  expect(emitter.eventNames()).toEqual([])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected external fetch')
    })
  )
  lookupMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  requestMock.mockReset().mockImplementation((_options, callback) => {
    const request = new MockRequest()
    requests.push(request)
    request.once('response', callback)
    responders.push(callback)
    return request
  })
  configMock.mockReturnValue({
    ...DEFAULT_CONFIG,
    llm_config: {
      ...DEFAULT_CONFIG.llm_config,
      customSkills: [{ id: 'agent', type: 'agent', apiAddress: endpoint }]
    }
  })
  requests.length = 0
  responders.length = 0
  service = new LLMProxySvcImpl()
})
afterEach(() => {
  service.cancelConversation({ conversationId: 'fetch' })
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('remoteFetch bounded lifetime (mock DNS/HTTPS only)', () => {
  it('expires hung DNS and ignores a late resolution', async () => {
    let resolve!: (addresses: Array<{ address: string; family: number }>) => void
    lookupMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    await start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(outcome.error?.name).toBe('TimeoutError')
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
    resolve([{ address: '93.184.216.34', family: 4 }])
    await flush()
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('registers cancellation during DNS, releases registration, ignores late DNS failure', async () => {
    let reject!: (error: Error) => void
    lookupMock.mockImplementation(
      () =>
        new Promise((_r, j) => {
          reject = j
        })
    )
    await start()
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: true
    })
    await flush()
    expect(outcome.error?.name).toBe('AbortError')
    reject(new Error('late DNS failure'))
    await flush()
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
  })

  it('does not retry a late request error after timeout', async () => {
    await start()
    requests[0].emit('timeout')
    await flush()
    requests[0].emit('error', networkError())
    await vi.advanceTimersByTimeAsync(5000)
    expect(outcome.error?.name).toBe('TimeoutError')
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requests[0].destroy).toHaveBeenCalledTimes(1)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses an absolute request/body deadline even with continuous data', async () => {
    await start()
    const response = respond()
    for (let i = 0; i < 4; i++) {
      response.emit('data', Buffer.from('x'))
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(outcome.error?.name).toBe('TimeoutError')
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(requests[0].destroy).toHaveBeenCalledTimes(1)
    response.emit('error', networkError())
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('distinguishes caller cancellation and releases body/request resources', async () => {
    await start()
    const response = respond()
    service.cancelConversation({ conversationId: 'fetch' })
    await flush()
    expect(outcome.error?.name).toBe('AbortError')
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(requests[0].destroy).toHaveBeenCalledTimes(1)
    requests[0].emit('error', networkError())
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['aborted', 'error', 'close'])('rejects response %s without retrying', async (event) => {
    await start()
    const response = respond()
    response.emit(event, networkError())
    await flush()
    expect(outcome.error).toBeInstanceOf(Error)
    expect(outcome.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requests[0].destroy).toHaveBeenCalledTimes(1)
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requires a complete response before accepting end', async () => {
    await start()
    const response = respond()
    response.emit('data', Buffer.from('partial'))
    response.emit('end')
    await flush()
    expect(outcome.error?.message).toMatch(/incomplete|premature/i)
    expect(outcome.value).toBeUndefined()
  })

  it('rejects request close before a response instead of waiting or retrying', async () => {
    await start()
    requests[0].emit('close')
    await flush()
    expect(outcome.error).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it.each(['content-length', 'stream'])('enforces the %s response cap', async (mode) => {
    await start()
    const response = respond(
      mode === 'content-length'
        ? { 'content-length': String(MAX_REMOTE_FETCH_RESPONSE_BYTES + 1) }
        : {}
    )
    if (mode === 'stream') response.emit('data', Buffer.alloc(MAX_REMOTE_FETCH_RESPONSE_BYTES + 1))
    await flush()
    expect(outcome.error?.message).toMatch(/too large/i)
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(requests[0].destroy).toHaveBeenCalledTimes(1)
    expect(response.listenerCount('data')).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestMock).toHaveBeenCalledTimes(1)
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a declared body length mismatch', async () => {
    await start()
    finish(respond({ 'content-length': '100' }), 'short')
    await flush()
    expect(outcome.error?.message).toMatch(/incomplete|length/i)
  })

  it('cancels immediately during GET backoff with no new attempt', async () => {
    await start({ timeoutMs: 5000 })
    requests[0].emit('error', networkError())
    closed(requests[0])
    await flush()
    service.cancelConversation({ conversationId: 'fetch' })
    await flush()
    expect(outcome.error?.name).toBe('AbortError')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('charges DNS and GET retry/backoff against one absolute budget', async () => {
    let resolve!: (addresses: Array<{ address: string; family: number }>) => void
    lookupMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    await start({ timeoutMs: 2500 })
    await vi.advanceTimersByTimeAsync(400)
    resolve([{ address: '93.184.216.34', family: 4 }])
    await flush()
    requests[0].emit('error', networkError())
    closed(requests[0])
    await vi.advanceTimersByTimeAsync(1000)
    expect(requestMock).toHaveBeenCalledTimes(2)
    requests[1].emit('error', networkError())
    closed(requests[1])
    await vi.advanceTimersByTimeAsync(1100)
    expect(outcome.error?.name).toBe('TimeoutError')
    await vi.advanceTimersByTimeAsync(10000)
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can retry GET before headers and then cleanly succeed', async () => {
    await start({ timeoutMs: 5000 })
    requests[0].emit('error', networkError())
    closed(requests[0])
    await vi.advanceTimersByTimeAsync(1000)
    const response = respond()
    finish(response)
    await flush()
    expect(outcome.value?.body).toBe('done')
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    closed(response)
    closed(requests[1])
  })

  it('never replays POST after a possibly accepted write', async () => {
    await start({ method: 'POST', body: '{"job":"synthetic"}', timeoutMs: 10000 })
    requests[0].emit('error', networkError())
    await flush()
    expect(outcome.error).toBeInstanceOf(Error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requests[0].write).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry request errors once response headers arrived', async () => {
    await start()
    const response = respond()
    requests[0].emit('error', networkError())
    await flush()
    expect(outcome.error).toBeInstanceOf(Error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestMock).toHaveBeenCalledTimes(1)
    closed(response)
    closed(requests[0])
  })

  it.each([502, 504])('preserves terminal HTTP %s status, statusText and body', async (status) => {
    await start()
    const response = respond({ 'content-length': '14' })
    response.statusCode = status
    response.statusMessage = 'Original upstream status'
    finish(response, 'raw error body')
    await flush()
    expect(outcome.value).toEqual({
      status,
      statusText: 'Original upstream status',
      body: 'raw error body'
    })
    requests[0].emit('error', networkError())
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestMock).toHaveBeenCalledTimes(1)
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns redirects unchanged without following them (existing compatibility)', async () => {
    await start()
    const response = respond({ location: 'https://127.0.0.1/private' })
    response.statusCode = 302
    finish(response, 'redirect body')
    await flush()
    expect(outcome.value?.status).toBe(302)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('preserves known headers and pins public DNS while retaining TLS hostname', async () => {
    const headers = {
      Authorization: 'Bearer synthetic',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Request-ID': 'synthetic'
    }
    await start({ method: 'POST', headers, body: '{}' })
    const options = requestMock.mock.calls[0][0]
    expect(options).toMatchObject({
      hostname: 'skills.example.com',
      family: 4,
      agent: false,
      port: 443,
      path: '/agent?mode=raw',
      method: 'POST',
      headers
    })
    const callback = vi.fn()
    options.lookup('skills.example.com', {}, callback)
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    finish(respond({ 'content-length': '4' }))
    await flush()
    expect(outcome.value?.body).toBe('done')
  })

  it('rejects any private DNS answer without opening HTTPS', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ])
    await start()
    expect(outcome.error?.message).toMatch(/private|local/)
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
  })

  it.each([
    [undefined, 300000],
    [0, 300000],
    [NaN, 300000],
    [Infinity, 300000],
    [-1, 1000],
    [1, 1000],
    [1000, 1000],
    [9999999999, 300000]
  ])('selects a finite absolute DNS timeout for %s', async (timeoutMs, budget) => {
    lookupMock.mockImplementation(() => new Promise(() => undefined))
    await start({ timeoutMs })
    await vi.advanceTimersByTimeAsync(budget - 1)
    expect(outcome.error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error?.name).toBe('TimeoutError')
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an already-aborted caller without DNS and removes its listener', async () => {
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('caller reason'), { name: 'TimeoutError' }))
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(
      remoteFetch({ url: endpoint, method: 'GET' }, configMock(), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(lookupMock).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes the caller listener after success without a conversation ID', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = remoteFetch({ url: endpoint, method: 'GET' }, configMock(), controller.signal)
    await flush()
    const response = respond()
    finish(response)
    await expect(result).resolves.toMatchObject({ body: 'done' })
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    controller.abort()
    expect(requests[0].destroy).toHaveBeenCalledTimes(1)
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the original request registered against duplicates even during DNS', async () => {
    lookupMock.mockImplementation(() => new Promise(() => undefined))
    await start()
    await expect(
      service.remoteFetch({ url: endpoint, method: 'GET', conversationId: 'fetch' })
    ).rejects.toMatchObject({ code: 'LLM_CONVERSATION_REQUEST_ACTIVE' })
    expect(lookupMock).toHaveBeenCalledTimes(1)
    await service.cancelConversation({ conversationId: 'fetch' })
    await flush()
    expect(outcome.error?.name).toBe('AbortError')
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await start()
    finish(respond())
    await flush()
    expect(outcome.value?.body).toBe('done')
  })

  it('destroys a late response callback without restoring listeners or settling twice', async () => {
    await start()
    await vi.advanceTimersByTimeAsync(2000)
    const error = outcome.error
    const late = new MockResponse()
    responders[0](late)
    late.emit('error', networkError())
    finish(late)
    await flush()
    expect(outcome.error).toBe(error)
    expect(outcome.value).toBeUndefined()
    expect(late.destroy).toHaveBeenCalledTimes(1)
    expect(requests[0].listenerCount('response')).toBe(0)
    closed(late)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows at most three GET attempts and ignores duplicate errors during backoff', async () => {
    await start({ timeoutMs: 10000 })
    for (let index = 0; index < 3; index++) {
      requests[index].emit('error', networkError())
      requests[index].emit('error', networkError())
      closed(requests[index])
      await vi.advanceTimersByTimeAsync(1000 * (index + 1))
    }
    expect(outcome.error?.message).toBe('ECONNRESET')
    expect(requestMock).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not infer retry safety from a substring in an error message', async () => {
    await start()
    requests[0].emit('error', new Error('bad request mentioning ECONNRESET'))
    await flush()
    expect(outcome.error).toBeInstanceOf(Error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it.each(['create', 'write', 'end'])(
    'cleans up synchronous request %s failures',
    async (stage) => {
      if (stage === 'create')
        requestMock.mockImplementation(() => {
          throw networkError()
        })
      else
        requestMock.mockImplementation((_options, callback) => {
          const request = new MockRequest()
          request.once('response', callback)
          requests.push(request)
          request[stage as 'write' | 'end'].mockImplementation(() => {
            throw networkError()
          })
          return request
        })
      await start({ method: 'POST', body: '{}' })
      expect(outcome.error?.message).toBe('ECONNRESET')
      expect(requestMock).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      for (const request of requests) {
        expect(request.destroy).toHaveBeenCalledTimes(1)
        closed(request)
      }
    }
  )

  it('releases the operation on DNS failure without retrying', async () => {
    lookupMock.mockRejectedValue(networkError('EAI_AGAIN'))
    await start()
    expect(outcome.error?.message).toBe('EAI_AGAIN')
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
  })

  it.each(['-1', 'abc', '1.5', '9007199254740992'])(
    'rejects malformed response length %s',
    async (length) => {
      await start()
      const response = respond({ 'content-length': length })
      await flush()
      expect(outcome.error?.message).toMatch(/content length/i)
      expect(response.destroy).toHaveBeenCalledTimes(1)
      expect(response.listenerCount('data')).toBe(0)
      closed(response)
      closed(requests[0])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('accepts exactly the body limit, counts bytes across chunks and frees listeners', async () => {
    await start()
    const response = respond({ 'content-length': String(MAX_REMOTE_FETCH_RESPONSE_BYTES) })
    response.emit('data', Buffer.alloc(MAX_REMOTE_FETCH_RESPONSE_BYTES - 1, 'a'))
    finish(response, 'b')
    await flush()
    expect(outcome.value?.body.length).toBe(MAX_REMOTE_FETCH_RESPONSE_BYTES)
    expect(outcome.value?.body.endsWith('b')).toBe(true)
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not mistake cached representation length on 304 for a truncated body', async () => {
    await start()
    const response = new MockResponse()
    response.statusCode = 304
    response.headers = { 'content-length': '100' }
    requests[0].emit('response', response)
    finish(response, '')
    await flush()
    expect(outcome.value).toMatchObject({ status: 304, body: '' })
  })

  it.each([
    { url: endpoint + '&extra=1' },
    { url: 'http://skills.example.com/agent?mode=raw' },
    { url: endpoint + '#fragment' },
    { method: 'DELETE' },
    { headers: { Host: 'attacker.example' } },
    { headers: { 'X-Test': 'value\r\nInjected: yes' } },
    { headers: { 'Content-Length': '1' } }
  ])('rejects invalid input before DNS: %j', async (overrides) => {
    await start(overrides as Partial<LLMRemoteFetchReq>)
    expect(outcome.error).toBeInstanceOf(Error)
    expect(lookupMock).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
  })

  it('retains the request body byte cap before DNS', async () => {
    await start({ method: 'POST', body: 'a'.repeat(MAX_REMOTE_FETCH_RESPONSE_BYTES + 1) })
    expect(outcome.error?.message).toMatch(/body is too large/)
    expect(lookupMock).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('remoteFetch numeric address policy (mock DNS/HTTPS only)', () => {
  it.each([
    '127.1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '3232235777',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[0:0:0:0:0:ffff:c0a8:101]',
    '[::ffff:169.254.169.254]'
  ])('rejects configured private numeric host %s before DNS or HTTPS', async (hostname) => {
    const url = `https://${hostname}/agent?mode=raw`
    configMock().llm_config.customSkills[0].apiAddress = url

    await start({ url })

    expect(outcome.error?.message).toBe('Remote fetch URL must target a public host.')
    expect(outcome.value).toBeUndefined()
    expect(lookupMock).not.toHaveBeenCalled()
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
  })

  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:c0a8:101',
    '::ffff:169.254.169.254'
  ])('rejects private mapped DNS answer %s even after a public answer', async (address) => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address, family: 6 }
    ])

    await start()

    expect(lookupMock).toHaveBeenCalledWith('skills.example.com', { all: true, verbatim: false })
    expect(outcome.error?.message).toBe('Remote fetch URL resolved to a private or local address.')
    expect(outcome.value).toBeUndefined()
    expect(requestMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await service.cancelConversation({ conversationId: 'fetch' })).toEqual({
      cancelled: false
    })
  })

  it('allows a public numeric IPv4 URL matching the canonical configured endpoint', async () => {
    configMock().llm_config.customSkills[0].apiAddress = 'https://93.184.216.34/agent?mode=raw'

    await start({ url: 'https://0x5db8d822/agent?mode=raw' })

    expect(lookupMock).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock.mock.calls[0][0]).toMatchObject({ hostname: '93.184.216.34', family: 4 })
    const response = respond()
    finish(response)
    await flush()
    expect(outcome.error).toBeUndefined()
    expect(outcome.value?.body).toBe('done')
    closed(response)
    closed(requests[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['::ffff:93.184.216.34', '::ffff:5db8:d822'])(
    'allows and pins public mapped DNS answer %s without changing the TLS hostname',
    async (address) => {
      lookupMock.mockResolvedValue([{ address, family: 6 }])

      await start()

      expect(requestMock).toHaveBeenCalledTimes(1)
      const options = requestMock.mock.calls[0][0]
      expect(options).toMatchObject({ hostname: 'skills.example.com', family: 6, agent: false })
      const callback = vi.fn()
      options.lookup('skills.example.com', {}, callback)
      expect(callback).toHaveBeenCalledWith(null, address, 6)
      const response = respond()
      finish(response)
      await flush()
      expect(outcome.error).toBeUndefined()
      expect(outcome.value?.body).toBe('done')
      closed(response)
      closed(requests[0])
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
