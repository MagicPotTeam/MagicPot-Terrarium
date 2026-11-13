import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcInvocationContext } from '@shared/api/createServer/ipcInvocationOrigin'
import { cancelInstalledCatalogPublication, finalizeInstalledCatalogPublication } from '@shared/api/createServer/installedCatalogPublication'
import { digestPolicyRequest, POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION } from '@shared/magicAgentPlatform2/policy'
import { createInstalledCatalogReadHost, type InstalledCatalogReadHost } from './installedCatalogReadBinding'
import { evaluateInstalledCatalogReadPolicy } from './installedCatalogPolicy'
import { INSTALLED_CATALOG_READ_METHOD as method, type ManagementReadState, type ManagementReadWindow } from './managementReadAdmission'
import type { InstalledCatalogReadOptions, InstalledCatalogSnapshot } from './installedCatalogReader'

const { cachedConfig, committed, userDataPath } = vi.hoisted(() => ({
  cachedConfig: vi.fn(() => { throw new Error('cached configuration is uninitialized') }),
  committed: vi.fn(() => () => {}), userDataPath: vi.fn()
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: userDataPath } }))
vi.mock('../config/config', () => ({ getConfig: cachedConfig, onConfigCommitted: committed }))

const base = 'file:///app/index.html', url = base + '#/agent-management'
const available = () => Object.freeze({ status: 'available' as const, entries: Object.freeze([Object.freeze({ id: 'demo', name: 'Demo', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' })]) })
const unavailable = { status: 'unavailable', reason: 'unavailable' }
const hosts: InstalledCatalogReadHost[] = []
class Sender extends EventEmitter {
  readonly id = 42
  destroyed = false
  url = url
  mainFrame = { url, parent: null as unknown, detached: false }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
}
function fixture(install = true) {
  const sender = new Sender(), window = Object.assign(new EventEmitter(), { webContents: sender, destroyed: false, isDestroyed() { return this.destroyed } })
  let mainWindow: ManagementReadWindow | null = window, state: ManagementReadState = 'ready', clock = 0, root: unknown = path.resolve('D:/catalog-fixture'), id = 0
  const listeners = new Set<() => void>(), getMainWindow = vi.fn(() => mainWindow), getReadState = vi.fn(() => state), getUserData = vi.fn(() => root), now = vi.fn(() => clock)
  const policy = vi.fn(evaluateInstalledCatalogReadPolicy), read = vi.fn(async (_options: InstalledCatalogReadOptions): Promise<InstalledCatalogSnapshot> => available()), newRequestId = vi.fn(() => 'installed-catalog-read:fixture_' + ++id)
  const deps = { getReadState, onConfigCommitted(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }, getUserData, evaluatePolicy: policy, readSnapshot: read, newRequestId, now, wallNow: () => 1000 }
  const host = createInstalledCatalogReadHost(deps); hosts.push(host)
  const dispose = install ? host.install(window, base, getMainWindow) : () => {}
  const invocation = (name = method) => createIpcInvocationContext(name, { sender, senderFrame: sender.mainFrame })
  const navigate = (next = base + '#/settings') => { sender.url = next; sender.mainFrame.url = next; sender.emit('did-navigate-in-page', {}, next, true) }
  return { host, sender, window, deps, dispose, invocation, navigate, listeners, getMainWindow, getReadState, getUserData, policy, read, newRequestId, now,
    setState(next: ManagementReadState) { state = next }, setClock(next: number) { clock = next }, setRoot(next: unknown) { root = next }, setMain(next: ManagementReadWindow | null) { mainWindow = next },
    commit() { for (const listener of [...listeners]) listener() } }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

// No real userData, filesystem reader, store, provider or runtime is used by these owner fixtures.
describe('independent MAIN installed-catalog preinstalled window owner and read facade', () => {
  it('default cached readiness denies uninitialized config even with affirmative feature env, without root resolution or config subscription', async () => {
    const f = fixture(false), host = createInstalledCatalogReadHost(); hosts.push(host)
    host.install(f.window, base, f.getMainWindow)
    vi.stubEnv('MAGICPOT_MAGICAGENT_PLATFORM', '1'); userDataPath.mockClear(); committed.mockClear(); cachedConfig.mockClear()
    expect(await host.read({}, f.invocation(), f.getMainWindow)).toEqual(unavailable)
    expect(cachedConfig).toHaveBeenCalled(); expect(userDataPath).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('synchronously admits before reader await, builds exact MAIN policy and root, and retains lease only until terminal publication', async () => {
    const f = fixture(), context = f.invocation(), pending = f.host.read({}, context, f.getMainWindow)
    expect(f.read).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(1)
    const options = f.read.mock.calls[0]?.[0]
    expect(options).toMatchObject({ userData: path.resolve('D:/catalog-fixture') }); expect(options?.lease.isCurrent()).toBe(true)
    const request = f.policy.mock.calls[0]?.[0]
    expect(request).toEqual({ discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION, requestId: 'installed-catalog-read:fixture_1', actor: { kind: 'service', id: 'main-management-installed-catalog-reader' }, origin: 'renderer', action: 'management.installed-catalog.read', transport: 'electron-ipc', target: { kind: 'installed-package-catalog', id: 'main-user-data-installed-packages' }, input: {}, effects: [{ kind: 'filesystem.read', risk: 'read', target: 'main-user-data-installed-packages' }] })
    expect(Object.isFrozen(request)).toBe(true); expect(digestPolicyRequest(request)).toBeTruthy()
    const value = await pending; expect(value.status).toBe('available'); expect(options?.lease.isCurrent()).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, value)).toBe(value)
    expect(options?.lease.signal.aborted).toBe(true); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    expect(f.policy.mock.calls.every(([candidate]) => candidate === request)).toBe(true)
    expect(finalizeInstalledCatalogPublication(method, context, value)).toEqual(unavailable)
  })
  it.each(['missing-binding', 'null-window', 'throwing-window', 'other-window', 'missing-context', 'copied-context', 'wrong-method', 'subframe', 'extra-payload', 'wrong-route', 'disabled', 'unavailable'] as const)('denies %s before any MAIN policy/root/reader access', async kind => {
    const f = fixture(kind !== 'missing-binding'), exact = f.invocation()
    if (kind === 'null-window') f.setMain(null)
    if (kind === 'throwing-window') f.getMainWindow.mockImplementation(() => { throw new Error('no window') })
    if (kind === 'other-window') f.setMain(Object.assign(new EventEmitter(), { webContents: new Sender(), isDestroyed: () => false }))
    if (kind === 'subframe') f.sender.mainFrame.parent = {}
    if (kind === 'wrong-route') f.navigate()
    if (kind === 'disabled' || kind === 'unavailable') f.setState(kind)
    const context = kind === 'missing-context' ? undefined : kind === 'copied-context' ? { ...exact } : kind === 'wrong-method' ? f.invocation('svcMagicAgentPlatform.listPackages') : exact
    expect(await f.host.read(kind === 'extra-payload' ? { path: '/claimed' } : {}, context, f.getMainWindow)).toEqual(unavailable)
    expect(f.policy).not.toHaveBeenCalled(); expect(f.newRequestId).not.toHaveBeenCalled(); expect(f.getUserData).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['deny', 'null', 'throw', 'plain-allow', 'wrong-policy', 'wrong-rule', 'timeout', 'output', 'extra-constraint'] as const)('rejects policy %s without root/reader access and releases early lease', async kind => {
    const f = fixture()
    f.policy.mockImplementation((request, at) => {
      if (kind === 'null') return null
      if (kind === 'throw') throw new Error('PRIVATE')
      const decision = evaluateInstalledCatalogReadPolicy(request, at)!
      if (kind === 'deny') return { ...decision, effect: 'deny' }
      if (kind === 'plain-allow') return { ...decision, effect: 'allow' }
      if (kind === 'wrong-policy') return { ...decision, policyVersion: 'other' }
      if (kind === 'wrong-rule') return { ...decision, matchedRuleIds: ['generic-read'] }
      return { ...decision, constraints: { ...decision.constraints, ...(kind === 'timeout' ? { maxTimeoutMs: 1 } : kind === 'output' ? { maxOutputChars: 1 } : { networkHosts: [] }) } }
    })
    expect(await f.host.read({}, f.invocation(), f.getMainWindow)).toEqual(unavailable)
    expect(f.getUserData).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['missing', 'empty', 'relative', 'whitespace', 'throw', 'noncanonical'] as const)('rejects %s MAIN root without any CWD fallback or reader access', async kind => {
    const f = fixture()
    if (kind === 'throw') f.getUserData.mockImplementation(() => { throw new Error('PRIVATE') })
    else f.setRoot(kind === 'missing' ? undefined : kind === 'empty' ? '' : kind === 'relative' ? 'relative/catalog' : kind === 'whitespace' ? ' ' + path.resolve('D:/catalog-fixture') : path.resolve('D:/catalog-fixture') + path.sep + '..' + path.sep + 'elsewhere')
    expect(await f.host.read({}, f.invocation(), f.getMainWindow)).toEqual(unavailable)
    expect(f.read).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  const invalidate = (f: ReturnType<typeof fixture>, kind: string) => {
    if (kind === 'config') f.commit()
    if (kind === 'disable-enable') { f.setState('disabled'); f.commit(); f.setState('ready') }
    if (kind === 'departure-return') { f.navigate(); f.navigate(url) }
    if (kind === 'reload') f.sender.emit('did-start-navigation', { isMainFrame: true }, url, false, true)
    if (kind === 'root') f.setRoot(path.resolve('D:/different-root'))
    if (kind === 'deadline') f.setClock(2000)
    if (kind === 'clock-backward') f.setClock(-1)
    if (kind === 'policy') f.policy.mockImplementation(() => null)
    if (kind === 'window') f.setMain(null)
    if (kind === 'binding') f.host.install(f.window, base, f.getMainWindow)
    if (kind === 'destroy') { f.sender.destroyed = true; f.sender.emit('destroyed') }
  }
  it.each(['config', 'disable-enable', 'departure-return', 'reload', 'root', 'deadline', 'clock-backward', 'policy', 'window', 'binding', 'destroy'])('late reader completion after %s never publishes available or partial rows', async kind => {
    const f = fixture(); let resolve!: (value: InstalledCatalogSnapshot) => void
    f.read.mockImplementation(() => new Promise(done => { resolve = done }))
    const context = f.invocation(), pending = f.host.read({}, context, f.getMainWindow)
    expect(f.read).toHaveBeenCalledOnce(); invalidate(f, kind); resolve(available())
    expect(await pending).toEqual(unavailable); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['config', 'disable-enable', 'departure-return', 'reload', 'root', 'deadline', 'clock-backward', 'policy', 'window', 'binding', 'destroy'])('terminal invalidation after successful handler %s is rejected by private final publication', async kind => {
    const f = fixture(), context = f.invocation(), value = await f.host.read({}, context, f.getMainWindow)
    expect(value.status).toBe('available'); invalidate(f, kind)
    expect(finalizeInstalledCatalogPublication(method, context, value)).toEqual(unavailable)
    expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('pre-request same URL reload is fenced from installation rather than creating lazy admission on read', async () => {
    const f = fixture(); f.sender.emit('did-start-navigation', { isMainFrame: true }, url, false, true)
    expect(await f.host.read({}, f.invocation(), f.getMainWindow)).toEqual(unavailable); expect(f.read).not.toHaveBeenCalled()
    f.sender.emit('did-navigate', {}, url)
    const context = f.invocation(), value = await f.host.read({}, context, f.getMainWindow)
    expect(finalizeInstalledCatalogPublication(method, context, value).status).toBe('available')
  })
  it('stale binding disposer and old invocation cancellation cannot erase a successor registration/read', async () => {
    const f = fixture(), first = f.invocation(), old = await f.host.read({}, first, f.getMainWindow)
    f.host.install(f.window, base, f.getMainWindow); f.dispose()
    const second = f.invocation(), value = await f.host.read({}, second, f.getMainWindow)
    cancelInstalledCatalogPublication(first); expect(finalizeInstalledCatalogPublication(method, first, old)).toEqual(unavailable)
    expect(finalizeInstalledCatalogPublication(method, second, value).status).toBe('available')
  })
  it('replacement clears old owner before abort callbacks and cannot overwrite a nested installed successor', async () => {
    const f = fixture(), first = f.invocation(); await f.host.read({}, first, f.getMainWindow)
    const oldLease = f.read.mock.calls[0]?.[0]?.lease
    oldLease?.signal.addEventListener('abort', () => { f.host.install(f.window, base, f.getMainWindow) }, { once: true })
    const stale = f.host.install(f.window, base, f.getMainWindow); stale()
    const next = f.invocation(), value = await f.host.read({}, next, f.getMainWindow)
    expect(finalizeInstalledCatalogPublication(method, next, value).status).toBe('available')
    expect(f.sender.listenerCount('did-start-navigation')).toBe(1)
  })
  it.each(['deadline', 'backward'] as const)('terminal final admission readiness cannot cross host %s boundary after the host predicate succeeded', async kind => {
    const f = fixture(), context = f.invocation(), value = await f.host.read({}, context, f.getMainWindow)
    expect(value.status).toBe('available'); f.setClock(1999)
    let finalHostTimeObserved = false
    f.now.mockImplementation(() => { if (f.listeners.size === 0) finalHostTimeObserved = true; return 1999 })
    f.getReadState.mockImplementation(() => {
      if (finalHostTimeObserved) f.now.mockImplementation(() => kind === 'deadline' ? 2000 : 1998)
      return 'ready'
    })
    expect(finalizeInstalledCatalogPublication(method, context, value)).toEqual(unavailable)
    expect(finalHostTimeObserved).toBe(true); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('registration-time newListener replacement removes the exact late-inserted retired closed listener', async () => {
    const f = fixture(false); let closedRegistrations = 0
    const reenter = (event: string | symbol) => {
      // Admission installs the first closed listener; the host registry installs the second.
      if (event === 'closed' && ++closedRegistrations === 2) {
        f.window.removeListener('newListener', reenter)
        f.host.install(f.window, base, f.getMainWindow)
      }
    }
    f.window.on('newListener', reenter)
    const stale = f.host.install(f.window, base, f.getMainWindow); stale()
    expect(f.window.listenerCount('closed')).toBe(2)
    expect(f.sender.listenerCount('did-start-navigation')).toBe(1)
    const context = f.invocation(), value = await f.host.read({}, context, f.getMainWindow)
    expect(finalizeInstalledCatalogPublication(method, context, value).status).toBe('available')
    f.host.dispose(); expect(f.window.listenerCount('closed')).toBe(0)
  })
  it('closed owner teardown does not read dead window or sender getters', async () => {
    const f = fixture(), context = f.invocation(); await f.host.read({}, context, f.getMainWindow)
    Object.defineProperty(f.window, 'webContents', { get() { throw new Error('destroyed window') } })
    expect(() => f.window.emit('closed')).not.toThrow(); f.dispose(); f.host.dispose()
    expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['unavailable', 'throws'] as const)('reader %s cannot leak authority or private errors', async kind => {
    const f = fixture()
    f.read.mockImplementation(async () => { if (kind === 'throws') throw new Error('PRIVATE_PATH'); return { status: 'unavailable', reason: 'invalid-metadata' } })
    const context = f.invocation(), value = await f.host.read({}, context, f.getMainWindow)
    expect(value).toEqual(unavailable); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    expect(finalizeInstalledCatalogPublication(method, context, available())).toEqual(unavailable)
  })
})
