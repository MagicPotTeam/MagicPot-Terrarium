import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/config', () => ({ onConfigCommitted: vi.fn(() => () => undefined), getConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { AgentThreadGoalProgress } from './agentThreadGoalProgress'
import { setAgentGoalScope } from './agentThreadGoalScope'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
import type { AgentGoalShareReq } from '@shared/api/agentThreadGoal'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let store: AgentThreadGoalStore, service: AgentThreadGoalProgress, config: typeof DEFAULT_CONFIG, sender: EventEmitter, req: AgentGoalShareReq
beforeEach(() => {
  vi.clearAllMocks(); config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'profile', model_name: 'Model', base_url: 'https://model.test/v1', api_key: 'PRIVATE_KEY' }]
  sender = Object.assign(new EventEmitter(), { id: 71, getURL: () => url, isDestroyed: () => false }); h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  store = new AgentThreadGoalStore(sideTestCodec()); service = new AgentThreadGoalProgress(async () => store, () => config)
  const goalId = randomUUID(); store.mutateUser(scope, { action: 'create', goalId, expectedRevision: 0, operationId: 'create', title: 'PRIVATE_TITLE', spec: normalizeAgentGoalSpec({ objective: 'PRIVATE_OBJECTIVE' }) })
  store.mutateUser(scope, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'activate', status: 'active', reason: 'user' })
  req = { ...scope, documentToken: setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope')).documentToken!, goalId, expectedRevision: 2, expectedGeneration: 2, profileId: 'profile' }
})
afterEach(() => { service.dispose(); sender.emit('did-start-navigation'); sender.emit('destroyed'); store.close(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const chat = (token: string): LLMChatReq => ({ ...scope, profileId: 'profile', goalProgressToken: token, messages: [{ role: 'user', content: 'Ordinary user question' }] })
const context = (toolCallId = 'call') => ({ route: scope.route, runId: 'run', toolCallId })
describe('single-request explicit goal progress data sharing, no automatic pursuit', () => {
  it('prepares no body or credential in receipt, claims once, and only status/report/proposal can persist', async () => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress'))
    expect(JSON.stringify(shared)).not.toMatch(/PRIVATE_/); expect(shared).toMatchObject({ mode: 'progress-only', budgetsEnforced: false, grantsPermission: false })
    const claimed = service.claim(chat(shared.token), invoke('chat'))
    expect(claimed.prompt).toContain('PRIVATE_OBJECTIVE'); expect(claimed.prompt).not.toContain(shared.token); expect(claimed.prompt).not.toContain('PRIVATE_KEY')
    expect(() => service.claim(chat(shared.token), invoke('chat'))).toThrow('not available')
    const provider = claimed.provider
    expect(provider.listTools().map(tool => tool.name)).toEqual(['drive_status', 'drive_report', 'drive_transition'])
    expect(JSON.parse((await provider.callTool('drive_status', {}, context())).content)).toMatchObject({ revision: 2, budgetsEnforced: false, goal: { id: req.goalId } })
    const args = { summary: 'Actual observed progress', evidence: ['receipt reference'] }
    await provider.callTool('drive_report', args, context('report'))
    await provider.callTool('drive_report', args, context('report')); expect(store.read(scope).revision).toBe(3)
    await expect(provider.callTool('drive_report', { ...args, summary: 'different' }, context('report'))).rejects.toThrow('replay')
    await provider.callTool('drive_transition', { ...args, status: 'completed' }, context('propose'))
    expect(store.read(scope)).toMatchObject({ revision: 4, goals: [{ status: 'active', proposal: { outcome: 'completed' } }] })
    claimed.dispose(); await expect(provider.callTool('drive_status', {}, context())).rejects.toThrow()
  })
  it.each(['scope', 'generation', 'profile', 'remote', 'navigation', 'expiry'] as const)('revokes the current share on %s instead of reopening execution or silently falling back', async mode => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress')), claimed = service.claim(chat(shared.token), invoke('chat'))
    if (mode === 'scope') setAgentGoalScope({ ...scope, conversationId: 'other', active: true, lifecycleRevision: 2 }, invoke('setAgentGoalScope'))
    else if (mode === 'generation') store.mutateUser(scope, { action: 'update', goalId: req.goalId, expectedGeneration: 2, expectedRevision: 2, operationId: 'edit', title: 'new', spec: normalizeAgentGoalSpec({ objective: 'new' }) })
    else if (mode === 'profile') config.llm_config.api_profiles[0].api_key = 'changed'
    else if (mode === 'remote') config.use_remote_llm = true
    else if (mode === 'navigation') sender.emit('did-start-navigation')
    else vi.spyOn(Date, 'now').mockReturnValue(shared.expiresAt)
    expect(() => claimed.assertLive()).toThrow()
    if (['scope', 'generation', 'navigation'].includes(mode)) expect(claimed.signal.aborted).toBe(true)
    await expect(claimed.provider.callTool('drive_report', { summary: 'late', evidence: [] }, context())).rejects.toThrow()
    claimed.dispose()
  })
  it.each(['goalId', 'actor', 'expectedRevision', 'operationId', 'confirm', 'allConversations'] as const)('rejects model-selected %s selectors/authority fields', async field => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress')), claimed = service.claim(chat(shared.token), invoke('chat'))
    await expect(claimed.provider.callTool('drive_report', { summary: 'x', evidence: [], [field]: 'forged' }, context())).rejects.toThrow('arguments')
    for (const status of ['active', 'paused', 'cancelled']) await expect(claimed.provider.callTool('drive_transition', { status, summary: 'x', evidence: ['x'] }, context())).rejects.toThrow('arguments')
    expect(store.read(scope).revision).toBe(2); claimed.dispose()
  })
  it('fails closed before claiming incompatible callers, attachments, hidden input, commands, profiles and continuations', async () => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress'))
    for (const extra of [{ sessionUrl: 'prior' }, { skillRuntime: {} }, { comparisonRouting: 'local' }, { imageRequest: {} }, { videoGenerationOptions: {} }, { isEdit: true }, { profileId: 'wrong' }, { profileScope: 'qapp' }, { messages: [{ role: 'user', content: '/tool drive_status {}' }] }, { messages: [{ role: 'user', content: 'x', hiddenContext: 'secret' }] }, { messages: [{ role: 'user', content: 'x', attachments: [{ type: 'file', url: 'secret' }] }] }]) expect(() => service.claim({ ...chat(shared.token), ...extra } as LLMChatReq, invoke('chat'))).toThrow()
    expect(() => service.claim(chat(shared.token), { ...invoke('chat'), senderId: 72 })).toThrow()
    expect(() => service.claim(chat(shared.token), undefined)).toThrow()
    const claimed = service.claim(chat(shared.token), invoke('chatStream')); claimed.dispose()
  })
  it('synchronously revokes an in-flight request on config commits and unregisters observers', async () => {
    let committed!: () => void
    const unsubscribe = vi.fn(), local = new AgentThreadGoalProgress(async () => store, () => config, listener => { committed = listener; return unsubscribe })
    const shared = await local.prepare(req, invoke('prepareAgentGoalProgress')), claimed = local.claim(chat(shared.token), invoke('chat'))
    committed(); expect(claimed.signal.aborted).toBe(true); expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(() => claimed.assertLive()).toThrow(); claimed.dispose(); local.dispose()
  })
  it('rejects a disable/reenable configuration round trip during awaited preparation and serializes competing shares', async () => {
    let finish!: () => void, committed!: () => void
    const load = vi.fn(() => new Promise<AgentThreadGoalStore>(resolve => { finish = () => resolve(store) })), unsub = vi.fn()
    const local = new AgentThreadGoalProgress(load, () => config, listener => { committed = listener; return unsub })
    const pending = local.prepare(req, invoke('prepareAgentGoalProgress'))
    await expect(local.prepare(req, invoke('prepareAgentGoalProgress'))).rejects.toThrow('busy')
    expect(load).toHaveBeenCalledOnce()
    config.use_remote_llm = true; committed(); config.use_remote_llm = false; finish()
    await expect(pending).rejects.toThrow('profile changed'); expect(unsub).toHaveBeenCalledOnce()
    local.dispose()
  })
  it('checks user consent/local/profile/goal revision again after an awaited store load', async () => {
    let finish!: () => void
    const delayed = new AgentThreadGoalProgress(() => new Promise(resolve => { finish = () => resolve(store) }), () => config)
    const pending = delayed.prepare(req, invoke('prepareAgentGoalProgress'))
    setAgentGoalScope({ ...scope, active: false, lifecycleRevision: 1 }, invoke('setAgentGoalScope')); finish()
    await expect(pending).rejects.toThrow(); delayed.dispose()
    config.use_remote_llm = true
    await expect(service.prepare(req, invoke('prepareAgentGoalProgress'))).rejects.toThrow()
  })
  it('revokes rather than rebasing after external progress in the same collection, but accepts verified self-writes', async () => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress')), claimed = service.claim(chat(shared.token), invoke('chat'))
    await claimed.provider.callTool('drive_report', { summary: 'self', evidence: [] }, context('self'))
    expect(claimed.signal.aborted).toBe(false)
    store.mutateUser(scope, { action: 'report', goalId: req.goalId, expectedRevision: 3, expectedGeneration: 2, operationId: 'external-report', summary: 'external newer report', evidence: [] })
    expect(claimed.signal.aborted).toBe(true)
    await expect(claimed.provider.callTool('drive_report', { summary: 'must not overwrite', evidence: [] }, context('late'))).rejects.toThrow()
    expect(store.read(scope)).toMatchObject({ revision: 4, goals: [{ progress: { summary: 'external newer report' } }] })
    claimed.dispose()
  })
  it('detects an unrelated reentrant post-commit write instead of advancing its cursor onto external state', async () => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress')), claimed = service.claim(chat(shared.token), invoke('chat'))
    let injected = false
    const off = store.onChanged(scope, () => {
      if (injected) return
      injected = true
      store.mutateUser(scope, { action: 'report', goalId: req.goalId, expectedGeneration: 2, expectedRevision: 3, operationId: 'reentrant-external', summary: 'External observer write', evidence: [] })
    })
    try {
      await expect(claimed.provider.callTool('drive_report', { summary: 'Self commit may already exist', evidence: [] }, context('self'))).rejects.toThrow('collection changed')
      expect(store.read(scope)).toMatchObject({ revision: 4, goals: [{ progress: { summary: 'External observer write' } }] })
      await expect(claimed.provider.callTool('drive_report', { summary: 'Must not rebase', evidence: [] }, context('again'))).rejects.toThrow()
      expect(store.read(scope).revision).toBe(4)
    } finally { off(); claimed.dispose() }
  })
  it('bounds distinct mutations and never lets a model create/confirm/delete a goal', async () => {
    const shared = await service.prepare(req, invoke('prepareAgentGoalProgress')), claimed = service.claim(chat(shared.token), invoke('chat'))
    for (let i = 0; i < 8; i++) await claimed.provider.callTool('drive_report', { summary: `p${i}`, evidence: [] }, context(`c${i}`))
    await expect(claimed.provider.callTool('drive_report', { summary: 'overflow', evidence: [] }, context('overflow'))).rejects.toThrow('budget')
    for (const name of ['drive_create', 'drive_update', 'mutateAgentGoal', 'drive_confirm']) await expect(claimed.provider.callTool(name, {}, context())).rejects.toThrow()
    expect(store.read(scope).revision).toBe(10); claimed.dispose()
  })
})
