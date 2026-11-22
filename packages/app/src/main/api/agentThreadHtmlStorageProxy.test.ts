import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ runtime: undefined as any, getRuntime: vi.fn(), osLaunch: vi.fn(), fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('./agentThreadHtmlRuntime', async original => ({ ...(await original()), getAgentThreadHtmlRuntime: h.getRuntime }))
vi.mock('./agentThreadHtmlProcess', () => ({ openHtmlProcess: h.osLaunch }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
import { setAgentHtmlScope } from './agentThreadHtmlScope'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig, saveConfig } from '../config/config'
import { AgentThreadHtmlRuntime } from './agentThreadHtmlRuntime'
import { AgentThreadHtmlApps } from './agentThreadHtmlApps'
import { sideTestCodec } from './agentThreadSideTestUtils'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'chat', documentToken: '' }, url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let root = '', config: typeof DEFAULT_CONFIG, sender: EventEmitter, apps: AgentThreadHtmlApps
beforeEach(() => {
  vi.clearAllMocks(); root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'html-storage-proxy-')))
  config = structuredClone(DEFAULT_CONFIG); config.project_trace_config.enable_agent_html_apps = true
  vi.mocked(getConfig).mockReturnValue(config); vi.mocked(saveConfig).mockImplementation(async patch => { Object.assign(config.project_trace_config, patch.project_trace_config) })
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender }); registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender as never })
  scope.documentToken = setAgentHtmlScope({ ...scope, active: true, lifecycleRevision: 1 }, invocation('setAgentHtmlScope')).documentToken!
  h.runtime = new AgentThreadHtmlRuntime(root, sideTestCodec(), () => config.project_trace_config.agent_html_storage_epoch); h.getRuntime.mockReset().mockResolvedValue(h.runtime)
  h.osLaunch.mockReset().mockImplementation(async (document, options) => { options.beforeSpawn(); return { closed: false, update: vi.fn(), captureState: vi.fn(async () => ({ revision: document.revision, stateRevision: 1, value: { count: 42 } })), close: vi.fn(async () => { options.onClosed(true); return { confirmed: true } }) } })
  apps = new AgentThreadHtmlApps()
})
afterEach(async () => { sender.emit('did-start-navigation'); await apps.dispose(); h.runtime.close(); clearMagicAgentTrustedRouteBindingsForTest(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
describe('trusted user initialization plus actual runtime/ledger (OS launch stub)', () => {
  it('status is passive; explicit init commits epoch but neither saves a document nor spawns code', async () => {
    const service = new LLMProxySvcImpl()
    expect(await service.agentHtmlStorageStatus(scope, invocation('agentHtmlStorageStatus'))).toMatchObject({ enabled: true, initialized: false, canInitialize: true, unconfirmedRuns: 0 })
    expect(saveConfig).not.toHaveBeenCalled(); expect(h.osLaunch).not.toHaveBeenCalled()
    expect(await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))).toMatchObject({ initialized: true, available: true, canInitialize: false })
    expect(config.project_trace_config.agent_html_storage_epoch).toMatch(/^[a-f0-9-]{36}$/); expect(h.osLaunch).not.toHaveBeenCalled()
    expect(await service.agentHtmlStorageStatus(scope, invocation('agentHtmlStorageStatus'))).toMatchObject({ initialized: true, unconfirmedRuns: 0 })
  })
  it('routes current apps through persistent admission and does not let pre-init open start code', async () => {
    const service = new LLMProxySvcImpl(), controller = new AbortController(), releases: Array<(success: boolean) => void> = []
    await apps.invoke({ title: 'App', html: '<p>test</p>' }, { ...scope, messages: [] }, invocation('chat'), {}, controller.signal, () => undefined, release => releases.push(release))
    const first = apps.list(scope, invocation('listAgentHtmlApps')).apps[0]
    await expect(apps.open({ ...scope, appId: first.id, expectedRevision: 1 }, invocation('openAgentHtmlApp'), () => true)).rejects.toThrow('Initialize')
    expect(h.osLaunch).not.toHaveBeenCalled()
    await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    const second = first
    expect(apps.list(scope, invocation('listAgentHtmlApps')).apps[0].status).toBe('ready')
    await apps.open({ ...scope, appId: second.id, expectedRevision: 1 }, invocation('openAgentHtmlApp'), () => true)
    expect(h.osLaunch).toHaveBeenCalledOnce(); expect(h.runtime.status().unconfirmedRuns).toBe(1)
    await apps.close({ ...scope, appId: second.id, expectedRevision: 1 }, invocation('closeAgentHtmlApp'))
    expect(h.runtime.status().unconfirmedRuns).toBe(0)
  })
  it('saves only user-selected main-owned documents, restores fresh ready cards, and never auto-executes', async () => {
    const service = new LLMProxySvcImpl(); await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    const owner = {}, controller = new AbortController(), release: Array<(success: boolean) => void> = []
    const call = (input: Record<string, unknown>) => apps.invoke(input, { ...scope, messages: [] }, invocation('chat'), owner, controller.signal, () => controller.signal.throwIfAborted(), item => release.push(item))
    await call({ title: 'Saved app', html: '<p>PRIVATE_DOCUMENT</p>', data: { n: 42 } })
    const app = apps.list(scope, invocation('listAgentHtmlApps')).apps[0]
    const req = { ...scope, appId: app.id, expectedRevision: 1, expectedStorageRevision: 0, operationId: 'user-save' }
    await expect(apps.save(req, invocation('saveAgentHtmlApp'), () => false)).rejects.toThrow('disabled')
    const first = await apps.save(req, invocation('saveAgentHtmlApp'), () => true)
    expect(first).toMatchObject({ app: { savedId: app.id, savedRevision: 1 }, saved: { storageRevision: 1, documentRevision: 1 } })
    expect(await apps.save(req, invocation('saveAgentHtmlApp'), () => true)).toEqual(first)
    const listed = await apps.listSaved(scope, invocation('listSavedAgentHtmlApps'), () => true)
    expect(listed.apps).toHaveLength(1); expect(JSON.stringify(listed)).not.toContain('PRIVATE_DOCUMENT')
    const restoreReq = { ...scope, savedId: app.id, expectedStorageRevision: 1, operationId: 'restore-one' }
    const restored = await apps.restore(restoreReq, invocation('restoreAgentHtmlApp'), () => true)
    expect(restored.app).toMatchObject({ status: 'ready', savedId: app.id, savedRevision: 1 }); expect(restored.app.id).not.toBe(app.id); expect(h.osLaunch).not.toHaveBeenCalled()
    expect(await apps.restore(restoreReq, invocation('restoreAgentHtmlApp'), () => true)).toEqual(restored)
    await expect(apps.restore({ ...restoreReq, expectedStorageRevision: 2 }, invocation('restoreAgentHtmlApp'), () => true)).rejects.toThrow('replay conflict')
    expect(await call({ read: restored.app.id })).toMatchObject({ html: '<p>PRIVATE_DOCUMENT</p>', data: { n: 42 } })
    await call({ update: restored.app.id, html: '<p>changed-but-not-saved</p>' })
    expect(h.runtime.checkpoints().read(scope, app.id).html).toBe('<p>PRIVATE_DOCUMENT</p>')
    await apps.save({ ...req, appId: restored.app.id, expectedRevision: 2, expectedStorageRevision: 1, operationId: 'explicit-resave' }, invocation('saveAgentHtmlApp'), () => true)
    expect(h.runtime.checkpoints().read(scope, app.id)).toMatchObject({ html: '<p>changed-but-not-saved</p>', storageRevision: 2, documentRevision: 2 })
    await expect(apps.save(req, invocation('saveAgentHtmlApp'), () => true)).rejects.toThrow('advanced')
    expect(apps.list(scope, invocation('listAgentHtmlApps')).apps.find(item => item.id === app.id)?.savedRevision).toBe(1)
    await expect(apps.open({ ...scope, appId: app.id, expectedRevision: 1 }, invocation('openAgentHtmlApp'), () => true)).rejects.toThrow('changed or was deleted')
    expect(h.osLaunch).not.toHaveBeenCalled()
  })
  it('refuses saving running/unknown instances and keeps saved-run quarantine through deletion/restore attempts', async () => {
    const service = new LLMProxySvcImpl(); await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    await apps.invoke({ title: 'App', html: '<p>test</p>' }, { ...scope, messages: [] }, invocation('chat'), {}, new AbortController().signal, () => undefined, () => undefined)
    const item = apps.list(scope, invocation('listAgentHtmlApps')).apps[0]
    const saved = await apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 0, operationId: 'save' }, invocation('saveAgentHtmlApp'), () => true)
    await apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invocation('openAgentHtmlApp'), () => true)
    await expect(apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 1, operationId: 'save-live' }, invocation('saveAgentHtmlApp'), () => true)).rejects.toThrow('idle')
    await expect(apps.deleteSaved({ ...scope, savedId: saved.saved.id, expectedStorageRevision: 1 }, invocation('deleteSavedAgentHtmlApp'), () => true)).rejects.toThrow('busy')
    await expect(apps.restore({ ...scope, savedId: saved.saved.id, expectedStorageRevision: 1, operationId: 'restore-live' }, invocation('restoreAgentHtmlApp'), () => true)).rejects.toThrow('unconfirmed')
    const closed = await apps.close({ ...scope, appId: item.id, expectedRevision: 1 }, invocation('closeAgentHtmlApp'))
    expect(closed.app.snapshotReady).toBe(true)
    await apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 1, operationId: 'save-closed' }, invocation('saveAgentHtmlApp'), () => true)
    expect(h.runtime.checkpoints().read(scope, item.id)).toMatchObject({ storageRevision: 2, state: { count: 42 } })
    await apps.deleteSaved({ ...scope, savedId: saved.saved.id, expectedStorageRevision: 2 }, invocation('deleteSavedAgentHtmlApp'), () => true)
    expect((await apps.listSaved(scope, invocation('listSavedAgentHtmlApps'), () => true)).apps).toEqual([])
    await expect(apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 0, operationId: 'recreate' }, invocation('saveAgentHtmlApp'), () => true)).rejects.toThrow('Deleted HTML identity')
  })
  it('rechecks save/read/delete ownership after async storage access and fences restore retries after navigation', async () => {
    const service = new LLMProxySvcImpl(); await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    await apps.invoke({ title: 'App', html: '<p>test</p>' }, { ...scope, messages: [] }, invocation('chat'), {}, new AbortController().signal, () => undefined, () => undefined)
    const item = apps.list(scope, invocation('listAgentHtmlApps')).apps[0]
    await apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 0, operationId: 'save' }, invocation('saveAgentHtmlApp'), () => true)
    await expect(apps.listSaved({ ...scope, conversationId: 'foreign' }, invocation('listSavedAgentHtmlApps'), () => true)).rejects.toThrow('conversation changed')
    await expect(apps.restore({ ...scope, conversationId: 'foreign', savedId: item.id, expectedStorageRevision: 1, operationId: 'foreign' }, invocation('restoreAgentHtmlApp'), () => true)).rejects.toThrow('conversation changed')
    const restoredReq = { ...scope, savedId: item.id, expectedStorageRevision: 1, operationId: 'restore' }
    await apps.restore(restoredReq, invocation('restoreAgentHtmlApp'), () => true)
    sender.emit('did-start-navigation'); await vi.waitFor(() => expect(apps.list(scope, invocation('listAgentHtmlApps')).apps).toEqual([]))
    scope.documentToken = setAgentHtmlScope({ ...scope, active: true, lifecycleRevision: 2 }, invocation('setAgentHtmlScope')).documentToken!
    await expect(apps.restore({ ...restoredReq, documentToken: scope.documentToken }, invocation('restoreAgentHtmlApp'), () => true)).rejects.toThrow('unavailable')
    expect(h.osLaunch).not.toHaveBeenCalled()
  })
  it('refuses an unconfirmed final state after capture failure but still stops through the native composition', async () => {
    const service = new LLMProxySvcImpl(); await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    h.osLaunch.mockImplementationOnce(async (_document, options) => { options.beforeSpawn(); return { closed: false, update: vi.fn(), captureState: vi.fn(async () => { throw new Error('capture timeout') }), close: vi.fn(async () => { options.onClosed(true); return { confirmed: true } }) } })
    await apps.invoke({ title: 'App', html: '<p>test</p>' }, { ...scope, messages: [] }, invocation('chat'), {}, new AbortController().signal, () => undefined, () => undefined)
    const item = apps.list(scope, invocation('listAgentHtmlApps')).apps[0]
    await apps.open({ ...scope, appId: item.id, expectedRevision: 1 }, invocation('openAgentHtmlApp'), () => true)
    expect(await apps.close({ ...scope, appId: item.id, expectedRevision: 1 }, invocation('closeAgentHtmlApp'))).toMatchObject({ app: { status: 'closed', snapshotReady: false } })
    await expect(apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 0, operationId: 'do-not-save-partial' }, invocation('saveAgentHtmlApp'), () => true)).rejects.toThrow('Save only')
    expect(h.runtime.checkpoints().list(scope)).toEqual([]); expect(h.runtime.status().unconfirmedRuns).toBe(0)
  })
  it.each(['save', 'list', 'restore', 'delete'] as const)('rejects %s after conversation rebinding during runtime acquisition', async method => {
    const service = new LLMProxySvcImpl(); await service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    await apps.invoke({ title: 'App', html: '<p>test</p>' }, { ...scope, messages: [] }, invocation('chat'), {}, new AbortController().signal, () => undefined, () => undefined)
    const item = apps.list(scope, invocation('listAgentHtmlApps')).apps[0]
    await apps.save({ ...scope, appId: item.id, expectedRevision: 1, expectedStorageRevision: 0, operationId: 'first' }, invocation('saveAgentHtmlApp'), () => true)
    let finish!: (runtime: AgentThreadHtmlRuntime) => void
    h.getRuntime.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const req = { ...scope, savedId: item.id, appId: item.id, expectedRevision: 1, expectedStorageRevision: 1, operationId: 'second' }
    const pending = method === 'save' ? apps.save(req, invocation('saveAgentHtmlApp'), () => true)
      : method === 'list' ? apps.listSaved(scope, invocation('listSavedAgentHtmlApps'), () => true)
        : method === 'restore' ? apps.restore(req, invocation('restoreAgentHtmlApp'), () => true)
          : apps.deleteSaved(req, invocation('deleteSavedAgentHtmlApp'), () => true)
    const denied = expect(pending).rejects.toThrow('conversation changed')
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    const successor = { ...scope, conversationId: 'successor' }
    setAgentHtmlScope({ ...successor, active: true, lifecycleRevision: 2 }, invocation('setAgentHtmlScope'))
    finish(h.runtime); await denied
    expect(h.runtime.checkpoints().read(scope, item.id)?.storageRevision).toBe(1); expect(h.osLaunch).not.toHaveBeenCalled()
    expect(apps.list(scope, invocation('listAgentHtmlApps')).apps).toHaveLength(1)
  })
  it('rejects stale scope activation/deactivation and revokes same-scope tokens on reactivation', () => {
    const old = { ...scope }
    setAgentHtmlScope({ ...scope, active: false, lifecycleRevision: 1 }, invocation('setAgentHtmlScope'))
    expect(() => setAgentHtmlScope({ ...scope, active: true, lifecycleRevision: 1 }, invocation('setAgentHtmlScope'))).toThrow('Retired')
    const next = setAgentHtmlScope({ ...scope, active: true, lifecycleRevision: 2 }, invocation('setAgentHtmlScope'))
    expect(next.documentToken).not.toBe(old.documentToken)
    expect(() => setAgentHtmlScope({ ...scope, active: false, lifecycleRevision: 1 }, invocation('setAgentHtmlScope'))).toThrow('Stale')
  })
  it.each(['missing', 'iframe', 'method', 'foreign-project', 'disabled', 'remote'] as const)('rejects %s initialization without config writes', async mode => {
    const service = new LLMProxySvcImpl(), context = invocation('initializeAgentHtmlStorage')
    if (mode === 'iframe') context.isMainFrame = false
    if (mode === 'method') context.methodName = 'svcLLMProxy.chat'
    if (mode === 'foreign-project') context.frameUrl = context.frameUrl.replace('project', 'foreign')
    if (mode === 'disabled') config.project_trace_config.enable_agent_html_apps = false
    if (mode === 'remote') config.use_remote_llm = true
    await expect(service.initializeAgentHtmlStorage(scope, mode === 'missing' ? undefined : context)).rejects.toThrow()
    expect(saveConfig).not.toHaveBeenCalled(); expect(h.osLaunch).not.toHaveBeenCalled()
  })
  it('rechecks document ownership after async runtime acquisition before config initialization', async () => {
    let finish!: (runtime: AgentThreadHtmlRuntime) => void
    h.getRuntime.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const service = new LLMProxySvcImpl(), pending = service.initializeAgentHtmlStorage(scope, invocation('initializeAgentHtmlStorage'))
    const denied = expect(pending).rejects.toThrow(/no longer active|conversation changed/)
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    sender.emit('did-start-navigation'); finish(h.runtime); await denied
    expect(saveConfig).not.toHaveBeenCalled()
  })
})
