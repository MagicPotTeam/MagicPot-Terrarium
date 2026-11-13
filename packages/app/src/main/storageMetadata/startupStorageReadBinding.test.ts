import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcInvocationContext } from '@shared/api/createServer/ipcInvocationOrigin'
import { cancelStartupStoragePublication, finalizeStartupStoragePublication } from '@shared/api/createServer/startupStoragePublication'
import { startupStorageMetadataUnavailable as unavailable } from '@shared/api/startupStorageMetadata'
import { POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, type PolicyDecision } from '@shared/magicAgentPlatform2/policy'
import { createStartupStorageSnapshot, type StartupStorageCapture } from '../config/startupStorageSnapshot'
import { createStartupStorageReadHost, type StartupStorageReadHost, type StartupStorageReadHostDeps } from './startupStorageReadBinding'
import { evaluateStartupStorageReadPolicy } from './startupStorageReadPolicy'
import { STARTUP_STORAGE_READ_METHOD as method, type StartupStorageReadState, type StartupStorageReadWindow } from './startupStorageReadAdmission'

const h = vi.hoisted(() => ({ config: vi.fn(() => { throw new Error('uninitialized cached configuration') }), committed: vi.fn(() => () => {}), enabled: vi.fn(() => true) }))
vi.mock('../config/config', () => ({ getConfig: h.config, onConfigCommitted: h.committed }))
vi.mock('../magicAgentRuntime/featureFlag', () => ({ isMagicAgentPlatformEnabled: h.enabled }))
const base = 'file:///app/index.html', managementUrl = base + '#/agent-management'
class Sender extends EventEmitter {
  readonly id = 73
  destroyed = false
  url = managementUrl
  mainFrame = { url: managementUrl, parent: null as unknown, detached: false }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
}
const hosts: StartupStorageReadHost[] = []
function fixture(install = true) {
  const sender = new Sender(), window = Object.assign(new EventEmitter(), { webContents: sender, destroyed: false, isDestroyed() { return this.destroyed } })
  const owner = createStartupStorageSnapshot(); owner.publish({ source: 'persisted', legacyLayout: false })
  let currentWindow: StartupStorageReadWindow | null = window, state: StartupStorageReadState = 'ready', clock = 10, id = 0
  const listeners = new Set<() => void>(), getMainWindow = vi.fn(() => currentWindow), getReadState = vi.fn(() => state), now = vi.fn(() => clock), wallNow = vi.fn(() => 1000)
  const subscribe = vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const capture = vi.fn((): StartupStorageCapture | null => owner.capture()), policy = vi.fn(evaluateStartupStorageReadPolicy), newRequestId = vi.fn(() => 'startup-storage-read:fixture_' + ++id)
  const deps: StartupStorageReadHostDeps = { getReadState, onConfigCommitted: subscribe, capture, evaluatePolicy: policy, newRequestId, now, wallNow }
  const host = createStartupStorageReadHost(deps); hosts.push(host)
  const dispose = install ? host.install(window, base, getMainWindow) : () => {}
  const invocation = (name = method) => createIpcInvocationContext(name, { sender, senderFrame: sender.mainFrame })
  const navigate = (next = base + '#/settings') => { sender.url = next; sender.mainFrame.url = next; sender.emit('did-navigate-in-page', {}, next, true) }
  return { host, sender, window, owner, deps, dispose, invocation, getMainWindow, getReadState, now, wallNow, subscribe, capture, policy, newRequestId, listeners, navigate,
    setMain(next: StartupStorageReadWindow | null) { currentWindow = next }, setState(next: StartupStorageReadState) { state = next }, setClock(next: number) { clock = next }, commit() { for (const listener of [...listeners]) listener() } }
}
const available = { status: 'available', source: 'persisted', legacyLayout: false }
beforeEach(() => { vi.useFakeTimers(); h.config.mockClear(); h.committed.mockClear(); h.enabled.mockClear() })
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('independent MAIN startup metadata host — capture only after own admission and exact zero-effect policy', () => {
  it('creates and installs the default host without eager cache/feature reads and denies uninitialized cache even if feature env is affirmative', async () => {
    const f = fixture(false), host = createStartupStorageReadHost(); hosts.push(host)
    host.install(f.window, base, f.getMainWindow)
    expect(h.config).not.toHaveBeenCalled(); expect(h.enabled).not.toHaveBeenCalled(); expect(h.committed).not.toHaveBeenCalled()
    vi.stubEnv('MAGICPOT_MAGICAGENT_PLATFORM', '1')
    expect(await host.read({}, f.invocation(), f.getMainWindow)).toBe(unavailable)
    expect(h.config).toHaveBeenCalled(); expect(h.enabled).not.toHaveBeenCalled(); expect(h.committed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('builds only the exact MAIN tuple, captures once and transfers terminal publication without exposing paths, tokens or time', async () => {
    const f = fixture(), context = f.invocation(), pending = f.host.read({}, context, f.getMainWindow)
    expect(f.capture).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(1)
    const request = f.policy.mock.calls[0]?.[0]
    expect(request).toEqual({ discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION, requestId: 'startup-storage-read:fixture_1', actor: { kind: 'service', id: 'main-management-startup-storage-reader' }, origin: 'renderer', action: 'management.startup-storage-metadata.read', transport: 'electron-ipc', target: { kind: 'startup-storage-metadata', id: 'main-startup-storage-snapshot' }, input: {}, effects: [] })
    expect(Object.isFrozen(request)).toBe(true)
    const result = await pending; expect(result).toEqual(available); expect(Object.isFrozen(result)).toBe(true)
    expect(Reflect.ownKeys(result).sort()).toEqual(['legacyLayout', 'source', 'status'])
    expect(finalizeStartupStoragePublication(method, context, result)).toEqual(available)
    expect(f.capture).toHaveBeenCalledOnce(); expect(f.policy.mock.calls.every(([value]) => value === request)).toBe(true)
    expect(vi.getTimerCount()).toBe(0); expect(f.listeners.size).toBe(1)
    expect(finalizeStartupStoragePublication(method, context, result)).toBe(unavailable)
    f.dispose(); expect(f.listeners.size).toBe(0)
  })
  it('requires the exact installed getter callable identity and never calls an unrecognized replacement getter', async () => {
    const f = fixture(), other = vi.fn(() => f.window)
    expect(await f.host.read({}, f.invocation(), other)).toBe(unavailable)
    expect(other).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled(); expect(f.policy).not.toHaveBeenCalled()
    const context = f.invocation(), result = await f.host.read({}, context, f.getMainWindow)
    expect(finalizeStartupStoragePublication(method, context, result)).toEqual(available)
  })
  it.each(['missing-binding', 'null-window', 'throw-window', 'different-window', 'missing-context', 'copied-context', 'wrong-method', 'subframe', 'extra-payload', 'wrong-route', 'bare-query', 'disabled', 'unavailable'] as const)('denies %s before policy/capture/subscription access', async kind => {
    const f = fixture(kind !== 'missing-binding'), exact = f.invocation()
    if (kind === 'null-window') f.setMain(null)
    if (kind === 'throw-window') f.getMainWindow.mockImplementation(() => { throw new Error('private') })
    if (kind === 'different-window') f.setMain(Object.assign(new EventEmitter(), { webContents: new Sender(), isDestroyed: () => false }))
    if (kind === 'subframe') f.sender.mainFrame.parent = {}
    if (kind === 'wrong-route') f.navigate()
    if (kind === 'bare-query') f.navigate(base + '?#/agent-management')
    if (kind === 'disabled' || kind === 'unavailable') f.setState(kind)
    const context = kind === 'missing-context' ? undefined : kind === 'copied-context' ? { ...exact } : kind === 'wrong-method' ? f.invocation('svcMagicAgentPlatform.readInstalledCatalog') : exact
    expect(await f.host.read(kind === 'extra-payload' ? { actor: 'user' } : {}, context, f.getMainWindow)).toBe(unavailable)
    expect(f.policy).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled(); expect(f.newRequestId).not.toHaveBeenCalled(); expect(f.subscribe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['null', 'throw', 'deny', 'plain-allow', 'catalog', 'rule', 'timeout', 'output', 'extra-constraint', 'audit', 'digest', 'evaluatedAt', 'getter', 'proxy'] as const)('rejects policy %s before capture and without borrowing any catalog decision', async kind => {
    const f = fixture(), hook = vi.fn(() => { throw new Error('diagnostic must not be read') })
    f.policy.mockImplementation((request, at) => {
      if (kind === 'null') return null
      if (kind === 'throw') throw Object.defineProperty({}, 'message', { get: hook })
      const exact = evaluateStartupStorageReadPolicy(request, at)!
      if (kind === 'deny' || kind === 'plain-allow') return { ...exact, effect: kind === 'deny' ? 'deny' : 'allow' }
      if (kind === 'catalog') return { ...exact, policyVersion: 'management-installed-catalog-read/v1' }
      if (kind === 'rule') return { ...exact, matchedRuleIds: ['management-installed-catalog-read-exact'] }
      if (kind === 'audit') return { ...exact, audit: { ...exact.audit, action: 'management.installed-catalog.read' } }
      if (kind === 'digest') return { ...exact, requestDigest: 'sha256:' + '0'.repeat(64) }
      if (kind === 'evaluatedAt') return { ...exact, evaluatedAt: at + 1 }
      if (kind === 'getter') return Object.defineProperty({}, 'effect', { get: hook }) as PolicyDecision
      if (kind === 'proxy') return exact // Spy must return plain data; raw wrapper below supplies the proxy.
      return { ...exact, constraints: { ...exact.constraints, ...(kind === 'timeout' ? { maxTimeoutMs: 2001 } : kind === 'output' ? { maxOutputChars: 257 } : { networkHosts: [] }) } }
    })
    // Vitest spy's returnValue instanceof Promise probes proxy getPrototypeOf before our host.
    // Return the proxy from a RAW dependency wrapper, preserving the call observer and 0 hooks.
    if (kind === 'proxy') f.deps.evaluatePolicy = (request, at) => new Proxy(f.policy(request, at)!, { get: hook, getPrototypeOf: hook, ownKeys: hook })
    expect(await f.host.read({}, f.invocation(), f.getMainWindow)).toBe(unavailable)
    expect(f.capture).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['unpublished', 'throw', 'mutable-capture', 'extra-field', 'getter', 'proxy', 'stale'] as const)('rejects %s capture without recapture, probes or partial metadata', async kind => {
    const f = fixture(), hook = vi.fn(() => { throw new Error('raw capture must not be read') }), exact = f.owner.capture()!
    if (kind === 'unpublished') f.capture.mockReturnValue(null)
    if (kind === 'throw') f.capture.mockImplementation(() => { throw Object.defineProperty({}, 'message', { get: hook }) })
    if (kind === 'mutable-capture') f.capture.mockReturnValue({ ...exact })
    if (kind === 'extra-field') f.capture.mockReturnValue(Object.freeze({ ...exact, path: '/private' }))
    if (kind === 'getter') f.capture.mockReturnValue(Object.freeze({ get snapshot() { return hook() }, isCurrent: () => true }))
    if (kind === 'proxy') { f.capture.mockReturnValue(exact); f.deps.capture = () => new Proxy(f.capture()!, { get: hook, getPrototypeOf: hook, ownKeys: hook }) }
    if (kind === 'stale') { f.owner.invalidate(); f.capture.mockReturnValue(exact) }
    expect(await f.host.read({}, f.invocation(), f.getMainWindow)).toBe(unavailable)
    expect(f.capture).toHaveBeenCalledOnce(); expect(hook).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  const invalidate = (f: ReturnType<typeof fixture>, kind: string) => {
    if (kind === 'config') f.commit()
    if (kind === 'config-ABA') { f.setState('disabled'); f.commit(); f.setState('ready'); f.commit() }
    if (kind === 'departure-return') { f.navigate(); f.navigate(managementUrl) }
    if (kind === 'reload') f.sender.emit('did-start-navigation', { isMainFrame: true }, managementUrl, false, true)
    if (kind === 'owner') f.owner.invalidate()
    if (kind === 'deadline') f.setClock(2010)
    if (kind === 'backwards') f.setClock(9)
    if (kind === 'policy') f.policy.mockReturnValue(null)
    if (kind === 'window') f.setMain(null)
    if (kind === 'binding') f.host.install(f.window, base, f.getMainWindow)
    if (kind === 'destroy') { f.sender.destroyed = true; f.sender.emit('destroyed') }
    if (kind === 'dispose') f.host.dispose()
  }
  it.each(['config', 'config-ABA', 'departure-return', 'reload', 'owner', 'deadline', 'backwards', 'policy', 'window', 'binding', 'destroy', 'dispose'])('rejects %s after the service await at final publication', async kind => {
    const f = fixture(), context = f.invocation(), result = await f.host.read({}, context, f.getMainWindow)
    expect(result).toEqual(available); invalidate(f, kind)
    expect(finalizeStartupStoragePublication(method, context, result)).toBe(unavailable)
    expect(f.capture).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['getWindow', 'readState', 'policy', 'wallClock', 'clock'] as const)('checks the ORIGINAL startup capture after terminal %s callbacks and cleans work first', async kind => {
    const f = fixture(), context = f.invocation(), result = await f.host.read({}, context, f.getMainWindow)
    expect(result).toEqual(available)
    const invalidateOwner = () => { expect(vi.getTimerCount()).toBe(0); expect(f.listeners.size).toBe(1); f.owner.invalidate() }
    if (kind === 'getWindow') f.getMainWindow.mockImplementation(() => { invalidateOwner(); return f.window })
    if (kind === 'readState') f.getReadState.mockImplementation(() => { invalidateOwner(); return 'ready' })
    if (kind === 'policy') f.policy.mockImplementation((request, at) => { invalidateOwner(); return evaluateStartupStorageReadPolicy(request, at) })
    if (kind === 'wallClock') f.wallNow.mockImplementation(() => { invalidateOwner(); return 1000 })
    if (kind === 'clock') f.now.mockImplementation(() => { invalidateOwner(); return 10 })
    expect(finalizeStartupStoragePublication(method, context, result)).toBe(unavailable)
    expect(f.capture).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it('retains config generation during terminal policy disable-commit-reenable-commit without invalidating the startup owner', async () => {
    const f = fixture(), context = f.invocation(), result = await f.host.read({}, context, f.getMainWindow)
    expect(result).toEqual(available)
    f.policy.mockImplementation((request, at) => { f.setState('disabled'); f.commit(); f.setState('ready'); f.commit(); return evaluateStartupStorageReadPolicy(request, at) })
    expect(finalizeStartupStoragePublication(method, context, result)).toBe(unavailable)
    expect(f.owner.capture()?.isCurrent()).toBe(true); expect(f.capture).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it('allows advancing monotonic time without extending the earlier host deadline beyond admission', async () => {
    const f = fixture(); let time = 10; f.now.mockImplementation(() => ++time)
    const context = f.invocation(), result = await f.host.read({}, context, f.getMainWindow)
    expect(finalizeStartupStoragePublication(method, context, result)).toEqual(available)
    expect(f.capture).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it('old cancellation, replay and stale disposer cannot erase a successor read', async () => {
    const f = fixture(), first = f.invocation(), old = await f.host.read({}, first, f.getMainWindow)
    expect(old).toEqual(available)
    const replacementDispose = f.host.install(f.window, base, f.getMainWindow); f.dispose()
    const second = f.invocation(), result = await f.host.read({}, second, f.getMainWindow)
    expect(result).toEqual(available); cancelStartupStoragePublication(first)
    expect(finalizeStartupStoragePublication(method, first, old)).toBe(unavailable)
    expect(finalizeStartupStoragePublication(method, second, result)).toEqual(available)
    replacementDispose(); expect(f.listeners.size).toBe(0); expect(f.sender.eventNames()).toEqual([]); expect(f.window.eventNames()).toEqual([])
  })
  it('preserves pending navigation if a prepended listener replaces the HOST inside already-dispatched navigation', async () => {
    const f = fixture(), first = f.invocation(); expect(await f.host.read({}, first, f.getMainWindow)).toEqual(available)
    f.sender.prependOnceListener('did-start-navigation', () => { f.host.install(f.window, base, f.getMainWindow) })
    f.sender.emit('did-start-navigation', { isMainFrame: true }, managementUrl, false, true)
    expect(await f.host.read({}, f.invocation(), f.getMainWindow)).toBe(unavailable)
    f.sender.emit('did-navigate', {}, managementUrl)
    const next = f.invocation(), result = await f.host.read({}, next, f.getMainWindow)
    expect(finalizeStartupStoragePublication(method, next, result)).toEqual(available)
  })
  it('does not overwrite a nested installation from lifecycle newListener and keeps exact cleanup ownership', async () => {
    const f = fixture(); let nested = false
    f.sender.once('newListener', () => { if (!nested) { nested = true; f.host.install(f.window, base, f.getMainWindow) } })
    const stale = f.host.install(f.window, base, f.getMainWindow); stale()
    const next = f.invocation(), result = await f.host.read({}, next, f.getMainWindow)
    expect(finalizeStartupStoragePublication(method, next, result)).toEqual(available)
    expect(f.sender.listenerCount('did-start-navigation')).toBe(1)
    f.host.dispose(); expect(f.sender.eventNames()).toEqual([]); expect(f.window.eventNames()).toEqual([]); expect(f.listeners.size).toBe(0)
  })
})
