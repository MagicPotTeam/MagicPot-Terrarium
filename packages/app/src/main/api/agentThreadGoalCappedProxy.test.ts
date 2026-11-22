import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ sender: undefined as unknown, owner: undefined as unknown, goalStore: undefined as unknown }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: () => h.sender }, BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false, webContents: h.sender }) } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd(), file: process.cwd(), resources: '' } }) }))
vi.mock('../llmProxy/providerDispatchOwner', async original => ({ ...(await original<typeof import('../llmProxy/providerDispatchOwner')>()), getProviderDispatchOwner: async () => h.owner }))
vi.mock('./agentThreadGoals', async original => { const actual = await original<typeof import('./agentThreadGoals')>(); return { ...actual, getAgentThreadGoalStore: async () => h.goalStore, agentThreadGoals: new actual.AgentThreadGoals(async () => h.goalStore as never) } })
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: vi.fn(() => { throw new Error('Capped recordkeeping must not construct ordinary runtime') }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig } from '../config/config'
import { OpenAIAPICli, type FetchImpl } from '@shared/llm/clients'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'
import { ProviderInvocationLedgerDataStore } from '../llmProxy/providerDispatchLedgerStore'
import { ProviderDispatchOwner } from '../llmProxy/providerDispatchOwner'
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { agentThreadGoalProgress } from './agentThreadGoalProgress'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import type { AgentGoalShareReq } from '@shared/api/agentThreadGoal'
const url = 'file:///D:/app/index.html#/canvas?id=project', endpoint = 'https://model.test/v1/chat/completions'
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let root: string, owner: ProviderDispatchOwner, ownerCodec: ReturnType<typeof sideTestCodec>, store: AgentThreadGoalStore, service: LLMProxySvcImpl, sender: EventEmitter, shareReq: AgentGoalShareReq
let fetcher: ReturnType<typeof vi.fn<FetchImpl>>
beforeEach(async () => {
  vi.clearAllMocks()
  sender = Object.assign(new EventEmitter(), { id: 71, getURL: () => url, isDestroyed: () => false }); h.sender = sender
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  root = mkdtempSync(path.join(tmpdir(), 'goal-cap-service-')); ownerCodec = sideTestCodec(); owner = new ProviderDispatchOwner(root, ownerCodec); h.owner = owner
  store = new AgentThreadGoalStore(sideTestCodec()); h.goalStore = store
  const config = structuredClone(DEFAULT_CONFIG); config.llm_config.api_profiles = [{ id: 'profile', model_name: 'model', base_url: endpoint, api_key: 'FIXTURE_KEY', provider: 'openai', api_mode: 'chat-completions' }]
  vi.mocked(getConfig).mockReturnValue(config)
  service = new LLMProxySvcImpl()
  const documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!, goalId = randomUUID()
  store.mutateUser(scope, { action: 'create', goalId, title: 'USER_GOAL', spec: normalizeAgentGoalSpec({ objective: 'USER_SHARED_GOAL' }), expectedRevision: 0, operationId: randomUUID() })
  store.mutateUser(scope, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, operationId: randomUUID(), status: 'active', reason: 'user record activation' })
  shareReq = { ...scope, documentToken, goalId, expectedGeneration: 2, expectedRevision: 2, profileId: 'profile', maxProviderDispatches: 3 }
  fetcher = vi.fn<FetchImpl>(); vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
  agentThreadGoalProgress.dispose(); sender.emit('did-start-navigation'); sender.emit('destroyed')
  await owner.shutdown(); store.close(); rmSync(root, { force: true, recursive: true }); clearMagicAgentTrustedRouteBindingsForTest()
  mainHostExtensionApiV1.llmProxy.splice(0, mainHostExtensionApiV1.llmProxy.length, ...mainHostExtensionApiV1.llmProxy.filter(item => item.id !== 'cap-escape-fixture'))
  sharedHostExtensionApiV1.llmProfiles.splice(0, sharedHostExtensionApiV1.llmProfiles.length, ...sharedHostExtensionApiV1.llmProfiles.filter(item => item.id !== 'cap-escape-fixture'))
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const answer = (content = 'Final bounded answer') => Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })
const request = (token: string) => ({ ...scope, profileId: 'profile', apiMode: 'auto' as const, goalProgressToken: token, messages: [{ role: 'user' as const, content: 'Record observed progress' }] })
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body))
describe('capped goal recordkeeping through real service + built-in API client + SQLite (provider fetch fixture)', () => {
  it.each([['chat', false], ['chat', true], ['chatStream', false], ['chatStream', true]] as const)('enforces one persistent cap through %s native=%s and exposes only three record tools without another model turn', async (method, native) => {
    vi.spyOn(OpenAIAPICli.prototype, 'supportsNativeTools', 'get').mockReturnValue(native)
    const extension = { id: 'cap-escape-fixture', createCli: vi.fn(() => { throw new Error('Extension must not receive capped request') }), normalizeRequestedProfileId: vi.fn(() => 'wrong'), handleChatRequest: vi.fn() }
    mainHostExtensionApiV1.llmProxy.push(extension); sharedHostExtensionApiV1.llmProfiles.push(extension)
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    expect(share).toMatchObject({ budgetsEnforced: false, dispatchCap: { maxProviderDispatches: 3, enforced: false, unaryOnly: true } })
    expect(fetcher).not.toHaveBeenCalled(); expect(owner.readData(scope).document.revision).toBe(0)
    fetcher.mockImplementation(async (url, init) => {
      expect(String(url)).toBe(endpoint); expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
      const body = bodyOf(init), attempt = owner.readData(scope).document.runs[0]
      expect(body.stream).toBe(false); expect(attempt.chargedProviderDispatches).toBe(fetcher.mock.calls.length); expect(attempt.attempts.at(-1)!.outcome).toBeUndefined()
      expect(JSON.stringify(body)).toContain('USER_SHARED_GOAL'); expect(JSON.stringify(body)).not.toMatch(/goalProgressToken|profileHash|operationHash|dispatchCap|FIXTURE_KEY/)
      if (fetcher.mock.calls.length === 1) {
        if (native) {
          expect(body.tools).toHaveLength(3)
          return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'provider-report', type: 'function', function: { name: body.tools[1].function.name, arguments: '{"summary":"Observed through actual capped client","evidence":["fixture"]}' } }] }, finish_reason: 'tool_calls' }] })
        }
        expect(body.tools).toBeUndefined()
        return answer('{"toolName":"drive_report","args":{"summary":"Observed through actual capped client","evidence":["fixture"]}}')
      }
      return answer()
    })
    const events: unknown[] = []
    if (method === 'chat') expect(await service.chat(request(share.token), invoke(method))).toMatchObject({ content: 'Final bounded answer', metadata: { dispatchAccounting: { dispatchCapEnforced: true, budgetsEnforced: false } } })
    else {
      await service.chatStream(request(share.token), { onData: event => events.push(event) }, invoke(method))
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', finishReason: 'stop', content: 'Final bounded answer' }))
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-status', toolStatus: expect.objectContaining({ toolName: 'drive_report', status: 'completed' }) }))
    }
    expect(fetcher).toHaveBeenCalledTimes(2); expect(extension.createCli).not.toHaveBeenCalled(); expect(extension.normalizeRequestedProfileId).not.toHaveBeenCalled(); expect(extension.handleChatRequest).not.toHaveBeenCalled()
    expect(store.read(scope).goals[0]).toMatchObject({ status: 'active', progress: { summary: 'Observed through actual capped client' } })
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'finished', chargedProviderDispatches: 2, maxProviderDispatches: 3 })
    const count = fetcher.mock.calls.length
    if (method === 'chat') await expect(service.chat(request(share.token), invoke(method))).rejects.toThrow('not available')
    else { const onData = vi.fn(); await service.chatStream(request(share.token), { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })) }
    expect(fetcher).toHaveBeenCalledTimes(count)
  })
  it.each(['chat', 'chatStream'] as const)('retains a completed goal write when the next %s send exhausts its cap, with no paid fallback or summary send', async method => {
    vi.spyOn(OpenAIAPICli.prototype, 'supportsNativeTools', 'get').mockReturnValue(false)
    const share = await service.prepareAgentGoalProgress({ ...shareReq, maxProviderDispatches: 1 }, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValue(answer('{"toolName":"drive_report","args":{"summary":"Already committed progress","evidence":[]}}'))
    const events: unknown[] = []
    if (method === 'chat') await expect(service.chat(request(share.token), invoke(method))).rejects.toThrow('budget')
    else { await service.chatStream(request(share.token), { onData: event => events.push(event) }, invoke(method)); expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('budget') })); expect(events).toContainEqual(expect.objectContaining({ type: 'tool-status', metadata: expect.objectContaining({ toolHistory: expect.arrayContaining([expect.objectContaining({ status: 'completed', toolName: 'drive_report' })]) }) })) }
    expect(fetcher).toHaveBeenCalledOnce(); expect(store.read(scope).goals[0].progress?.summary).toBe('Already committed progress')
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
    await expect(service.prepareAgentGoalProgress({ ...shareReq, expectedRevision: 3 }, invoke('prepareAgentGoalProgress'))).rejects.toThrow(/blocked|uncertain/)
  })
  it('charges each real retry separately and does not reinterpret goal turns as a dispatch budget', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const share = await service.prepareAgentGoalProgress({ ...shareReq, maxProviderDispatches: 2 }, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'server overloaded' } }, { status: 503 })).mockImplementation(async () => answer())
    const pending = service.chat(request(share.token), invoke('chat')).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ content: 'Final bounded answer' }); expect(fetcher).toHaveBeenCalledTimes(2)
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'finished', chargedProviderDispatches: 2, attempts: [{ outcome: { status: 503 } }, { outcome: { status: 200 } }] })
    expect(store.read(scope).goals[0].spec.budgets.maxTurns).toBe(5)
  })
  it('charges protocol correction through the same cap rather than creating a fresh admission', async () => {
    vi.spyOn(OpenAIAPICli.prototype, 'supportsNativeTools', 'get').mockReturnValue(false)
    const share = await service.prepareAgentGoalProgress({ ...shareReq, maxProviderDispatches: 1 }, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValue(answer('{"toolName":"drive_report","args":'))
    await expect(service.chat(request(share.token), invoke('chat'))).rejects.toThrow('budget')
    expect(fetcher).toHaveBeenCalledOnce(); expect(store.read(scope).revision).toBe(2); expect(owner.readData(scope).document.runs).toHaveLength(1)
  })
  it('connection uncertainty blocks client retry, and Stop does not refund or revive a charged run', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    fetcher.mockRejectedValue(new Error('net::ERR_CONNECTION_CLOSED'))
    const pending = service.chat(request(share.token), invoke('chat')).catch(error => error)
    await vi.advanceTimersByTimeAsync(2000); expect(await pending).toBeInstanceOf(Error)
    expect(fetcher).toHaveBeenCalledOnce(); expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it.each(['prepare', 'chat', 'chatStream'] as const)('rejects v2 DATA at the real capped %s boundary without a provider, reset, goal write or ordinary fallback', async method => {
    const share = method === 'prepare' ? undefined : await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    // Fault injection: a non-cooperating same-user writer does not hold the
    // production ownership lock. It must cause a version rejection, never a
    // new authority; the production factory exposes no such DATA writer.
    const data = new ProviderInvocationLedgerDataStore(ownerCodec, path.join(root, 'ledger-v1.sqlite'))
    try { data.upgradeV2(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 }, Date.now()) } finally { data.close() }
    const before = owner.readCurrentData(scope), goalBefore = store.read(scope)
    if (method === 'prepare') await expect(service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))).rejects.toThrow('unsupported by the v1 API')
    else if (method === 'chat') await expect(service.chat(request(share!.token), invoke('chat'))).rejects.toThrow('unsupported by the v1 API')
    else {
      const events: unknown[] = []; await service.chatStream(request(share!.token), { onData: event => events.push(event) }, invoke('chatStream'))
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('unsupported by the v1 API') })); expect(events).toContainEqual(expect.objectContaining({ type: 'done', finishReason: 'error' }))
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(store.read(scope)).toEqual(goalBefore); expect(owner.readCurrentData(scope)).toEqual(before)
    await expect(service.listAgentGoalDispatches({ ...scope, documentToken: shareReq.documentToken }, invoke('listAgentGoalDispatches'))).rejects.toThrow('removed')
    expect(owner.readCurrentData(scope)).toEqual(before)
  })
  it('rejects an external ledger revision change between prepare and submit without rebasing or ordinary fallback', async () => {
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    const run = owner.createAdmission({ scope, binding: { goalId: shareReq.goalId, generation: 2, profileHash: 'a'.repeat(64) }, expectedRevision: 0, maxProviderDispatches: 1, maxWalltimeMs: 1000, endpoint, fetch: fetcher, signal: new AbortController().signal, assertLive: () => undefined }); run.finish()
    await expect(service.chat(request(share.token), invoke('chat'))).rejects.toThrow('no automatic rebase')
    expect(fetcher).not.toHaveBeenCalled(); expect(owner.readData(scope).document.revision).toBe(2)
    await expect(service.chat(request(share.token), invoke('chat'))).rejects.toThrow('not available')
  })
  it('revokes a delayed body when the goal generation changes, preserving a charged unknown without executing tools', async () => {
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    let entered!: () => void
    const dispatched = new Promise<void>(resolve => { entered = resolve })
    fetcher.mockImplementation(async () => { entered(); return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })) })
    const pending = service.chat(request(share.token), invoke('chat')).catch(error => error); await dispatched
    store.mutateUser(scope, { action: 'control', goalId: shareReq.goalId, expectedGeneration: 2, expectedRevision: 2, operationId: randomUUID(), status: 'paused', reason: 'user pause' })
    expect(await pending).toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledOnce(); expect(store.read(scope).goals[0].progress).toBeUndefined()
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it.each(['stop', 'navigation'] as const)('revokes %s during a pending capped response and never refunds or retries the dispatch', async kind => {
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    let entered!: () => void
    const sent = new Promise<void>(resolve => { entered = resolve })
    fetcher.mockImplementation(async () => { entered(); return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })) })
    const pending = service.chat({ ...request(share.token), cancellationId: 'cap-cancel' }, invoke('chat')).catch(error => error)
    await sent
    if (kind === 'stop') expect(await service.cancelConversation({ conversationId: scope.conversationId, cancellationId: 'cap-cancel' }, invoke('cancelConversation'))).toEqual({ cancelled: true })
    else sender.emit('did-start-navigation')
    expect(await pending).toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledOnce()
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
    expect(store.read(scope).revision).toBe(2)
  })
  it.each([0, 33, 1.5, -1, Number.NaN])('rejects invalid cap %s before storage admission or any model fetch', async cap => {
    await expect(service.prepareAgentGoalProgress({ ...shareReq, maxProviderDispatches: cap }, invoke('prepareAgentGoalProgress'))).rejects.toThrow('Invalid')
    expect(fetcher).not.toHaveBeenCalled(); expect(owner.readData(scope).document.revision).toBe(0)
  })
  it.each(['responses', 'gemini', 'codex', 'query-key'] as const)('rejects unsupported %s profile at prepare without creating a run or calling a model', async kind => {
    const profile = getConfig().llm_config.api_profiles[0]
    if (kind === 'responses') profile.api_mode = 'responses'
    else if (kind === 'gemini') profile.provider = 'gemini'
    else if (kind === 'codex') profile.auth_mode = 'codex_oauth'
    else profile.base_url += '?key=PRIVATE_SECRET'
    await expect(service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled(); expect(owner.readData(scope).document.revision).toBe(0)
  })
  it.each(['navigation', 'profile', 'goal', 'remote'] as const)('rechecks %s while capped preparation awaits owner initialization, without beginning a run', async kind => {
    let finish!: (owner: ProviderDispatchOwner) => void
    h.owner = new Promise<ProviderDispatchOwner>(resolve => { finish = resolve })
    const pending = service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    // The goal-store await resolves before the owner await; no polling/sleep.
    await Promise.resolve(); await Promise.resolve()
    if (kind === 'navigation') sender.emit('did-start-navigation')
    else if (kind === 'profile') getConfig().llm_config.api_profiles[0].api_key = 'REVOKED_KEY'
    else if (kind === 'remote') getConfig().use_remote_llm = true
    else store.mutateUser(scope, { action: 'control', goalId: shareReq.goalId, expectedGeneration: 2, expectedRevision: 2, operationId: randomUUID(), status: 'paused', reason: 'user pause during preparation' })
    finish(owner); await expect(pending).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled(); expect(owner.readData(scope).document.revision).toBe(0)
  })
  it.each(['responses', 'attachments', 'hidden', 'skill', 'profile'] as const)('rejects capped submit %s changes before a provider dispatch and never falls back', async kind => {
    const shared = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    const req = request(shared.token)
    if (kind === 'responses') Object.assign(req, { apiMode: 'responses' })
    else if (kind === 'attachments') Object.assign(req.messages[0], { attachments: [{ type: 'image', url: 'https://private.invalid/image.png' }] })
    else if (kind === 'hidden') Object.assign(req.messages[0], { hiddenContext: 'PRIVATE_HIDDEN' })
    else if (kind === 'skill') Object.assign(req, { skillRuntime: { skillId: 'other', bindings: [] } })
    else getConfig().llm_config.api_profiles[0].base_url = 'https://changed.test/chat'
    await expect(service.chat(req, invoke('chat'))).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled(); expect(owner.readData(scope).document.revision).toBe(0)
  })
  it('blocks capped preparation on a restarted unfinished idle run without minting a new admission', async () => {
    const abandoned = owner.createAdmission({ scope, binding: { goalId: shareReq.goalId, generation: 2, profileHash: 'a'.repeat(64) }, expectedRevision: 0, maxProviderDispatches: 1, maxWalltimeMs: 1000, endpoint, fetch: fetcher, signal: new AbortController().signal, assertLive: () => undefined })
    // Orderly shutdown only fences; a new owner cannot replace that owner domain.
    await owner.shutdown(); owner = new ProviderDispatchOwner(root, ownerCodec)
    h.owner = owner
    await expect(service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))).rejects.toThrow(/blocked|uncertain/)
    expect(fetcher).not.toHaveBeenCalled(); abandoned.dispose()
  })
  it.each(['auto', undefined] as const)('accepts an explicit matching Chat Completions request when persisted api_mode is %s', async mode => {
    getConfig().llm_config.api_profiles[0].api_mode = mode
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    fetcher.mockImplementation(async () => answer())
    expect(await service.chat({ ...request(share.token), apiMode: 'chat-completions' }, invoke('chat'))).toMatchObject({ content: 'Final bounded answer' })
    expect(fetcher).toHaveBeenCalledOnce(); expect(owner.readData(scope).document.runs[0].status).toBe('finished')
  })
  it.each(['chat', 'chatStream'] as const)('does not recover a continuation from structured provider text through %s conversion', async method => {
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValue(answer(JSON.stringify({ content: 'Structured final text', sessionUrl: 'PRIVATE_CONTINUATION' })))
    if (method === 'chat') expect(await service.chat(request(share.token), invoke('chat'))).not.toHaveProperty('sessionUrl')
    else { const events: unknown[] = []; await service.chatStream(request(share.token), { onData: event => events.push(event) }, invoke('chatStream')); expect(events.some(event => typeof event === 'object' && event && 'sessionUrl' in event)).toBe(false) }
    expect(fetcher).toHaveBeenCalledOnce(); expect(owner.readData(scope).document.runs[0].status).toBe('finished')
  })
  it.each(['length', 'error', 'cancelled'] as const)('does not finish accounting for a capped final provider response marked %s', async reason => {
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValue(answer('Incomplete answer'))
    const chat = OpenAIAPICli.prototype.chat
    vi.spyOn(OpenAIAPICli.prototype, 'chat').mockImplementation(async function (this: OpenAIAPICli, params) { return { ...await chat.call(this, params), finishReason: reason } })
    await expect(service.chat(request(share.token), invoke('chat'))).rejects.toThrow()
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it('does not write a goal after ownership shutdown revokes the admitted transport, even if the complete client result arrives later', async () => {
    vi.spyOn(OpenAIAPICli.prototype, 'supportsNativeTools', 'get').mockReturnValue(false)
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValue(answer('{"toolName":"drive_report","args":{"summary":"Must not run after ownership retirement","evidence":[]}}'))
    const chat = OpenAIAPICli.prototype.chat
    vi.spyOn(OpenAIAPICli.prototype, 'chat').mockImplementation(async function (this: OpenAIAPICli, params) { const result = await chat.call(this, params); await owner.shutdown(); return result })
    await expect(service.chat(request(share.token), invoke('chat'))).rejects.toThrow('capped admission ended')
    expect(store.read(scope).revision).toBe(2); expect(fetcher).toHaveBeenCalledOnce()
    owner = new ProviderDispatchOwner(root, ownerCodec); h.owner = owner
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it.each(['length', 'error', 'cancelled'] as const)('does not execute a syntactically complete legacy goal invocation from a %s response', async reason => {
    vi.spyOn(OpenAIAPICli.prototype, 'supportsNativeTools', 'get').mockReturnValue(false)
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    fetcher.mockResolvedValue(answer('{"toolName":"drive_report","args":{"summary":"Must never commit incomplete evidence","evidence":[]}}'))
    const chat = OpenAIAPICli.prototype.chat
    vi.spyOn(OpenAIAPICli.prototype, 'chat').mockImplementation(async function (this: OpenAIAPICli, params) { return { ...await chat.call(this, params), finishReason: reason } })
    await expect(service.chat(request(share.token), invoke('chat'))).rejects.toThrow('Incomplete goal record')
    expect(fetcher).toHaveBeenCalledOnce(); expect(store.read(scope).revision).toBe(2); expect(store.read(scope).goals[0].progress).toBeUndefined()
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it.each(['chat', 'chatStream'] as const)('validates final converted structured content before %s marks accounting finished', async method => {
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    const structuredOutput = { name: 'final_contract', schema: { type: 'object' as const, required: ['content'], properties: { content: { type: 'string' as const } }, additionalProperties: false } }
    fetcher.mockResolvedValue(answer('{"content":"plain text no longer satisfies object schema"}'))
    if (method === 'chat') await expect(service.chat({ ...request(share.token), structuredOutput }, invoke('chat'))).rejects.toThrow()
    else {
      const events: unknown[] = []
      await service.chatStream({ ...request(share.token), structuredOutput }, { onData: event => events.push(event) }, invoke('chatStream'))
      expect(events).toContainEqual(expect.objectContaining({ type: 'error' })); expect(events).not.toContainEqual(expect.objectContaining({ type: 'done', finishReason: 'stop' }))
    }
    expect(fetcher).toHaveBeenCalledOnce(); expect(store.read(scope).revision).toBe(2)
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1 })
  })
  it('does not renew the original prepared expiry when dispatch begins later', async () => {
    vi.useFakeTimers()
    const share = await service.prepareAgentGoalProgress(shareReq, invoke('prepareAgentGoalProgress'))
    await vi.advanceTimersByTimeAsync(100000)
    fetcher.mockImplementation(async () => new Promise<Response>(() => undefined))
    const pending = service.chat(request(share.token), invoke('chat')).catch(error => error)
    await vi.advanceTimersByTimeAsync(20000)
    expect(await pending).toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledOnce()
    expect(owner.readData(scope).document.runs[0]).toMatchObject({ status: 'unknown', chargedProviderDispatches: 1, deadlineAt: share.expiresAt })
  })
})
