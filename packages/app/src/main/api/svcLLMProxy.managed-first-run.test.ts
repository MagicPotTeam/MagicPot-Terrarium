import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { withCooperativeOperation } from '../assistantRuntime/cooperativeOperation'
import { createProviderRawWorkRetainer } from '../assistantRuntime/providerRawWorkRetention'
const state = vi.hoisted(() => ({ config: vi.fn() }))
vi.mock('../config/config', () => ({ getConfig: state.config, saveConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('electron', () => ({ net: {}, app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: { fromWebContents: () => undefined }, webContents: { fromId: () => undefined }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(), getMcpClientManager: () => ({ listToolsSnapshot: () => [] }) }))
import {
  LLMProxySvcImpl,
  prepareManagedTextFirstRun,
  invokePreparedManagedTextFirstRun,
  type PreparedManagedTextFirstRun
} from './svcLLMProxyImpl'

const profile = () => ({ id: 'first-text', model_name: 'fixture-text', api_key: 'only-a-fixture-credential', base_url: 'http://127.0.0.1:1/v1/chat/completions', provider: 'openai' as const, call_type: 'api', deployment: 'local' as const, model_use: 'agent' as const, api_mode: 'chat-completions' as const })
const config = (): Config => { const value = structuredClone(DEFAULT_CONFIG); value.use_remote_llm = false; value.llm_config.api_profiles = [profile()]; return value }
const request = () => ({ profileId: 'first-text', route: { channel: 'generic', scopeType: 'dm' as const, scopeId: 'first-run-envelope' }, messages: [{ role: 'user' as const, content: 'one approved question' }], systemPrompt: 'one approved system', maxOutputTokens: 128, temperature: 0.25 })
const response = (content = 'one plain response', extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
// Deterministic injected Electron transaction; never global transport fallback.
// These envelope fixtures close automatically. The explicit composition cases
// below hold close themselves to test service/transport ownership separately.
const installNative = (fetcher: typeof fetch): void => {
  Object.assign(net, { request: vi.fn((input: { url: string; method: string; redirect: RequestRedirect; credentials: RequestCredentials }) => {
    const headers: Record<string, string> = {}
    const client = Object.assign(new EventEmitter(), {
      abort: vi.fn(() => { client.emit('abort'); client.emit('close') }),
      setHeader: (name: string, value: string) => { headers[name] = value },
      end: (body?: Buffer) => {
        void (async () => {
          const reply = await fetcher(input.url, { method: input.method, headers, body: body?.toString('utf8'), redirect: input.redirect, credentials: input.credentials })
          const incoming = Object.assign(new EventEmitter(), { headers: Object.fromEntries(reply.headers), statusCode: reply.status, statusMessage: reply.statusText, pause: () => undefined, resume: () => undefined })
          client.emit('response', incoming)
          incoming.emit('data', Buffer.from(await reply.text())); incoming.emit('end'); client.emit('close')
        })().catch(error => { client.emit('error', error); client.emit('close') })
      }
    })
    return client
  }) })
}
async function run(service: object, plan: PreparedManagedTextFirstRun['plan'], assertCurrent: () => void = () => undefined) {
  const controller = new CooperativeExecutionController(), cancellation = new AbortController()
  try {
    return await withCooperativeOperation(controller, 'llm-inference', cancellation.signal, async child =>
      invokePreparedManagedTextFirstRun(service, plan, { signal: cancellation.signal, runId: '00000000-0000-4000-8000-000000000001' }, {
        assertCurrent,
        retainRawWork: createProviderRawWorkRetainer(child, cancellation.signal, assertCurrent)
      })
    )
  } finally { await controller.whenQuiescent() }
}
afterEach(() => { Reflect.deleteProperty(net, 'request'); Reflect.deleteProperty(net, 'fetch'); vi.restoreAllMocks(); vi.unstubAllGlobals(); state.config.mockReset() })

describe('prepared single text service envelope, not production lifecycle or approval acceptance', () => {
  it('prepares without effects, detaches the actual body, redacts credentials and sends exactly that body once', async () => {
    state.config.mockImplementation(() => { throw Error('Global config must not be consulted') })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()); installNative(fetcher)
    const service = LLMProxySvcImpl.createManagedRealChatService(), c = config(), req = request()
    const prepared = prepareManagedTextFirstRun(service, req, c)
    expect(fetcher).not.toHaveBeenCalled(); expect(state.config).not.toHaveBeenCalled()
    expect(prepared.material).toMatchObject({ protocol: 'managed-text-first-run/v1', endpoint: profile().base_url, profileId: 'first-text', credentialBinding: expect.stringMatching(/^[a-f0-9]{64}$/), body: { model: 'fixture-text', messages: [{ role: 'system', content: 'one approved system' }, { role: 'user', content: 'one approved question' }], temperature: 0.25, stream: false, max_tokens: 128 } })
    expect(JSON.stringify(prepared.material)).not.toContain(profile().api_key)
    expect(Object.isFrozen(prepared.material.body.messages)).toBe(true)
    req.messages[0].content = 'changed caller'; c.llm_config.api_profiles[0].api_key = 'changed key'
    expect((await run(service, prepared.plan)).content).toBe('one plain response')
    expect(fetcher).toHaveBeenCalledOnce()
    const [endpoint, init] = fetcher.mock.calls[0]
    expect(endpoint).toBe(prepared.material.endpoint); expect(JSON.parse(String(init?.body))).toEqual(prepared.material.body)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${profile().api_key}`)
    await expect(run(service, prepared.plan)).rejects.toThrow(/consum|used|plan|prepared/i)
    expect(fetcher).toHaveBeenCalledOnce(); expect(state.config).not.toHaveBeenCalled()
  })
  it('rejects copied plans and foreign service routing without consuming the original', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()); installNative(fetcher)
    const service = LLMProxySvcImpl.createManagedRealChatService(), other = LLMProxySvcImpl.createManagedRealChatService(), prepared = prepareManagedTextFirstRun(service, request(), config())
    await expect(run(service, { ...prepared.plan })).rejects.toThrow(/plan|prepared|exact/i)
    await expect(run(other, prepared.plan)).rejects.toThrow(/plan|prepared|exact/i)
    expect(fetcher).not.toHaveBeenCalled(); await run(service, prepared.plan); expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(['end', 'abort', 'error'] as const)('composes actual prepared service with managed last-close ownership after %s', async kind => {
    const incoming = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' }, statusCode: 200, statusMessage: 'OK', pause: vi.fn(), resume: vi.fn() })
    let sent!: () => void
    const dispatched = new Promise<void>(resolve => { sent = resolve })
    const client = Object.assign(new EventEmitter(), { abort: vi.fn(() => { client.emit('abort') }), end: vi.fn(sent), setHeader: vi.fn() })
    const native = vi.fn(() => client), netFetch = vi.fn(), globalFetch = vi.fn()
    Object.assign(net, { request: native, fetch: netFetch }); vi.stubGlobal('fetch', globalFetch)
    const service = LLMProxySvcImpl.createManagedRealChatService(), prepared = prepareManagedTextFirstRun(service, request(), config())
    const controller = new CooperativeExecutionController(), abort = new AbortController()
    const caller = withCooperativeOperation(controller, 'llm-inference', abort.signal, child => invokePreparedManagedTextFirstRun(service, prepared.plan, { signal: abort.signal, runId: 'compose-service' }, {
      assertCurrent: () => undefined, retainRawWork: createProviderRawWorkRetainer(child, abort.signal, () => undefined)
    }))
    void caller.catch(() => undefined)
    // Flush bounded microtasks instead of awaiting a possibly undispatched sent
    // promise: the pre-fix ordinary mock-fetch branch must fail assertions, not hang.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(native).toHaveBeenCalledOnce(); await dispatched
    if (kind === 'end') {
      client.emit('response', incoming)
      incoming.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'composed response' }, finish_reason: 'stop' }] })))
      incoming.emit('end'); await expect(caller).resolves.toMatchObject({ content: 'composed response' })
    } else if (kind === 'abort') { abort.abort(Error('composed stop')); await expect(caller).rejects.toThrow('composed stop') }
    else { client.emit('error', Error('composed network error')); await expect(caller).rejects.toThrow('composed network error') }
    expect(controller.isQuiescent()).toBe(false)
    client.emit('close'); await controller.whenQuiescent()
    expect(controller.isQuiescent()).toBe(true); expect(netFetch).not.toHaveBeenCalled(); expect(globalFetch).not.toHaveBeenCalled()
  })
  it('refuses missing native request support rather than falling back to global or net.fetch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher); Object.assign(net, { fetch: fetcher })
    const service = LLMProxySvcImpl.createManagedRealChatService(), prepared = prepareManagedTextFirstRun(service, request(), config())
    await expect(run(service, prepared.plan)).rejects.toThrow(/Electron|transaction|transport/i); expect(fetcher).not.toHaveBeenCalled()
  })
  it('binds the private credential/config identity without exposing a dictionary hash or the credential', () => {
    const service = LLMProxySvcImpl.createManagedRealChatService(), c = config()
    const one = prepareManagedTextFirstRun(service, request(), c), again = prepareManagedTextFirstRun(service, request(), c)
    c.llm_config.api_profiles[0].api_key = 'another-fixture-secret'
    const changed = prepareManagedTextFirstRun(service, request(), c)
    expect(one.material.credentialBinding).toBe(again.material.credentialBinding)
    expect(changed.material.credentialBinding).not.toBe(one.material.credentialBinding)
    expect(JSON.stringify(changed.material)).not.toContain('another-fixture-secret')
  })
  it('uses the actual client defaults and keeps output JSON literal, not media/session authority', async () => {
    const content = '{"content":"nested", "sessionUrl":"https://fixture.invalid/continue", "attachments":[{"url":"file:///forbidden"}]}'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(content)); installNative(fetcher)
    const service = LLMProxySvcImpl.createManagedRealChatService(), req = request()
    Reflect.deleteProperty(req, 'temperature'); req.systemPrompt = ''
    const prepared = prepareManagedTextFirstRun(service, req, config()), result = await run(service, prepared.plan)
    expect(prepared.material.body).toMatchObject({ temperature: 0.7, messages: [{ role: 'user', content: req.messages[0].content }] })
    expect(result).toEqual({ content }); expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(prepared.material.body)
  })
  it('observes private revocation before fetch and burns that execution slot', async () => {
    const fetcher = vi.fn<typeof fetch>(); installNative(fetcher)
    const service = LLMProxySvcImpl.createManagedRealChatService(), prepared = prepareManagedTextFirstRun(service, request(), config())
    await expect(run(service, prepared.plan, () => { throw Error('original owner revoked') })).rejects.toThrow('original owner revoked')
    await expect(run(service, prepared.plan)).rejects.toThrow(/consum|used|plan|prepared/i); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['remote', 'duplicate', 'tools', 'accessor', 'proxy', 'unbounded', 'helper', 'history', 'bytes', 'duration', 'query', 'provider'] as const)('refuses %s input at preparation before any provider work', kind => {
    const fetcher = vi.fn<typeof fetch>(); installNative(fetcher)
    const service = LLMProxySvcImpl.createManagedRealChatService(), c = config(), req = request(), getter = vi.fn(() => 'side effect')
    if (kind === 'remote') c.use_remote_llm = true
    if (kind === 'duplicate') c.llm_config.api_profiles.push(profile())
    if (kind === 'tools') Object.assign(req, { skillRuntime: { bindings: [{ appId: 'untrusted', toolNames: ['session.status'] }] } })
    if (kind === 'accessor') Object.defineProperty(req, 'systemPrompt', { enumerable: true, get: getter })
    if (kind === 'unbounded') req.maxOutputTokens = 0
    if (kind === 'helper') req.messages[0].content = '/tool session.status {}'
    if (kind === 'proxy') Object.assign(req, { route: new Proxy(req.route, { ownKeys: () => { getter(); return [] } }) })
    if (kind === 'history') req.messages.push({ role: 'user', content: 'prior user input' })
    if (kind === 'bytes') req.messages[0].content = '中'.repeat(24_000)
    if (kind === 'duration') Object.assign(c.llm_config.api_profiles[0], { request_timeout_ms: 1 })
    if (kind === 'query') c.llm_config.api_profiles[0].base_url += '?token=do-not-approve'
    if (kind === 'provider') Object.assign(c.llm_config.api_profiles[0], { provider: 'gemini' })
    expect(() => prepareManagedTextFirstRun(service, req, c)).toThrow(); expect(getter).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['native', 'json', 'incomplete', 'error', 'legacy-function', 'media', 'fenced-json', 'refusal-status', 'choices'] as const)('rejects %s response without tools or a second model attempt', async kind => {
    let reply = response()
    if (kind === 'native') reply = response('looks finished', { tool_calls: [{ id: 'one', type: 'function', function: { name: 'session.status', arguments: '{}' } }] })
    if (kind === 'json') reply = response('{"toolName":"session.status","args":{}}')
    if (kind === 'incomplete') reply = new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'truncated' }, finish_reason: 'length' }] }))
    if (kind === 'legacy-function') reply = response('looks plain', { function_call: { name: 'session.status', arguments: '{}' } })
    if (kind === 'media') reply = response('looks plain', { images: [{ url: 'file:///forbidden' }] })
    if (kind === 'fenced-json') reply = response('```json\n{"toolName":"session.status","args":{}}\n```')
    if (kind === 'refusal-status') reply = new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'filtered' }, finish_reason: 'content_filter' }] }))
    if (kind === 'choices') reply = new Response(JSON.stringify({ choices: [1, 2].map(() => ({ message: { role: 'assistant', content: 'ambiguous' }, finish_reason: 'stop' })) }))
    if (kind === 'error') reply = new Response(JSON.stringify({ error: { message: 'tools is not supported' } }), { status: 400 })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply).mockResolvedValueOnce(response('must not sample')); installNative(fetcher)
    const service = LLMProxySvcImpl.createManagedRealChatService(), prepared = prepareManagedTextFirstRun(service, request(), config())
    await expect(run(service, prepared.plan)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce()
  })
})
