import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcInvocationContext } from '@shared/api/createServer/ipcInvocationOrigin'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import {
  completeManagementReadLease,
  createManagementReadAdmission,
  INSTALLED_CATALOG_READ_METHOD,
  type ManagementReadAdmission,
  type ManagementReadLease,
  type ManagementReadState,
  type ManagementReadTerminalCheck,
  type ManagementReadWindow
} from './managementReadAdmission'
import {
  authorizeMagicAgentTrustedRoute,
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from './trustedRouteBinding'
import { MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE } from '@shared/magicAgent'

const base = 'file:///app/index.html', url = base + '#/agent-management'
const requireLease = (value: ManagementReadLease | null): ManagementReadLease => {
  expect(value).not.toBeNull()
  if (!value) throw new Error('Expected admitted management read')
  return value
}
const allAdmissions: ManagementReadAdmission[] = []
class Sender extends EventEmitter {
  readonly id = 42
  destroyed = false
  url = url
  mainFrame = { url, parent: null as unknown, detached: false }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
}
function fixture() {
  const sender = new Sender(), window = Object.assign(new EventEmitter(), { webContents: sender, destroyed: false, isDestroyed() { return this.destroyed } })
  let mainWindow: ManagementReadWindow | null = window, state: ManagementReadState = 'ready', clock = 0
  const configListeners = new Set<() => void>()
  const getReadState = vi.fn(() => state), getMainWindow = vi.fn(() => mainWindow)
  const options = { window, trustedRendererUrl: base, getMainWindow, getReadState, timeoutMs: 100, now: () => clock,
    onConfigCommitted(listener: () => void) { configListeners.add(listener); return () => { configListeners.delete(listener) } } }
  const admission = createManagementReadAdmission(options); allAdmissions.push(admission)
  const invocation = (method = INSTALLED_CATALOG_READ_METHOD): ServiceInvocationContext => createIpcInvocationContext(method, { sender, senderFrame: sender.mainFrame })
  const navigate = (next = base + '#/settings') => {
    sender.url = next; sender.mainFrame.url = next
    sender.emit('did-navigate-in-page', {}, next, true, 1, 2)
  }
  const senderEvents = sender.eventNames(), windowEvents = window.eventNames()
  return { sender, window, options, admission, invocation, configListeners, navigate, getReadState, getMainWindow, senderEvents, windowEvents,
    setMainWindow(next: ManagementReadWindow | null) { mainWindow = next }, setState(next: ManagementReadState) { state = next },
    setClock(next: number) { clock = next }, commitConfig() { for (const listener of [...configListeners]) listener() } }
}
beforeEach(() => { vi.useFakeTimers(); clearMagicAgentTrustedRouteBindingsForTest() })
afterEach(() => {
  for (const admission of allAdmissions.splice(0)) admission.dispose()
  clearMagicAgentTrustedRouteBindingsForTest(); vi.useRealTimers()
})

describe('independent MAIN exact-management read admission, no endpoint or catalog IO wired', () => {
  it('admits only an exact transport-origin request and synchronously installs a revocable bounded lease', () => {
    const f = fixture(), baseline = f.sender.eventNames().length
    const lease = requireLease(f.admission.begin({}, f.invocation()))
    expect(lease.isCurrent()).toBe(true); expect(lease.signal.aborted).toBe(false)
    expect(f.configListeners.size).toBe(1)
    expect(f.sender.eventNames().length).toBe(baseline)
    expect(f.sender.listenerCount('did-start-navigation')).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(Object.isFrozen(lease)).toBe(true)
    lease.close(); lease.close()
    expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true)
    expect(f.sender.eventNames()).toEqual(f.senderEvents); expect(f.window.eventNames()).toEqual(f.windowEvents)
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['/settings', '/canvas?id=p1', '/agent-studio', '/agent-management/child', '/agent-management/', '/agent-management?tab=sessions', '/agent-management?', '/agent-management#again', '/%61gent-management'])('denies wrong/noncanonical route %s before a read lease is installed', route => {
    const f = fixture(); f.navigate(base + '#' + route)
    expect(f.admission.begin({}, f.invocation())).toBeNull()
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['http://untrusted/index.html', 'file:///other/index.html', 'file://other-host/app/index.html', base + '?outer=1'])('denies mismatched renderer base %s', otherBase => {
    const f = fixture(); f.navigate(otherBase + '#/agent-management')
    expect(f.admission.begin({}, f.invocation())).toBeNull()
  })

  it.each(['getStatus', 'listPackages', 'listAgents', 'setEnabled', 'installPackage', 'readInstalledCatalog.child'])('does not widen the method allowlist to %s', method => {
    const f = fixture()
    expect(f.admission.begin({}, f.invocation('svcMagicAgentPlatform.' + method))).toBeNull()
  })

  it.each([null, undefined, [], 'read', { path: '/tmp' }, { actor: { kind: 'user' } }, { enabled: true }, { route: '/agent-management' }, { policy: 'allow' }, { unused: undefined }])('denies nonempty or non-object payload %#', payload => {
    const f = fixture(); expect(f.admission.begin(payload, f.invocation())).toBeNull()
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects exotic/accessor payloads without executing accessors', () => {
    const f = fixture(), getter = vi.fn(() => { throw new Error('must not execute') })
    for (const payload of [Object.create({ route: '/agent-management' }), Object.defineProperty({}, 'hidden', { get: getter }), { [Symbol('claim')]: true }]) {
      expect(f.admission.begin(payload, f.invocation())).toBeNull()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['absent', 'copy', 'json', 'otherSender', 'otherFrame', 'subframe', 'detached', 'senderUrl', 'frameUrl'] as const)('denies %s identity even when visible fields look like the main management renderer', kind => {
    const f = fixture(), original = f.invocation()
    let invocation: ServiceInvocationContext | undefined = original
    if (kind === 'absent') invocation = undefined
    if (kind === 'copy') invocation = { ...original }
    if (kind === 'json') invocation = JSON.parse(JSON.stringify(original))
    if (kind === 'otherSender') invocation = createIpcInvocationContext(INSTALLED_CATALOG_READ_METHOD, { sender: new Sender(), senderFrame: f.sender.mainFrame })
    if (kind === 'otherFrame') invocation = createIpcInvocationContext(INSTALLED_CATALOG_READ_METHOD, { sender: f.sender, senderFrame: { ...f.sender.mainFrame } })
    if (kind === 'subframe') { f.sender.mainFrame.parent = {}; invocation = f.invocation() }
    if (kind === 'detached') f.sender.mainFrame.detached = true
    if (kind === 'senderUrl') f.sender.url = base + '#/settings'
    if (kind === 'frameUrl') f.sender.mainFrame.url = base + '#/settings'
    expect(f.admission.begin({}, invocation)).toBeNull()
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['nullWindow', 'otherWindow', 'windowDestroyed', 'senderDestroyed', 'disabled', 'unavailable'] as const)('denies %s before IO/lease setup', kind => {
    const f = fixture()
    if (kind === 'nullWindow') f.setMainWindow(null)
    if (kind === 'otherWindow') f.setMainWindow({ ...f.window, isDestroyed: () => false, webContents: f.sender, on: () => undefined, removeListener: () => undefined })
    if (kind === 'windowDestroyed') f.window.destroyed = true
    if (kind === 'senderDestroyed') f.sender.destroyed = true
    if (kind === 'disabled' || kind === 'unavailable') f.setState(kind)
    expect(f.admission.begin({}, f.invocation())).toBeNull()
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('revokes synchronously on hash departure so leave-and-return cannot revive an outstanding result', async () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    let resolve!: (value: string) => void
    const pending = new Promise<string>(done => { resolve = done })
    const publish = vi.fn()
    const completed = pending.then(value => { if (lease.isCurrent()) publish(value) })
    f.navigate(); expect(lease.signal.aborted).toBe(true)
    f.navigate(url); resolve('stale catalog'); await completed
    expect(publish).not.toHaveBeenCalled(); expect(lease.isCurrent()).toBe(false)
    const next = requireLease(f.admission.begin({}, f.invocation())); expect(next.isCurrent()).toBe(true)
    expect(f.configListeners.size).toBe(1); next.close()
  })

  it.each(['modernReload', 'legacyReload', 'modernSameDocument', 'legacySameDocument', 'processGone', 'destroyed', 'windowClosed'] as const)('revokes on %s and cleans all per-read listeners', kind => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    if (kind === 'modernReload') f.sender.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    if (kind === 'legacyReload') f.sender.emit('did-start-navigation', {}, url, false, true)
    if (kind === 'modernSameDocument') f.sender.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: true })
    if (kind === 'legacySameDocument') f.sender.emit('did-start-navigation', {}, url, true, true)
    if (kind === 'processGone') f.sender.emit('render-process-gone', {}, { reason: 'crashed' })
    if (kind === 'destroyed') f.sender.emit('destroyed')
    if (kind === 'windowClosed') f.window.emit('closed')
    expect(lease.signal.aborted).toBe(true); expect(lease.isCurrent()).toBe(false)
    expect(f.configListeners.size).toBe(0)
    if (kind === 'destroyed' || kind === 'windowClosed') {
      expect(f.sender.eventNames()).toEqual([]); expect(f.window.eventNames()).toEqual([])
    } else {
      expect(f.sender.eventNames()).toEqual(f.senderEvents); expect(f.window.eventNames()).toEqual(f.windowEvents)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores subframe navigation but never treats a pending reload as continued authority', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    f.sender.emit('did-start-navigation', { url: 'about:blank', isMainFrame: false, isSameDocument: false })
    f.sender.emit('did-navigate-in-page', {}, 'about:blank', false)
    expect(lease.isCurrent()).toBe(true)
    f.sender.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    expect(lease.isCurrent()).toBe(false)
  })

  it('config disable then re-enable never revives the old read, even if both occur before its await returns', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    f.setState('disabled'); f.commitConfig(); f.setState('ready'); f.commitConfig()
    expect(lease.signal.aborted).toBe(true); expect(lease.isCurrent()).toBe(false)
    expect(requireLease(f.admission.begin({}, f.invocation())).isCurrent()).toBe(true)
  })

  it.each(['state', 'window', 'frame', 'url'] as const)('fresh %s failure is latched so silent changes cannot revive a checked read', kind => {
    const f = fixture(), originalFrame = f.sender.mainFrame, lease = requireLease(f.admission.begin({}, f.invocation()))
    if (kind === 'state') f.setState('disabled')
    if (kind === 'window') f.setMainWindow(null)
    if (kind === 'frame') f.sender.mainFrame = { ...originalFrame }
    if (kind === 'url') f.sender.url = base + '#/settings'
    expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true)
    f.setState('ready'); f.setMainWindow(f.window); f.sender.mainFrame = originalFrame; f.sender.url = url
    expect(lease.isCurrent()).toBe(false)
  })

  it.each(['timer', 'clock'] as const)('expires by %s and suppresses a late result without restarting the read', kind => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    if (kind === 'timer') vi.advanceTimersByTime(101)
    else f.setClock(101)
    expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true)
    f.setClock(0); expect(lease.isCurrent()).toBe(false)
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('supersedes an old per-window read without allowing its close or invalidate cleanup to release a new lease', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    const next = requireLease(f.admission.begin({}, f.invocation()))
    expect(old.signal.aborted).toBe(true); old.close(); expect(next.isCurrent()).toBe(true)
    expect(f.configListeners.size).toBe(1)
    f.admission.invalidate(); expect(next.isCurrent()).toBe(false)
    const last = requireLease(f.admission.begin({}, f.invocation())); expect(last.isCurrent()).toBe(true)
    old.close(); next.close(); expect(last.isCurrent()).toBe(true)
  })

  it('replacement admission revokes old reads and old disposal cannot revoke the replacement', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    const replacement = createManagementReadAdmission(f.options); allAdmissions.push(replacement)
    expect(old.isCurrent()).toBe(false); expect(f.admission.begin({}, f.invocation())).toBeNull()
    const next = requireLease(replacement.begin({}, f.invocation())); f.admission.dispose()
    expect(next.isCurrent()).toBe(true)
    replacement.dispose(); expect(next.signal.aborted).toBe(true)
    expect(replacement.begin({}, f.invocation())).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })

  it('an invalid new request does not cancel a valid pending read', () => {
    const f = fixture(), current = requireLease(f.admission.begin({}, f.invocation()))
    expect(f.admission.begin({ actor: 'forged' }, f.invocation())).toBeNull()
    expect(current.isCurrent()).toBe(true); expect(current.signal.aborted).toBe(false)
  })

  it('supersession abort callback can start a newer read without being overwritten by the old begin', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    let newer: ManagementReadLease | null = null
    old.signal.addEventListener('abort', () => { newer = f.admission.begin({}, f.invocation()) }, { once: true })
    expect(f.admission.begin({}, f.invocation())).toBeNull()
    const current = requireLease(newer); expect(current.isCurrent()).toBe(true)
    old.close(); expect(current.isCurrent()).toBe(true); expect(f.configListeners.size).toBe(1)
  })

  it('invalidation removes old authority before abort callback and does not erase a reentrant read', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    let newer: ManagementReadLease | null = null
    old.signal.addEventListener('abort', () => { newer = f.admission.begin({}, f.invocation()) }, { once: true })
    f.admission.invalidate()
    const current = requireLease(newer); expect(current.isCurrent()).toBe(true)
    old.close(); expect(current.isCurrent()).toBe(true); expect(f.configListeners.size).toBe(1)
  })

  it('replacement cannot overwrite another admission created synchronously by the old read abort callback', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    let newer: ManagementReadLease | null = null
    old.signal.addEventListener('abort', () => {
      const newest = createManagementReadAdmission(f.options); allAdmissions.push(newest)
      newer = newest.begin({}, f.invocation())
    }, { once: true })
    const outerReplacement = createManagementReadAdmission(f.options); allAdmissions.push(outerReplacement)
    expect(outerReplacement.begin({}, f.invocation())).toBeNull()
    const current = requireLease(newer); expect(current.isCurrent()).toBe(true)
    f.admission.dispose(); outerReplacement.dispose(); expect(current.isCurrent()).toBe(true)
  })

  it('fences a state getter reentry before a stale begin installs any read authority', () => {
    const f = fixture(); let newer: ManagementReadLease | null = null
    f.getReadState.mockImplementationOnce(() => { newer = f.admission.begin({}, f.invocation()); return 'ready' })
    expect(f.admission.begin({}, f.invocation())).toBeNull()
    expect(requireLease(newer).isCurrent()).toBe(true); expect(f.configListeners.size).toBe(1)
  })

  it('handles synchronous config-subscription invalidation and still unsubscribes the returned listener', () => {
    const f = fixture(), unsubscribe = vi.fn()
    const admission = createManagementReadAdmission({ ...f.options, onConfigCommitted(listener) { listener(); return unsubscribe } }); allAdmissions.push(admission)
    expect(admission.begin({}, f.invocation())).toBeNull()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(f.sender.eventNames()).toEqual(f.senderEvents); expect(f.window.eventNames()).toEqual(f.windowEvents)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes a lifecycle hook installed after newListener synchronously creates a newer admission', () => {
    const f = fixture(); let entered = false, newest: ManagementReadAdmission | null = null
    const replaceDuringAdd = (name: string | symbol) => {
      if (name !== 'did-start-navigation' || entered) return
      entered = true; newest = createManagementReadAdmission(f.options); allAdmissions.push(newest)
    }
    f.sender.on('newListener', replaceDuringAdd)
    const stale = createManagementReadAdmission(f.options); allAdmissions.push(stale)
    expect(stale.begin({}, f.invocation())).toBeNull()
    expect(requireLease(newest!.begin({}, f.invocation())).isCurrent()).toBe(true)
    expect(f.sender.listenerCount('did-start-navigation')).toBe(1)
    expect(f.configListeners.size).toBe(1); expect(vi.getTimerCount()).toBe(1)
    f.sender.removeListener('newListener', replaceDuringAdd)
  })

  it.each(['not a URL', base + '?', base + '?q=1', base + '#', url, 'javascript:alert(1)'])('rejects invalid or query/hash-bearing trusted renderer configuration %s', trustedRendererUrl => {
    const f = fixture(), admission = createManagementReadAdmission({ ...f.options, trustedRendererUrl }); allAdmissions.push(admission)
    expect(admission.begin({}, f.invocation())).toBeNull()
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a bare outer query and a request captured outside management even after live URLs agree', () => {
    const f = fixture(); f.navigate(base + '?#/agent-management')
    expect(f.admission.begin({}, f.invocation())).toBeNull()
    f.navigate(); const previous = f.invocation(); f.navigate(url)
    expect(f.admission.begin({}, previous)).toBeNull()
    expect(requireLease(f.admission.begin({}, f.invocation())).isCurrent()).toBe(true)
  })

  it.each(['modern', 'legacy', 'inPage'] as const)('blocks abort-callback read revival while %s navigation still exposes the old exact management URL', kind => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    let attempted = false, reentrant: ManagementReadLease | null = null
    old.signal.addEventListener('abort', () => {
      attempted = true; expect(old.isCurrent()).toBe(false)
      reentrant = f.admission.begin({}, f.invocation())
    }, { once: true })
    if (kind === 'modern') f.sender.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    if (kind === 'legacy') f.sender.emit('did-start-navigation', {}, url, false, true)
    if (kind === 'inPage') f.sender.emit('did-navigate-in-page', {}, url, true)
    expect(attempted).toBe(true); expect(reentrant).toBeNull(); expect(old.isCurrent()).toBe(false)
    if (kind !== 'inPage') {
      expect(f.admission.begin({}, f.invocation())).toBeNull()
      f.sender.emit('did-navigate', {}, url)
    }
    expect(requireLease(f.admission.begin({}, f.invocation())).isCurrent()).toBe(true)
  })

  it('unwinds earlier lifecycle hooks if a later registration throws after adding its listener', () => {
    const f = fixture(), originalOn = f.sender.on.bind(f.sender)
    vi.spyOn(f.sender, 'on').mockImplementation((name, listener) => {
      const result = originalOn(name, listener)
      if (name === 'did-navigate-in-page') throw new Error('registration failed')
      return result
    })
    const admission = createManagementReadAdmission(f.options); allAdmissions.push(admission)
    expect(admission.begin({}, f.invocation())).toBeNull()
    expect(f.sender.eventNames()).toEqual([]); expect(f.window.eventNames()).toEqual([])
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    vi.restoreAllMocks()
  })

  it.each(['dispose', 'replace', 'throw'] as const)('does not continue read setup after synchronous subscription %s', kind => {
    const f = fixture(), unsubscribe = vi.fn(); let replacement: ManagementReadAdmission | null = null
    const admission = createManagementReadAdmission({ ...f.options, onConfigCommitted() {
      if (kind === 'dispose') admission.dispose()
      if (kind === 'replace') { replacement = createManagementReadAdmission(f.options); allAdmissions.push(replacement) }
      if (kind === 'throw') throw new Error('subscription unavailable')
      return unsubscribe
    } }); allAdmissions.push(admission)
    expect(admission.begin({}, f.invocation())).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    if (kind !== 'throw') expect(unsubscribe).toHaveBeenCalledOnce()
    if (kind === 'replace') expect(requireLease(replacement!.begin({}, f.invocation())).isCurrent()).toBe(true)
    admission.dispose()
  })

  it.each(['dispose', 'invalidate'] as const)('old abort callbacks can %s without seeing old authority or corrupting cleanup', kind => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    old.signal.addEventListener('abort', () => {
      expect(old.isCurrent()).toBe(false); expect(f.configListeners.size).toBe(0)
      if (kind === 'dispose') f.admission.dispose(); else f.admission.invalidate()
    }, { once: true })
    expect(f.admission.begin({}, f.invocation())).toBeNull()
    expect(old.isCurrent()).toBe(false); expect(vi.getTimerCount()).toBe(0)
    if (kind === 'invalidate') expect(requireLease(f.admission.begin({}, f.invocation())).isCurrent()).toBe(true)
    else expect(f.admission.begin({}, f.invocation())).toBeNull()
  })

  it.each(['modern', 'legacy', 'inPage', 'processGone'] as const)('same-window replacement preserves the %s fence during abort callback and any unfinished navigation', kind => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    let replacement: ManagementReadAdmission | null = null, callbackLease: ManagementReadLease | null = null
    old.signal.addEventListener('abort', () => {
      replacement = createManagementReadAdmission(f.options); allAdmissions.push(replacement)
      callbackLease = replacement.begin({}, f.invocation())
    }, { once: true })
    if (kind === 'modern') f.sender.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    if (kind === 'legacy') f.sender.emit('did-start-navigation', {}, url, false, true)
    if (kind === 'inPage') f.sender.emit('did-navigate-in-page', {}, url, true)
    if (kind === 'processGone') f.sender.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(callbackLease).toBeNull(); expect(old.signal.aborted).toBe(true)
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    const next = createManagementReadAdmission(f.options); allAdmissions.push(next)
    replacement!.dispose()
    if (kind !== 'inPage') {
      expect(next.begin({}, f.invocation())).toBeNull()
      f.sender.emit('did-navigate', {}, url)
    }
    expect(requireLease(next.begin({}, f.invocation())).isCurrent()).toBe(true)
    expect(f.sender.listenerCount('did-start-navigation')).toBe(1)
  })

  it('same-window replacement between navigation start and commit cannot clear the pending interval', () => {
    const f = fixture(), old = requireLease(f.admission.begin({}, f.invocation()))
    f.sender.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    const replacement = createManagementReadAdmission(f.options); allAdmissions.push(replacement)
    expect(old.isCurrent()).toBe(false); expect(replacement.begin({}, f.invocation())).toBeNull()
    f.sender.emit('did-navigate', {}, url)
    expect(requireLease(replacement.begin({}, f.invocation())).isCurrent()).toBe(true)
  })

  it.each(['disabled', 'throw'] as const)('latches observed %s freshness failure despite sequence-only denied-method reentry', result => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    const deniedInvocation = f.invocation('svcMagicAgentPlatform.setEnabled')
    f.getReadState.mockImplementationOnce(() => {
      expect(f.admission.begin({}, deniedInvocation)).toBeNull()
      if (result === 'throw') throw new Error('cached state unavailable')
      return 'disabled'
    })
    expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true)
    expect(lease.isCurrent()).toBe(false); expect(f.configListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('latches observed expired clock despite sequence-only denied-method reentry without firing timers', () => {
    const f = fixture(), clock = vi.fn(() => 0)
    const admission = createManagementReadAdmission({ ...f.options, now: clock }); allAdmissions.push(admission)
    const lease = requireLease(admission.begin({}, f.invocation())), deniedInvocation = f.invocation('svcMagicAgentPlatform.setEnabled')
    clock.mockImplementationOnce(() => { expect(admission.begin({}, deniedInvocation)).toBeNull(); return 101 })
    clock.mockReturnValueOnce(101)
    expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true)
    clock.mockReturnValue(0)
    expect(lease.isCurrent()).toBe(false); expect(f.configListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('terminal completion is once-only, cleans before final predicates and permits its own intentional abort', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), abort = vi.fn()
    lease.signal.addEventListener('abort', abort, { once: true })
    const check = vi.fn(() => { expect(lease.isCurrent()).toBe(false); expect(lease.signal.aborted).toBe(true); expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0); return true })
    expect(completeManagementReadLease(lease, check)).toBe(true)
    expect(check).toHaveBeenCalledOnce(); expect(abort).toHaveBeenCalledOnce()
    expect(completeManagementReadLease(lease, check)).toBe(false); expect(check).toHaveBeenCalledOnce()
    const next = requireLease(f.admission.begin({}, f.invocation())); lease.close(); expect(next.isCurrent()).toBe(true)
  })

  it.each(['copied', 'fake', 'closed'] as const)('terminal completion rejects %s lease without running final predicates', kind => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), check = vi.fn(() => true)
    if (kind === 'closed') lease.close()
    const candidate = kind === 'copied' ? { ...lease } : kind === 'fake' ? { signal: new AbortController().signal, close: vi.fn(), isCurrent: () => true } : lease
    expect(completeManagementReadLease(candidate, check)).toBe(false); expect(check).not.toHaveBeenCalled()
    if (kind !== 'closed') expect(lease.isCurrent()).toBe(true)
  })

  it.each(['false', 'throw', 'promise'] as const)('terminal completion fails closed for final predicate %s and does not retain resources', kind => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    const check = vi.fn(() => { if (kind === 'throw') throw new Error('PRIVATE'); return kind === 'promise' ? Promise.resolve(true) as unknown as boolean : false })
    expect(completeManagementReadLease(lease, check)).toBe(false); expect(check).toHaveBeenCalledOnce()
    expect(lease.signal.aborted).toBe(true); expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    expect(completeManagementReadLease(lease, () => true)).toBe(false)
  })

  it.each(['invalidate', 'throw'] as const)('terminal cleanup %s prevents publication even while all fresh identity fields remain ready', kind => {
    const f = fixture()
    const admission = createManagementReadAdmission({ ...f.options, onConfigCommitted(listener) {
      f.configListeners.add(listener)
      return () => { f.configListeners.delete(listener); if (kind === 'throw') throw new Error('cleanup failed'); admission.invalidate() }
    } }); allAdmissions.push(admission)
    const lease = requireLease(admission.begin({}, f.invocation()))
    expect(completeManagementReadLease(lease, () => true)).toBe(false)
    expect(lease.signal.aborted).toBe(true); expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('terminal abort-callback successor remains current while the old publication is rejected', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())); let successor: ManagementReadLease | null = null
    lease.signal.addEventListener('abort', () => { successor = f.admission.begin({}, f.invocation()) }, { once: true })
    expect(completeManagementReadLease(lease, () => true)).toBe(false)
    const current = requireLease(successor); expect(current.isCurrent()).toBe(true)
    lease.close(); expect(completeManagementReadLease(lease, () => true)).toBe(false); expect(current.isCurrent()).toBe(true)
  })

  it.each(['invalidate', 'replacement', 'successor', 'denied-reentry', 'disabled', 'departure', 'expired'] as const)('terminal final predicate %s cannot revive publication with a true return', kind => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())); let successor: ManagementReadLease | null = null
    const check = () => {
      if (kind === 'invalidate') f.admission.invalidate()
      if (kind === 'replacement') { const admission = createManagementReadAdmission(f.options); allAdmissions.push(admission); successor = admission.begin({}, f.invocation()) }
      if (kind === 'successor') successor = f.admission.begin({}, f.invocation())
      if (kind === 'denied-reentry') expect(f.admission.begin({}, f.invocation('svcMagicAgentPlatform.setEnabled'))).toBeNull()
      if (kind === 'disabled') f.setState('disabled')
      if (kind === 'departure') f.navigate()
      if (kind === 'expired') f.setClock(101)
      return true
    }
    expect(completeManagementReadLease(lease, check)).toBe(false); expect(lease.signal.aborted).toBe(true)
    if (kind === 'replacement' || kind === 'successor') { const current = requireLease(successor); expect(current.isCurrent()).toBe(true); lease.close(); expect(current.isCurrent()).toBe(true) }
  })

  it.each(['state', 'clock'] as const)('terminal final %s getter reentry is fenced after every callback, not just before it', kind => {
    const f = fixture(), clock = vi.fn(() => 0), admission = createManagementReadAdmission({ ...f.options, now: clock }); allAdmissions.push(admission)
    const lease = requireLease(admission.begin({}, f.invocation()))
    const check = () => {
      if (kind === 'state') f.getReadState.mockImplementationOnce(() => { admission.invalidate(); return 'ready' })
      else clock.mockImplementationOnce(() => { admission.invalidate(); return 0 })
      return true
    }
    expect(completeManagementReadLease(lease, check)).toBe(false)
    expect(lease.signal.aborted).toBe(true); expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('terminal completion cannot recursively reuse its own authority from abort or final predicate callbacks', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), nested = vi.fn(() => true)
    lease.signal.addEventListener('abort', () => { expect(completeManagementReadLease(lease, nested)).toBe(false) }, { once: true })
    expect(completeManagementReadLease(lease, () => { expect(completeManagementReadLease(lease, nested)).toBe(false); return true })).toBe(true)
    expect(nested).not.toHaveBeenCalled()
  })

  it.each((['cleanup', 'abort', 'final'] as const).flatMap(stage => (['payload', 'missing', 'copied'] as const).map(kind => ({ stage, kind }))))('terminal $stage callback preflight-denied $kind reentry fences the old completion', ({ stage, kind }) => {
    const f = fixture()
    const denied = () => {
      const invocation = f.invocation(), input = kind === 'payload' ? { unexpected: true } : {}
      expect(admission.begin(input, kind === 'missing' ? undefined : kind === 'copied' ? { ...invocation } : invocation)).toBeNull()
    }
    const admission = createManagementReadAdmission({ ...f.options, onConfigCommitted(listener) {
      f.configListeners.add(listener)
      return () => { f.configListeners.delete(listener); if (stage === 'cleanup') denied() }
    } }); allAdmissions.push(admission)
    const lease = requireLease(admission.begin({}, f.invocation()))
    if (stage === 'abort') lease.signal.addEventListener('abort', denied, { once: true })
    expect(completeManagementReadLease(lease, () => { if (stage === 'final') denied(); return true })).toBe(false)
    expect(lease.signal.aborted).toBe(true); expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('preflight-denied reentry during terminal abort cannot cancel a callback-created successor', () => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())); let successor: ManagementReadLease | null = null
    lease.signal.addEventListener('abort', () => {
      successor = f.admission.begin({}, f.invocation())
      expect(f.admission.begin({ unexpected: true }, f.invocation())).toBeNull()
    }, { once: true })
    expect(completeManagementReadLease(lease, () => true)).toBe(false)
    const current = requireLease(successor); expect(current.isCurrent()).toBe(true)
    lease.close(); expect(current.isCurrent()).toBe(true)
  })

  it.each(['proxy', 'accessor-deadline', 'accessor-floor', 'extra', 'symbol', 'missing', 'prototype', 'array', 'nan-deadline', 'infinite-floor', 'negative-floor', 'equal-bounds', 'reversed-bounds', 'wider-deadline', 'wrong-type'] as const)('object-form terminal constraints reject %s without running getters or proxy traps', kind => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation())), getter = vi.fn(() => 50), trap = vi.fn()
    let value: unknown = { deadline: 50, minimumTime: 0 }
    if (kind === 'proxy') value = new Proxy(value as object, { getPrototypeOf() { trap(); return Object.prototype }, ownKeys() { trap(); return ['deadline', 'minimumTime'] } })
    if (kind === 'accessor-deadline') value = { get deadline() { return getter() }, minimumTime: 0 }
    if (kind === 'accessor-floor') value = { deadline: 50, get minimumTime() { return getter() } }
    if (kind === 'extra') value = { deadline: 50, minimumTime: 0, unexpected: true }
    if (kind === 'symbol') value = { deadline: 50, minimumTime: 0, [Symbol('claim')]: true }
    if (kind === 'missing') value = { deadline: 50 }
    if (kind === 'prototype') value = Object.assign(Object.create({ inherited: true }), { deadline: 50, minimumTime: 0 })
    if (kind === 'array') value = [50, 0]
    if (kind === 'nan-deadline') value = { deadline: Number.NaN, minimumTime: 0 }
    if (kind === 'infinite-floor') value = { deadline: 50, minimumTime: Number.POSITIVE_INFINITY }
    if (kind === 'negative-floor') value = { deadline: 50, minimumTime: -1 }
    if (kind === 'equal-bounds') value = { deadline: 50, minimumTime: 50 }
    if (kind === 'reversed-bounds') value = { deadline: 50, minimumTime: 51 }
    if (kind === 'wider-deadline') value = { deadline: 101, minimumTime: 0 }
    if (kind === 'wrong-type') value = { deadline: '50', minimumTime: 0 }
    expect(completeManagementReadLease(lease, () => value as ManagementReadTerminalCheck)).toBe(false)
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled(); expect(lease.signal.aborted).toBe(true)
    expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
    expect(completeManagementReadLease(lease, () => true)).toBe(false)
  })

  it.each([9, 10, 49, 50])('object-form terminal constraints enforce inclusive floor and exclusive deadline at final time %s', time => {
    const f = fixture(), lease = requireLease(f.admission.begin({}, f.invocation()))
    f.setClock(time)
    expect(completeManagementReadLease(lease, () => Object.freeze({ deadline: 50, minimumTime: 10 }))).toBe(time >= 10 && time < 50)
    expect(lease.signal.aborted).toBe(true); expect(f.configListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('management registration never overwrites or expands the existing Chat/Studio route binding', () => {
    const f = fixture()
    registerMagicAgentTrustedRouteBinding(42, undefined, { trustedUrl: base, trustedWebContents: f.sender })
    const studio = { methodName: 'svcMagicAgentPlatform.listPackages', senderId: 42, senderUrl: base + '#/agent-studio', frameUrl: base + '#/agent-studio', isMainFrame: true }
    expect(() => authorizeMagicAgentTrustedRoute(MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE, studio)).not.toThrow()
    const lease = requireLease(f.admission.begin({}, f.invocation()))
    expect(() => authorizeMagicAgentTrustedRoute(MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE, f.invocation())).toThrow()
    expect(() => authorizeMagicAgentTrustedRoute(MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE, studio)).not.toThrow()
    lease.close(); f.admission.dispose()
    expect(() => authorizeMagicAgentTrustedRoute(MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE, studio)).not.toThrow()
  })
})
