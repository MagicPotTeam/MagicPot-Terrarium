import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ senders: new Map<number, unknown>() }))
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => h.senders.get(id) } }))
vi.mock('./agentThreadScope', () => ({ authorizeAgentThreadScope: (_scope: unknown, invocation: { senderId: number; methodName: string }, method: string) => { if (invocation.methodName !== `svcLLMProxy.${method}`) throw Error('unauthorized'); return invocation.senderId } }))
import { AgentTeamMessageQueue } from './agentTeamMessageQueue'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const source = { scope: 'scope', thread: 'pane', lead: 'lead', member: 'member' }
const intent = { source, kind: 'message' as const, hop: 1 as const, recipient: 'other', text: 'hello' }
const invoke = (id: number, method: string) => ({ senderId: id, methodName: `svcLLMProxy.${method}`, senderUrl: 'file:///fixture', frameUrl: 'file:///fixture', isMainFrame: true })
const scope = { route, conversationId: 'lead', storageScope: 'scope' }
const sender = (id: number) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, getURL: () => 'file:///fixture' })
const options = (id = 1) => ({ invocation: invoke(id, 'chatStream'), route, lease: { assertLive: vi.fn() } })
afterEach(() => { vi.useRealTimers(); h.senders.clear() })
describe('process-local team intent queue', () => {
  it('retains after request lease ends and claims exactly once; unauthorized identities get no entry', () => {
    h.senders.set(1, sender(1)); h.senders.set(2, sender(2)); const q = new AgentTeamMessageQueue(), o = options()
    const { requestId } = q.enqueue(intent, o); o.lease.assertLive.mockImplementation(() => { throw Error('disposed') })
    const list = invoke(1, 'listAgentTeamMessages'), claim = invoke(1, 'claimAgentTeamMessage')
    expect(q.list(scope, list)).toHaveLength(1)
    expect(q.list(scope, invoke(2, 'listAgentTeamMessages'))).toEqual([])
    expect(q.list({ ...scope, conversationId: 'other' }, list)).toEqual([])
    expect(q.list({ ...scope, storageScope: 'other' }, list)).toEqual([])
    expect(q.claim({ ...scope, id: requestId, route: { ...route, threadId: 'other' } }, claim)).toBeUndefined()
    expect(q.claim({ ...scope, id: requestId }, invoke(2, 'claimAgentTeamMessage'))).toBeUndefined()
    expect(q.claim({ ...scope, id: requestId }, claim)).toMatchObject({ id: requestId, ...intent })
    expect(q.claim({ ...scope, id: requestId }, claim)).toBeUndefined(); q.dispose()
  })
  it('clears entries on navigation/destroy but not subframe navigation', () => {
    const s = sender(1); h.senders.set(1, s); const q = new AgentTeamMessageQueue()
    q.enqueue(intent, options()); s.emit('did-start-navigation', { isMainFrame: false })
    expect(q.list(scope, invoke(1, 'listAgentTeamMessages'))).toHaveLength(1)
    s.emit('did-start-navigation', { isMainFrame: true }); expect(q.list(scope, invoke(1, 'listAgentTeamMessages'))).toEqual([])
    q.enqueue(intent, options()); s.emit('destroyed'); expect(q.list(scope, invoke(1, 'listAgentTeamMessages'))).toEqual([]); q.dispose()
  })
  it('rejects cancellation, failed lease and malformed input without enqueuing', () => {
    h.senders.set(1, sender(1)); const q = new AgentTeamMessageQueue(), o = options(), controller = new AbortController(); controller.abort()
    expect(() => q.enqueue(intent, { ...o, signal: controller.signal })).toThrow()
    o.lease.assertLive.mockImplementation(() => { throw Error('expired') }); expect(() => q.enqueue(intent, o)).toThrow('expired')
    expect(() => q.enqueue({ ...intent, recipient: source.member }, options())).toThrow()
    expect(() => q.enqueue({ ...intent, hop: 3 as 1 }, options())).toThrow()
    expect(() => q.enqueue({ ...intent, hop: 0 as 1 }, options())).toThrow()
    expect(q.list(scope, invoke(1, 'listAgentTeamMessages'))).toEqual([]); q.dispose()
  })
  it('bounds capacity and removes expired items by timer', () => {
    vi.useFakeTimers(); h.senders.set(1, sender(1)); const q = new AgentTeamMessageQueue()
    for (let i = 0; i < 128; i++) q.enqueue(intent, options())
    expect(() => q.enqueue(intent, options())).toThrow('capacity')
    vi.advanceTimersByTime(60_000)
    expect(q.list(scope, invoke(1, 'listAgentTeamMessages'))).toEqual([])
    expect(() => q.enqueue(intent, options())).not.toThrow(); q.dispose()
  })
})
