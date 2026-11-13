import { isProxy } from 'node:util/types'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getIpcInvocationOrigin } from '@shared/api/createServer/ipcInvocationOrigin'
import type { StartupStorageCapture } from '../config/startupStorageSnapshot'

export const STARTUP_STORAGE_READ_METHOD = 'svcState.readStartupStorageMetadata'
export type StartupStorageReadState = 'ready' | 'disabled' | 'unavailable'
export type StartupStorageReadEmitter = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}
export type StartupStorageReadFrame = { readonly url: string; readonly parent: unknown; readonly detached: boolean }
export type StartupStorageReadSender = StartupStorageReadEmitter & {
  readonly id: number
  isDestroyed(): boolean
  getURL(): string
  readonly mainFrame: StartupStorageReadFrame
}
export type StartupStorageReadWindow = StartupStorageReadEmitter & {
  isDestroyed(): boolean
  readonly webContents: StartupStorageReadSender
}
export type StartupStorageReadLease = Readonly<{ signal: AbortSignal; isCurrent(): boolean; close(): void }>
export type StartupStorageReadAdmission = Readonly<{
  begin(payload: unknown, invocation?: ServiceInvocationContext): StartupStorageReadLease | null
  invalidate(): void
  dispose(): void
}>
export type StartupStorageReadAdmissionOptions = {
  window: StartupStorageReadWindow
  trustedRendererUrl: string
  getMainWindow(): StartupStorageReadWindow | null
  getReadState(): StartupStorageReadState
  onConfigCommitted(listener: () => void): () => void
  timeoutMs?: number
  now?: () => number
}
export type StartupStorageTerminalCheck = false | Readonly<{ deadline: number; minimumTime: number; storageCapture: StartupStorageCapture }>

type Completion = { phase: 'pending' | 'completing' | 'spent'; interfered: boolean; complete(check: () => StartupStorageTerminalCheck): boolean }
// Entirely separate authority domain from catalog, including its terminal map and window owners.
const completions = new WeakMap<StartupStorageReadLease, Completion>()
const admissions = new WeakMap<StartupStorageReadWindow, StartupStorageReadAdmission>()
const windowFences = new WeakMap<StartupStorageReadWindow, { sender: StartupStorageReadSender; pending: boolean; depth: number; setupGeneration: number }>()
const safely = (cleanup: () => void): void => { try { cleanup() } catch { /* Already revoked. */ } }

export function completeStartupStorageReadLease(lease: StartupStorageReadLease, finalCheck: () => StartupStorageTerminalCheck): boolean {
  const completion = completions.get(lease)
  if (!completion) return false
  if (completion.phase !== 'pending') { completion.interfered = true; return false }
  completion.phase = 'completing' // Consume before cleanup/abort/predicates can reenter.
  try { return completion.complete(finalCheck) && !completion.interfered } catch { return false }
  finally { completion.phase = 'spent' }
}
function emptyPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || isProxy(value)) return false
  try { return [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === 0 } catch { return false }
}
function exactManagementUrl(base: string): string | null {
  try {
    if (typeof base !== 'string' || base.length > 8192 || base !== base.trim() || base.includes('?') || base.includes('#')) return null
    const parsed = new URL(base)
    return ['file:', 'http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.href === base ? base + '#/agent-management' : null
  } catch { return null }
}
function ownData(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
  const keys = Reflect.ownKeys(value), output: Record<string, unknown> = {}
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) return null
    output[key] = descriptor.value
  }
  return output
}
type Read = {
  controller: AbortController
  invocation: ServiceInvocationContext
  sequence: number
  deadline: number
  minimumTime: number
  closed: boolean
  cleanupFailed: boolean
  cleanups: Array<() => void>
}

/** MAIN identity/lifetime only. No reader, configuration initializer, endpoint or UI registration. */
export function createStartupStorageReadAdmission(options: StartupStorageReadAdmissionOptions): StartupStorageReadAdmission {
  const { window, trustedRendererUrl, getMainWindow, getReadState, onConfigCommitted } = options
  const sender = window.webContents, now = options.now ?? Date.now, timeout = options.timeoutMs ?? 2000
  const expectedUrl = exactManagementUrl(trustedRendererUrl)
  const fence = windowFences.get(window) ?? { sender, pending: false, depth: 0, setupGeneration: 0 }
  if (!windowFences.has(window)) windowFences.set(window, fence)
  let disposed = false, installed = false, sequence = 0, current: Read | undefined
  let configState: 'absent' | 'installing' | 'ready' | 'failed' = 'absent', configCleanup: (() => void) | undefined
  const lifecycleCleanups: Array<() => void> = []
  const owns = (): boolean => !disposed && admissions.get(window) === admission
  const available = (): boolean => owns() && installed && !fence.pending && fence.depth === 0
  const close = (read: Read | undefined): void => {
    if (!read || read.closed) return
    read.closed = true
    if (current === read) current = undefined
    for (const cleanup of read.cleanups.splice(0).reverse()) { try { cleanup() } catch { read.cleanupFailed = true } }
    try { read.controller.abort() } catch { read.cleanupFailed = true }
  }
  const invalidate = (): void => { sequence++; close(current) }
  const dispose = (): void => {
    if (disposed) return
    disposed = true; installed = false; sequence++
    if (admissions.get(window) === admission) admissions.delete(window)
    const unsubscribe = configCleanup; configCleanup = undefined; configState = 'failed'
    for (const cleanup of lifecycleCleanups.splice(0).reverse()) safely(cleanup)
    if (unsubscribe) safely(unsubscribe)
    close(current)
  }
  const duringEvent = (action: () => void): void => {
    if (!owns()) return
    fence.depth++
    try { action() } finally { fence.depth-- }
  }
  // Lazy admission-lifetime observation survives work-lease cleanup and terminal callbacks.
  // A commit changes sequence even when current is empty; ABA readiness cannot revive a read.
  const ensureConfigObserver = (stillOwns: () => boolean): boolean => {
    if (configState === 'ready') return stillOwns()
    if (configState !== 'absent') return false
    configState = 'installing'
    try {
      const unsubscribe = onConfigCommitted(() => duringEvent(invalidate))
      if (typeof unsubscribe !== 'function') { configState = 'failed'; return false }
      if (!stillOwns()) { configState = 'failed'; safely(unsubscribe); return false }
      configCleanup = unsubscribe; configState = 'ready'
      return true
    } catch { configState = 'failed'; return false }
  }
  const fresh = (invocation: ServiceInvocationContext): boolean => {
    try {
      const origin = getIpcInvocationOrigin(invocation), frame = sender.mainFrame
      return invocation.methodName === STARTUP_STORAGE_READ_METHOD &&
        Number.isSafeInteger(sender.id) && sender.id >= 0 && invocation.senderId === sender.id &&
        invocation.isMainFrame === true && origin?.sender === sender && origin.frame === frame &&
        frame.parent === null && frame.detached === false &&
        !window.isDestroyed() && !sender.isDestroyed() && window.webContents === sender &&
        getMainWindow() === window && getReadState() === 'ready' &&
        sender.getURL() === expectedUrl && frame.url === expectedUrl &&
        invocation.senderUrl === expectedUrl && invocation.frameUrl === expectedUrl
    } catch { return false }
  }
  const live = (read: Read): boolean => {
    if (read.closed || current !== read) return false
    let valid = false
    try {
      if (available() && sequence === read.sequence && fresh(read.invocation)) {
        const time = now()
        valid = Number.isFinite(time) && time >= read.minimumTime && time < read.deadline
        if (valid) read.minimumTime = time
      }
    } catch { /* Fail closed without diagnostics. */ }
    if (read.closed || current !== read) return false
    if (!valid || !available() || sequence !== read.sequence) { close(read); return false }
    return true
  }
  const admission: StartupStorageReadAdmission = Object.freeze({
    begin: (payload: unknown, invocation?: ServiceInvocationContext): StartupStorageReadLease | null => {
      const attempt = ++sequence
      if (!available() || !emptyPayload(payload) || !invocation || !getIpcInvocationOrigin(invocation)) return null
      const stillOwns = (): boolean => sequence === attempt && available()
      if (!fresh(invocation) || !stillOwns()) return null
      close(current)
      if (!stillOwns() || !fresh(invocation) || !stillOwns() || !ensureConfigObserver(stillOwns) || !stillOwns()) return null
      let started: number
      try { started = now() } catch { return null }
      if (!Number.isFinite(started) || started < 0 || !Number.isFinite(started + timeout) || started + timeout <= started || !stillOwns()) return null
      const read: Read = { controller: new AbortController(), invocation, sequence: attempt, deadline: started + timeout, minimumTime: started, closed: false, cleanupFailed: false, cleanups: [] }
      current = read
      const lease = Object.freeze({ signal: read.controller.signal, isCurrent: () => live(read), close: () => close(read) })
      completions.set(lease, { phase: 'pending', interfered: false, complete: finalCheck => {
        const terminalSequence = sequence
        // No live()/window/readiness/clock call before revocation: initial eligibility is private.
        const eligible = !read.closed && current === read && read.sequence === terminalSequence && available()
        close(read) // Detach work/timer and abort first; the admission config observer stays live.
        const terminalOwner = (): boolean => eligible && available() && sequence === terminalSequence && current === undefined && !read.cleanupFailed
        if (!terminalOwner()) return false
        try {
          if (typeof finalCheck !== 'function') return false
          const checked = ownData(finalCheck(), ['deadline', 'minimumTime', 'storageCapture'])
          if (!checked || typeof checked.deadline !== 'number' || typeof checked.minimumTime !== 'number' || !Number.isFinite(checked.deadline) || !Number.isFinite(checked.minimumTime) || checked.minimumTime < 0 || checked.deadline <= checked.minimumTime || checked.deadline > read.deadline) return false
          const capture = ownData(checked.storageCapture, ['snapshot', 'isCurrent'])
          if (!capture || !Object.isFrozen(checked.storageCapture) || typeof capture.isCurrent !== 'function' || isProxy(capture.isCurrent)) return false
          const captureIsCurrent = capture.isCurrent as () => boolean
          const minimumTime = Math.max(read.minimumTime, checked.minimumTime), deadline = checked.deadline
          if (!terminalOwner() || !fresh(read.invocation)) return false
          const time = now()
          // After all callbacks/cleanup/clock, only private memory checks and the trusted MAIN
          // startup owner's frozen identity predicate remain. No callback/await follows it.
          return Number.isFinite(time) && time >= minimumTime && time < deadline && terminalOwner() &&
            captureIsCurrent() === true && terminalOwner()
        } catch { return false }
      } })
      try {
        const timer = setTimeout(() => close(read), timeout)
        read.cleanups.push(() => clearTimeout(timer))
        if (!stillOwns() || !live(read) || !stillOwns()) { close(read); return null }
        return lease
      } catch { close(read); return null }
    }, invalidate, dispose
  })
  if (fence.sender !== sender || !expectedUrl || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2000) { disposed = true; return admission }
  const previous = admissions.get(window), setupGeneration = ++fence.setupGeneration
  const settingUp = (): boolean => !disposed && fence.setupGeneration === setupGeneration && admissions.get(window) === previous
  // Install a full replacement observation set while the old owner/listeners remain active.
  const hook = (emitter: StartupStorageReadEmitter, event: string, listener: (...args: unknown[]) => void): boolean => {
    const remove = (): void => { emitter.removeListener(event, listener) }
    lifecycleCleanups.push(remove)
    try { emitter.on(event, listener) } catch { safely(remove); throw new Error('Startup storage read lifecycle unavailable.') }
    if (!settingUp()) { safely(remove); return false }
    return true
  }
  // A previously scheduled listener may execute after a prepended listener replaced its owner.
  // Revocation observations belong to the actual window, never to replaceable read authority.
  // Old pending/start events may only revoke the current owner; old completion events below
  // still require owns(), so they cannot clear a newer nested navigation's pending state.
  const observePendingNavigation = (): void => {
    fence.depth++
    try { fence.pending = true; admissions.get(window)?.invalidate() } finally { fence.depth-- }
  }
  const startNavigation = (details: unknown, _url?: unknown, _sameDocument?: unknown, legacyMainFrame?: unknown): void => {
    const main = details && typeof details === 'object' ? (details as { isMainFrame?: unknown }).isMainFrame ?? legacyMainFrame : legacyMainFrame
    if (main === true) observePendingNavigation()
  }
  try {
    const hooks: Array<[StartupStorageReadEmitter, string, (...args: unknown[]) => void]> = [
      [sender, 'did-start-navigation', startNavigation],
      [sender, 'did-navigate-in-page', (_event, _url, mainFrame) => { if (mainFrame === true) duringEvent(() => { fence.pending = false; invalidate() }) }],
      [sender, 'did-navigate', () => duringEvent(() => { fence.pending = false; invalidate() })],
      [sender, 'render-process-gone', observePendingNavigation],
      [sender, 'destroyed', dispose], [window, 'closed', dispose]
    ]
    for (const [emitter, event, listener] of hooks) if (!hook(emitter, event, listener)) { dispose(); return admission }
    if (!settingUp()) { dispose(); return admission }
    // New listeners become authoritative before old disposal/abort can emit navigation.
    admissions.set(window, admission); installed = true
    previous?.dispose()
    if (!owns()) dispose()
  } catch { dispose() }
  return admission
}
