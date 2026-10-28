import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig } from '../config/config'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import {
  createElectronRequestFetch,
  type ElectronRequestFactory,
  LLMProxySvcImpl
} from './svcLLMProxyImpl'

vi.mock('electron', () => ({ net: {} }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }))
vi.mock('../extensions/generatedRegistry', () => ({ mainHostExtensionApiV1: { llmProxy: [] } }))

const url = 'https://fixture.invalid/response'

const createFixture = () => {
  const incoming = Object.assign(new EventEmitter(), {
    headers: { 'x-fixture': ['ok'] } as Record<string, string[] | undefined>,
    statusCode: 200,
    statusMessage: 'OK',
    pause: vi.fn(),
    resume: vi.fn()
  })
  let markSent!: () => void
  const sent = new Promise<void>((resolve) => {
    markSent = resolve
  })
  const events = new EventEmitter()
  const client = Object.assign(events, {
    abort: vi.fn(() => {
      events.emit('abort')
      incoming.emit('aborted')
    }),
    end: vi.fn(() => markSent()),
    setHeader: vi.fn()
  })
  const factory = vi.fn<ElectronRequestFactory>(() => client)
  return { incoming, client, factory, sent, fetch: createElectronRequestFetch(factory) }
}

const expectLateEventsSafe = (client: EventEmitter, incoming: EventEmitter): void => {
  expect(() => {
    incoming.emit('data', Buffer.from('late'))
    incoming.emit('end')
    incoming.emit('aborted')
    for (let i = 0; i < 2; i++) {
      incoming.emit('error', new Error('late response error'))
      client.emit('error', new Error('late request error'))
    }
    client.emit('abort')
  }).not.toThrow()
}

beforeEach(() => {
  vi.mocked(getConfig).mockReturnValue(structuredClone(DEFAULT_CONFIG))
  // A plain function avoids the service's mock-fetch override while forbidding real network I/O.
  vi.stubGlobal('fetch', () => {
    throw new Error('Unexpected global fetch')
  })
})

afterEach(() => {
  mainHostExtensionApiV1.llmProxy.length = 0
  Reflect.deleteProperty(net, 'fetch')
  Reflect.deleteProperty(net, 'request')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Electron request Fetch response boundaries', () => {
  it.each([
    { method: 'GET', status: 204 },
    { method: 'GET', status: 205 },
    { method: 'GET', status: 304 },
    { method: 'HEAD', status: 200 }
  ])(
    'returns a null body for $method $status without waiting for end or draining',
    async ({ method, status }) => {
      const fixture = createFixture()
      fixture.incoming.statusCode = status
      const controller = new AbortController()
      const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
      const pending = fixture.fetch(url, { method, signal: controller.signal })
      await fixture.sent

      expect(() => fixture.client.emit('response', fixture.incoming)).not.toThrow()
      const response = await pending
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
      expect(response.url).toBe(url)
      expect(response.headers.get('x-fixture')).toBe('ok')
      await expect(response.text()).resolves.toBe('')
      expect(fixture.incoming.listenerCount('data')).toBe(0)
      expect(fixture.incoming.resume).not.toHaveBeenCalled()
      expect(fixture.client.abort).toHaveBeenCalledOnce()
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      controller.abort()
      expectLateEventsSafe(fixture.client, fixture.incoming)
      expect(fixture.client.abort).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { statusCode: 199 },
    { statusCode: 600 },
    { statusMessage: 'bad\r\nstatus' },
    { headers: { 'bad header': ['value'] } },
    { headers: { 'x-header': ['bad\r\nvalue'] } },
    { statusCode: 204, headers: { 'bad header': ['value'] } }
  ])(
    'rejects malformed response metadata %j instead of throwing from the event',
    async (metadata) => {
      const fixture = createFixture()
      Object.assign(fixture.incoming, metadata)
      const controller = new AbortController()
      const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
      const pending = fixture.fetch(url, { signal: controller.signal })
      const rejected = expect(pending).rejects.toBeInstanceOf(Error)
      await fixture.sent

      expect(() => fixture.client.emit('response', fixture.incoming)).not.toThrow()
      await rejected
      expect(fixture.client.abort).toHaveBeenCalledOnce()
      expect(fixture.incoming.resume).not.toHaveBeenCalled()
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      controller.abort()
      expectLateEventsSafe(fixture.client, fixture.incoming)
      expect(fixture.client.abort).toHaveBeenCalledOnce()
    }
  )

  it('discards a response arriving after cancellation without constructing or reading a body', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const reason = new Error('cancel before headers')
    const pending = fixture.fetch(url, { signal: controller.signal })
    const rejected = expect(pending).rejects.toBe(reason)
    await fixture.sent
    controller.abort(reason)
    await rejected

    fixture.incoming.statusCode = 600
    expect(() => fixture.client.emit('response', fixture.incoming)).not.toThrow()
    expect(fixture.incoming.listenerCount('data')).toBe(0)
    expect(fixture.incoming.resume).not.toHaveBeenCalled()
    expectLateEventsSafe(fixture.client, fixture.incoming)
    expect(fixture.client.abort).toHaveBeenCalledOnce()
  })

  it('preserves Electron scalar response headers alongside multi-value headers', async () => {
    const fixture = createFixture()
    Object.assign(fixture.incoming, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '14',
        'x-values': ['one', 'two']
      }
    })
    const pending = fixture.fetch(url, { method: 'POST', body: '{}' })
    await fixture.sent
    fixture.client.emit('response', fixture.incoming)
    fixture.incoming.emit('data', '{"protocol":1}')
    fixture.incoming.emit('end')
    const response = await pending
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('content-length')).toBe('14')
    expect(response.headers.get('x-values')).toBe('one, two')
    await expect(response.json()).resolves.toEqual({ protocol: 1 })
  })

  it('keeps 200 response streaming, backpressure, and completion cleanup', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    const pending = fixture.fetch(url, { signal: controller.signal })
    await fixture.sent
    fixture.client.emit('response', fixture.incoming)
    fixture.incoming.emit('data', 'first')
    expect(fixture.incoming.pause).toHaveBeenCalledOnce()
    const response = await pending
    expect(response.body).not.toBeNull()
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: Buffer.from('first') })
    expect(fixture.incoming.resume).toHaveBeenCalled()
    fixture.incoming.emit('data', Buffer.from('second'))
    await expect(reader.read()).resolves.toEqual({ done: false, value: Buffer.from('second') })
    fixture.incoming.emit('end')
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expectLateEventsSafe(fixture.client, fixture.incoming)
    expect(fixture.client.abort).not.toHaveBeenCalled()
  })

  it('cancels the Electron request when the Fetch body reader cancels', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const removeListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    const pending = fixture.fetch(url, { signal: controller.signal })
    await fixture.sent
    fixture.client.emit('response', fixture.incoming)
    const response = await pending
    const reader = response.body!.getReader()
    await reader.cancel('reader stopped')
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expectLateEventsSafe(fixture.client, fixture.incoming)
    expect(fixture.client.abort).toHaveBeenCalledOnce()
  })

  it.each(['client', 'incoming'] as const)(
    'aborts and errors the body on a %s error after headers',
    async (source) => {
      const fixture = createFixture()
      const pending = fixture.fetch(url)
      await fixture.sent
      fixture.client.emit('response', fixture.incoming)
      const response = await pending
      const reason = new Error('transport failed')
      const rejected = expect(response.text()).rejects.toBe(reason)
      expect(() => fixture[source].emit('error', reason)).not.toThrow()
      await rejected
      expectLateEventsSafe(fixture.client, fixture.incoming)
      expect(fixture.client.abort).toHaveBeenCalledOnce()
    }
  )

  it.each(['setHeader', 'end'] as const)(
    'cleans up a synchronous %s failure',
    async (operation) => {
      const fixture = createFixture()
      const reason = new Error('request setup failed')
      fixture.client[operation].mockImplementationOnce(() => {
        throw reason
      })
      await expect(fixture.fetch(url, { headers: { 'x-fixture': 'ok' } })).rejects.toBe(reason)
      fixture.client.emit('response', fixture.incoming)
      expectLateEventsSafe(fixture.client, fixture.incoming)
      expect(fixture.client.abort).toHaveBeenCalledOnce()
    }
  )
})

describe.each(['URL', 'Request'] as const)(
  'Electron request credentials from %s input',
  (inputKind) => {
    it.each(['omit', 'include', 'same-origin', undefined] as const)(
      'forwards %s without changing legacy defaults',
      async (credentials) => {
        const fixture = createFixture()
        const init: RequestInit = {
          method: 'POST',
          body: '{}',
          headers: { authorization: 'Bearer explicit-fixture-token' },
          redirect: 'error',
          ...(credentials === undefined ? {} : { credentials })
        }
        const pending =
          inputKind === 'Request' ? fixture.fetch(new Request(url, init)) : fixture.fetch(url, init)
        await fixture.sent
        expect(fixture.factory).toHaveBeenCalledWith({
          method: 'POST',
          url,
          redirect: 'error',
          ...(credentials === 'omit'
            ? { credentials: 'omit', useSessionCookies: false }
            : credentials === 'include'
              ? { credentials: 'include' }
              : {})
        })
        expect(fixture.client.listenerCount('login')).toBe(0)
        expect(fixture.client.setHeader).toHaveBeenCalledWith(
          'authorization',
          'Bearer explicit-fixture-token'
        )
        fixture.client.emit('response', fixture.incoming)
        fixture.incoming.emit('end')
        await expect((await pending).text()).resolves.toBe('')
      }
    )
  }
)

describe('main-process transport and cancellation scopes', () => {
  it.each(['omit', 'include', undefined] as const)(
    'keeps GET credentials %s on net.fetch',
    async (credentials) => {
      const fixture = createFixture()
      const electronFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      Object.assign(net, { fetch: electronFetch, request: fixture.factory })
      const fetchImpl = new LLMProxySvcImpl()['getFetchImpl']()
      const controller = new AbortController()
      const init: RequestInit = { credentials, signal: controller.signal }
      await fetchImpl(new URL(url), init)
      expect(electronFetch).toHaveBeenLastCalledWith(url, init)
      const request = new Request(url, init)
      await fetchImpl(request)
      expect(electronFetch).toHaveBeenLastCalledWith(request, undefined)
      expect(fixture.factory).not.toHaveBeenCalled()
    }
  )

  it.each(['before', 'after'] as const)(
    'connects conversation cancellation %s response headers to Electron',
    async (timing) => {
      const fixture = createFixture()
      Object.assign(net, { request: fixture.factory })
      mainHostExtensionApiV1.llmProxy.push({
        id: 'adapter-cancellation-fixture',
        async handleChatRequest(_req, context) {
          if (!context.fetchImpl) throw new Error('Missing fixture transport')
          const response = await context.fetchImpl(url, {
            method: 'POST',
            body: '{}',
            credentials: 'omit',
            signal: context.signal
          })
          return { content: await response.text() }
        }
      })
      const service = new LLMProxySvcImpl()
      const conversationId = 'adapter-fixture'
      const pending = service.chat({
        conversationId,
        messages: [{ role: 'user', content: 'Synthetic fixture' }]
      })
      const rejected = expect(pending).rejects.toThrow('Conversation cancelled by the user.')
      await fixture.sent
      if (timing === 'after') fixture.client.emit('response', fixture.incoming)
      await expect(service.cancelConversation({ conversationId })).resolves.toEqual({
        cancelled: true
      })
      await rejected
      if (timing === 'before') fixture.client.emit('response', fixture.incoming)
      expectLateEventsSafe(fixture.client, fixture.incoming)
      expect(fixture.client.abort).toHaveBeenCalledOnce()
      await expect(service.cancelConversation({ conversationId })).resolves.toEqual({
        cancelled: false
      })
    }
  )
})
