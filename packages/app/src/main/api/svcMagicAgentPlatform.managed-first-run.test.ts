import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { magicAgentPlatformSvcDef } from '@shared/api/svcMagicAgentPlatform'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { MagicAgentPlatformAdapter } from '../magicAgentRuntime/platformAdapter'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

const mocks = vi.hoisted(() => ({ root: '', mcp: vi.fn(), globalConfig: vi.fn(), ordinaryRuntime: vi.fn(), ordinaryAdapter: vi.fn(), kernel: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: { fromWebContents: () => undefined }, webContents: { fromId: () => undefined }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: mocks.root } }) }))
vi.mock('../config/config', () => ({ getConfig: mocks.globalConfig, saveConfig: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: mocks.mcp, getMcpClientManager: () => { throw Error('No global MCP manager in bounded first run') } }))
vi.mock('../assistantRuntime/runtime', async importOriginal => ({ ...await importOriginal<object>(), getAssistantRuntime: mocks.ordinaryRuntime }))
vi.mock('../magicAgentRuntime/platformAdapter', async importOriginal => ({ ...await importOriginal<object>(), getMagicAgentPlatformAdapter: mocks.ordinaryAdapter }))
vi.mock('../agentKernel', async importOriginal => ({ ...await importOriginal<object>(), getAgentKernel: mocks.kernel }))

const roots: string[] = []
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function setup() {
  mocks.root = await createNodeTestArtifactDir('managed-first-run-platform'); roots.push(mocks.root)
  const config = structuredClone(DEFAULT_CONFIG) as Config
  config.use_remote_llm = false
  config.llm_config.api_profiles = [{ id: 'text', model_name: 'platform-text-fixture', api_key: 'fixture-only-key', base_url: 'http://127.0.0.1:1/v1/chat/completions', provider: 'openai', call_type: 'api', deployment: 'local', model_use: 'agent', api_mode: 'chat-completions', request_timeout_ms: 1000 }]
  const store = new AssistantSessionStore(path.join(mocks.root, 'isolated-sessions.json'))
  const service = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(store)
  const owner = new CooperativeExecutionController(), controller = new AbortController()
  const context = { controller, cooperativeExecution: owner, runId: 'platform-first-run', assertDispatchCurrent: vi.fn(), assertCompletionCurrent: vi.fn() }
  const request = { agentId: 'fixture.agent', route: { channel: 'generic', scopeType: 'dm' as const, scopeId: 'local-platform-pane' }, text: 'exact platform input', systemPrompt: '  exact system  ', profileId: 'text', maxOutputTokens: 128, temperature: 0.2 }
  const prepared = service.prepare(request, config)
  const sent = deferred()
  const incoming = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' }, statusCode: 200, statusMessage: 'OK', pause: vi.fn(), resume: vi.fn() })
  let wireBody = ''
  const client = Object.assign(new EventEmitter(), { abort: vi.fn(() => client.emit('abort')), setHeader: vi.fn(), end: vi.fn((body: Buffer) => { wireBody = body.toString('utf8'); sent.resolve() }) })
  Object.assign(net, { request: vi.fn(() => client), fetch: vi.fn() })
  const reply = () => { client.emit('response', incoming); incoming.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'one platform reply' }, finish_reason: 'stop' }] }))); incoming.emit('end') }
  return { store, service, config, owner, controller, context, request, prepared, sent, client, incoming, reply, body: () => JSON.parse(wireBody) }
}
function expectNoOrdinaryPath() {
  for (const mock of [mocks.mcp, mocks.globalConfig, mocks.ordinaryRuntime, mocks.ordinaryAdapter, mocks.kernel]) expect(mock).not.toHaveBeenCalled()
  expect(net.fetch).not.toHaveBeenCalled()
}
afterEach(async () => {
  Reflect.deleteProperty(net, 'request'); Reflect.deleteProperty(net, 'fetch')
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
  for (const mock of [mocks.mcp, mocks.globalConfig, mocks.ordinaryRuntime, mocks.ordinaryAdapter, mocks.kernel]) mock.mockReset()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('actual private platform service → adapter → runtime → text client; fixture guards, not production authority', () => {
  it('prepares without ordinary registries/config, then maps one exact reply while waiting for native final close', async () => {
    const f = await setup()
    expectNoOrdinaryPath(); expect(net.request).not.toHaveBeenCalled()
    expect(await fs.readdir(mocks.root)).toEqual([])
    expect(Object.isFrozen(f.service)).toBe(true)
    expect(JSON.stringify(f.prepared.material)).not.toContain('fixture-only-key')
    const run = f.service.start(f.prepared.plan, f.context)
    await f.sent.promise; f.reply()
    const result = await run.result
    expect(result).toMatchObject({ runId: f.context.runId, agentId: 'fixture.agent', status: 'completed', content: 'one platform reply', toolCalls: [], messages: [{ role: 'user', content: 'exact platform input' }, { role: 'assistant', content: 'one platform reply' }] })
    expect(result.events.map(event => event.type)).toEqual(['assistantRuntime.started', 'assistantRuntime.completed'])
    expect(result.events.every(event => event.agentId === 'fixture.agent')).toBe(true)
    expect(f.body()).toEqual(f.prepared.material.model.body)
    expect(f.owner.isQuiescent()).toBe(false)
    let closed = false; void run.closed.then(() => { closed = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(closed).toBe(false)
    f.client.emit('close')
    expect(f.service.consumeClosure(await run.closed, f.context)).toMatchObject({ runId: f.context.runId, outcome: 'completed', finalInputDigest: f.prepared.material.digest })
    expect(f.owner.isQuiescent()).toBe(true); expect(net.request).toHaveBeenCalledOnce(); expectNoOrdinaryPath()
  })
  it('keeps original ownership through delayed final writes even after responsive caller cancellation', async () => {
    const f = await setup(), held = deferred(), entered = deferred(), original = f.store.upsertRun.bind(f.store)
    vi.spyOn(f.store, 'upsertRun').mockImplementation(async (...args) => { entered.resolve(); await held.promise; return original(...args) })
    const run = f.service.start(f.prepared.plan, f.context)
    await f.sent.promise
    f.context.assertDispatchCurrent.mockImplementation(() => { throw Error('dispatch revoked') })
    f.controller.abort(Error('cancelled by original owner'))
    await expect(run.result).rejects.toThrow('cancelled by original owner')
    await entered.promise; f.client.emit('close')
    let closed = false; void run.closed.then(() => { closed = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
    held.resolve()
    expect(f.service.consumeClosure(await run.closed, f.context)).toMatchObject({ outcome: 'cancelled' })
    expect(f.owner.isQuiescent()).toBe(true); expectNoOrdinaryPath()
  })
  it('cannot publish closure or retry after a final store failure, and still waits for native close', async () => {
    const f = await setup(), original = f.store.appendTurn.bind(f.store)
    const write = vi.spyOn(f.store, 'appendTurn').mockImplementation(async (...args) => {
      if (args[1].some(message => message.role === 'assistant')) throw Error('platform final persistence failed')
      return original(...args)
    })
    const run = f.service.start(f.prepared.plan, f.context)
    await f.sent.promise; f.reply()
    await expect(run.result).rejects.toThrow('platform final persistence failed')
    let closed = false; void run.closed.catch(() => { closed = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
    f.client.emit('close'); await expect(run.closed).rejects.toThrow('platform final persistence failed')
    expect(write.mock.calls.filter(args => args[1].some(message => message.role === 'assistant'))).toHaveLength(1)
    expect(() => f.service.start(f.prepared.plan, f.context)).toThrow(/prepared|unused|plan/i)
    expectNoOrdinaryPath()
  })
  it('pins response identity and model material before caller mutations without package/agent re-resolution', async () => {
    const packageMethods = MagicAgentPlatformSvcImpl.prototype as unknown as { listPackageAgents(): Promise<unknown> }
    const ordinary = [vi.spyOn(MagicAgentPlatformAdapter.prototype, 'runAgent'), vi.spyOn(MagicAgentPlatformAdapter.prototype, 'refreshRuntimeTools'), vi.spyOn(MagicAgentPlatformAdapter.prototype, 'listAgents'), vi.spyOn(packageMethods, 'listPackageAgents')]
    const f = await setup()
    f.request.agentId = 'mutated.agent'; f.request.text = 'mutated'; f.request.route.scopeId = 'other-pane'
    f.request.systemPrompt = 'mutated system'; f.config.llm_config.api_profiles[0].base_url = 'https://never-contact.invalid/v1/chat/completions'
    const run = f.service.start(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); f.client.emit('close')
    await expect(run.result).resolves.toMatchObject({ agentId: 'fixture.agent', messages: [{ content: 'exact platform input' }, { content: 'one platform reply' }] })
    await run.closed
    expect(f.body()).toEqual(f.prepared.material.model.body)
    for (const spy of ordinary) expect(spy).not.toHaveBeenCalled()
    expectNoOrdinaryPath()
  })
  it('rejects copied service, foreign plans/contexts and closure replay without consuming originals', async () => {
    const f = await setup(), copy = { ...f.service }
    expect(() => copy.start(f.prepared.plan, f.context)).toThrow(/exact|facade|service/i)
    expect(() => copy.prepare(f.request, f.config)).toThrow(/exact|facade|service/i)
    const other = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(new AssistantSessionStore(path.join(mocks.root, 'other.json')))
    expect(() => other.start(f.prepared.plan, f.context)).toThrow(/prepared|plan/i)
    expect(() => f.service.start({ ...f.prepared.plan }, f.context)).toThrow(/prepared|plan/i)
    const run = f.service.start(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); f.client.emit('close'); await run.result
    const closure = await run.closed
    expect(() => copy.consumeClosure(closure, f.context)).toThrow(/exact|facade|service/i)
    expect(() => other.consumeClosure(closure, f.context)).toThrow(/closure/i)
    expect(() => f.service.consumeClosure({ ...closure }, f.context)).toThrow(/closure/i)
    expect(() => f.service.consumeClosure(closure, { ...f.context, controller: new AbortController() })).toThrow(/closure/i)
    expect(() => f.service.consumeClosure(closure, f.context)).not.toThrow()
    expect(() => f.service.consumeClosure(closure, f.context)).toThrow(/closure|consum/i)
  })
  it('has no ordinary agent/tool/singleton surface and grants no execution to preview DTOs', async () => {
    const f = await setup()
    expect(Reflect.has(f.service, 'runAgent')).toBe(false); expect(Reflect.has(f.service, 'callTool')).toBe(false)
    expect(Reflect.has(new MagicAgentPlatformSvcImpl(), 'prepare')).toBe(false)
    for (const method of ['prepare', 'start', 'consumeClosure', 'createManagedTextFirstRunService']) expect(Reflect.has(magicAgentPlatformSvcDef, method)).toBe(false)
    expect(() => f.service.start(f.prepared.material as never, f.context)).toThrow(/prepared|plan/i)
    expect(() => f.service.consumeClosure(f.prepared.material as never, f.context)).toThrow(/closure/i)
    let child: unknown
    await f.owner.run('assistant-turn', undefined, scope => { child = scope })
    expect(() => f.service.start(f.prepared.plan, { ...f.context, cooperativeExecution: child } as never)).toThrow(/original|context|root/i)
    expect(net.request).not.toHaveBeenCalled(); expectNoOrdinaryPath()
  })
  it('keeps final native close owned after the platform caller deadline and never falls back to ordinary runAgent', async () => {
    const f = await setup()
    vi.useFakeTimers()
    const run = f.service.start(f.prepared.plan, f.context)
    void run.result.catch(() => undefined)
    await f.sent.promise; await vi.advanceTimersByTimeAsync(1001)
    await expect(run.result).rejects.toThrow(/deadline/i)
    let closed = false; void run.closed.then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
    f.client.emit('close')
    expect(f.service.consumeClosure(await run.closed, f.context)).toMatchObject({ outcome: 'cancelled' })
    expect(net.request).toHaveBeenCalledOnce(); expectNoOrdinaryPath()
  })
  it.each(['model-tool', 'native-error', 'early-close', 'no-native'] as const)('has one sanitized failed outcome and no retry/helper for %s', async kind => {
    const f = await setup()
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('Global fetch fallback forbidden') }))
    if (kind === 'no-native') Reflect.deleteProperty(net, 'request')
    const run = f.service.start(f.prepared.plan, f.context)
    if (kind !== 'no-native') {
      await f.sent.promise
      if (kind === 'model-tool') {
        f.client.emit('response', f.incoming)
        f.incoming.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'foreign', type: 'function', function: { name: 'files.write', arguments: '{"path":"not-owned"}' } }] }, finish_reason: 'tool_calls' }] })))
        f.incoming.emit('end')
      } else if (kind === 'native-error') f.client.emit('error', Error('secret-bearing fixture-only-key upstream error'))
      else f.client.emit('close')
    }
    const result = await run.result
    expect(result).toMatchObject({ status: 'failed', toolCalls: [] })
    expect(JSON.stringify(result)).not.toContain('fixture-only-key'); expect(JSON.stringify(result)).not.toContain('not-owned')
    if (kind === 'model-tool' || kind === 'native-error') { expect(f.owner.isQuiescent()).toBe(false); f.client.emit('close') }
    if (kind === 'early-close') {
      let closed = false; void run.closed.then(() => { closed = true })
      f.client.emit('error', Error('late native callback')); f.incoming.emit('end'); f.client.emit('close')
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
      expect(() => f.service.consumeClosure({} as never, f.context)).toThrow(/closure/i)
    } else expect(f.service.consumeClosure(await run.closed, f.context)).toMatchObject({ outcome: 'failed' })
    if (kind !== 'no-native') expect(net.request).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled(); expectNoOrdinaryPath()
  })
  it.each(['abort', 'revoked', 'async'] as const)('burns the prepared platform slot on %s dispatch refusal', async kind => {
    const f = await setup()
    if (kind === 'abort') f.controller.abort(Error('pre-dispatch cancel'))
    if (kind === 'revoked') f.context.assertDispatchCurrent.mockImplementation(() => { throw Error('revoked') })
    if (kind === 'async') f.context.assertDispatchCurrent.mockImplementation((async () => undefined) as () => void)
    expect(() => f.service.start(f.prepared.plan, f.context)).toThrow()
    expect(() => f.service.start(f.prepared.plan, f.context)).toThrow(/unused|prepared|plan/i)
    expect(net.request).not.toHaveBeenCalled(); expect(f.owner.isQuiescent()).toBe(true); expectNoOrdinaryPath()
  })
  it('requires completion-only authority after all final writes, and does not resurrect dispatch for closure', async () => {
    const f = await setup(), run = f.service.start(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); await run.result
    f.context.assertCompletionCurrent.mockImplementation(() => { throw Error('completion revoked') })
    f.client.emit('close'); await expect(run.closed).rejects.toThrow('completion revoked')
    expect(f.owner.isQuiescent()).toBe(true); expectNoOrdinaryPath()
  })
  it.each(['attachments', 'memory', 'tools', 'metadata', 'session', 'helper', 'nonlocal', 'route-proxy'] as const)('rejects unsupported platform preparation %s without callbacks or I/O', async kind => {
    const f = await setup(), service = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(new AssistantSessionStore(path.join(mocks.root, `negative-${kind}.json`))), callback = vi.fn()
    const req: Record<string, unknown> = { ...f.request }
    if (kind === 'attachments') req.attachments = []
    if (kind === 'memory') req.memory = { allowHistory: true, contextMessageLimit: 2, scope: 'session' }
    if (kind === 'tools') req.allowedToolNames = ['files.read']
    if (kind === 'metadata') req.metadata = { managed: true, dispatch: callback }
    if (kind === 'session') req.sessionId = 'legacy'
    if (kind === 'helper') req.text = '/tools'
    if (kind === 'nonlocal') req.route = { ...f.request.route, channel: 'runtime-channel' }
    if (kind === 'route-proxy') req.route = new Proxy(f.request.route, { ownKeys: () => { callback(); return [] } })
    expect(() => service.prepare(req as never, f.config)).toThrow(/managed|first.run|plain|snapshot|route|unsupported/i)
    expect(callback).not.toHaveBeenCalled(); expect(net.request).not.toHaveBeenCalled(); expectNoOrdinaryPath()
  })
})
