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
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import type { AgentTeamMessageQueue } from './agentTeamMessageQueue'
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
