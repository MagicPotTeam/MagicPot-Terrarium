import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), store: undefined as unknown, dispatchOwner: undefined as unknown }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd(), file: process.cwd(), resources: '' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
vi.mock('../llmProxy/providerDispatchOwner', async original => ({ ...(await original<typeof import('../llmProxy/providerDispatchOwner')>()), getProviderDispatchOwner: async () => h.dispatchOwner }))
vi.mock('./agentThreadGoalProgress', async original => {
  const actual = await original<typeof import('./agentThreadGoalProgress')>()
  return { ...actual, agentThreadGoalProgress: new actual.AgentThreadGoalProgress(async () => h.store as import('./agentThreadGoalStore').AgentThreadGoalStore) }
})
vi.mock('./agentThreadGoals', async original => {
  const actual = await original<typeof import('./agentThreadGoals')>()
  return { ...actual, agentThreadGoals: new actual.AgentThreadGoals(async () => h.store as import('./agentThreadGoalStore').AgentThreadGoalStore) }
})
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const url = 'file:///D:/app/index.html#/canvas?id=project', invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let sender: EventEmitter, store: AgentThreadGoalStore
beforeEach(() => {
  vi.clearAllMocks(); store = new AgentThreadGoalStore(sideTestCodec()); h.store = store
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url }); h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  const config = structuredClone(DEFAULT_CONFIG); config.llm_config.api_profiles = [{ id: 'profile', model_name: 'model', base_url: 'https://model.example/v1', api_key: 'unused' }]
  vi.mocked(getConfig).mockReturnValue(config); h.listTools.mockReturnValue([])
  h.callTool.mockImplementation((route, name, args, options) => options.toolProvider.callTool(name, args, { route, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
})
afterEach(() => { mainHostExtensionApiV1.llmProxy.splice(0, mainHostExtensionApiV1.llmProxy.length, ...mainHostExtensionApiV1.llmProxy.filter(item => item.id !== 'goal-progress-exact-profile-test')); sender.emit('did-start-navigation'); sender.emit('destroyed'); store.close(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
describe('goal data IPC through real service, separate from normal parent model calls (model stub)', () => {
  it('rejects the removed dispatch-counter service without reading its owner or calling a model', async () => {
    const service = new LLMProxySvcImpl(), documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!
    const readCurrentData = vi.fn(() => ({ document: { version: 1, ownerHash: 'PRIVATE_OWNER_HASH', revision: 0, runs: [], receipts: [] }, orphaned: false, mutationBlocked: false, grantsPermission: false }))
    h.dispatchOwner = { readCurrentData }
    await expect(service.listAgentGoalDispatches({ ...scope, documentToken }, invoke('listAgentGoalDispatches'))).rejects.toThrow('removed')
    expect(readCurrentData).not.toHaveBeenCalled()
    expect(cliFromProfile).not.toHaveBeenCalled(); expect(h.callTool).not.toHaveBeenCalled()
    await expect(service.listAgentGoalDispatches({ ...scope, documentToken }, invoke('chat'))).rejects.toThrow()
  })
  it.each([['chat', false], ['chat', true], ['chatStream', false], ['chatStream', true]] as const)('shares exactly one goal and persists status/report/proposal through real %s native=%s without terminal authorization or delegation', async (method, native) => {
    const service = new LLMProxySvcImpl(), documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!
    const goalId = randomUUID()
    await service.mutateAgentGoal({ ...scope, documentToken, action: 'create', goalId, title: 'SHARED_TITLE', spec: normalizeAgentGoalSpec({ objective: 'USER_SHARED_OBJECTIVE' }), expectedRevision: 0, operationId: 'create' }, invoke('mutateAgentGoal'))
    await service.mutateAgentGoal({ ...scope, documentToken, action: 'control', goalId, expectedGeneration: 1, expectedRevision: 1, operationId: 'activate', status: 'active', reason: 'user' }, invoke('mutateAgentGoal'))
    const shared = await service.prepareAgentGoalProgress({ ...scope, documentToken, goalId, expectedGeneration: 2, expectedRevision: 2, profileId: 'profile' }, invoke('prepareAgentGoalProgress'))
    expect(cliFromProfile).not.toHaveBeenCalled()
    const calls = [{ name: 'drive_status', args: {} }, { name: 'drive_report', args: { summary: 'Observed progress', evidence: ['reference'] } }, { name: 'drive_transition', args: { status: 'completed', summary: 'Ready for user review', evidence: ['reference'] } }]
    const normalize = vi.fn(() => 'forbidden-profile'), handle = vi.fn(), createCli = vi.fn()
    const extension = { id: 'goal-progress-exact-profile-test', normalizeRequestedProfileId: normalize, handleChatRequest: handle, createCli }
    mainHostExtensionApiV1.llmProxy.push(extension)
    const chat = vi.fn(async input => {
      expect(normalize).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled(); expect(createCli).not.toHaveBeenCalled()
      expect(input.disableProviderTools).toBe(true)
      expect(input.systemPrompt).toContain('USER_SHARED_OBJECTIVE'); expect(JSON.stringify(input)).not.toContain(shared.token)
      expect(input.systemPrompt).toContain('budgetsEnforced')
      if (native) expect(input.tools.map((tool: { name: string }) => tool.name)).toEqual(['drive_status', 'drive_report', 'drive_transition'])
      else expect(input.systemPrompt).not.toMatch(/files\.read|files\.write|shell\.execute|image\.create|mcp_call|search_memory/)
      expect(input.tools?.some((tool: { name: string }) => ['explore', 'critic', 'fork', 'jobs.list', 'drive_create', 'mutateAgentGoal'].includes(tool.name))).not.toBe(true)
      const call = calls[chat.mock.calls.length - 1]
      if (!call) return 'Proposed only; user confirmation is still required.'
      if (!native) return JSON.stringify({ toolName: call.name, args: call.args })
      const index = input.tools.findIndex((tool: { name: string }) => tool.name === call.name)
      return { content: '', toolCalls: [{ id: `goal-${chat.mock.calls.length}`, name: call.name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(call.args) }] }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const request = { ...scope, profileId: 'profile', goalProgressToken: shared.token, messages: [{ role: 'user' as const, content: 'Review this goal in this ordinary turn' }] }, onData = vi.fn()
    if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Proposed only; user confirmation is still required.' })
    else { await service.chatStream(request, { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Proposed only; user confirmation is still required.' })) }
    expect(chat).toHaveBeenCalledTimes(4); expect(h.callTool).not.toHaveBeenCalled()
    expect(store.read(scope)).toMatchObject({ revision: 4, goals: [{ status: 'active', proposal: { outcome: 'completed' }, progress: { summary: 'Observed progress' } }] })
    await expect(service.chat(request, invoke('chat'))).rejects.toThrow('not available')
    expect(chat).toHaveBeenCalledTimes(4)
    mainHostExtensionApiV1.llmProxy.splice(mainHostExtensionApiV1.llmProxy.indexOf(extension), 1)
    chat.mockReset().mockResolvedValue('Later ordinary turn without goal binding')
    await service.chat({ ...request, goalProgressToken: undefined }, invoke('chat'))
    expect(JSON.stringify(chat.mock.calls[0][0])).not.toMatch(/USER_SHARED_OBJECTIVE|drive_report|drive_status|drive_transition/)
  })
  it.each([false, true])('never executes an ordinary host tool from a recordkeeping turn (native=%s)', async native => {
    const service = new LLMProxySvcImpl(), documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!, goalId = randomUUID()
    store.mutateUser(scope, { action: 'create', goalId, title: 'goal', spec: normalizeAgentGoalSpec({ objective: 'record only' }), expectedRevision: 0, operationId: 'create' })
    store.mutateUser(scope, { action: 'control', goalId, expectedGeneration: 1, expectedRevision: 1, operationId: 'activate', status: 'active', reason: 'user' })
    const share = await service.prepareAgentGoalProgress({ ...scope, documentToken, goalId, expectedGeneration: 2, expectedRevision: 2, profileId: 'profile' }, invoke('prepareAgentGoalProgress'))
    const chat = vi.fn(async () => native ? { content: '', toolCalls: [{ id: 'forged-host', name: 'files.write', wireName: 'forged', arguments: '{"path":"forbidden.txt","content":"bad"}' }] } : JSON.stringify({ toolName: 'files.write', args: { path: 'forbidden.txt', content: 'bad' } }))
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const result = service.chat({ ...scope, profileId: 'profile', goalProgressToken: share.token, messages: [{ role: 'user', content: 'Only record progress' }] }, invoke('chat'))
    if (native) await expect(result).rejects.toThrow()
    else expect(await result).toMatchObject({ content: JSON.stringify({ toolName: 'files.write', args: { path: 'forbidden.txt', content: 'bad' } }) }) // Unbound legacy JSON remains plain model text, never an invocation.
    expect(chat).toHaveBeenCalledOnce(); expect(h.callTool).not.toHaveBeenCalled(); expect(store.read(scope).revision).toBe(2)
  })
  it.each(['answer', 'https://result.test/answer.png'])('does not return a provider continuation from a bound %s result', async content => {
    const service = new LLMProxySvcImpl(), documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!, goalId = randomUUID()
    store.mutateUser(scope, { action: 'create', goalId, title: 'goal', spec: normalizeAgentGoalSpec({ objective: 'shared' }), expectedRevision: 0, operationId: 'create' })
    store.mutateUser(scope, { action: 'control', goalId, expectedGeneration: 1, expectedRevision: 1, operationId: 'activate', status: 'active', reason: 'user' })
    const share = await service.prepareAgentGoalProgress({ ...scope, documentToken, goalId, expectedGeneration: 2, expectedRevision: 2, profileId: 'profile' }, invoke('prepareAgentGoalProgress'))
    const chat = vi.fn(async () => ({ content, sessionUrl: 'PRIVATE_PROVIDER_CONTINUATION' }))
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: true } as never)
    const value = await service.chat({ ...scope, profileId: 'profile', goalProgressToken: share.token, messages: [{ role: 'user', content: 'Review' }] }, invoke('chat'))
    expect(value).not.toHaveProperty('sessionUrl'); expect(chat).toHaveBeenCalledOnce()
  })
  it.each(['chat', 'chatStream'] as const)('aborts real API-client retries before another provider fetch on goal revocation via %s', async method => {
    const service = new LLMProxySvcImpl(), documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!, goalId = randomUUID()
    store.mutateUser(scope, { action: 'create', goalId, title: 'goal', spec: normalizeAgentGoalSpec({ objective: 'ACTUAL_CLIENT_SHARED' }), expectedRevision: 0, operationId: 'create' })
    store.mutateUser(scope, { action: 'control', goalId, expectedGeneration: 1, expectedRevision: 1, operationId: 'activate', status: 'active', reason: 'user' })
    const share = await service.prepareAgentGoalProgress({ ...scope, documentToken, goalId, expectedGeneration: 2, expectedRevision: 2, profileId: 'profile' }, invoke('prepareAgentGoalProgress'))
    const actual = await vi.importActual<typeof import('@shared/llm')>('@shared/llm')
    vi.mocked(cliFromProfile).mockImplementation((...args) => actual.cliFromProfile(...args))
    const fetch = vi.fn(async (_url, init) => {
      expect(String(init?.body)).toContain('ACTUAL_CLIENT_SHARED'); expect(String(init?.body)).not.toContain(share.token)
      store.mutateUser(scope, { action: 'control', goalId, expectedGeneration: 2, expectedRevision: 2, operationId: 'pause', status: 'paused', reason: 'user revoked' })
      return new Response('{"error":{"code":"server_overloaded","message":"Retryable overload"}}', { status: 503, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const request = { ...scope, profileId: 'profile', goalProgressToken: share.token, messages: [{ role: 'user' as const, content: 'Review' }] }
    try {
      if (method === 'chat') await expect(service.chat(request, invoke(method))).rejects.toThrow()
      else { const onData = vi.fn(); await service.chatStream(request, { onData }, invoke(method)); expect(onData).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done', finishReason: 'stop' })) }
      expect(fetch).toHaveBeenCalledOnce(); expect(store.read(scope).goals[0].status).toBe('paused')
    } finally { vi.unstubAllGlobals() }
  })
  it('rejects a stale bound goal before another model step or tool dispatch', async () => {
    const service = new LLMProxySvcImpl(), token = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!, goalId = randomUUID()
    store.mutateUser(scope, { action: 'create', goalId, title: 'goal', spec: normalizeAgentGoalSpec({ objective: 'shared' }), expectedRevision: 0, operationId: 'c' })
    store.mutateUser(scope, { action: 'control', goalId, expectedGeneration: 1, expectedRevision: 1, operationId: 'a', status: 'active', reason: 'user' })
    const share = await service.prepareAgentGoalProgress({ ...scope, documentToken: token, goalId, expectedGeneration: 2, expectedRevision: 2, profileId: 'profile' }, invoke('prepareAgentGoalProgress'))
    const chat = vi.fn(async () => {
      store.mutateUser(scope, { action: 'control', goalId, expectedGeneration: 2, expectedRevision: 2, operationId: 'pause', status: 'paused', reason: 'user' })
      return JSON.stringify({ toolName: 'drive_report', args: { summary: 'stale', evidence: [] } })
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: false } as never)
    await expect(service.chat({ ...scope, profileId: 'profile', goalProgressToken: share.token, messages: [{ role: 'user', content: 'Review' }] }, invoke('chat'))).rejects.toThrow(/retired|goal changed/)
    expect(chat).toHaveBeenCalledOnce(); expect(h.callTool).not.toHaveBeenCalled(); expect(store.read(scope).goals[0].progress).toBeUndefined()
  })
  it.each([['chat', false], ['chat', true], ['chatStream', false], ['chatStream', true]] as const)('stores user-only goal data without inheriting body or model management via %s native=%s', async (method, native) => {
    const service = new LLMProxySvcImpl(), documentToken = (await service.setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope'))).documentToken!
    const req = { ...scope, documentToken, action: 'create' as const, goalId: randomUUID(), title: 'PRIVATE_GOAL_TITLE', spec: normalizeAgentGoalSpec({ objective: 'PRIVATE_GOAL_OBJECTIVE' }), expectedRevision: 0, operationId: randomUUID() }
    expect(await service.mutateAgentGoal(req, invoke('mutateAgentGoal'))).toMatchObject({ status: 'applied', goals: [{ status: 'draft' }] })
    expect(await service.listAgentGoals({ ...scope, documentToken }, invoke('listAgentGoals'))).toMatchObject({ goals: [{ title: 'PRIVATE_GOAL_TITLE' }] })
    expect(cliFromProfile).not.toHaveBeenCalled(); expect(h.callTool).not.toHaveBeenCalled()
    const chat = vi.fn(async input => {
      expect(JSON.stringify(input)).not.toMatch(/PRIVATE_GOAL_|mutateAgentGoal|listAgentGoals|drive_create|drive_report|drive_transition|setAgentGoalScope/)
      return 'Ordinary parent answer without inheriting user-only goal data.'
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const request = { ...scope, profileId: 'profile', messages: [{ role: 'user' as const, content: 'Continue ordinary work' }] }, onData = vi.fn()
    if (method === 'chat') expect(await service.chat(request, invoke(method))).toMatchObject({ content: 'Ordinary parent answer without inheriting user-only goal data.' })
    else { await service.chatStream(request, { onData }, invoke(method)); expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: 'Ordinary parent answer without inheriting user-only goal data.' })) }
    expect(chat).toHaveBeenCalledOnce(); expect(h.callTool).not.toHaveBeenCalled()
    await expect(service.chat({ ...request, messages: [{ role: 'user', content: '/tool drive_transition {"status":"completed"}' }] }, invoke('chat'))).rejects.toThrow()
    expect(store.read(scope)).toMatchObject({ revision: 1, goals: [{ status: 'draft' }] })
  })
})
