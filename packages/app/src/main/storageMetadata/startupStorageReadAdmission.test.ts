import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcInvocationContext } from '@shared/api/createServer/ipcInvocationOrigin'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { createStartupStorageSnapshot } from '../config/startupStorageSnapshot'
import { completeManagementReadLease, createManagementReadAdmission } from '../magicAgentRuntime/managementReadAdmission'
import { completeStartupStorageReadLease, createStartupStorageReadAdmission, STARTUP_STORAGE_READ_METHOD, type StartupStorageReadAdmission, type StartupStorageReadLease, type StartupStorageReadState, type StartupStorageReadWindow, type StartupStorageTerminalCheck } from './startupStorageReadAdmission'

const base = 'file:///app/index.html', managementUrl = base + '#/agent-management'
class Sender extends EventEmitter {
  readonly id = 42
  destroyed = false
  url = managementUrl
  mainFrame = { url: managementUrl, parent: null as unknown, detached: false }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
}
const admissions: StartupStorageReadAdmission[] = [], otherDisposers: Array<() => void> = []
function fixture() {
  const sender = new Sender(), window = Object.assign(new EventEmitter(), { webContents: sender, destroyed: false, isDestroyed() { return this.destroyed } })
  let currentWindow: StartupStorageReadWindow | null = window, state: StartupStorageReadState = 'ready', clock = 10
  const listeners = new Set<() => void>(), owner = createStartupStorageSnapshot()
  expect(owner.publish({ source: 'persisted', legacyLayout: false })).toBe(true)
  const getMainWindow = vi.fn(() => currentWindow), getReadState = vi.fn(() => state), now = vi.fn(() => clock)
  const onConfigCommitted = vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const options = { window, trustedRendererUrl: base, getMainWindow, getReadState, now, onConfigCommitted, timeoutMs: 100 }
  const admission = createStartupStorageReadAdmission(options); admissions.push(admission)
  const invocation = (method = STARTUP_STORAGE_READ_METHOD) => createIpcInvocationContext(method, { sender, senderFrame: sender.mainFrame })
  const navigate = (next = base + '#/settings') => { sender.url = next; sender.mainFrame.url = next; sender.emit('did-navigate-in-page', {}, next, true) }
  const finalCheck = (): StartupStorageTerminalCheck => Object.freeze({ deadline: 100, minimumTime: 10, storageCapture: owner.capture()! })
  return { sender, window, options, admission, invocation, owner, listeners, getMainWindow, getReadState, now, onConfigCommitted, navigate, finalCheck,
    setWindow(value: StartupStorageReadWindow | null) { currentWindow = value }, setState(value: StartupStorageReadState) { state = value }, setClock(value: number) { clock = value }, commit() { for (const listener of [...listeners]) listener() } }
}
function requireLease(value: StartupStorageReadLease | null): StartupStorageReadLease {
  expect(value).not.toBeNull(); if (!value) throw new Error('Expected independent storage read lease'); return value
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const admission of admissions.splice(0)) admission.dispose(); for (const dispose of otherDisposers.splice(0)) dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('independent storage metadata admission, no endpoint/reader/UI registration', () => {
  it('admits exact transport origin and sets up one revocable bounded lease with no initialized store access', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    expect(lease.isCurrent()).toBe(true); expect(lease.signal.aborted).toBe(false); expect(Object.isFrozen(lease)).toBe(true)
    expect(f.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(1)
    lease.close(); lease.close(); expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true)
    // The one config observer belongs to the admission, not the closed work lease.
    expect(f.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(0); expect(f.owner.capture()?.isCurrent()).toBe(true)
    f.admission.dispose(); expect(f.listeners.size).toBe(0)
  })
  it.each(['/settings', '/agent-studio', '/agent-management/', '/agent-management/child', '/agent-management?x=1', '/agent-management?', '/%61gent-management', '/agent-management#other'])('denies noncanonical route %s', route => {
    const f = fixture(); f.navigate(base + '#' + route)
    expect(f.admission.begin({}, f.invocation())).toBeNull(); expect(f.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([base + '?', base + '?outer=1', 'file:///other/index.html', 'http://untrusted/index.html'])('does not normalize a mismatched raw renderer URL %s', rendererBase => {
    const f = fixture(); f.navigate(rendererBase + '#/agent-management')
    expect(f.admission.begin({}, f.invocation())).toBeNull()
  })
  it.each(['svcMagicAgentPlatform.readInstalledCatalog', 'svcState.getConfig', 'svcState.getUserDataDirectoryState', 'svcState.getStorageLocations', 'svcState.setUserDataDirectory', 'svcState.readStartupStorageMetadata.child'])('does not inherit authority for %s', method => {
    const f = fixture(); expect(f.admission.begin({}, f.invocation(method))).toBeNull(); expect(f.listeners.size).toBe(0)
  })
  it.each([null, undefined, [], '', 1, { path: '/fake' }, { actor: { kind: 'service' } }, { policy: 'allow' }, { unused: undefined }, Object.create({ inherited: true }), { [Symbol('claim')]: true }])('denies nonempty, inherited or non-object request %#', payload => {
    const f = fixture(); expect(f.admission.begin(payload, f.invocation())).toBeNull(); expect(f.listeners.size).toBe(0)
  })
  it('accepts exact null-prototype empty request but rejects hidden/accessor/proxy requests before inspecting them', () => {
    const f = fixture(), trap = vi.fn(() => { throw new Error('not inspected') }), proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap })
    const revoked = Proxy.revocable({}, {}); revoked.revoke()
    for (const value of [Object.defineProperty({}, 'path', { get: trap }), proxy, revoked.proxy]) expect(f.admission.begin(value, f.invocation())).toBeNull()
    expect(trap).not.toHaveBeenCalled(); const lease = requireLease(f.admission.begin(Object.create(null), f.invocation())); lease.close()
  })
  it.each(['missing', 'copy', 'json', 'scalar', 'other-sender', 'other-frame', 'subframe', 'detached', 'frame-url', 'sender-url'] as const)('denies %s provenance despite copied visible claims', kind => {
    const f = fixture(), original = f.invocation(); let context: ServiceInvocationContext | undefined = original
    if (kind === 'missing') context = undefined
    if (kind === 'copy') context = { ...original }
    if (kind === 'json') context = JSON.parse(JSON.stringify(original))
    if (kind === 'scalar') context = { methodName: STARTUP_STORAGE_READ_METHOD, senderId: 42, senderUrl: managementUrl, frameUrl: managementUrl, isMainFrame: true }
    if (kind === 'other-sender') context = createIpcInvocationContext(STARTUP_STORAGE_READ_METHOD, { sender: new Sender(), senderFrame: f.sender.mainFrame })
    if (kind === 'other-frame') context = createIpcInvocationContext(STARTUP_STORAGE_READ_METHOD, { sender: f.sender, senderFrame: { ...f.sender.mainFrame } })
    if (kind === 'subframe') { f.sender.mainFrame.parent = {}; context = f.invocation() }
    if (kind === 'detached') f.sender.mainFrame.detached = true
    if (kind === 'frame-url') f.sender.mainFrame.url = base + '#/settings'
    if (kind === 'sender-url') f.sender.url = base + '#/settings'
    expect(f.admission.begin({}, context)).toBeNull(); expect(f.listeners.size).toBe(0)
  })
  it.each(['no-window', 'other-window', 'window-destroyed', 'sender-destroyed', 'disabled', 'unavailable'] as const)('denies %s before working lease or subscription setup', kind => {
    const f = fixture()
    if (kind === 'no-window') f.setWindow(null)
    if (kind === 'other-window') f.setWindow(Object.assign(new EventEmitter(), { ...f.window }))
    if (kind === 'window-destroyed') f.window.destroyed = true
    if (kind === 'sender-destroyed') f.sender.destroyed = true
    if (kind === 'disabled' || kind === 'unavailable') f.setState(kind)
    expect(f.admission.begin({}, f.invocation())).toBeNull(); expect(f.listeners.size).toBe(0)
  })
  it('does not revive a request after leave-return or config disable-reenable, but a new request may be admitted', () => {
    const f = fixture(), first = requireLease(f.admission.begin({}, f.invocation()))
    f.navigate(); f.navigate(managementUrl); expect(first.isCurrent()).toBe(false)
    const next = requireLease(f.admission.begin({}, f.invocation()))
    f.setState('disabled'); f.commit(); f.setState('ready'); f.commit()
    expect(next.isCurrent()).toBe(false); expect(f.owner.capture()?.isCurrent()).toBe(true)
    expect(requireLease(f.admission.begin({}, f.invocation())).isCurrent()).toBe(true)
  })
  it('retains same-window navigation-pending fence across replacement and same-URL reload', () => {
    const f = fixture(), first = requireLease(f.admission.begin({}, f.invocation()))
    f.sender.emit('did-start-navigation', { isMainFrame: true }, managementUrl, false, true)
    const next = createStartupStorageReadAdmission(f.options); admissions.push(next)
    expect(first.isCurrent()).toBe(false); expect(next.begin({}, f.invocation())).toBeNull()
    f.sender.emit('did-navigate', {}, managementUrl)
    expect(requireLease(next.begin({}, f.invocation())).isCurrent()).toBe(true)
  })
  it.each(['render-process-gone', 'destroyed', 'window-closed'] as const)('revokes on %s and cannot finish the old request', event => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    if (event === 'window-closed') f.window.emit('closed'); else f.sender.emit(event)
    expect(lease.isCurrent()).toBe(false); expect(completeStartupStorageReadLease(lease, f.finalCheck)).toBe(false)
  })
  it('expires without restoring authority when clock rolls back and also enforces timer closure', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    f.setClock(11); expect(lease.isCurrent()).toBe(true); f.setClock(10); expect(lease.isCurrent()).toBe(false)
    f.setClock(12); expect(lease.isCurrent()).toBe(false)
    const next = requireLease(f.admission.begin({}, f.invocation())); vi.advanceTimersByTime(101)
    expect(next.isCurrent()).toBe(false); expect(f.listeners.size).toBe(1)
    f.admission.dispose(); expect(f.listeners.size).toBe(0)
  })
  it('installs storage and catalog admission on the same actual window without evicting either owner or lending leases', () => {
    const f = fixture(), catalog = createManagementReadAdmission(f.options); otherDisposers.push(() => catalog.dispose())
    const storageLease = requireLease(f.admission.begin({}, f.invocation()))
    const catalogLease = catalog.begin({}, f.invocation('svcMagicAgentPlatform.readInstalledCatalog'))!
    expect(catalogLease).not.toBeNull(); expect(storageLease.isCurrent()).toBe(true); expect(catalogLease.isCurrent()).toBe(true)
    expect(completeManagementReadLease(storageLease, () => true)).toBe(false)
    expect(completeStartupStorageReadLease(catalogLease, f.finalCheck)).toBe(false)
    expect(storageLease.isCurrent()).toBe(true); expect(catalogLease.isCurrent()).toBe(true)
    expect(completeStartupStorageReadLease(storageLease, f.finalCheck)).toBe(true); expect(catalogLease.isCurrent()).toBe(true)
    expect(completeManagementReadLease(catalogLease, () => true)).toBe(true)
  })

  it('completes once only after revocation/cleanup and validates the captured startup owner as the final freshness dependency', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), capture = f.owner.capture()!, trace: string[] = []
    lease.signal.addEventListener('abort', () => { trace.push('cleanup'); expect(lease.isCurrent()).toBe(false) })
    const final = vi.fn(() => { trace.push('external-final'); expect(f.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(0); return { deadline: 100, minimumTime: 10, storageCapture: capture } })
    expect(completeStartupStorageReadLease(lease, final)).toBe(true)
    expect(trace).toEqual(['cleanup', 'external-final']); expect(final).toHaveBeenCalledOnce()
    expect(completeStartupStorageReadLease(lease, final)).toBe(false); expect(final).toHaveBeenCalledOnce()
    expect(lease.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not complete copied/forged/already closed leases or asynchronous/truthy final checks', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), final = vi.fn(f.finalCheck)
    expect(completeStartupStorageReadLease({ ...lease }, final)).toBe(false); expect(final).not.toHaveBeenCalled()
    expect(completeStartupStorageReadLease(lease, (() => Promise.resolve(f.finalCheck())) as unknown as () => StartupStorageTerminalCheck)).toBe(false)
    expect(completeStartupStorageReadLease(lease, final)).toBe(false)
    const next = requireLease(f.admission.begin({}, f.invocation())); next.close(); expect(completeStartupStorageReadLease(next, final)).toBe(false)
  })
  it.each(['before-complete', 'cleanup', 'final-check', 'window', 'ready', 'clock'] as const)('rejects startup invalidation at %s without recapturing or rearming the owner', position => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), capture = f.owner.capture()!
    if (position === 'before-complete') f.owner.invalidate()
    if (position === 'cleanup') lease.signal.addEventListener('abort', () => f.owner.invalidate())
    const check = () => {
      if (position === 'final-check') f.owner.invalidate()
      if (position === 'window') f.getMainWindow.mockImplementation(() => { f.owner.invalidate(); return f.window })
      if (position === 'ready') f.getReadState.mockImplementation(() => { f.owner.invalidate(); return 'ready' })
      if (position === 'clock') f.now.mockImplementation(() => { f.owner.invalidate(); return 20 })
      return { deadline: 100, minimumTime: 10, storageCapture: capture }
    }
    expect(completeStartupStorageReadLease(lease, check)).toBe(false); expect(capture.isCurrent()).toBe(false)
    expect(f.owner.capture()).toBeNull()
  })
  it.each([NaN, Infinity, -1, 9, 100])('fails final non-finite/rollback/expired clock %s after external checks', time => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    const final = () => { f.now.mockReturnValue(time); return f.finalCheck() }
    expect(completeStartupStorageReadLease(lease, final)).toBe(false)
  })
  it('checks internal sequence after the final clock callback and rejects even a denied reentrant attempt', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    const final = () => { f.now.mockImplementation(() => { expect(f.admission.begin({ policy: 'allow' }, f.invocation())).toBeNull(); return 20 }); return f.finalCheck() }
    expect(completeStartupStorageReadLease(lease, final)).toBe(false)
  })
  it('makes final completion terminal before reentry and cannot be revived through nested completion', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    const final = () => { expect(completeStartupStorageReadLease(lease, f.finalCheck)).toBe(false); f.admission.invalidate(); return f.finalCheck() }
    expect(completeStartupStorageReadLease(lease, final)).toBe(false)
  })
  it('fails closed on config unsubscribe/abort reentry while preserving a legitimate successor and not running the old final check', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())); let successor: StartupStorageReadLease | null = null
    lease.signal.addEventListener('abort', () => { successor = f.admission.begin({}, f.invocation()) })
    const final = vi.fn(f.finalCheck)
    expect(completeStartupStorageReadLease(lease, final)).toBe(false); expect(final).not.toHaveBeenCalled()
    expect(successor).not.toBeNull(); expect(successor!.isCurrent()).toBe(true)
    lease.close(); expect(successor!.isCurrent()).toBe(true)
  })
  it('handles synchronous subscription invalidation transactionally before its unsubscribe has returned', () => {
    const f = fixture(), cleanup = vi.fn(); f.admission.dispose()
    const options = { ...f.options, onConfigCommitted: (listener: () => void) => { listener(); return cleanup } }
    const admission = createStartupStorageReadAdmission(options); admissions.push(admission)
    expect(admission.begin({}, f.invocation())).toBeNull(); expect(cleanup).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['final-check', 'window', 'ready', 'clock'] as const)('rejects terminal config disable-commit-reenable-commit at %s without invalidating the startup owner', position => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), capture = f.owner.capture()!
    const commitAba = () => { f.setState('disabled'); f.commit(); f.setState('ready'); f.commit() }
    const final = () => {
      if (position === 'final-check') commitAba()
      if (position === 'window') f.getMainWindow.mockImplementation(() => { commitAba(); return f.window })
      if (position === 'ready') f.getReadState.mockImplementation(() => { commitAba(); return 'ready' })
      if (position === 'clock') f.now.mockImplementation(() => { commitAba(); return 20 })
      return { deadline: 100, minimumTime: 10, storageCapture: capture }
    }
    expect(completeStartupStorageReadLease(lease, final)).toBe(false)
    expect(capture.isCurrent()).toBe(true); expect(lease.signal.aborted).toBe(true)
  })
  it('observes navigation start emitted by the old lease abort during same-window owner handoff', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    lease.signal.addEventListener('abort', () => { f.sender.emit('did-start-navigation', { isMainFrame: true }, managementUrl, false, true) })
    const replacement = createStartupStorageReadAdmission(f.options); admissions.push(replacement)
    expect(lease.signal.aborted).toBe(true)
    expect(replacement.begin({}, f.invocation())).toBeNull()
    f.sender.emit('did-navigate', {}, managementUrl)
    expect(requireLease(replacement.begin({}, f.invocation())).isCurrent()).toBe(true)
  })
  it('preserves shared navigation observation when replacement occurs in an earlier listener of the same already-dispatched event', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation())); let replacement: StartupStorageReadAdmission | undefined
    f.sender.prependOnceListener('did-start-navigation', () => { replacement = createStartupStorageReadAdmission(f.options); admissions.push(replacement) })
    f.sender.emit('did-start-navigation', { isMainFrame: true }, managementUrl, false, true)
    expect(old.signal.aborted).toBe(true); expect(replacement).toBeDefined()
    expect(replacement!.begin({}, f.invocation())).toBeNull()
    f.sender.emit('did-navigate', {}, managementUrl)
    expect(requireLease(replacement!.begin({}, f.invocation())).isCurrent()).toBe(true)
  })
  it('performs no terminal external window/readiness/clock predicate until the work signal is aborted and timer cleared', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), observations: Array<{ callback: string; aborted: boolean; timers: number }> = []
    const observe = (callback: string) => { observations.push({ callback, aborted: lease.signal.aborted, timers: vi.getTimerCount() }) }
    f.getMainWindow.mockImplementation(() => { observe('window'); return f.window })
    f.getReadState.mockImplementation(() => { observe('ready'); return 'ready' })
    f.now.mockImplementation(() => { observe('clock'); return 20 })
    expect(completeStartupStorageReadLease(lease, () => { observe('final'); return f.finalCheck() })).toBe(true)
    expect(observations.length).toBeGreaterThan(0)
    expect(observations.every(value => value.aborted && value.timers === 0)).toBe(true)
    expect(observations[0].callback).toBe('final')
  })
  it('keeps one admission config observer across closed/terminal leases and unsubscribes it exactly on disposal', () => {
    const f = fixture(), first = requireLease(f.admission.begin({}, f.invocation()))
    first.close(); expect(f.listeners.size).toBe(1)
    const next = requireLease(f.admission.begin({}, f.invocation()))
    expect(f.onConfigCommitted).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(1)
    expect(completeStartupStorageReadLease(next, f.finalCheck)).toBe(true); expect(f.listeners.size).toBe(1)
    f.admission.dispose(); f.admission.dispose(); expect(f.listeners.size).toBe(0)
    expect(f.sender.eventNames()).toEqual([]); expect(f.window.eventNames()).toEqual([])
  })
  it('removes lifecycle hooks on registration failure and does not leak an apparently ready factory', () => {
    const f = fixture(); f.admission.dispose()
    const on = f.sender.on.bind(f.sender), remove = vi.spyOn(f.sender, 'removeListener')
    vi.spyOn(f.sender, 'on').mockImplementation((event, listener) => { on(event, listener); if (event === 'did-navigate') throw new Error('fixture lifecycle install failed'); return f.sender })
    const admission = createStartupStorageReadAdmission(f.options); admissions.push(admission)
    expect(admission.begin({}, f.invocation())).toBeNull(); expect(remove).toHaveBeenCalled()
    expect(f.sender.eventNames()).toEqual([]); expect(f.window.eventNames()).toEqual([])
  })
})
