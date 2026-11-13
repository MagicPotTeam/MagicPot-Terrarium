import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentThreadHtmlApps } from './agentThreadHtmlApps'
import type { openHtmlProcess, IsolatedHtmlProcess } from './agentThreadHtmlProcess'
import type { HtmlAppEvent } from './agentThreadHtmlHost'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ app: {}, webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'chat' }, url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let apps: AgentThreadHtmlApps, launch: ReturnType<typeof vi.fn<typeof openHtmlProcess>>, sender: EventEmitter & { id: number; isDestroyed(): boolean; getURL(): string }
const calls: Array<(success: boolean) => void> = []
let owner: object, signal: AbortController, emit: (event: HtmlAppEvent) => void, close: ReturnType<typeof vi.fn<IsolatedHtmlProcess['close']>>, update: ReturnType<typeof vi.fn<IsolatedHtmlProcess['update']>>
const call = (input: Record<string, unknown>) => apps.invoke(input, { ...scope, messages: [] }, invoke('chat'), owner, signal.signal, () => signal.signal.throwIfAborted(), release => calls.push(release))
const list = () => apps.list(scope, invoke('listAgentHtmlApps')).apps
beforeEach(() => {
  owner = {}; signal = new AbortController(); calls.length = 0
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url }); sender.setMaxListeners(0)
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender }); registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
  update = vi.fn(async () => undefined)
  launch = vi.fn<typeof openHtmlProcess>(async (_doc, options) => {
    emit = options.onEvent
    close = vi.fn(async () => { options.onClosed(true); return { confirmed: true } })
    return { closed: false, close, update }
  })
  apps = new AgentThreadHtmlApps(launch)
})
afterEach(async () => { await apps.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); vi.useRealTimers() })
describe('thread-owned HTML app documents and control', () => {
  it('retains a prepared document without executing until explicit trusted user open', async () => {
    const result: any = await call({ title: 'HTML', html: '<p>original</p>', data: { n: 1 } })
    expect(result).toMatchObject({ awaitingUserOpen: true, shown: false, grantsPermission: false }); expect(launch).not.toHaveBeenCalled()
    const item = list()[0]; expect(JSON.stringify(item)).not.toContain('original')
    expect(await apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)).toMatchObject({ app: { status: 'open' } })
    expect(launch).toHaveBeenCalledOnce()
    calls.forEach(release => release(true)); signal.abort(); expect(close).not.toHaveBeenCalled()
  })
  it('transfers state acknowledged after the last poll before replacing HTML and rejects stale stop revisions', async () => {
    const captureState = vi.fn(async () => ({ revision: 1, stateRevision: 1, value: { newest: 42 } }))
    launch.mockImplementationOnce(async (_document, options) => { emit = options.onEvent; close = vi.fn(async () => { options.onClosed(true); return { confirmed: true } }); return { closed: false, close, update, captureState } })
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    await apps.open({ ...scope, appId: id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    await call({ update: id, html: '<p>two</p>' })
    expect(captureState).toHaveBeenCalledOnce(); expect(update).toHaveBeenCalledWith(expect.objectContaining({ state: { newest: 42 }, revision: 2 }))
    expect(await call({ read: id })).toMatchObject({ state: { newest: 42 }, app: { revision: 2 } })
    await expect(apps.close({ ...scope, appId: id, expectedRevision: 1 }, invoke('closeAgentHtmlApp'))).rejects.toThrow('revision conflict')
    expect(close).not.toHaveBeenCalled(); expect(list()[0].status).toBe('open')
  })
  it('requires read-before-patch in every new parent request and applies exact ordered edits', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    owner = {}
    await expect(call({ update: id, patch: [{ find: 'one', replace: 'two' }] })).rejects.toThrow('Read')
    expect(await call({ read: id })).toMatchObject({ html: '<p>one</p>' })
    await call({ update: id, patch: [{ find: 'one', replace: 'two' }] }); expect(await call({ read: id })).toMatchObject({ html: '<p>two</p>', app: { revision: 2 } })
    await expect(call({ update: id, expectedRevision: 1, html: 'stale' })).rejects.toThrow('revision')
    await expect(call({ update: id, patch: [{ find: 'missing', replace: '' }] })).rejects.toThrow('exactly once')
  })
  it('waits for named untrusted app events and ignores events from a superseded revision', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    await apps.open({ ...scope, appId: id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    await call({ update: id, html: '<p>two</p>' }); expect(update).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
    emit({ name: 'done', data: 'OLD', revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    const pending = call({ update: id, wait_for: ['done'], timeout_s: 5 })
    await vi.waitFor(() => expect(list()[0].revision).toBe(2)); expect(update).toHaveBeenCalledOnce()
    emit({ name: 'done', data: { result: 42 }, revision: 2, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(await pending).toMatchObject({ event: { data: { result: 42 }, origin: 'app' }, grantsPermission: false })
  })
  it.each(['failure', 'navigation', 'stop'])('revokes owned execution on %s without a new model turn', async reason => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const item = list()[0]
    await apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    if (reason === 'failure') calls.forEach(release => release(false))
    else if (reason === 'navigation') sender.emit('did-start-navigation')
    else await apps.close({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('closeAgentHtmlApp'))
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    if (reason === 'navigation') expect(list()).toEqual([])
  })
  it('aborts an in-flight update owned by a later parent request before it acknowledges', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    await apps.open({ ...scope, appId: id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    calls.splice(0).forEach(release => release(true)); signal = new AbortController(); owner = {}
    let rejectUpdate!: (error: Error) => void
    update.mockImplementation(() => new Promise((_resolve, reject) => { rejectUpdate = reject }))
    const pending = call({ update: id, html: '<p>two</p>', expectedRevision: 1 })
    const rejected = expect(pending).rejects.toThrow('aborted update')
    signal.abort(); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    rejectUpdate(new Error('aborted update')); await rejected
    expect(list()[0]).toMatchObject({ revision: 1, status: 'closed' })
  })
  it('does not reload or clear queued feedback for wait-only calls and only permits one waiter', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    await apps.open({ ...scope, appId: id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    const wait = call({ update: id, wait_for: ['done'], timeout_s: 5 })
    await expect(call({ update: id, wait_for: ['done'] })).rejects.toThrow('waiter')
    emit({ name: 'done', data: 'value', revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(await wait).toMatchObject({ event: { data: 'value' }, app: { revision: 1 } }); expect(update).not.toHaveBeenCalled()
    emit({ name: 'done', data: 'queued', revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(await call({ update: id, wait_for: ['done'] })).toMatchObject({ event: { data: 'queued' } })
  })
  it('evicts bounded old events and explicitly reports loss instead of blocking done behind unrelated feedback', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    await apps.open({ ...scope, appId: id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    for (let i = 0; i < 16; i++) emit({ name: 'progress', data: i, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    emit({ name: 'done', data: 'finished', revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(await call({ update: id, wait_for: ['done'] })).toMatchObject({ event: { data: 'finished' }, droppedEvents: 1 })
    for (let i = 0; i < 2; i++) emit({ name: 'progress', data: i, revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(await call({ update: id, wait_for: ['different'] })).toMatchObject({ eventQueueOverflow: true, droppedEvents: 2 })
    let settled = false
    const pending = call({ update: id, wait_for: ['different'] }).then(result => { settled = true; return result })
    await Promise.resolve(); expect(settled).toBe(false)
    emit({ name: 'different', data: 'future', revision: 1, origin: 'app', untrustedData: true, grantsPermission: false })
    expect(await pending).toMatchObject({ event: { data: 'future' } })
  })
  it('reports a superseded waiter instead of consuming events from a successor document', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    const wait = call({ update: id, wait_for: ['done'], timeout_s: 5 })
    await call({ update: id, html: '<p>two</p>', expectedRevision: 1 })
    expect(await wait).toMatchObject({ superseded: true, app: { revision: 2 } })
  })
  it('returns explicit timeout and can wait again without reloading a document', async () => {
    vi.useFakeTimers()
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    const pending = call({ update: id, wait_for: ['done'], timeout_s: 1 })
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toMatchObject({ timedOut: true, app: { revision: 1, status: 'ready' } }); expect(launch).not.toHaveBeenCalled()
  })
  it('does not commit a late update acknowledgement after the user has stopped the app', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const id = list()[0].id
    await apps.open({ ...scope, appId: id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    let finish!: () => void
    update.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = call({ update: id, html: '<p>late</p>' }); const rejected = expect(pending).rejects.toThrow()
    await apps.close({ ...scope, appId: id, expectedRevision: 1 }, invoke('closeAgentHtmlApp'))
    finish(); await rejected; expect(list()[0]).toMatchObject({ revision: 1, status: 'closed' })
  })
  it('waits for owned launch settlement when user stop arrives during opening', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const item = list()[0]
    let finish!: (process: IsolatedHtmlProcess) => void, opts!: Parameters<typeof openHtmlProcess>[1]
    launch.mockImplementationOnce((_document, options) => { opts = options; return new Promise(resolve => { finish = resolve }) })
    const opening = apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    const rejected = expect(opening).rejects.toThrow()
    let settled = false
    const stopping = apps.close({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('closeAgentHtmlApp')).then(result => { settled = true; return result })
    expect(opts.signal.aborted).toBe(true); await Promise.resolve(); expect(settled).toBe(false)
    const lateClose = vi.fn(async () => { opts.onClosed(true); return { confirmed: true } })
    finish({ closed: false, close: lateClose, update: vi.fn(async () => undefined) })
    await rejected; expect(await stopping).toMatchObject({ app: { status: 'closed' } }); expect(lateClose).toHaveBeenCalledOnce()
  })
  it('retains unknown closure through expiry and disposal instead of freeing capacity', async () => {
    vi.useFakeTimers()
    await call({ title: 'HTML', html: '<p>one</p>' }); const item = list()[0]
    await apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)
    close.mockResolvedValue({ confirmed: false })
    expect(await apps.close({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('closeAgentHtmlApp'))).toMatchObject({ app: { status: 'unknown' } })
    await vi.advanceTimersByTimeAsync(900001)
    expect(list()[0].status).toBe('unknown')
    await expect(call({ read: item.id })).rejects.toThrow('expired')
    await apps.dispose(); expect(list()[0].status).toBe('unknown')
    // Dispose must not turn a tombstone into a reusable ready record.
    await expect(apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invoke('openAgentHtmlApp'), () => true)).rejects.toThrow('already open')
  })
  it('refuses disabled, foreign and stale user opens, and does not expose another conversation', async () => {
    await call({ title: 'HTML', html: '<p>one</p>' }); const item = list()[0], req = { ...scope, appId: item.id, expectedRevision: 1 }
    await expect(apps.open(req, invoke('openAgentHtmlApp'), () => false)).rejects.toThrow('disabled')
    await expect(apps.open({ ...req, expectedRevision: 2 }, invoke('openAgentHtmlApp'), () => true)).rejects.toThrow('stale')
    await expect(apps.open({ ...req, conversationId: 'other' }, invoke('openAgentHtmlApp'), () => true)).rejects.toThrow('unavailable')
    await expect(apps.open(req, { ...invoke('openAgentHtmlApp'), isMainFrame: false }, () => true)).rejects.toThrow('not trusted')
    expect(launch).not.toHaveBeenCalled()
  })
})
