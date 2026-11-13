import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderDispatchFetch, type ProviderDispatchReceipt } from './providerDispatchFetch'
import { OpenAIAPICli, GeminiAPICli, ClaudeAPICli, OllamaAPICli } from '@shared/llm/clients'
import type { FetchImpl } from '@shared/llm/clients'
const endpoint = 'https://model.test/v1/chat/completions'
const post = (): RequestInit => ({ method: 'POST', body: '{"messages":[{"role":"user","content":"PRIVATE_PROMPT"}]}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer PRIVATE_KEY' } })
const live = new Set<ReturnType<typeof createProviderDispatchFetch>>()
function setup(fetch: FetchImpl = vi.fn(async () => new Response('answer')), extra: Partial<Parameters<typeof createProviderDispatchFetch>[0]> = {}) {
  const signal = new AbortController(), tickets: object[] = [], receipts: Array<{ ticket: object; receipt: ProviderDispatchReceipt }> = []
  const reserve = vi.fn<() => object>(() => { const ticket = Object.freeze({ id: tickets.length + 1 }); tickets.push(ticket); return ticket })
  const settle = vi.fn((ticket: object, receipt: ProviderDispatchReceipt) => { receipts.push({ ticket, receipt }) })
  const wrapper = createProviderDispatchFetch({ endpoint, signal: signal.signal, fetch, assertLive: () => undefined, reserve, settle, ...extra })
  live.add(wrapper); return { wrapper, fetch, signal, reserve, settle, tickets, receipts }
}
afterEach(() => { live.forEach(value => value.dispose()); live.clear(); vi.useRealTimers(); vi.restoreAllMocks() })
describe('isolated actual-fetch admission prerequisite, not a goal budget or runner', () => {
  it.each(['https://model.test/a?', 'https://model.test/a#', 'https://user:pass@model.test/a', 'http://external.test/a', 'https://model.test/a?key=SECRET'])('rejects unsupported endpoint %s before any request', endpoint => {
    expect(() => setup(undefined, { endpoint })).toThrow('endpoint')
  })
  it('reserves before each invocation and confirms transport only after observed response EOF, not headers', async () => {
    const events: string[] = [], t = setup(vi.fn(async (_url, init) => { events.push('fetch'); expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' }); return new Response('answer') }))
    t.reserve.mockImplementation(() => { events.push('reserve'); return Object.freeze({}) })
    const response = await t.wrapper.fetch(endpoint, post())
    expect(events).toEqual(['reserve', 'fetch']); expect(t.wrapper.state).toBe('active'); expect(t.settle).not.toHaveBeenCalled()
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('active')
    expect(await response.text()).toBe('answer'); expect(t.wrapper.state).toBe('idle')
    expect(t.receipts[0].receipt).toEqual({ state: 'response-complete', status: 200, responseBytes: 6, charged: true, grantsPermission: false })
    expect(JSON.stringify(t.receipts)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_KEY/)
    expect(await (await t.wrapper.fetch(endpoint, post())).text()).toBe('answer'); expect(t.reserve).toHaveBeenCalledTimes(2)
  })
  it('refuses reusing a completed reservation capability for another delegate invocation', async () => {
    const ticket = Object.freeze({}), t = setup(undefined, { reserve: () => ticket })
    await (await t.wrapper.fetch(endpoint, post())).text()
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('fresh')
    expect(t.fetch).toHaveBeenCalledOnce(); expect(t.wrapper.state).toBe('blocked')
  })
  it('does not change an already confirmed EOF receipt when the parent aborts or wrapper is disposed later', async () => {
    const t = setup(); await (await t.wrapper.fetch(endpoint, post())).text()
    t.signal.abort(new Error('Later Stop')); t.wrapper.dispose()
    expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('response-complete')
  })
  it('pins validated body/method/headers before reserve can mutate the caller init object', async () => {
    const request = post(), originalBody = request.body, t = setup(vi.fn(async (_input, sent) => { expect(sent?.method).toBe('POST'); expect(sent?.body).toBe(originalBody); expect(new Headers(sent?.headers).has('cookie')).toBe(false); return new Response('ok') }))
    t.reserve.mockImplementation(() => { request.method = 'GET'; request.body = 'NOT_JSON'; request.headers = { Cookie: 'BAD' }; return Object.freeze({ id: 1 }) })
    expect(await (await t.wrapper.fetch(endpoint, request)).text()).toBe('ok')
  })
  it('does not dispatch if final assertLive synchronously aborts only the request signal', async () => {
    const request = new AbortController(); let checks = 0
    const t = setup(undefined, { assertLive() { if (++checks === 3) request.abort(new Error('Revoked at final assert')) } })
    await expect(t.wrapper.fetch(endpoint, { ...post(), signal: request.signal })).rejects.toThrow('Revoked')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('not-dispatched')
    expect(t.wrapper.state).toBe('idle') // No delegate invocation occurred; reservation is still charged.
    await (await t.wrapper.fetch(endpoint, post())).text(); expect(t.fetch).toHaveBeenCalledOnce(); expect(t.reserve).toHaveBeenCalledTimes(2)
  })
  it.each([1, 2, 3])('locks admission before reentrant assertLive callback #%s and keeps disposal ownership', async reenterAt => {
    let checks = 0, nested: Promise<Response> | undefined
    const t = setup(undefined, { assertLive() { if (++checks === reenterAt) { nested = t.wrapper.fetch(endpoint, post()); void nested.catch(() => undefined) } } })
    const response = await t.wrapper.fetch(endpoint, post())
    await expect(nested).rejects.toThrow('active'); expect(t.fetch).toHaveBeenCalledOnce(); expect(t.reserve).toHaveBeenCalledOnce(); expect(t.wrapper.state).toBe('active')
    t.wrapper.dispose(); await expect(response.text()).rejects.toThrow(); expect(t.receipts[0].receipt.state).toBe('unknown'); expect(t.wrapper.state).toBe('blocked')
  })
  it('rejects an asynchronous live guard before reserving or dispatching, observing its rejection', async () => {
    const t = setup(undefined, { assertLive: async () => { throw new Error('Delayed guard failure') } })
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('synchronously')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.reserve).not.toHaveBeenCalled(); expect(t.wrapper.state).toBe('idle')
  })
  it('does not dispatch when the final synchronous live guard crosses the monotonic deadline', async () => {
    let time = 0, checks = 0
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    const t = setup(undefined, { timeoutMs: 100, assertLive() { if (++checks === 3) time = 101 } })
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('deadline')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.receipts[0].receipt.state).toBe('not-dispatched'); expect(t.reserve).toHaveBeenCalledOnce()
  })
  it('does not preconsume an unread body and blocks another dispatch after its deadline', async () => {
    vi.useFakeTimers()
    const pull = vi.fn(), t = setup(vi.fn(async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 }))), { timeoutMs: 100 })
    const response = await t.wrapper.fetch(endpoint, post()); expect(pull).not.toHaveBeenCalled(); expect(t.settle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(t.wrapper.state).toBe('blocked'); expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('unknown')
    await expect(response.text()).rejects.toThrow(); await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('uncertain')
  })
  it('requires a fresh exact synchronous reservation and rechecks revocation after it before invoking fetch', async () => {
    const t = setup()
    t.reserve.mockImplementation(() => { t.signal.abort(new Error('Revoked during reservation')); return {} })
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow()
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.receipts[0].receipt).toEqual({ state: 'not-dispatched', charged: true, grantsPermission: false })
  })
  it.each(['reserve', 'settle'] as const)('blocks on %s failure without silently bypassing or refunding admission', async kind => {
    const t = setup()
    if (kind === 'reserve') {
      t.reserve.mockImplementation(() => { throw new Error('Persistence lost') }); await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow()
      expect(t.fetch).not.toHaveBeenCalled(); expect(t.settle).not.toHaveBeenCalled()
    } else {
      t.settle.mockImplementation(() => { throw new Error('Persistence lost') }); const response = await t.wrapper.fetch(endpoint, post())
      await expect(response.text()).rejects.toThrow('durably confirmed'); expect(t.fetch).toHaveBeenCalledOnce()
    }
    expect(t.wrapper.state).toBe('blocked'); await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('uncertain')
  })
  it('rejects asynchronous reservation or settlement callbacks and observes their late rejections', async () => {
    const first = setup(undefined, { reserve: (() => Promise.reject(new Error('late reserve'))) as never })
    await expect(first.wrapper.fetch(endpoint, post())).rejects.toThrow('synchronous'); expect(first.wrapper.state).toBe('blocked'); expect(first.fetch).not.toHaveBeenCalled()
    const second = setup(undefined, { settle: (() => Promise.reject(new Error('late receipt'))) as never })
    const response = await second.wrapper.fetch(endpoint, post()); await expect(response.text()).rejects.toThrow('durably confirmed'); expect(second.wrapper.state).toBe('blocked')
  })
  it.each(['fetch-reject', 'body-error', 'cancel', 'parent-abort', 'dispose', 'oversize'] as const)('retains unknown after %s and never equates it with rollback or completion', async kind => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const t = setup(kind === 'fetch-reject' ? vi.fn(async () => { throw new Error('Connection closed') }) : vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }, { highWaterMark: 0 }))), { responseBytes: 3 })
    if (kind === 'fetch-reject') await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow()
    else {
      const response = await t.wrapper.fetch(endpoint, post())
      if (kind === 'cancel') await response.body!.cancel()
      else {
        const result = response.text().catch(error => error)
        if (kind === 'body-error') controller.error(new Error('Body interrupted'))
        else if (kind === 'parent-abort') t.signal.abort(new Error('Stop'))
        else if (kind === 'dispose') t.wrapper.dispose()
        else controller.enqueue(new TextEncoder().encode('four'))
        expect(await result).toBeInstanceOf(Error)
      }
    }
    expect(t.wrapper.state).toBe('blocked'); expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('unknown')
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow()
  })
  it('observes ignored abort and late transport response without clearing unknown', async () => {
    let finish!: (value: Response) => void
    const t = setup(vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = t.wrapper.fetch(endpoint, post()).catch(error => error); t.signal.abort(new Error('Stop'))
    expect(await pending).toBeInstanceOf(Error)
    const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel })))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('unknown'); expect(t.wrapper.state).toBe('blocked')
  })
  it('counts a fully observed HTTP failure as response-complete transport evidence, not business success or a refund', async () => {
    const t = setup(vi.fn(async () => new Response('overloaded', { status: 503 })))
    expect((await t.wrapper.fetch(endpoint, post())).status).toBe(503)
    expect(t.settle).not.toHaveBeenCalled(); t.wrapper.dispose()
    expect(t.receipts[0].receipt.state).toBe('unknown')
    const second = setup(vi.fn(async () => new Response('overloaded', { status: 503 })))
    expect(await (await second.wrapper.fetch(endpoint, post())).text()).toBe('overloaded')
    expect(second.receipts[0].receipt).toMatchObject({ state: 'response-complete', status: 503, charged: true })
  })
  it('handles null-body 204 as zero-byte transport completion, never a completed model answer', async () => {
    const t = setup(vi.fn(async () => new Response(null, { status: 204 })))
    expect((await t.wrapper.fetch(endpoint, post())).status).toBe(204)
    expect(t.receipts[0].receipt).toEqual({ state: 'response-complete', status: 204, responseBytes: 0, charged: true, grantsPermission: false })
  })
  it('never admits nested reentrant dispatch while a durable settle callback is still executing', async () => {
    let nested: Promise<Response> | undefined
    const t = setup()
    t.settle.mockImplementation(() => { nested = t.wrapper.fetch(endpoint, post()); void nested.catch(() => undefined) })
    await (await t.wrapper.fetch(endpoint, post())).text()
    await expect(nested).rejects.toThrow('active'); expect(t.fetch).toHaveBeenCalledOnce()
  })
  it.each(['clone', 'tee'] as const)('rejects %s without allowing tee prefetch to clear an unread reservation', async split => {
    const t = setup(); const response = await t.wrapper.fetch(endpoint, post())
    expect(() => split === 'clone' ? response.clone() : response.body!.tee()).toThrow('unsupported')
    expect(t.fetch).toHaveBeenCalledOnce(); expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('unknown')
    await expect(response.text()).rejects.toThrow(); await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('uncertain')
  })
  it('captures getter-based init fields exactly once before validating and sending', async () => {
    const body = '{"ok":true}', getter = vi.fn().mockReturnValueOnce(body).mockReturnValue(new ReadableStream())
    const t = setup(vi.fn(async (_input, init) => { expect(init?.body).toBe(body); return new Response('ok') }))
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, get body() { return getter() } }
    expect(await (await t.wrapper.fetch(endpoint, init)).text()).toBe('ok'); expect(getter).toHaveBeenCalledOnce()
  })
  it.each(['wrong-endpoint', 'request-object', 'get', 'stream-body', 'redirect-follow', 'credentials', 'cookie', 'invalid-json', 'oversize'] as const)('refuses %s before reservation or network', async kind => {
    const t = setup(undefined, { requestBytes: 100 })
    const init = { ...post() }
    let input: RequestInfo | URL = endpoint
    if (kind === 'wrong-endpoint') input = 'https://wrong.test/v1/chat/completions'
    else if (kind === 'request-object') input = new Request(endpoint, init)
    else if (kind === 'get') init.method = 'GET'
    else if (kind === 'stream-body') init.body = new ReadableStream() as never
    else if (kind === 'redirect-follow') init.redirect = 'follow'
    else if (kind === 'credentials') init.credentials = 'include'
    else if (kind === 'cookie') init.headers = { 'Content-Type': 'application/json', Cookie: 'SECRET' }
    else if (kind === 'invalid-json') init.body = 'not json'
    else init.body = JSON.stringify({ text: 'x'.repeat(101) })
    await expect(t.wrapper.fetch(input, init)).rejects.toThrow(); expect(t.reserve).not.toHaveBeenCalled(); expect(t.fetch).not.toHaveBeenCalled()
  })
  it.each(['redirect', 'url-change'] as const)('blocks transport-%s even when a supplied adapter violates redirect:error', async kind => {
    const response = new Response('data')
    Object.defineProperty(response, kind === 'redirect' ? 'redirected' : 'url', { value: kind === 'redirect' ? true : 'https://wrong.test/model' })
    const t = setup(vi.fn(async () => response))
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('redirected'); expect(t.receipts[0].receipt.state).toBe('unknown')
  })
})

describe('native fetch loopback transport evidence (isolated, no supplier or production wiring)', () => {
  it.each([false, true])('reserves before local HTTP POST and never follows a redirect (redirect=%s)', async redirect => {
    const calls: Array<{ path?: string; body: string; reserved: number }> = []
    let reserved = 0
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString()
      calls.push({ path: request.url, body, reserved })
      if (redirect) { response.writeHead(307, { Location: '/unbudgeted-target' }); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'local transport ok' }, finish_reason: 'stop' }] }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback test port.')
    const local = `http://127.0.0.1:${address.port}/chat`, t = setup(globalThis.fetch, { endpoint: local, reserve: () => Object.freeze({ reservationId: `INTERNAL_RESERVATION_${++reserved}` }) })
    try {
      if (redirect) {
        await expect(t.wrapper.fetch(local, post())).rejects.toThrow(); expect(t.wrapper.state).toBe('blocked'); expect(t.receipts[0].receipt.state).toBe('unknown')
        await expect(t.wrapper.fetch(local, post())).rejects.toThrow('uncertain'); expect(calls).toHaveLength(1)
      } else {
        const cli = new OpenAIAPICli('key', local, 'model', { apiMode: 'chat-completions', fetchImpl: t.wrapper.fetch, enableHostedTools: false })
        for (let i = 0; i < 2; i++) expect(await cli.chat({ messages: [{ role: 'user', content: 'Only local loopback fixture' }], disableProviderTools: true })).toMatchObject({ content: 'local transport ok' })
        expect(calls.map(call => call.reserved)).toEqual([1, 2]); expect(t.receipts.map(value => value.receipt.state)).toEqual(['response-complete', 'response-complete'])
      }
      expect(calls.every(call => call.path === '/chat' && call.reserved > 0 && !call.body.includes('INTERNAL_RESERVATION'))).toBe(true)
    } finally { t.wrapper.dispose(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})

describe('real API clients with isolated per-fetch admission (mock provider, no production wiring)', () => {
  const cases = [
    { name: 'OpenAI', endpoint, create: (fetch: FetchImpl) => new OpenAIAPICli('key', endpoint, 'model', { apiMode: 'chat-completions', fetchImpl: fetch, enableHostedTools: false }), success: () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) },
    { name: 'Gemini', endpoint: 'https://gemini.test/v1beta/models/model:generateContent', create: (fetch: FetchImpl) => new GeminiAPICli('key', 'https://gemini.test', 'model', { fetchImpl: fetch, authMode: 'x-goog-api-key' }), success: () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) },
    { name: 'Claude', endpoint: 'https://claude.test/v1/messages', create: (fetch: FetchImpl) => new ClaudeAPICli('key', 'https://claude.test', 'model', { fetchImpl: fetch }), success: () => Response.json({ content: [{ type: 'text', text: 'ok' }] }) },
    { name: 'Ollama', endpoint: 'https://ollama.test/api/chat', create: (fetch: FetchImpl) => new OllamaAPICli('', 'https://ollama.test', 'model', { fetchImpl: fetch }), success: () => Response.json({ message: { content: 'ok' } }) }
  ]
  it('conservatively fences a successful SSE model result when the parser stops at its terminal marker before transport EOF', async () => {
    const terminal = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const upstream = vi.fn<FetchImpl>().mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(terminal)) } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }))
    const t = setup(upstream), cli = new OpenAIAPICli('key', endpoint, 'model', { apiMode: 'chat-completions', fetchImpl: t.wrapper.fetch, enableHostedTools: false })
    const result = await cli.chat({ messages: [{ role: 'user', content: 'Test' }], disableProviderTools: true, onDelta: () => undefined })
    expect(result.content).toBe('ok'); expect(t.receipts).toHaveLength(1); expect(t.receipts[0].receipt.state).toBe('unknown'); expect(t.wrapper.state).toBe('blocked')
    await expect(t.wrapper.fetch(endpoint, post())).rejects.toThrow('uncertain'); expect(upstream).toHaveBeenCalledOnce()
  })
  it('blocks a real client connection retry after the first possibly-dispatched unknown outcome', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const upstream = vi.fn<FetchImpl>().mockRejectedValue(new Error('net::ERR_CONNECTION_CLOSED'))
    const t = setup(upstream), cli = new OpenAIAPICli('key', endpoint, 'model', { apiMode: 'chat-completions', fetchImpl: t.wrapper.fetch, enableHostedTools: false })
    const pending = cli.chat({ messages: [{ role: 'user', content: 'Test' }], retryCapacity: true, disableProviderTools: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBeInstanceOf(Error); expect(upstream).toHaveBeenCalledOnce(); expect(t.reserve).toHaveBeenCalledOnce(); expect(t.wrapper.state).toBe('blocked')
    expect(t.receipts[0].receipt.state).toBe('unknown')
  })
  it.each(cases)('charges each actual $name retry fetch, not one cli.chat call', async provider => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const upstream = vi.fn<FetchImpl>().mockResolvedValueOnce(Response.json({ error: { code: 'server_overloaded', message: 'server overloaded' } }, { status: 503 })).mockImplementation(async () => provider.success())
    const t = setup(upstream, { endpoint: provider.endpoint }), result = provider.create(t.wrapper.fetch).chat({ messages: [{ role: 'user', content: 'Test' }], retryCapacity: true, disableProviderTools: true })
    const observed = result.catch(error => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await observed).toMatchObject({ content: 'ok' }); expect(upstream).toHaveBeenCalledTimes(2); expect(t.reserve).toHaveBeenCalledTimes(2)
    expect(t.receipts.map(value => value.receipt.state)).toEqual(['response-complete', 'response-complete']); expect(t.receipts.map(value => value.receipt.state === 'response-complete' ? value.receipt.status : 0)).toEqual([503, 200])
  })
})
