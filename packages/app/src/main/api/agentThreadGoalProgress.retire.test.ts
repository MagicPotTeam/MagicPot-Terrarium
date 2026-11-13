import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { DEFAULT_CONFIG } from '@shared/config/config'

vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/config', () => ({ onConfigCommitted: vi.fn(() => () => undefined), getConfig: vi.fn() }))
import { AgentThreadGoalStore } from './agentThreadGoalStore'
import { AgentThreadGoalProgress } from './agentThreadGoalProgress'
import { setAgentGoalScope } from './agentThreadGoalScope'
import { normalizeAgentGoalSpec } from './agentThreadGoalPolicy'
import { sideTestCodec, sideScope as scope } from './agentThreadSideTestUtils'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 371, isMainFrame: true, frameUrl: url, senderUrl: url })
let store: AgentThreadGoalStore, progress: AgentThreadGoalProgress, sender: EventEmitter
let request: Parameters<AgentThreadGoalProgress['prepare']>[0]
beforeEach(() => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'synthetic-profile', model_name: 'Synthetic', base_url: 'https://invalid.example/v1', api_key: 'synthetic' }]
  sender = Object.assign(new EventEmitter(), { id: 371, getURL: () => url, isDestroyed: () => false })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(371, scope.route, { trustedUrl: url, trustedWebContents: sender as never })
  store = new AgentThreadGoalStore(sideTestCodec(), ':memory:')
  progress = new AgentThreadGoalProgress(async () => store, () => config)
  const goalId = randomUUID()
  store.mutateUser(scope, { action: 'create', goalId, expectedRevision: 0, operationId: 'create', title: 'Synthetic', spec: normalizeAgentGoalSpec({ objective: 'Synthetic' }) })
  store.mutateUser(scope, { action: 'control', goalId, expectedRevision: 1, expectedGeneration: 1, operationId: 'activate', status: 'active', reason: 'User' })
  request = { ...scope, documentToken: setAgentGoalScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentGoalScope')).documentToken!, goalId, expectedRevision: 2, expectedGeneration: 2, profileId: 'synthetic-profile' }
})
afterEach(() => { progress.dispose(); sender.emit('did-start-navigation'); sender.emit('destroyed'); store.close(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const chat = (token: string): LLMChatReq => ({ ...scope, profileId: 'synthetic-profile', goalProgressToken: token, messages: [{ role: 'user', content: 'Synthetic question' }] })
const retire = (token: string) => progress.retireReady({ ...scope, documentToken: request.documentToken, token }, invoke('retireAgentGoalProgress'))

describe('retiring a synthetic unclaimed goal share', () => {
  it('synchronously retires ready token, preventing later claim, then reports unknown', async () => {
    const share = await progress.prepare(request, invoke('prepareAgentGoalProgress'))
    expect(retire(share.token)).toEqual({ status: 'retired' })
    expect(() => progress.claim(chat(share.token), invoke('chat'))).toThrow()
    expect(retire(share.token)).toEqual({ status: 'unknown' })
  })
  it('does not cancel a claimed request', async () => {
    const share = await progress.prepare(request, invoke('prepareAgentGoalProgress'))
    const claimed = progress.claim(chat(share.token), invoke('chat'))
    try { expect(retire(share.token)).toEqual({ status: 'already-claimed' }); expect(claimed.signal.aborted).toBe(false); claimed.assertLive() } finally { claimed.dispose() }
  })
  it('rejects unauthorized and stale documents without revoking the valid share', async () => {
    const share = await progress.prepare(request, invoke('prepareAgentGoalProgress'))
    const input = { ...scope, documentToken: request.documentToken, token: share.token }
    expect(() => progress.retireReady(input, { ...invoke('retireAgentGoalProgress'), senderId: 372 })).toThrow()
    expect(() => progress.retireReady({ ...input, documentToken: randomUUID() }, invoke('retireAgentGoalProgress'))).toThrow()
    expect(retire(randomUUID())).toEqual({ status: 'unknown' })
    expect(retire(share.token)).toEqual({ status: 'retired' })
  })
})
