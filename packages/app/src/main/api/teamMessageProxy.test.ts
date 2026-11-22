import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
const h = vi.hoisted(() => ({ data: '', senders: new Map<number, unknown>() }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: (id: number) => h.senders.get(id) } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
vi.mock('./agentThreadScope', () => ({ authorizeAgentThreadScope: (_scope: unknown, invocation: { senderId: number; methodName: string } | undefined, method: string) => { if (invocation?.methodName !== `svcLLMProxy.${method}`) throw Error('unauthorized'); return invocation.senderId } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: vi.fn(() => []), callTool: vi.fn() }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
// The real End store, one per test profile (the production module keeps one for the process).
vi.mock(import('./teamEndStore'), async original => {
  const actual = await original(), { MagicAgentEventStore } = await import('../magicAgentPlatform2/persistence/eventStore')
  const stores = new Map<string, InstanceType<typeof actual.TeamEndStore>>()
  const getTeamEndStore = () => {
    if (!stores.has(h.data)) stores.set(h.data, new actual.TeamEndStore(new MagicAgentEventStore(':memory:')))
    return stores.get(h.data)!
  }
  return { ...actual, getTeamEndStore, assertTeamRequestActive: (req: { teamMember?: unknown }) => { if (Object.hasOwn(req, 'teamMember')) getTeamEndStore().assertActive(req.teamMember) } }
})
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { getConfig } from '../config/config'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { AgentTeamMessageQueue, teamMessageStoreOpener } from './agentTeamMessageQueue'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { TeamEndStore } from './teamEndStore'
import { TEAM_MESSAGE_STATE_KIND, TeamMessageStore } from './teamMessageStore'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const team = { scope: 'scope', thread: 'pane', lead: 'lead' }
const source = { ...team, member: 'writer' }
const invoke = (id: number, method: string) => ({ senderId: id, methodName: `svcLLMProxy.${method}`, senderUrl: 'file:///fixture', frameUrl: 'file:///fixture', isMainFrame: true })
const sender = (id: number) => { const s = Object.assign(new EventEmitter(), { id, isDestroyed: () => false, getURL: () => 'file:///fixture' }); h.senders.set(id, s); return s }
const services: LLMProxySvcImpl[] = []
function service(): { svc: LLMProxySvcImpl; queue: AgentTeamMessageQueue } {
  const svc = new LLMProxySvcImpl()
  services.push(svc)
  // The service's own queue: the member's send_message tool reaches exactly this enqueue.
  return { svc, queue: (svc as unknown as { teamMessageQueue: AgentTeamMessageQueue }).teamMessageQueue }
}
const enqueue = (queue: AgentTeamMessageQueue, over: Record<string, unknown> = {}) =>
  queue.enqueue({ source, kind: 'message', hop: 1, recipient: 'designer', text: 'synthetic note', ...over } as never, { invocation: invoke(1, 'chatStream'), route, lease: { assertLive: () => {} } }).requestId
const file = () => join(h.data, 'team-messages', 'messages.sqlite')
function stored(id: string): Record<string, unknown> | undefined {
  for (const { queue } of services.splice(0).map(svc => ({ queue: (svc as unknown as { teamMessageQueue: AgentTeamMessageQueue }).teamMessageQueue }))) queue.dispose()
  const db = new MagicAgentEventStore(file())
  try { return db.getResource<Record<string, unknown>>(TEAM_MESSAGE_STATE_KIND, id)?.state } finally { db.close() }
}
beforeEach(() => { h.data = mkdtempSync(join(realpathSync(tmpdir()), 'team-proxy-')); sender(1) })
afterEach(() => {
  vi.restoreAllMocks(); h.senders.clear()
  for (const svc of services.splice(0)) (svc as unknown as { teamMessageQueue: AgentTeamMessageQueue }).teamMessageQueue.dispose()
  rmSync(h.data, { recursive: true, force: true })
})

describe('team End and the durable message queue', () => {
  it('ends the queued messages of the team after End is recorded', async () => {
    const { svc, queue } = service()
    const id = enqueue(queue)
    await expect(svc.endTeam(team)).resolves.toEqual({ ended: true })
    expect((await svc.listAgentTeamMessages({ route, conversationId: 'lead', storageScope: 'scope' }, invoke(1, 'listAgentTeamMessages'))).intents).toEqual([])
    expect(stored(id)).toMatchObject({ status: 'ended' })
  })

  it('ends no message when End itself fails, and keeps End when the queue fails', async () => {
    const { svc, queue } = service()
    const id = enqueue(queue)
    vi.spyOn(TeamEndStore.prototype, 'end').mockImplementationOnce(() => { throw Error('write failed') })
    await expect(svc.endTeam(team)).rejects.toThrow('write failed')
    expect((await svc.listAgentTeamMessages({ route, conversationId: 'lead', storageScope: 'scope' }, invoke(1, 'listAgentTeamMessages'))).intents.map(intent => intent.id)).toEqual([id])
    vi.spyOn(TeamMessageStore.prototype, 'endTeam').mockImplementation(() => { throw Error('disk full') })
    await expect(svc.endTeam(team)).resolves.toEqual({ ended: true })
    expect(stored(id)).toMatchObject({ status: 'queued' })
  })

  it('creates no message file for End on a profile that never queued a message', async () => {
    const { svc } = service()
    await expect(svc.endTeam(team)).resolves.toEqual({ ended: true })
    expect(existsSync(join(h.data, 'team-messages'))).toBe(false)
  })
})

describe('MAIN records the start of a member-message delivery request', () => {
  const recipient = { ...team, member: 'designer' }
  let provider: ReturnType<typeof vi.fn>
  beforeEach(() => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.llm_config.api_profiles = [{ id: 'profile', model_name: 'model', base_url: 'https://example.invalid/v1', api_key: 'unused' }]
    vi.mocked(getConfig).mockReturnValue(config)
    provider = vi.fn(async (_input: unknown) => 'delivered')
    vi.mocked(cliFromProfile).mockReset().mockReturnValue({ chat: provider, supportsNativeTools: false } as never)
  })
  const request = (id: string, lease: string, over: Partial<LLMChatReq> = {}): LLMChatReq => ({
    profileId: 'profile', messages: [{ role: 'user', content: 'synthetic delivery' }], route, conversationId: 'designer',
    teamMember: recipient, teamMessageHop: 1, teamMessageDelivery: { id, lease }, ...over
  })
  const scope = { route, conversationId: 'lead', storageScope: 'scope' }
  async function claimed(queue: AgentTeamMessageQueue, svc: LLMProxySvcImpl, over: Record<string, unknown> = {}, by = 1) {
    const id = enqueue(queue, over)
    const { intent } = await svc.claimAgentTeamMessage({ ...scope, id }, invoke(by, 'claimAgentTeamMessage'))
    return { id, lease: intent!.lease! }
  }
  /** by: the sending webContents (negative: the same webContents in another method's invocation), or null for none. */
  const send = (svc: LLMProxySvcImpl, method: 'chat' | 'chatStream', req: LLMChatReq, by: number | null = 1) =>
    method === 'chat' ? svc.chat(req, by === null ? undefined : by < 0 ? invoke(-by, 'claimAgentTeamMessage') : invoke(by, 'chat'))
      : svc.chatStream(req, { onData: vi.fn() } as never, by === null ? undefined : by < 0 ? invoke(-by, 'claimAgentTeamMessage') : invoke(by, 'chatStream'))
  const rejected = 'Team message is no longer available.'

  it.each(['chat', 'chatStream'] as const)('%s: admits a delivery once, records its start first, and never forwards the lease', async method => {
    const { svc, queue } = service()
    const { id, lease } = await claimed(queue, svc)
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log'), vi.spyOn(console, 'info')]
    const onward = vi.spyOn(svc as unknown as { chatViaAPI: (req: LLMChatReq, ...rest: unknown[]) => Promise<unknown> }, 'chatViaAPI')
    await send(svc, method, request(id, lease))
    expect(provider).toHaveBeenCalledOnce()
    // The request that goes on carries no lease.
    expect(onward).toHaveBeenCalledOnce()
    expect(Object.hasOwn(onward.mock.calls[0][0], 'teamMessageDelivery')).toBe(false)
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(lease)
    expect(JSON.stringify(provider.mock.calls[0][0])).not.toContain(lease)
    expect(JSON.stringify(provider.mock.calls[0][0])).not.toContain('teamMessageDelivery')
    // A repeat by the same lease holder for the same recipient: admitted, nothing written again.
    await send(svc, method, request(id, lease))
    expect(provider).toHaveBeenCalledTimes(2)
    const state = stored(id)
    expect(state).toMatchObject({ status: 'closed', starts: [{ recipient: 'designer' }] })
    expect((state!.starts as unknown[]).length).toBe(1)
  })

  it('chatStream: records the start, then sends no lease to a remote transport', async () => {
    const config = structuredClone(DEFAULT_CONFIG)
    config.use_remote_llm = true
    config.remote_llm_server_config = { ...config.remote_llm_server_config, server_origin: 'http://127.0.0.1:9', access_token: 'synthetic-token' }
    vi.mocked(getConfig).mockReturnValue(config)
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { bodies.push(init.body); throw Error('no network in tests') }))
    try {
      const { svc, queue } = service()
      const { id, lease } = await claimed(queue, svc)
      await send(svc, 'chatStream', request(id, lease)).catch(() => undefined)
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) { expect(body).not.toContain(lease); expect(body).not.toContain('teamMessageDelivery') }
      expect(stored(id)).toMatchObject({ status: 'closed', starts: [{ recipient: 'designer' }] })
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['chat', 'chatStream'] as const)('%s: records each channel recipient once, never the source member', async method => {
    const { svc, queue } = service()
    const { id, lease } = await claimed(queue, svc, { kind: 'channel', recipient: undefined })
    await send(svc, method, request(id, lease))
    await send(svc, method, request(id, lease, { conversationId: 'critic', teamMember: { ...team, member: 'critic' } }))
    await send(svc, method, request(id, lease))
    await expect(send(svc, method, request(id, lease, { conversationId: 'writer', teamMember: source }))).rejects.toThrow(rejected)
    expect(provider).toHaveBeenCalledTimes(3)
    expect(stored(id)).toMatchObject({ status: 'claimed', starts: [{ recipient: 'designer' }, { recipient: 'critic' }] })
  })

  it.each(['chat', 'chatStream'] as const)('%s: refuses every other presentation before any provider set-up', async method => {
    const { svc, queue } = service()
    sender(2)
    const { id, lease } = await claimed(queue, svc)
    const queued = enqueue(queue)
    const refused: Array<[string, LLMChatReq, number | null]> = [
      ['a wrong token', request(id, 'not-the-lease'), 1],
      ['another sender', request(id, lease), 2],
      ['no invocation', request(id, lease), null],
      ['an invocation of another method', request(id, lease), -1],
      ['another team', request(id, lease, { teamMember: { ...recipient, lead: 'other-lead' } }), 1],
      ['another thread route', request(id, lease, { route: { ...route, threadId: 'other' } }), 1],
      ['a wrong recipient', request(id, lease, { conversationId: 'critic', teamMember: { ...team, member: 'critic' } }), 1],
      ['a wrong hop', request(id, lease, { teamMessageHop: 2 }), 1],
      ['no hop', request(id, lease, { teamMessageHop: undefined }), 1],
      ['no team member', (({ teamMember: _member, ...rest }) => rest)(request(id, lease)), 1],
      ['a record still queued', request(queued, lease), 1],
      ['an unknown id', request('00000000-0000-4000-8000-000000000000', lease), 1],
      ['an extra field', { ...request(id, lease), teamMessageDelivery: { id, lease, extra: 1 } as never }, 1],
      ['an undefined field', { ...request(id, lease), teamMessageDelivery: undefined }, 1]
    ]
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log'), vi.spyOn(console, 'info')]
    for (const [name, req, by] of refused) await expect(send(svc, method, req, by), name).rejects.toThrow(rejected)
    expect(cliFromProfile).not.toHaveBeenCalled()
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(lease)
    expect(stored(id)).toMatchObject({ status: 'claimed', starts: [] })
    expect(stored(queued)).toMatchObject({ status: 'queued' })
  })

  it.each(['chat', 'chatStream'] as const)('%s: refuses a lease whose document ended, a claim of an earlier boot and an ended team', async method => {
    const window = sender(1)
    let { svc, queue } = service()
    const closed = await claimed(queue, svc)
    window.emit('destroyed')
    sender(1)
    await expect(send(svc, method, request(closed.id, closed.lease))).rejects.toThrow(rejected)
    // The document ended but its claim could not be closed (write failure): the lease is gone all the same.
    const stuck = await claimed(queue, svc)
    vi.spyOn(TeamMessageStore.prototype, 'closeClaim').mockImplementationOnce(() => { throw Error('disk full') })
    h.senders.get(1) && (h.senders.get(1) as EventEmitter).emit('render-process-gone', { reason: 'crashed' })
    sender(1)
    await expect(send(svc, method, request(stuck.id, stuck.lease))).rejects.toThrow(rejected)
    // An earlier boot: its claim is never admitted by this process, and recovery makes it unknown.
    const earlier = new AgentTeamMessageQueue({ store: teamMessageStoreOpener(file(), 'earlier-boot') })
    ;(svc as unknown as { teamMessageQueue: AgentTeamMessageQueue }).teamMessageQueue.dispose()
    ;(svc as unknown as { teamMessageQueue: AgentTeamMessageQueue }).teamMessageQueue = earlier
    const old = await claimed(earlier, svc)
    earlier.dispose()
    ;({ svc, queue } = service())
    await expect(send(svc, method, request(old.id, old.lease))).rejects.toThrow(rejected)
    const ended = await claimed(queue, svc)
    await svc.endTeam(team)
    await expect(send(svc, method, request(ended.id, ended.lease))).rejects.toThrow('Team has ended.')
    expect(cliFromProfile).not.toHaveBeenCalled()
    expect(stored(closed.id)).toMatchObject({ status: 'unknown', starts: [] })
    expect(stored(stuck.id)).toMatchObject({ status: 'unknown', starts: [] })
    expect(stored(old.id)).toMatchObject({ status: 'unknown', starts: [] })
    expect(stored(ended.id)).toMatchObject({ status: 'claimed', starts: [] })
  })

  it.each(['chat', 'chatStream'] as const)('%s: refuses the request when the start cannot be written', async method => {
    const { svc, queue } = service()
    const { id, lease } = await claimed(queue, svc)
    vi.spyOn(TeamMessageStore.prototype, 'start').mockImplementation(() => { throw Error('disk full') })
    await expect(send(svc, method, request(id, lease))).rejects.toThrow(rejected)
    expect(cliFromProfile).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(stored(id)).toMatchObject({ status: 'claimed', starts: [] })
  })

  it.each(['chat', 'chatStream'] as const)('%s: a request without the field never touches the store', async method => {
    const { svc } = service()
    const start = vi.spyOn(TeamMessageStore.prototype, 'start')
    await send(svc, method, { profileId: 'profile', messages: [{ role: 'user', content: 'plain member turn' }], route, conversationId: 'designer', teamMember: recipient })
    await send(svc, method, { profileId: 'profile', messages: [{ role: 'user', content: 'ordinary chat' }] }, null)
    expect(provider).toHaveBeenCalledTimes(2)
    expect(start).not.toHaveBeenCalled()
    expect(existsSync(join(h.data, 'team-messages'))).toBe(false)
  })
})
