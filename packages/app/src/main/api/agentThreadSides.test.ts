import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentThreadSides, type SideProfileFactory } from './agentThreadSides'
import { AgentThreadSideStore } from './agentThreadSideStore'
import { sideScope as scope, sideDocument, sideTestCodec } from './agentThreadSideTestUtils'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
import type { AgentSideStartReq } from '@shared/api/agentThreadSide'
const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (method: string, senderId = 71) => ({ methodName: `svcLLMProxy.${method}`, senderId, isMainFrame: true, frameUrl: url, senderUrl: url })
let service: AgentThreadSides, store: AgentThreadSideStore, sender: EventEmitter & { id: number; isDestroyed(): boolean; getURL(): string }
const request = (): AgentSideStartReq => ({ ...scope, branchId: randomUUID(), operationId: randomUUID(), profileId: 'profile', question: 'PRIVATE_SIDE', snapshot: [{ role: 'user', content: 'ORIGINAL_PARENT' }] })
const chat = vi.fn(), factory: SideProfileFactory = () => ({ profileId: 'profile', profileDigest: 'a'.repeat(64), modelLabel: 'model', assertCurrent: () => undefined, createClient: async () => ({ chat, supportsIsolatedReadOnlyTurns: true }), listTools: () => [], read: vi.fn() })
const listed = () => service.list(scope, invoke('listAgentSides'))
beforeEach(() => {
  store = new AgentThreadSideStore(sideTestCodec()); service = new AgentThreadSides(async () => store)
  chat.mockReset(); chat.mockResolvedValue('ANSWER')
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url }); sender.setMaxListeners(0)
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, scope.route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(async () => { await service.dispose(); store.close(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
describe('user-only durable side lifecycle', () => {
  it('starts, opens and continues the same saved branch without new parent snapshot or duplicate model calls', async () => {
    const req = request(); await service.start(req, invoke('startAgentSide'), factory)
    await vi.waitFor(async () => expect((await listed()).branches[0]).toMatchObject({ status: 'completed', busy: false }))
    const opened = await service.open(req, invoke('openAgentSide'))
    expect(JSON.stringify(opened)).not.toContain('ORIGINAL_PARENT'); expect(opened.messages).toHaveLength(2)
    await service.start(req, invoke('startAgentSide'), factory); expect(chat).toHaveBeenCalledOnce()
    const follow = { ...scope, branchId: req.branchId, operationId: randomUUID(), expectedRevision: opened.branch.revision, question: 'FOLLOW_UP' }
    await service.continue(follow, invoke('continueAgentSide'), factory)
    await vi.waitFor(async () => expect((await listed()).branches[0]).toMatchObject({ turns: 2, busy: false }))
    const text = JSON.stringify(chat.mock.calls[1][0].messages)
    for (const part of ['ORIGINAL_PARENT', 'PRIVATE_SIDE', 'ANSWER', 'FOLLOW_UP']) expect(text).toContain(part)
    await service.continue(follow, invoke('continueAgentSide'), factory); expect(chat).toHaveBeenCalledTimes(2)
  })
  it('recovers an identical pending continuation while the committed turn is still busy', async () => {
    const req = request(); await service.start(req, invoke('startAgentSide'), factory)
    await vi.waitFor(async () => expect((await listed()).branches[0].busy).toBe(false))
    const before = (await listed()).branches[0]
    let finish!: (value: string) => void
    chat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const follow = { ...scope, branchId: req.branchId, expectedRevision: before.revision, operationId: randomUUID(), question: 'COMMITTED_FOLLOWUP' }
    try {
      await service.continue(follow, invoke('continueAgentSide'), factory)
      await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
      const recovered = await service.continue(follow, invoke('continueAgentSide'), factory)
      expect(recovered.branch).toMatchObject({ busy: true, turns: 2 })
      expect(chat).toHaveBeenCalledTimes(2)
      await expect(service.continue({ ...follow, question: 'CHANGED' }, invoke('continueAgentSide'), factory)).rejects.toThrow('replay conflict')
      expect(chat).toHaveBeenCalledTimes(2)
    } finally { finish('FOLLOWUP_ANSWER'); await vi.waitFor(async () => expect((await listed()).branches[0].busy).toBe(false)) }
  })
  it('marks crashed persisted work interrupted on reopen but never auto-runs or changes its saved snapshot', async () => {
    const doc = sideDocument(); store.save(scope, doc, 0)
    const opened = await service.open({ ...scope, branchId: doc.id }, invoke('openAgentSide'))
    expect(opened.branch).toMatchObject({ status: 'interrupted', revision: 2, canContinue: true }); expect(chat).not.toHaveBeenCalled()
    expect(store.read(scope, doc.id)?.snapshot).toEqual(doc.snapshot)
  })
  it('holds capacity through an uncooperative cancelled provider and rejects late reply retention', async () => {
    let finish!: (value: string) => void
    chat.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    const req = request(); await service.start(req, invoke('startAgentSide'), factory)
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce())
    const before = (await listed()).branches[0]
    const stopped = await service.stop({ ...req, expectedRevision: before.revision }, invoke('stopAgentSide'))
    expect(stopped.branch.busy).toBe(true)
    await expect(service.continue({ ...req, expectedRevision: before.revision, operationId: randomUUID(), question: 'another' }, invoke('continueAgentSide'), factory)).rejects.toThrow('running or draining')
    await expect(service.start(request(), invoke('startAgentSide'), factory)).rejects.toThrow('concurrency')
    finish('LATE_SECRET'); await vi.waitFor(async () => expect((await listed()).branches[0].busy).toBe(false))
    expect(JSON.stringify(await service.open(req, invoke('openAgentSide')))).not.toContain('LATE_SECRET')
  })
  it('blocks stale revisions, profile changes and replay after deletion', async () => {
    const req = request(); await service.start(req, invoke('startAgentSide'), factory)
    await vi.waitFor(async () => expect((await listed()).branches[0].busy).toBe(false))
    const branch = (await listed()).branches[0], follow = { ...req, expectedRevision: branch.revision, operationId: randomUUID(), question: 'next' }
    await expect(service.continue({ ...follow, expectedRevision: 1 }, invoke('continueAgentSide'), factory)).rejects.toThrow('revision')
    await expect(service.continue(follow, invoke('continueAgentSide'), (...args) => ({ ...factory(...args), profileDigest: 'b'.repeat(64) }))).rejects.toThrow('profile changed')
    await service.delete({ ...req, expectedRevision: branch.revision }, invoke('deleteAgentSide'))
    await expect(service.start(req, invoke('startAgentSide'), factory)).rejects.toThrow('Deleted side identity')
    expect(chat).toHaveBeenCalledOnce()
  })
  it('allows only one current document to control a running branch, then requires a fresh explicit continuation', async () => {
    let finish!: (value: string) => void
    chat.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    const req = request(); await service.start(req, invoke('startAgentSide'), factory)
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce())
    const second = Object.assign(new EventEmitter(), { id: 72, isDestroyed: () => false, getURL: () => url })
    registerMagicAgentTrustedRouteBinding(72, scope.route, { trustedUrl: url, trustedWebContents: second })
    electron.fromId.mockImplementation((id) => id === 72 ? second : sender)
    electron.parent.mockImplementation((child) => ({ isDestroyed: () => false, webContents: child }))
    expect((await service.list(scope, invoke('listAgentSides', 72))).branches).toEqual([])
    await expect(service.open(req, invoke('openAgentSide', 72))).rejects.toThrow('another')
    sender.emit('did-start-navigation'); finish('LATE_PRIVATE')
    await vi.waitFor(() => expect(store.read(scope, req.branchId)?.status).toBe('stopped'))
    const opened = await service.open(req, invoke('openAgentSide', 72))
    expect(JSON.stringify(opened)).not.toContain('LATE_PRIVATE')
    expect(chat).toHaveBeenCalledOnce()
    await service.continue({ ...req, expectedRevision: opened.branch.revision, operationId: randomUUID(), question: 'User explicitly continues' }, invoke('continueAgentSide', 72), factory)
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2))
  })
  it('shares global admission across scopes and does not allocate another branch while four calls drain', async () => {
    const finishes: Array<(value: string) => void> = []
    chat.mockImplementation(() => new Promise<string>((resolve) => { finishes.push(resolve) }))
    try {
      for (let i = 0; i < 4; i++) await service.start({ ...request(), conversationId: `chat-${i}` }, invoke('startAgentSide'), factory)
      await vi.waitFor(() => expect(finishes).toHaveLength(4))
      await expect(service.start(request(), invoke('startAgentSide'), factory)).rejects.toThrow('concurrency')
      expect(store.list(scope)).toEqual([])
    } finally { finishes.forEach((finish) => finish('done')) }
  })
  it('revalidates document after store loading and rejects foreign scopes and methods', async () => {
    const req = request(); await expect(service.start(req, invoke('chat'), factory)).rejects.toThrow('denied')
    let finish!: (s: AgentThreadSideStore) => void
    const delayed = new AgentThreadSides(() => new Promise((resolve) => { finish = resolve }))
    const pending = delayed.start(req, invoke('startAgentSide'), factory).catch((e) => e)
    sender.emit('did-start-navigation'); finish(store); expect(await pending).toBeInstanceOf(Error); expect(chat).not.toHaveBeenCalled()
    expect((await service.list({ ...scope, conversationId: 'other' }, invoke('listAgentSides'))).branches).toEqual([])
    await expect(service.open({ ...req, conversationId: 'other' }, invoke('openAgentSide'))).rejects.toThrow('unavailable')
  })
})
