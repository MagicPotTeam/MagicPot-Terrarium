import fs from 'node:fs/promises'
import path from 'node:path'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { AssistantRuntime } from './runtime'
import { AssistantSessionStore } from './sessionStore'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
const mocks = vi.hoisted(() => ({ root: '', mcp: vi.fn(), globalConfig: vi.fn() }))
vi.mock('electron', () => ({ net: {}, app: { isPackaged: false, getPath: () => process.cwd() }, BrowserWindow: { fromWebContents: () => undefined }, webContents: { fromId: () => undefined }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: mocks.root } }) }))
vi.mock('../config/config', () => ({ getConfig: mocks.globalConfig, saveConfig: vi.fn() }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: mocks.mcp, getMcpClientManager: () => { throw Error('No MCP manager in zero tool first run') } }))
const roots: string[] = []
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function freshRuntime(store: AssistantSessionStore) {
  return new AssistantRuntime({ chatService: LLMProxySvcImpl.createManagedRealChatService(), sessionStore: store, configProvider: mocks.globalConfig, managedTextFirstRun: true })
}
async function setup() {
  mocks.root = await createNodeTestArtifactDir('managed-first-run-runtime'); roots.push(mocks.root)
  const config = structuredClone(DEFAULT_CONFIG) as Config
  config.use_remote_llm = false
  config.llm_config.api_profiles = [{ id: 'text', model_name: 'text-fixture', api_key: 'fixture-only', base_url: 'http://127.0.0.1:1/v1/chat/completions', provider: 'openai', call_type: 'api', deployment: 'local', model_use: 'agent', api_mode: 'chat-completions' }]
  config.llm_config.api_profiles[0].request_timeout_ms = 1000
  const store = new AssistantSessionStore(path.join(mocks.root, 'isolated-sessions.json'))
  const runtime = freshRuntime(store)
  const owner = new CooperativeExecutionController(), abort = new AbortController()
  const dispatchCheck = vi.fn(), completionCheck = vi.fn()
  const context = { controller: abort, cooperativeExecution: owner, runId: 'managed-runtime-first', assertDispatchCurrent: dispatchCheck, assertCompletionCurrent: completionCheck }
  const input = { route: { channel: 'generic', scopeType: 'dm' as const, scopeId: 'fresh-runtime' }, text: 'exact first input', systemPrompt: 'exact system', profileId: 'text', maxOutputTokens: 128, temperature: 0.2 }
  const prepared = runtime.prepareManagedTextFirstRun(input, config)
  const sent = deferred(), incoming = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' }, statusCode: 200, statusMessage: 'OK', pause: vi.fn(), resume: vi.fn() })
  let wireBody = ''
  const client = Object.assign(new EventEmitter(), { abort: vi.fn(() => client.emit('abort')), setHeader: vi.fn(), end: vi.fn((body: Buffer) => { wireBody = body.toString('utf8'); sent.resolve() }) })
  Object.assign(net, { request: vi.fn(() => client), fetch: vi.fn() })
  const reply = () => { client.emit('response', incoming); incoming.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'one runtime reply' }, finish_reason: 'stop' }] }))); incoming.emit('end') }
  return { runtime, store, config, owner, abort, context, input, prepared, sent, client, reply, body: () => JSON.parse(wireBody) }
}
afterEach(async () => { Reflect.deleteProperty(net, 'request'); Reflect.deleteProperty(net, 'fetch'); mocks.mcp.mockReset(); mocks.globalConfig.mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

describe('actual prepared AssistantRuntime bounded tail; fixture authority, not production policy', () => {
  it('keeps final persistence and native close separately owned, then issues one bounded closure', async () => {
    const f = await setup(), held = deferred(), entered = deferred()
    const original = f.store.appendTurn.bind(f.store)
    vi.spyOn(f.store, 'appendTurn').mockImplementation(async (...args) => {
      if (args[1].some(message => message.role === 'assistant')) { entered.resolve(); await held.promise }
      return original(...args)
    })
    const execution = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); await entered.promise
    expect(f.owner.isQuiescent()).toBe(false)
    let closed = false; void execution.closed.then(() => { closed = true })
    f.client.emit('close'); await Promise.resolve(); expect(closed).toBe(false)
    held.resolve()
    const result = await execution.result, closure = await execution.closed
    expect(result).toMatchObject({ status: 'completed', reply: { content: 'one runtime reply' } })
    expect(f.owner.isQuiescent()).toBe(true)
    expect(f.body()).toEqual(f.prepared.material.model.body)
    expect(f.runtime.consumeManagedTextFirstRunClosure(closure, f.context)).toMatchObject({ runId: f.context.runId, outcome: 'completed', finalInputDigest: f.prepared.material.digest })
    expect(() => f.runtime.consumeManagedTextFirstRunClosure(closure, f.context)).toThrow(/consum|closure/i)
    expect(mocks.mcp).not.toHaveBeenCalled(); expect(mocks.globalConfig).not.toHaveBeenCalled()
    const session = await f.store.getSession(f.prepared.material.storage.route)
    expect(session?.messages.map(message => message.content)).toEqual(['exact first input', 'one runtime reply'])
  })
  it('caller abort is prompt while final cancellation persistence and native close remain owned', async () => {
    const f = await setup(), held = deferred(), entered = deferred(), original = f.store.upsertRun.bind(f.store)
    vi.spyOn(f.store, 'upsertRun').mockImplementation(async (...args) => {
      if (args[1].status === 'cancelled') { entered.resolve(); await held.promise }
      return original(...args)
    })
    const execution = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    void execution.closed.catch(() => undefined)
    await f.sent.promise
    f.context.assertDispatchCurrent.mockImplementation(() => { throw Error('dispatch authority revoked') })
    f.abort.abort(Error('user cancelled'))
    await expect(execution.result).rejects.toThrow(/cancelled/i)
    await entered.promise; expect(f.owner.isQuiescent()).toBe(false)
    held.resolve(); f.client.emit('close')
    const closure = await execution.closed
    expect(f.runtime.consumeManagedTextFirstRunClosure(closure, f.context)).toMatchObject({ outcome: 'cancelled' })
    expect(f.context.assertCompletionCurrent).toHaveBeenCalled()
    expect((await f.store.getSession(f.prepared.material.storage.route))?.runs[0].status).toBe('cancelled')
  })
  it('rejects ordinary operations, copied plans/closures and detached subscriber registration', async () => {
    const f = await setup()
    expect(() => f.runtime.subscribeEvents(f.input.route, () => undefined)).toThrow(/managed|subscriber|unsupported/i)
    await expect(f.runtime.handleMessage(f.input)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.submitMessage(f.input)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.handleCommand(f.input.route, 'tools')).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.callTool(f.input.route, 'files.read', {})).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.callPrivateSideRead(f.input.route, 'files.read', {}, { signal: f.abort.signal, readExternalFile: vi.fn() })).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.resolveSkillHintWorkspace(f.input.route, f.abort.signal)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.resetSession(f.input.route)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.cancelRoute(f.input.route)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.attachWorkspace(f.input.route, 'ordinary')).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.detachWorkspace(f.input.route)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.manageWorkspace(f.input.route, 'share')).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.startTaskGroup(f.input.route)).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.resumeRun(f.input.route, 'prior')).rejects.toThrow(/managed|prepared/i)
    await expect(f.runtime.resumeWorkflow('prior', f.input.route)).rejects.toThrow(/managed|prepared/i)
    expect(() => f.runtime.listTools()).toThrow(/managed|prepared/i)
    expect(() => f.runtime.prepareManagedTextFirstRun(f.input, f.config)).toThrow(/unused|preparation/i)
    expect(() => f.runtime.startPreparedManagedTextFirstRun({ ...f.prepared.plan }, f.context)).toThrow(/prepared|plan/i)
    expect(() => f.runtime.consumeManagedTextFirstRunClosure({} as never, f.context)).toThrow(/closure/i)
    expect(net.request).not.toHaveBeenCalled()
  })
  it('does not mint closure or retry final publication when its actual awaited store write fails', async () => {
    const f = await setup(), original = f.store.appendTurn.bind(f.store)
    const write = vi.spyOn(f.store, 'appendTurn').mockImplementation(async (...args) => {
      if (args[1].some(message => message.role === 'assistant')) throw Error('final publication failed')
      return original(...args)
    })
    const execution = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    void execution.closed.catch(() => undefined)
    await f.sent.promise; f.reply(); f.client.emit('close')
    await expect(execution.result).rejects.toThrow('final publication failed')
    await expect(execution.closed).rejects.toThrow('final publication failed')
    expect(write.mock.calls.filter(args => args[1].some(message => message.role === 'assistant'))).toHaveLength(1)
    expect(() => f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)).toThrow(/consum|prepared|plan/i)
  })
  it('keeps native close owned after all successful final store writes and result settlement', async () => {
    const f = await setup(), execution = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await f.sent.promise; f.reply()
    await expect(execution.result).resolves.toMatchObject({ status: 'completed' })
    let closed = false; void execution.closed.then(() => { closed = true })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
    f.client.emit('close'); await execution.closed; expect(f.owner.isQuiescent()).toBe(true)
  })
  it.each(['error', 'early-close'] as const)('publishes one failed outcome after %s, without retries or raw error persistence', async kind => {
    const f = await setup(), execute = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await f.sent.promise
    if (kind === 'error') f.client.emit('error', Error('raw credential: fixture-only'))
    else f.client.emit('close')
    await expect(execute.result).resolves.toMatchObject({ status: 'failed' })
    if (kind === 'error') {
      expect(f.owner.isQuiescent()).toBe(false); f.client.emit('close')
      const closure = await execute.closed
      expect(f.runtime.consumeManagedTextFirstRunClosure(closure, f.context)).toMatchObject({ outcome: 'failed' })
    } else {
      let closed = false; void execute.closed.then(() => { closed = true })
      expect(f.owner.isQuiescent()).toBe(false)
      f.reply(); f.client.emit('error', Error('late native failure')); f.client.emit('close')
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
      expect(() => f.runtime.consumeManagedTextFirstRunClosure({} as never, f.context)).toThrow(/closure/i)
    }
    const session = await f.store.getSession(f.prepared.material.storage.route)
    expect(JSON.stringify(session)).not.toContain('fixture-only')
    expect(session?.runs[0].status).toBe('failed'); expect(session?.runs[0].toolCalls).toEqual([])
    expect(session?.messages).toHaveLength(1); expect(net.request).toHaveBeenCalledOnce()
  })
  it('does not unlock on runtime deadline while its already-owned cancellation write is held', async () => {
    const f = await setup(), hold = deferred(), entered = deferred(), original = f.store.upsertRun.bind(f.store)
    vi.spyOn(f.store, 'upsertRun').mockImplementation(async (...args) => { entered.resolve(); await hold.promise; return original(...args) })
    vi.useFakeTimers()
    const execute = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    void execute.result.catch(() => undefined)
    await f.sent.promise
    await vi.advanceTimersByTimeAsync(1001)
    await expect(execute.result).rejects.toThrow(/deadline/i); await entered.promise
    f.client.emit('close')
    let closed = false; void execute.closed.then(() => { closed = true })
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(closed).toBe(false); expect(f.owner.isQuiescent()).toBe(false)
    hold.resolve(); await execute.closed; expect(f.owner.isQuiescent()).toBe(true)
  })
  it('retains setup I/O on caller abort, completes cancellation and never dispatches the model', async () => {
    const f = await setup(), hold = deferred(), entered = deferred(), original = f.store.getSession.bind(f.store)
    vi.spyOn(f.store, 'getSession').mockImplementationOnce(async (...args) => { entered.resolve(); await hold.promise; return original(...args) })
    const execute = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await entered.promise; f.abort.abort(Error('cancelled during setup'))
    await expect(execute.result).rejects.toThrow('cancelled during setup'); expect(f.owner.isQuiescent()).toBe(false)
    hold.resolve()
    expect(f.runtime.consumeManagedTextFirstRunClosure(await execute.closed, f.context)).toMatchObject({ outcome: 'cancelled' })
    expect(net.request).not.toHaveBeenCalled()
    expect((await f.store.getSession(f.prepared.material.storage.route))?.runs[0].status).toBe('cancelled')
  })
  it('detaches final normalized input/options from mutations and never rereads global config', async () => {
    const f = await setup()
    f.input.text = 'changed caller'; f.input.systemPrompt = 'changed system'; f.input.temperature = 1.9
    f.config.llm_config.api_profiles[0].api_key = 'changed-credential'; f.config.llm_config.api_profiles[0].base_url = 'https://never-contact.invalid/v1/chat/completions'
    const execute = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); f.client.emit('close')
    await execute.result; await execute.closed
    expect(f.body()).toEqual(f.prepared.material.model.body)
    expect(f.body().messages).toEqual([{ role: 'system', content: 'exact system' }, { role: 'user', content: 'exact first input' }])
    expect(mocks.globalConfig).not.toHaveBeenCalled(); expect(mocks.mcp).not.toHaveBeenCalled()
    expect(net.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://127.0.0.1:1/v1/chat/completions' }))
  })
  it.each(['abort', 'sync-guard', 'async-guard'] as const)('burns the original plan before a pre-dispatch %s refusal', async kind => {
    const f = await setup()
    if (kind === 'abort') f.abort.abort(Error('cancelled before dispatch'))
    if (kind === 'sync-guard') f.context.assertDispatchCurrent.mockImplementation(() => { throw Error('revoked') })
    if (kind === 'async-guard') f.context.assertDispatchCurrent.mockImplementation((async () => undefined) as () => void)
    expect(() => f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)).toThrow()
    expect(() => f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)).toThrow(/unused|prepared/i)
    expect(net.request).not.toHaveBeenCalled(); expect(f.owner.isQuiescent()).toBe(true)
  })
  it('refuses foreign runtime/owner and copied closure identities without consuming the original', async () => {
    const f = await setup(), other = freshRuntime(new AssistantSessionStore(path.join(mocks.root, 'other.json')))
    expect(() => other.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)).toThrow(/prepared|plan/i)
    const execute = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); f.client.emit('close'); await execute.result
    const closure = await execute.closed
    expect(() => other.consumeManagedTextFirstRunClosure(closure, f.context)).toThrow(/closure/i)
    expect(() => f.runtime.consumeManagedTextFirstRunClosure({ ...closure }, f.context)).toThrow(/closure/i)
    expect(() => f.runtime.consumeManagedTextFirstRunClosure(closure, { ...f.context, controller: new AbortController() })).toThrow(/closure/i)
    expect(() => f.runtime.consumeManagedTextFirstRunClosure(closure, f.context)).not.toThrow()
  })
  it('does not mint closure if completion authority is revoked after final writes', async () => {
    const f = await setup(), execute = f.runtime.startPreparedManagedTextFirstRun(f.prepared.plan, f.context)
    await f.sent.promise; f.reply(); await execute.result
    f.context.assertCompletionCurrent.mockImplementation(() => { throw Error('completion epoch revoked') })
    f.client.emit('close'); await expect(execute.closed).rejects.toThrow('completion epoch revoked')
    expect(f.owner.isQuiescent()).toBe(true)
  })
  it.each(['onEvent', 'attachments', 'toolProvider', 'workspace', 'history', 'resume', 'proxy'] as const)('rejects unsupported preparation %s before any callback or I/O', async kind => {
    const f = await setup(), runtime = freshRuntime(new AssistantSessionStore(path.join(mocks.root, `negative-${kind}.json`))), callback = vi.fn()
    const req: Record<string, unknown> = { ...f.input }
    if (kind === 'onEvent') req.onEvent = callback
    if (kind === 'attachments') req.attachments = []
    if (kind === 'toolProvider') req.toolProvider = { listTools: callback, callTool: callback }
    if (kind === 'workspace') req.workspaceId = 'ordinary'
    if (kind === 'history') req.executionMode = 'inherit'
    if (kind === 'resume') req.resumeFromRunId = 'ordinary'
    if (kind === 'proxy') req.route = new Proxy(f.input.route, { ownKeys: () => { callback(); return [] } })
    expect(() => runtime.prepareManagedTextFirstRun(req as never, f.config)).toThrow(/managed|snapshot|plain|first run/i)
    expect(callback).not.toHaveBeenCalled(); expect(net.request).not.toHaveBeenCalled()
  })
})
