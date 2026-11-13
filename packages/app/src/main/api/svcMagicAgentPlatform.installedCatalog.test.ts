import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServiceValidationError } from '@shared/api/apiUtils/serviceValidation'
import { parseInstalledCatalogReadResponse, installedCatalogUnavailable } from '@shared/api/installedCatalog'
import { magicAgentPlatformSvcDef } from '@shared/api/svcMagicAgentPlatform'
import { createIpcInvocationContext } from '@shared/api/createServer/ipcInvocationOrigin'
import { finalizeInstalledCatalogPublication, INSTALLED_CATALOG_PUBLICATION_METHOD as method, registerInstalledCatalogPublication } from '@shared/api/createServer/installedCatalogPublication'
import { registerIpcServer } from '@shared/api/createServer/registerIpcServer'
import { createInstalledCatalogReadHost, type InstalledCatalogReadHost } from '../magicAgentRuntime/installedCatalogReadBinding'
import { evaluateInstalledCatalogReadPolicy } from '../magicAgentRuntime/installedCatalogPolicy'
import type { InstalledCatalogReadOptions, InstalledCatalogSnapshot } from '../magicAgentRuntime/installedCatalogReader'
import type { ManagementReadState, ManagementReadWindow } from '../magicAgentRuntime/managementReadAdmission'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

const h = vi.hoisted(() => ({
  handle: vi.fn(), on: vi.fn(), getPath: vi.fn(),
  getConfig: vi.fn(() => { throw new Error('cache unavailable') }),
  initConfig: vi.fn(() => { throw new Error('Must not initialize configuration') }),
  saveConfig: vi.fn(() => { throw new Error('Must not save configuration') }),
  onConfigCommitted: vi.fn(() => () => {}),
  forbidden: vi.fn(function () { throw new Error('Unrelated runtime/store/policy construction forbidden') })
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: h.getPath }, ipcMain: { handle: h.handle, on: h.on }, MessagePortMain: class {} }))
vi.mock('../config/config', () => ({ getConfig: h.getConfig, initConfig: h.initConfig, saveConfig: h.saveConfig, onConfigCommitted: h.onConfigCommitted }))
// Counted import firebreaks, not stubs claiming the whole production import graph is hermetic.
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: h.forbidden }))
vi.mock('../agentKernel', () => ({ getAgentKernel: h.forbidden }))
vi.mock('../magicAgentRuntime/platformAdapter', () => ({ getMagicAgentPlatformAdapter: h.forbidden, MagicAgentPlatformAdapter: h.forbidden }))
vi.mock('../magicAgentRuntime/graph', () => ({ createMagicAgentGraphPreflightSnapshot: h.forbidden, getMagicAgentGraphRuntime: h.forbidden, MagicAgentGraphCatalogService: h.forbidden, MagicAgentGraphRunStore: h.forbidden, MagicAgentGraphRunEventStore: h.forbidden, MagicAgentUserGraphStore: h.forbidden, validateMagicAgentGraphDefinition: h.forbidden }))
vi.mock('../magicAgentRuntime/package', async () => ({ MagicAgentPackageStore: h.forbidden, validateMagicAgentPackageManifest: (await import('../magicAgentRuntime/package/manifest')).validateMagicAgentPackageManifest }))
vi.mock('../magicAgentPlatform2/productionRuntime', () => ({ getAssistantTerminalPolicyRuntime: h.forbidden }))
vi.mock('../magicAgentRuntime/creativeToolApproval', () => ({ invokeApprovedGraphTool: h.forbidden }))
vi.mock('../magicAgentPlatform2/agents/persistentAgentConfigStore', () => ({ createMagicAgentConfigContent: h.forbidden }))
vi.mock('../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner', () => ({ getProductionAgentInstanceLifecycle: h.forbidden }))
vi.mock('../magicAgentPlatform2/channels/productionRuntimeChannelLifecycle', () => ({ getProductionRuntimeChannelLifecycle: h.forbidden }))
vi.mock('../magicAgentPlatform2/drives/productionDriveLifecycle', () => ({ getProductionDriveLifecycle: h.forbidden }))
vi.mock('../magicAgentPlatform2/triggers/productionTriggerLifecycle', () => ({ getProductionTriggerLifecycle: h.forbidden }))
vi.mock('../magicAgentPlatform2/triggers/triggerCommandService', () => ({ TriggerCommandService: h.forbidden }))
vi.mock('../mcp/runtime', () => ({ getMcpClientManager: h.forbidden, syncMcpClientManager: h.forbidden }))
vi.mock('../magicAgentPlatform2/memory/publicSemanticMemoryService', () => ({ PublicSemanticMemoryService: h.forbidden }))

const base = 'file:///app/index.html', managementUrl = base + '#/agent-management'
const available = () => Object.freeze({ status: 'available' as const, entries: Object.freeze([Object.freeze({ id: 'demo', name: 'Demo', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' })]) })
const hosts: InstalledCatalogReadHost[] = []
const IO = ['writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'openSync', 'readFileSync'] as const
const asyncIO = ['writeFile', 'mkdir', 'rename', 'unlink', 'rm', 'open', 'opendir', 'readFile'] as const
let io: ReturnType<typeof vi.spyOn>[] = []
function fixture(install = true) {
  const sender = Object.assign(new EventEmitter(), { id: 42, url: managementUrl, mainFrame: { url: managementUrl, parent: null as unknown, detached: false }, isDestroyed: () => false, getURL() { return this.url } })
  const window = Object.assign(new EventEmitter(), { webContents: sender, isDestroyed: () => false })
  let main: ManagementReadWindow | null = window, state: ManagementReadState = 'ready', clock = 0, root = path.resolve('D:/catalog-service-fixture')
  const listeners = new Set<() => void>(), getMainWindow = vi.fn(() => main), getReadState = vi.fn(() => state), getUserData = vi.fn(() => root)
  const policy = vi.fn(evaluateInstalledCatalogReadPolicy), read = vi.fn(async (_options: InstalledCatalogReadOptions): Promise<InstalledCatalogSnapshot> => available())
  const host = createInstalledCatalogReadHost({ getReadState, getUserData, evaluatePolicy: policy, readSnapshot: read, newRequestId: () => 'installed-catalog-read:service_fixture', now: () => clock, wallNow: () => 1000, onConfigCommitted(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }); hosts.push(host)
  if (install) host.install(window, base, getMainWindow)
  const delegate = vi.fn((payload: unknown, invocation?: ServiceInvocationContext) => host.read(payload, invocation, getMainWindow))
  const service = new MagicAgentPlatformSvcImpl({ installedCatalogRead: delegate })
  const invocation = (name = method) => createIpcInvocationContext(name, { sender, senderFrame: sender.mainFrame })
  return { service, host, delegate, sender, window, read, policy, getMainWindow, getReadState, getUserData, listeners, invocation,
    event: () => ({ sender, senderFrame: sender.mainFrame }),
    commit() { for (const listener of [...listeners]) listener() }, setState(next: ManagementReadState) { state = next }, setClock(next: number) { clock = next }, setRoot(next: string) { root = next }, setMain(next: ManagementReadWindow | null) { main = next },
    navigate(next = base + '#/settings') { sender.url = next; sender.mainFrame.url = next; sender.emit('did-navigate-in-page', {}, next, true) } }
}
const noInitialization = (service: MagicAgentPlatformSvcImpl) => {
  const names = ['getAdapter', 'getGraphRuntime', 'getPackageStore', 'getUserGraphStore', 'getRunStore', 'getRunEventStore', 'getAgentKernel', 'publicMemory'] as const
  const target = service as unknown as Record<(typeof names)[number], () => unknown>
  return names.map(name => vi.spyOn(target, name).mockImplementation(() => { throw new Error('Runtime/store initialization forbidden') }))
}
const assertNoIO = () => { for (const spy of io) expect(spy).not.toHaveBeenCalled(); expect(h.initConfig).not.toHaveBeenCalled(); expect(h.saveConfig).not.toHaveBeenCalled(); expect(h.getPath).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled() }
const wire = (service: MagicAgentPlatformSvcImpl, response = parseInstalledCatalogReadResponse) => {
  registerIpcServer({ svcMagicAgentPlatform: { readInstalledCatalog: { ...magicAgentPlatformSvcDef.readInstalledCatalog, response } } }, { svcMagicAgentPlatform: { readInstalledCatalog: service.readInstalledCatalog } })
  const callback = h.handle.mock.calls.find(([name]) => name === method)?.[1]
  expect(callback).toBeTypeOf('function'); return callback
}
beforeEach(() => {
  vi.useFakeTimers(); h.handle.mockClear(); h.on.mockClear()
  // Do not reset forbidden/cache/root/init/save sentinels: import/constructor calls must remain observable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // These spies observe this bounded per-call fixture, not module-evaluation or native FS confinement.
  io = [...IO.map(name => vi.spyOn(fs, name)), ...asyncIO.map(name => vi.spyOn(fsPromises, name))]
})
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('installed-catalog real typed service and unary ownership composition', () => {
  it('module evaluation and the real default constructor do not invoke counted unrelated construction or root/config boundaries', () => {
    new MagicAgentPlatformSvcImpl()
    expect(h.forbidden).not.toHaveBeenCalled(); expect(h.getConfig).not.toHaveBeenCalled(); expect(h.onConfigCommitted).not.toHaveBeenCalled(); assertNoIO()
  })
  it('registers dedicated strict empty and detached response validators as a RAW unary method', () => {
    const definition = magicAgentPlatformSvcDef.readInstalledCatalog
    expect(definition.type).toBe('unary'); expect(definition.ipcResult).toBeUndefined(); expect(definition.request).toBeTypeOf('function'); expect(definition.response).toBe(parseInstalledCatalogReadResponse)
  })
  it.each(['default', 'authenticated-sdk', 'ipc-without-injection'] as const)('default-denies %s service without touching config/root/runtime/store/IO', async kind => {
    const f = fixture(false), service = new MagicAgentPlatformSvcImpl(), guards = noInitialization(service)
    const invocation = kind === 'default' ? undefined : kind === 'authenticated-sdk' ? { methodName: method, authenticatedActor: { kind: 'user' as const, id: 'sdk-user' } } : f.invocation()
    vi.stubEnv('MAGICPOT_MAGICAGENT_PLATFORM', '1')
    expect(await service.readInstalledCatalog({}, invocation)).toEqual(installedCatalogUnavailable)
    for (const guard of guards) expect(guard).not.toHaveBeenCalled()
    expect(h.getConfig).not.toHaveBeenCalled(); expect(f.delegate).not.toHaveBeenCalled(); assertNoIO()
  })
  it.each(['missing-context', 'copied-context', 'sdk', 'wrong-method', 'extra-payload', 'proxy-payload', 'accessor-payload'] as const)('rejects service preflight %s with zero delegate and zero initialization', async kind => {
    const f = fixture(), exact = f.invocation(), getter = vi.fn(() => 'PRIVATE'), guards = noInitialization(f.service)
    const invocation = kind === 'missing-context' ? undefined : kind === 'copied-context' ? { ...exact } : kind === 'sdk' ? { ...exact, authenticatedActor: { kind: 'user' as const, id: 'sdk' } } : kind === 'wrong-method' ? f.invocation('svcMagicAgentPlatform.getStatus') : exact
    const payload = kind === 'extra-payload' ? { path: 'PRIVATE' } : kind === 'proxy-payload' ? new Proxy({}, { ownKeys: () => { getter(); return [] } }) : kind === 'accessor-payload' ? Object.defineProperty({}, 'actor', { get: getter, enumerable: true }) : {}
    expect(await f.service.readInstalledCatalog(payload as Record<string, never>, invocation)).toEqual(installedCatalogUnavailable)
    expect(f.delegate).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); for (const guard of guards) expect(guard).not.toHaveBeenCalled(); assertNoIO()
  })
  it('forwards the exact request and invocation identity to the injected host before awaiting and retains lease until private completion', async () => {
    const f = fixture(), context = f.invocation(), payload = {}, guards = noInitialization(f.service)
    const pending = f.service.readInstalledCatalog(payload, context)
    expect(f.delegate).toHaveBeenCalledExactlyOnceWith(payload, context); expect(f.read).toHaveBeenCalledOnce()
    const value = await pending; expect(value.status).toBe('available'); expect(f.listeners.size).toBe(1)
    expect(finalizeInstalledCatalogPublication(method, context, value)).toEqual(available()); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    for (const guard of guards) expect(guard).not.toHaveBeenCalled(); assertNoIO()
  })
  it.each(['subframe', 'untrusted-route', 'missing-binding', 'null-window', 'disabled', 'unavailable'] as const)('genuine IPC %s denial belongs to host, with zero policy/root/reader/init/write', async kind => {
    const f = fixture(kind !== 'missing-binding')
    if (kind === 'subframe') f.sender.mainFrame.parent = {}
    if (kind === 'untrusted-route') f.navigate()
    if (kind === 'null-window') f.setMain(null)
    if (kind === 'disabled' || kind === 'unavailable') f.setState(kind)
    expect(await f.service.readInstalledCatalog({}, f.invocation())).toEqual(installedCatalogUnavailable)
    expect(f.delegate).toHaveBeenCalledOnce(); expect(f.policy).not.toHaveBeenCalled(); expect(f.getUserData).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); assertNoIO()
  })
  it.each(['throws', 'invalid-response', 'unavailable'] as const)('service %s cancels any registered owner and leaks no private fields/errors', async kind => {
    const f = fixture(), context = f.invocation(), cancel = vi.fn()
    f.delegate.mockImplementation(async (_payload, invocation) => {
      expect(registerInstalledCatalogPublication(invocation, { complete: () => true, cancel })).toBe(true)
      if (kind === 'throws') throw new Error('PRIVATE_PATH')
      if (kind === 'unavailable') return { status: 'unavailable', reason: 'invalid-metadata' }
      return { ...available(), sourcePath: 'PRIVATE_PATH' }
    })
    const value = await f.service.readInstalledCatalog({}, context)
    expect(value).toEqual(installedCatalogUnavailable); expect(cancel).toHaveBeenCalledOnce(); expect(finalizeInstalledCatalogPublication(method, context, available())).toEqual(installedCatalogUnavailable); assertNoIO()
  })
  it('real unary registration uses real service, dedicated validators, private IPC context, host policy and terminal cleanup', async () => {
    const f = fixture(), guards = noInitialization(f.service), callback = wire(f.service)
    const value = await callback(f.event(), {})
    expect(value).toEqual(available()); expect(Object.isFrozen(value.entries[0])).toBe(true); expect(f.delegate).toHaveBeenCalledOnce(); expect(f.policy).toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0); for (const guard of guards) expect(guard).not.toHaveBeenCalled(); assertNoIO()
  })
  it('strict real unary request validation rejects claims before service delegation', async () => {
    const f = fixture(), callback = wire(f.service)
    await expect(callback(f.event(), { actor: { kind: 'service' }, path: 'PRIVATE' })).rejects.toBeInstanceOf(ServiceValidationError)
    expect(f.delegate).not.toHaveBeenCalled(); expect(f.getUserData).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); assertNoIO()
  })
  it.each(['config', 'route', 'window', 'root', 'deadline', 'policy'] as const)('real unary response validation %s invalidation after handler success denies final publication', async kind => {
    const f = fixture(), callback = wire(f.service, raw => {
      const value = parseInstalledCatalogReadResponse(raw)
      if (kind === 'config') f.commit()
      if (kind === 'route') f.navigate()
      if (kind === 'window') f.setMain(null)
      if (kind === 'root') f.setRoot(path.resolve('D:/other-fixture-root'))
      if (kind === 'deadline') f.setClock(2000)
      if (kind === 'policy') f.policy.mockImplementation(() => null)
      return value
    })
    expect(await callback(f.event(), {})).toEqual(installedCatalogUnavailable); expect(f.read).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0); assertNoIO()
  })
  it('real unary response validator rejection cancels the actual host lease before throwing a validation error', async () => {
    const f = fixture(), callback = wire(f.service, () => { throw new Error('invalid fixture response') })
    await expect(callback(f.event(), {})).rejects.toBeInstanceOf(ServiceValidationError)
    expect(f.read).toHaveBeenCalledOnce(); expect(f.read.mock.calls[0]?.[0]?.lease.signal.aborted).toBe(true); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0); assertNoIO()
  })
  it('real unary cannot publish an available delegated result that never registered an invocation owner', async () => {
    const f = fixture(); f.delegate.mockImplementation(async () => available())
    expect(await wire(f.service)(f.event(), {})).toEqual(installedCatalogUnavailable); expect(f.delegate).toHaveBeenCalledOnce(); expect(f.read).not.toHaveBeenCalled(); assertNoIO()
  })
  it('real unary ignores late reader available after departure and return without initializing storage', async () => {
    const f = fixture(); let resolve!: (value: InstalledCatalogSnapshot) => void
    f.read.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = wire(f.service)(f.event(), {})
    expect(f.read).toHaveBeenCalledOnce(); f.navigate(); f.navigate(managementUrl); resolve(available())
    expect(await pending).toEqual(installedCatalogUnavailable); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0); assertNoIO()
  })
})
