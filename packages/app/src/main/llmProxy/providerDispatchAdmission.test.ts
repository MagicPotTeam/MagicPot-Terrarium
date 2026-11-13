import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { createProviderDispatchAdmission, type ProviderDispatchAdmission } from './providerDispatchAdmission'
import { ProviderDispatchLedgerStore } from './providerDispatchLedgerStore'
import * as transport from './providerDispatchFetch'
import { sideTestCodec, sideScope as scope } from '../api/agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { OpenAIAPICli, GeminiAPICli, ClaudeAPICli, OllamaAPICli, type FetchImpl } from '@shared/llm/clients'
const endpoint = 'https://model.test/v1/chat/completions'
const post = (): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"PRIVATE_PROMPT"}]}' })
const roots: string[] = [], stores: ProviderDispatchLedgerStore[] = [], requests: ProviderDispatchAdmission[] = []
afterEach(() => { requests.splice(0).forEach(value => value.dispose()); stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.useRealTimers(); vi.restoreAllMocks() })
function setup(extra: Partial<Parameters<typeof createProviderDispatchAdmission>[0]> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-admission-')); roots.push(root)
  const file = path.join(root, 'ledger.sqlite'), codec = sideTestCodec(), store = new ProviderDispatchLedgerStore(codec, file); stores.push(store)
  const parent = new AbortController(), fetch = vi.fn<FetchImpl>(async () => new Response('ok')), binding = { goalId: randomUUID(), generation: 2, profileHash: 'b'.repeat(64) }, assertLive = vi.fn(() => undefined)
  const options = { store, scope, binding, expectedRevision: 0, maxProviderDispatches: 2, maxWalltimeMs: 10000, endpoint, fetch, signal: parent.signal, assertLive, ...extra }
  const request = createProviderDispatchAdmission(options); requests.push(request)
  return { file, codec, store, request, options, parent, fetch, assertLive }
}
describe('isolated private-capability ledger/transport adapter, not production user admission or a goal runner', () => {
  it('commits a charged pending reservation before delegate invocation and settles only at response EOF', async () => {
    const t = setup(); t.fetch.mockImplementation(async () => {
      expect(t.store.read(scope).document).toMatchObject({ revision: 2, runs: [{ chargedProviderDispatches: 1, attempts: [{ id: expect.any(String) }] }] })
      expect(t.store.read(scope).document.runs[0].attempts[0].outcome).toBeUndefined(); return new Response('ok')
    })
    const response = await t.request.fetch(endpoint, post())
    expect(t.request.state).toBe('active'); expect(t.store.read(scope).document.revision).toBe(2)
    expect(await response.text()).toBe('ok'); expect(t.request.state).toBe('ready')
    t.request.finish(); expect(t.request.state).toBe('finished')
    expect(t.store.read(scope).document).toMatchObject({ revision: 4, runs: [{ status: 'finished', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'response-complete', status: 200 } }] }] })
    expect(JSON.stringify(t.fetch.mock.calls)).not.toMatch(/profileHash|goalId|attemptId|operationId|grantsPermission/)
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow()
  })
  it('does not expose settlement/reservation capabilities, or accept structural copies and foreign tickets', async () => {
    let callbacks!: Parameters<typeof transport.createProviderDispatchFetch>[0]
    const original = transport.createProviderDispatchFetch
    vi.spyOn(transport, 'createProviderDispatchFetch').mockImplementation(options => { callbacks = options; return original(options) })
    const t = setup(); expect(Object.keys(t.request).sort()).toEqual(['dispose', 'fetch', 'finish', 'state'])
    const response = await t.request.fetch(endpoint, post())
    expect(() => callbacks.settle(Object.freeze({}), { state: 'not-dispatched', charged: true, grantsPermission: false })).toThrow('capability')
    expect(t.store.read(scope).document.revision).toBe(2)
    await expect(response.text()).rejects.toThrow(); expect(t.request.state).toBe('blocked')
    expect(() => t.request.finish()).toThrow()
  })
  it('does not rebase onto an external data orphan or newer collection revision', async () => {
    const t = setup(), doc = t.store.read(scope).document
    t.store.apply(scope, { action: 'orphan', operationId: randomUUID(), runId: doc.runs[0].id, expectedRevision: 1 }, Date.now())
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow('changed')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.request.state).toBe('blocked'); expect(t.store.read(scope).document.revision).toBe(2)
  })
  it('keeps unrelated conversations independent without letting one mutate another pending run', async () => {
    const a = setup(), other = { ...scope, conversationId: 'other' }
    const b = createProviderDispatchAdmission({ ...a.options, scope: other }); requests.push(b)
    const response = await a.request.fetch(endpoint, post())
    expect(await (await b.fetch(endpoint, post())).text()).toBe('ok'); b.finish()
    expect(a.store.read(scope).document.revision).toBe(2); expect(a.store.read(other).document.runs[0].status).toBe('finished')
    await response.body!.cancel(); expect(a.store.read(scope).document.runs[0].status).toBe('unknown')
  })
  it('charges each real API-client retry and rejects a later send when the per-dispatch budget is exhausted', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const t = setup(); t.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'server overloaded' } }, { status: 503 })).mockImplementation(async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    const cli = new OpenAIAPICli('key', endpoint, 'model', { apiMode: 'chat-completions', fetchImpl: t.request.fetch, enableHostedTools: false })
    const pending = cli.chat({ messages: [{ role: 'user', content: 'Test' }], retryCapacity: true, disableProviderTools: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ content: 'ok' }); expect(t.fetch).toHaveBeenCalledTimes(2)
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ chargedProviderDispatches: 2, attempts: [{ outcome: { state: 'response-complete', status: 503 } }, { outcome: { state: 'response-complete', status: 200 } }] })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow('budget'); expect(t.fetch).toHaveBeenCalledTimes(2)
  })
  it.each([
    { provider: 'Gemini', endpoint: 'https://gemini.test/v1beta/models/model:generateContent', create: (fetch: FetchImpl) => new GeminiAPICli('key', 'https://gemini.test', 'model', { fetchImpl: fetch, authMode: 'x-goog-api-key' }), result: () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) },
    { provider: 'Claude', endpoint: 'https://claude.test/v1/messages', create: (fetch: FetchImpl) => new ClaudeAPICli('key', 'https://claude.test', 'model', { fetchImpl: fetch }), result: () => Response.json({ content: [{ type: 'text', text: 'ok' }] }) },
    { provider: 'Ollama', endpoint: 'https://ollama.test/api/chat', create: (fetch: FetchImpl) => new OllamaAPICli('', 'https://ollama.test', 'model', { fetchImpl: fetch }), result: () => Response.json({ message: { content: 'ok' } }) }
  ])('persists two charged dispatches for the real $provider client retry path, without promoting model output to run completion', async item => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const upstream = vi.fn<FetchImpl>().mockResolvedValueOnce(Response.json({ error: { code: 'server_overloaded', message: 'server overloaded' } }, { status: 503 })).mockImplementation(async () => item.result())
    const t = setup({ endpoint: item.endpoint, fetch: upstream })
    const pending = item.create(t.request.fetch).chat({ messages: [{ role: 'user', content: 'Test' }], retryCapacity: true, disableProviderTools: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ content: 'ok' }); expect(upstream).toHaveBeenCalledTimes(2)
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'active', chargedProviderDispatches: 2, attempts: [{ outcome: { status: 503 } }, { outcome: { status: 200 } }] })
    t.request.finish(); expect(t.store.read(scope).document.runs[0].status).toBe('finished')
  })
  it('only trusted transport can settle its exact pending ticket once; copied or cross-instance tickets never advance a ledger', () => {
    const callbacks: Array<Parameters<typeof transport.createProviderDispatchFetch>[0]> = [], original = transport.createProviderDispatchFetch
    vi.spyOn(transport, 'createProviderDispatchFetch').mockImplementation(options => { callbacks.push(options); return original(options) })
    const a = setup(), b = setup(), ticket = callbacks[0].reserve()
    expect(Object.isFrozen(ticket)).toBe(true)
    expect(() => callbacks[1].settle(ticket, { state: 'not-dispatched', charged: true, grantsPermission: false })).toThrow('capability')
    expect(() => callbacks[0].settle(structuredClone(ticket), { state: 'not-dispatched', charged: true, grantsPermission: false })).toThrow('capability')
    expect(a.store.read(scope).document.revision).toBe(2); expect(b.store.read(scope).document.revision).toBe(1)
    callbacks[0].settle(ticket, { state: 'not-dispatched', charged: true, grantsPermission: false })
    expect(a.store.read(scope).document.runs[0]).toMatchObject({ status: 'active', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'not-dispatched' } }] })
    expect(() => callbacks[0].settle(ticket, { state: 'not-dispatched', charged: true, grantsPermission: false })).toThrow('capability')
    expect(a.store.read(scope).document.revision).toBe(3)
  })
  it('does not retry a lost settlement command even if a trusted test host calls its original capability again', () => {
    let callbacks!: Parameters<typeof transport.createProviderDispatchFetch>[0]
    const original = transport.createProviderDispatchFetch
    vi.spyOn(transport, 'createProviderDispatchFetch').mockImplementation(options => { callbacks = options; return original(options) })
    const t = setup(), ticket = callbacks.reserve(), apply = t.store.apply.bind(t.store)
    const mutation = vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { const value = apply(scope, command, now); if (command.action === 'settle') throw new Error('Lost acknowledgement'); return value })
    const outcome = { state: 'not-dispatched' as const, charged: true as const, grantsPermission: false as const }
    expect(() => callbacks.settle(ticket, outcome)).toThrow('Lost acknowledgement')
    const count = mutation.mock.calls.length
    expect(() => callbacks.settle(ticket, outcome)).toThrow('already attempted')
    expect(mutation).toHaveBeenCalledTimes(count); expect(t.store.read(scope).document.revision).toBe(3)
  })
  it.each(['idle', 'pending', 'eof'] as const)('Stop fences an unfinished %s run, never refunds or leaves it resumable', async point => {
    const t = setup()
    let response: Response | undefined
    if (point !== 'idle') response = await t.request.fetch(endpoint, post())
    if (point === 'eof') await response!.text()
    t.parent.abort(new Error('Stop'))
    if (point === 'pending') await expect(response!.text()).rejects.toThrow()
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: point === 'idle' ? 0 : 1 })
    const reopened = new ProviderDispatchLedgerStore(t.codec, t.file); stores.push(reopened)
    expect(() => createProviderDispatchAdmission({ ...t.options, store: reopened, expectedRevision: reopened.read(scope).document.revision, signal: new AbortController().signal })).toThrow('uncertain')
  })
  it('records charged not-dispatched when Stop occurs in the reservation commit callback before transport invocation', async () => {
    const t = setup(), apply = t.store.apply.bind(t.store)
    vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'reserve') t.parent.abort(new Error('Stop in commit')); return result })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow()
    expect(t.fetch).not.toHaveBeenCalled()
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'not-dispatched', charged: true } }] })
  })
  it('allows a definitive charged outcome after the wall deadline, while expiry cannot renew dispatch rights', async () => {
    const t = setup({ maxWalltimeMs: 100 }), real = Date.now()
    const response = await t.request.fetch(endpoint, post())
    vi.spyOn(Date, 'now').mockReturnValue(real + 1000)
    await expect(response.text()).rejects.toThrow('deadline')
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'unknown' } }] })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow()
  })
  it('pins binding and scope before a main callback mutates the original options', async () => {
    const t = setup(), prior = structuredClone(t.options.binding)
    t.options.binding.generation = 99; t.options.binding.profileHash = 'c'.repeat(64)
    expect(await (await t.request.fetch(endpoint, post())).text()).toBe('ok')
    expect(t.store.read(scope).document.runs[0].binding).toEqual(prior)
  })
  it('configuration revocation prevents any subsequent delegate invocation, even after a known response', async () => {
    const t = setup(); await (await t.request.fetch(endpoint, post())).text()
    t.assertLive.mockImplementation(() => { throw new Error('Profile disabled') })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow('Profile disabled')
    expect(t.fetch).toHaveBeenCalledOnce(); expect(t.store.read(scope).document.runs[0].status).toBe('unknown')
  })
  it('lost reservation acknowledgement cannot mint a replacement ticket or dispatch; reopening only reads retained accounting', async () => {
    const t = setup(), apply = t.store.apply.bind(t.store)
    vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'reserve') throw new Error('Lost reservation receipt'); return result })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow('Lost reservation receipt')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.store.read(scope).document.runs[0].attempts[0].outcome).toBeUndefined()
    const reopened = new ProviderDispatchLedgerStore(t.codec, t.file); stores.push(reopened)
    expect(reopened.read(scope)).toMatchObject({ orphaned: true, document: { runs: [{ chargedProviderDispatches: 1 }] } })
    expect(() => createProviderDispatchAdmission({ ...t.options, store: reopened, expectedRevision: 2 })).toThrow()
    expect(t.fetch).not.toHaveBeenCalled()
  })
  it('lost settlement acknowledgement blocks another send while retaining the possibly committed receipt data', async () => {
    const t = setup(), apply = t.store.apply.bind(t.store)
    vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'settle') throw new Error('Lost settlement receipt'); return result })
    const response = await t.request.fetch(endpoint, post()); await expect(response.text()).rejects.toThrow()
    expect(t.request.state).toBe('blocked'); expect(t.store.read(scope).document.runs[0].attempts[0].outcome?.state).toBe('response-complete')
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow(); expect(t.fetch).toHaveBeenCalledOnce()
  })
  it('cannot finish while a response body is pending or clone cancellation made the outcome uncertain', async () => {
    const t = setup(), response = await t.request.fetch(endpoint, post())
    expect(() => t.request.finish()).toThrow('active'); expect(() => response.clone()).toThrow('unsupported')
    expect(() => t.request.finish()).toThrow(); expect(t.store.read(scope).document.runs[0].status).toBe('unknown')
  })
  it('validates unsupported endpoints and preaborted consent before persistent begin', () => {
    const t = setup(); t.request.finish()
    const before = t.store.read(scope).document.revision
    expect(() => createProviderDispatchAdmission({ ...t.options, endpoint: 'https://model.test/path?key=secret', expectedRevision: before })).toThrow('endpoint')
    const signal = new AbortController(); signal.abort()
    expect(() => createProviderDispatchAdmission({ ...t.options, signal: signal.signal, expectedRevision: before })).toThrow()
    expect(t.store.read(scope).document.revision).toBe(before)
  })
  it('does not regain authority from a pending receipt after closing the issuing store', async () => {
    const t = setup(), response = await t.request.fetch(endpoint, post()); t.store.close()
    await expect(response.text()).rejects.toThrow(); expect(t.request.state).toBe('blocked')
    const next = new ProviderDispatchLedgerStore(t.codec, t.file); stores.push(next)
    expect(next.read(scope)).toMatchObject({ orphaned: true, document: { revision: 2 } })
  })
  it('records unknown on actual transport connection failure and prevents a client retry from reaching fetch twice', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const t = setup(); t.fetch.mockRejectedValue(new Error('net::ERR_CONNECTION_CLOSED'))
    const cli = new OpenAIAPICli('key', endpoint, 'model', { apiMode: 'chat-completions', fetchImpl: t.request.fetch, enableHostedTools: false })
    const pending = cli.chat({ messages: [{ role: 'user', content: 'Test' }], retryCapacity: true, disableProviderTools: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000); expect(await pending).toBeInstanceOf(Error)
    expect(t.fetch).toHaveBeenCalledOnce(); expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it('ties real loopback HTTP dispatch to committed SQLite pending data before each POST', async () => {
    let calls = 0
    const server = createServer(async (req, res) => { for await (const _chunk of req) { /* Drain bounded JSON fixture. */ } calls++; expect(t.store.read(scope).document.runs[0].chargedProviderDispatches).toBe(calls); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"answer":"ok"}') })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port')
    const local = `http://127.0.0.1:${address.port}/model`
    const t = setup({ endpoint: local, fetch: globalThis.fetch })
    try {
      for (let i = 0; i < 2; i++) expect(await (await t.request.fetch(local, post())).json()).toEqual({ answer: 'ok' })
      expect(calls).toBe(2); t.request.finish(); expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'finished', chargedProviderDispatches: 2 })
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
  it.each(['idle', 'waiting-headers', 'waiting-body'] as const)('original run expiry revokes a suspended %s lifetime independently of per-fetch timeout', async point => {
    vi.useFakeTimers()
    const upstream = vi.fn<FetchImpl>(async () => point === 'waiting-headers' ? new Promise<Response>(() => undefined) : new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })))
    const t = setup({ maxWalltimeMs: 100, timeoutMs: 10000, fetch: upstream })
    let result: Promise<unknown> | undefined
    if (point === 'waiting-headers') result = t.request.fetch(endpoint, post()).catch(error => error)
    if (point === 'waiting-body') result = (await t.request.fetch(endpoint, post())).text().catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    if (result) expect(await result).toBeInstanceOf(Error)
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: point === 'idle' ? 0 : 1 })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow()
    expect(upstream).toHaveBeenCalledTimes(point === 'idle' ? 0 : 1)
  })
  it('does not admit nested sends or finish from the live guard while explicit finish is in progress', async () => {
    const t = setup(); let nested: Promise<Response> | undefined
    t.assertLive.mockImplementation(() => {
      nested = t.request.fetch(endpoint, post()); void nested.catch(() => undefined)
      expect(() => t.request.finish()).toThrow('active')
    })
    t.request.finish()
    await expect(nested).rejects.toThrow('finish')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'finished', chargedProviderDispatches: 0 })
  })
  it('Stop during the definitive settlement callback records the outcome before orphan fencing', async () => {
    const t = setup(), apply = t.store.apply.bind(t.store)
    vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { if (command.action === 'settle') t.parent.abort(new Error('Stop during settlement')); return apply(scope, command, now) })
    const response = await t.request.fetch(endpoint, post())
    await expect(response.text()).rejects.toThrow() // Model prose is not final accepted transport after Stop.
    expect(t.store.read(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'response-complete' } }] })
    expect(t.fetch).toHaveBeenCalledOnce()
  })
  it.each([204, 205])('Stop inside bodyless %s settlement rejects delivery without rewriting the confirmed transport receipt', async status => {
    const t = setup(), apply = t.store.apply.bind(t.store)
    t.fetch.mockResolvedValueOnce(new Response(null, { status }))
    vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { if (command.action === 'settle') t.parent.abort(new Error('Stop during bodyless settlement')); return apply(scope, command, now) })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow()
    const run = t.store.read(scope).document.runs[0]
    expect(run).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1, attempts: [{ outcome: { state: 'response-complete', status, responseBytes: 0 } }] })
    expect(run.attempts).toHaveLength(1); expect(t.fetch).toHaveBeenCalledOnce()
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow()
  })
  it('Stop during begin commit cannot return a live adapter or silently finish idle accounting', () => {
    const t = setup(), apply = t.store.apply.bind(t.store), other = { ...scope, conversationId: 'during-begin' }
    const parent = new AbortController()
    vi.spyOn(t.store, 'apply').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'begin') parent.abort(new Error('Stop during begin')); return result })
    expect(() => createProviderDispatchAdmission({ ...t.options, scope: other, signal: parent.signal })).toThrow()
    expect(t.store.read(other).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 0 })
  })
  it('rechecks the original deadline after a slow final SQLite verification, not only before it', async () => {
    const t = setup({ maxWalltimeMs: 1000 }), read = t.store.read.bind(t.store), time = Date.now()
    let verification = 0
    vi.spyOn(t.store, 'read').mockImplementation(scope => {
      const result = read(scope)
      // Fetch two pre-reserve guards + reserve guard, then final pre-delegate guard.
      if (++verification === 4) vi.spyOn(Date, 'now').mockReturnValue(time + 2000)
      return result
    })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow('verification')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.store.read(scope).document.runs[0].attempts[0]).toMatchObject({ outcome: { state: 'not-dispatched', charged: true } })
  })
  it('durability failure after successful COMMIT does not turn an accounting receipt into replacement permission', async () => {
    const t = setup(), db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db)
    let fail = true
    vi.spyOn(db, 'exec').mockImplementation(sql => { const result = exec(sql); if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Lost database acknowledgement') } return result })
    await expect(t.request.fetch(endpoint, post())).rejects.toThrow('Lost database')
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.store.read(scope)).toMatchObject({ mutationBlocked: true, orphaned: true, document: { revision: 2 } })
  })
})
