import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
import { mutateAgentNote, approveAgentNoteMutation } from './agentThreadNotes'
import { AgentThreadNotesStore } from './agentThreadNotesStore'
import { getAssistantTerminalPolicyRuntime, closeAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = () => ({ methodName: 'svcLLMProxy.mutateAgentNote', senderId: 71, isMainFrame: true, senderUrl: url, frameUrl: url })
const req = () => ({ ...scope, action: 'set' as const, key: 'preference', value: 'Blue', expectedRevision: 0, operationId: randomUUID() })
let store: AgentThreadNotesStore
let sender: EventEmitter & { id: number; isDestroyed: () => boolean; getURL: () => string }
beforeEach(() => {
  store = new AgentThreadNotesStore()
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(() => { closeAssistantTerminalPolicyRuntime(); store.close(); clearMagicAgentTrustedRouteBindingsForTest(); vi.clearAllMocks() })
describe('formal approval for durable conversation notes', () => {
  it('waits for the real production approval center, then consumes exactly one permit before save', async () => {
    const runtime = getAssistantTerminalPolicyRuntime()
    const pending = mutateAgentNote(req(), invocation(), { store }).catch((e) => e)
    await vi.waitFor(() => expect(runtime.listPendingTerminalApprovals()).toHaveLength(1))
    expect(store.get(scope).notes).toEqual([])
    const approval = runtime.listPendingTerminalApprovals()[0]
    expect(approval.request.request.target.id).toBe('scratchpad')
    expect(approval.request.request.input).toMatchObject({ key: 'preference', value: 'Blue', conversationId: scope.conversationId })
    runtime.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
    expect(await pending).toMatchObject({ revision: 1, notes: [{ key: 'preference', value: 'Blue' }] })
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it('denial causes no mutation', async () => {
    const runtime = getAssistantTerminalPolicyRuntime()
    const pending = mutateAgentNote(req(), invocation(), { store }).catch((e) => e)
    await vi.waitFor(() => expect(runtime.listPendingTerminalApprovals()).toHaveLength(1))
    const approval = runtime.listPendingTerminalApprovals()[0]
    runtime.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: false })
    expect(await pending).toBeInstanceOf(Error)
    expect(store.get(scope)).toEqual({ revision: 0, notes: [] })
  })
  it('snapshot approval does not authorize caller changes or stale concurrent edits', async () => {
    let finish!: () => void
    const approve = vi.fn(async () => new Promise<void>((resolve) => { finish = resolve }))
    const input = req()
    const pending = mutateAgentNote(input, invocation(), { store, approve })
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
    input.value = 'Injected value'
    finish()
    expect((await pending).notes[0].value).toBe('Blue')
    const second = mutateAgentNote({ ...req(), expectedRevision: 1 }, invocation(), { store, approve }).catch((e) => e)
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
    store.mutate({ ...req(), key: 'newer', expectedRevision: 1 })
    finish()
    expect(await second).toMatchObject({ message: expect.stringContaining('revision conflict') })
    expect(store.get(scope).notes.find((note) => note.key === 'newer')).toBeDefined()
  })
  it('revokes approval on navigation and rejects untrusted/iframe/cross-project callers', async () => {
    const runtime = getAssistantTerminalPolicyRuntime()
    const pending = mutateAgentNote(req(), invocation(), { store }).catch((e) => e)
    await vi.waitFor(() => expect(runtime.listPendingTerminalApprovals()).toHaveLength(1))
    sender.emit('did-start-navigation', { isMainFrame: true })
    expect(await pending).toBeInstanceOf(Error)
    expect(store.get(scope).notes).toEqual([])
    for (const other of [undefined, { ...invocation(), isMainFrame: false }, { ...invocation(), senderId: 72 }]) await expect(mutateAgentNote(req(), other, { store })).rejects.toThrow()
    await expect(mutateAgentNote({ ...req(), route: { ...route, scopeId: 'other' } }, invocation(), { store })).rejects.toThrow()
  })
  it('recovers a committed operation on identical public retry without another approval or write', async () => {
    const approve = vi.fn(async () => undefined)
    const input = req()
    const saved = await mutateAgentNote(input, invocation(), { store, approve })
    expect(await mutateAgentNote(input, invocation(), { store, approve })).toEqual(saved)
    expect(approve).toHaveBeenCalledOnce()
    await expect(mutateAgentNote({ ...input, value: 'Conflict' }, invocation(), { store, approve })).rejects.toThrow('replay conflict')
    expect(approve).toHaveBeenCalledOnce()
  })
  it('clear waits for exact production approval and clears only the approved notes revision', async () => {
    store.mutate(req())
    const clear = { ...scope, action: 'clear' as const, expectedRevision: 1, operationId: randomUUID() }
    const policy = getAssistantTerminalPolicyRuntime()
    const pending = mutateAgentNote(clear, invocation(), { store }).catch((e) => e)
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    expect(store.get(scope).notes).toHaveLength(1)
    const approval = policy.listPendingTerminalApprovals()[0]
    expect(approval.request.request.input).toMatchObject({ action: 'clear', expectedRevision: 1, clearScope: 'current-conversation-notes-only', conversationId: scope.conversationId })
    expect(approval.request.request.input).not.toHaveProperty('key')
    policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
    expect(await pending).toEqual({ revision: 2, notes: [] })
    const approve = vi.fn(async () => { throw new Error('must not reapprove') })
    expect(await mutateAgentNote(clear, invocation(), { store, approve })).toEqual({ revision: 2, notes: [] })
    expect(approve).not.toHaveBeenCalled()
  })
  it.each(['denial', 'navigation', 'cancel', 'concurrent-edit'])('clear does not erase notes on %s while approval is pending', async (mode) => {
    store.mutate(req())
    const policy = getAssistantTerminalPolicyRuntime(), controller = new AbortController()
    const clear = { ...scope, action: 'clear' as const, expectedRevision: 1, operationId: randomUUID() }
    const pending = mutateAgentNote(clear, invocation(), { store, signal: controller.signal }).catch(e => e)
    await vi.waitFor(() => expect(policy.listPendingTerminalApprovals()).toHaveLength(1))
    const approval = policy.listPendingTerminalApprovals()[0]
    if (mode === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true })
    else if (mode === 'cancel') controller.abort()
    else {
      if (mode === 'concurrent-edit') store.mutate({ ...req(), key: 'newer', expectedRevision: 1 })
      policy.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: mode !== 'denial' })
    }
    expect(await pending).toBeInstanceOf(Error)
    expect(store.get(scope).notes.map(n => n.key)).toEqual(mode === 'concurrent-edit' ? ['preference', 'newer'] : ['preference'])
    expect(policy.listPendingTerminalApprovals()).toHaveLength(0)
  })
  it('validates malformed input before requesting approval', async () => {
    const approve = vi.fn<typeof approveAgentNoteMutation>()
    await expect(mutateAgentNote({ ...req(), value: 'x'.repeat(4001) }, invocation(), { store, approve })).rejects.toThrow('Invalid')
    await expect(mutateAgentNote({ ...req(), action: 'clear' } as unknown as Parameters<typeof mutateAgentNote>[0], invocation(), { store, approve })).rejects.toThrow('Invalid')
    await expect(mutateAgentNote({ ...scope, action: 'clear', expectedRevision: 0, operationId: randomUUID(), allConversations: true } as unknown as Parameters<typeof mutateAgentNote>[0], invocation(), { store, approve })).rejects.toThrow('Invalid')
    expect(approve).not.toHaveBeenCalled()
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
})
