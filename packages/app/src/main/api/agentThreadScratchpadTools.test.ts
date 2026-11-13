import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadScratchpadTools } from './agentThreadScratchpadTools'
import { AgentThreadInteractions } from './agentThreadInteractions'
import { getAgentThreadNotesStore, closeAgentThreadNotesStore } from './agentThreadNotesStore'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: '/scratchpad-unit-fixture' } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }, url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = { methodName: 'svcLLMProxy.chat', senderId: 98, isMainFrame: true, senderUrl: url, frameUrl: url }
const context = { route, runId: 'original-run', toolCallId: 'original-call' }, admission = vi.fn()
let sender: EventEmitter, lease: NonNullable<ReturnType<AgentThreadInteractions['create']>>, tools: AssistantRunToolProvider
beforeEach(async () => {
  vi.clearAllMocks(); admission.mockReset(); await closeAgentThreadNotesStore()
  sender = Object.assign(new EventEmitter(), { id: 98, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(98, route, { trustedUrl: url, trustedWebContents: sender as never })
  lease = new AgentThreadInteractions().create({ ...scope, messages: [] }, invocation)!
  tools = createAgentThreadScratchpadTools({ scope, invocation, lease, assertInvocation: admission })
})
afterEach(async () => { lease.dispose(); await closeAgentThreadNotesStore(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
const call = (args: Record<string, unknown>, ctx: Parameters<AssistantRunToolProvider['callTool']>[2] = context) => tools.callTool('scratchpad', args, ctx)
const seed = async () => { const store = await getAgentThreadNotesStore(); store.mutate({ ...scope, action: 'set', key: 'retained', value: 'old value', expectedRevision: 0, operationId: 'seed' }); return store }
async function approve(approved = true) {
  const policy = getAssistantTerminalPolicyRuntime()
  await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
  const item = policy.listPendingTerminalApprovals()[0]
  policy.resolvePendingTerminalApproval({ approvalId: item.approvalId, expectedRevision: item.revision, approved })
  return item
}
describe('invocation-owned scratchpad canonical-store provider', () => {
  it('lists detached precise definitions without loading or exposing note contents', async () => {
    const first = tools.listTools()
    expect(first.map(tool => tool.name)).toEqual(['scratchpad']); expect(first[0].description).toContain('formal approval')
    first[0].inputSchema.extra = 'mutated'; first[0].description = 'changed'
    expect(tools.listTools()[0].inputSchema).not.toHaveProperty('extra'); expect(tools.listTools()[0].description).not.toBe('changed')
    expect(admission).not.toHaveBeenCalled(); expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  })
  it('defaults get, distinguishes missing keys, lists keys not all values, and keeps siblings separate', async () => {
    const store = await seed()
    store.mutate({ ...scope, conversationId: 'sibling', action: 'set', key: 'secret', value: 'SIBLING_PRIVATE', expectedRevision: 0, operationId: 'seed' })
    const content = (await call({ key: 'retained' })).content
    expect(JSON.parse(content)).toEqual({ source: 'conversation_scratchpad', action: 'get', key: 'retained', value: 'old value', found: true, revision: 1, untrustedData: true, grantsPermission: false })
    expect(JSON.parse((await call({ action: 'list' })).content)).toMatchObject({ revision: 1, keys: ['retained'] })
    expect((await call({ action: 'list' })).content).not.toContain('old value')
    expect(JSON.parse((await call({ key: 'absent' })).content)).toMatchObject({ key: 'absent', found: false, revision: 1 })
    expect(content).not.toContain('SIBLING_PRIVATE'); expect(store.get(scope).revision).toBe(1)
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  })
  it.each([
    {}, { action: 'get' }, { key: '' }, { key: '__private__' }, { key: '../path' }, { key: '空白' },
    { key: 'x'.repeat(65) }, { key: 'x', value: 'not-read' }, { key: 'x', expectedRevision: 0 },
    { action: 'list', key: 'x' }, { action: 'list', value: 'x' }, { action: 'update' },
    { action: 'set', key: 'x', value: 'x' }, { action: 'set', key: 'x', value: 'x', expectedRevision: -1 },
    { action: 'set', key: 'x', value: 'x'.repeat(4001), expectedRevision: 0 }, { action: 'set', key: 'x', expectedRevision: 0 },
    { action: 'delete', key: 'x', value: 'not-delete', expectedRevision: 0 }, { action: 'clear', key: 'x', expectedRevision: 0 },
    { action: 'clear', value: 'x', expectedRevision: 0 }, { action: 'clear', expectedRevision: 1.5 },
    { action: 'list', conversationId: 'sibling' }, { action: 'list', route }, { action: 'list', operationId: 'forged' }
  ])('rejects invalid/mutation/cross-owner arguments before approval: %j', async args => {
    await expect(call(args)).rejects.toThrow()
    expect((await getAgentThreadNotesStore()).get(scope)).toEqual({ revision: 0, notes: [] })
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  })
  it.each(['set', 'delete', 'clear'] as const)('waits for exact formal approval before %s, uses CAS and leaves other conversations untouched', async action => {
    const store = await seed()
    const args = action === 'clear' ? { action, expectedRevision: 1 } : { action, key: 'retained', ...(action === 'set' ? { value: 'approved new' } : {}), expectedRevision: 1 }
    const pending = call(args)
    await vi.waitFor(() => expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(1))
    expect(store.get(scope).notes[0].value).toBe('old value')
    const item = await approve()
    expect(item.request.request.target.id).toBe('scratchpad'); expect(item.request.request.action).toBe('memory.note.write')
    expect(item.request.request.input).toMatchObject({ action, expectedRevision: 1, conversationId: scope.conversationId })
    expect(JSON.parse((await pending).content)).toMatchObject({ revision: 2, untrustedData: true, grantsPermission: false })
    expect(store.get(scope).notes.map(note => note.value)).toEqual(action === 'set' ? ['approved new'] : [])
    expect(store.get({ ...scope, conversationId: 'sibling' })).toEqual({ revision: 0, notes: [] })
  })
  it.each(['denial', 'caller-abort', 'navigation', 'concurrent-CAS'] as const)('does not mutate or resurrect retained values on %s', async cause => {
    const store = await seed(), controller = new AbortController()
    const pending = tools.callTool('scratchpad', { action: 'clear', expectedRevision: 1 }, { ...context, signal: controller.signal }).catch(error => error)
    await vi.waitFor(() => expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toHaveLength(1))
    if (cause === 'caller-abort') controller.abort()
    else if (cause === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true })
    else {
      if (cause === 'concurrent-CAS') store.mutate({ ...scope, action: 'set', key: 'newer', value: 'newer value', expectedRevision: 1, operationId: 'other' })
      await approve(cause !== 'denial')
    }
    expect(await pending).toBeInstanceOf(Error)
    expect(store.get(scope).notes.map(note => note.key)).toEqual(cause === 'concurrent-CAS' ? ['retained', 'newer'] : ['retained'])
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  })
  it('snapshots mutable arguments before await, replays only current state, and refuses conflicting same-call writes', async () => {
    const store = await seed(), args = { action: 'set', key: 'retained', value: 'exact approved', expectedRevision: 1 }
    const pending = call(args); args.value = 'later injection'
    const item = await approve(); expect(item.request.request.input).toMatchObject({ value: 'exact approved' })
    await pending
    store.mutate({ ...scope, action: 'delete', key: 'retained', expectedRevision: 2, operationId: 'later-delete' })
    expect(JSON.parse((await call({ ...args, value: 'exact approved' })).content)).toMatchObject({ revision: 3, keys: [] })
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
    await expect(call({ ...args, value: 'conflicting same identity' })).rejects.toThrow('replay conflict')
    expect(store.get(scope)).toEqual({ revision: 3, notes: [] })
  })
  it('checks cancellation, original admission, scope and mutation identity before touching the store', async () => {
    await expect(tools.callTool('other', {}, context)).rejects.toThrow('outside')
    await expect(call({ action: 'list' }, { ...context, route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    admission.mockImplementationOnce(() => { throw Error('Original invocation revoked') })
    await expect(call({ action: 'list' })).rejects.toThrow('Original invocation revoked')
    await expect(call({ action: 'clear', expectedRevision: 0 }, { ...context, toolCallId: '' })).rejects.toThrow('original run')
    lease.dispose(); await expect(call({ action: 'list' })).rejects.toThrow()
    expect(getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()).toEqual([])
  })
})
