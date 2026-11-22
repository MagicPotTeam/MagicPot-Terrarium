import { isProxy } from 'node:util/types'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getIpcInvocationOrigin } from '@shared/api/createServer/ipcInvocationOrigin'

export const INSTALLED_CATALOG_READ_METHOD = 'svcMagicAgentPlatform.readInstalledCatalog'
export type ManagementReadState = 'ready' | 'disabled' | 'unavailable'
export type ManagementReadEmitter = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}
export type ManagementReadFrame = { readonly url: string; readonly parent: unknown; readonly detached: boolean }
export type ManagementReadSender = ManagementReadEmitter & {
  readonly id: number
  isDestroyed(): boolean
  getURL(): string
  readonly mainFrame: ManagementReadFrame
}
export type ManagementReadWindow = ManagementReadEmitter & {
  isDestroyed(): boolean
  readonly webContents: ManagementReadSender
}
export type ManagementReadLease = Readonly<{
  signal: AbortSignal
  isCurrent(): boolean
  close(): void
}>
export type ManagementReadAdmission = Readonly<{
  begin(payload: unknown, invocation?: ServiceInvocationContext): ManagementReadLease | null
  invalidate(): void
  dispose(): void
}>
export type ManagementReadAdmissionOptions = {
  window: ManagementReadWindow
  trustedRendererUrl: string
  getMainWindow(): ManagementReadWindow | null
  getReadState(): ManagementReadState
  onConfigCommitted(listener: () => void): () => void
  timeoutMs?: number
  now?: () => number
}

export type ManagementReadTerminalCheck = boolean | Readonly<{ deadline: number; minimumTime: number }>
const terminalCompletions = new WeakMap<ManagementReadLease, (finalCheck: () => ManagementReadTerminalCheck) => boolean>()
/** Once-only MAIN terminal operation; copied leases never acquire completion authority. */
export function completeManagementReadLease(lease: ManagementReadLease, finalCheck: () => ManagementReadTerminalCheck): boolean {
  const complete = terminalCompletions.get(lease)
  if (!complete) return false
  terminalCompletions.delete(lease) // Consume before cleanup, abort or final predicates can reenter.
  return complete(finalCheck)
}

const admissions = new WeakMap<ManagementReadWindow, ManagementReadAdmission>()
// Navigation belongs to the actual window, not to replaceable admission factories.
const windowFences = new WeakMap<ManagementReadWindow, { sender: ManagementReadSender; pending: boolean; depth: number }>()
const safely = (cleanup: () => void): void => { try { cleanup() } catch { /* Revoked authority never depends on cleanup success. */ } }
const emptyPayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || isProxy(value)) return false
  try {
    return [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === 0
  } catch { return false }
}
const exactManagementUrl = (base: string): string | null => {
  try {
    if (typeof base !== 'string' || base.length > 8192 || base !== base.trim() || base.includes('?') || base.includes('#')) return null
    const parsed = new URL(base)
    if (!['file:', 'http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href !== base) return null
    return base + '#/agent-management'
  } catch { return null }
}

type Read = {
  controller: AbortController
  invocation: ServiceInvocationContext
  deadline: number
  closed: boolean
  cleanupFailed: boolean
  cleanups: Array<() => void>
}

/** MAIN-owned identity/lifetime only. No policy entitlement, reader, service or UI registration. */
export function createManagementReadAdmission(options: ManagementReadAdmissionOptions): ManagementReadAdmission {
  const { window, trustedRendererUrl, getMainWindow, getReadState, onConfigCommitted } = options
  const now = options.now ?? Date.now, timeout = options.timeoutMs ?? 5000
  const sender = window.webContents, expectedUrl = exactManagementUrl(trustedRendererUrl)
  let disposed = false, installed = false, sequence = 0
  const fence = windowFences.get(window) ?? { sender, pending: false, depth: 0 }
  if (!windowFences.has(window)) windowFences.set(window, fence)
  let current: Read | undefined
  const lifecycleCleanups: Array<() => void> = []
  const owns = (): boolean => !disposed && admissions.get(window) === admission
  const available = (): boolean => owns() && installed && !fence.pending && fence.depth === 0
  const close = (read: Read | undefined): void => {
    if (!read || read.closed) return
    read.closed = true
    if (current === read) current = undefined
    // Detach exact old resources before external abort listeners can install a successor.
    for (const cleanup of read.cleanups.splice(0).reverse()) {
      try { cleanup() } catch { read.cleanupFailed = true }
    }
    try { read.controller.abort() } catch { read.cleanupFailed = true }
  }
  const invalidate = (): void => { sequence++; close(current) }
  const dispose = (): void => {
    if (disposed) return
    disposed = true; installed = false; sequence++
    if (admissions.get(window) === admission) admissions.delete(window)
    for (const cleanup of lifecycleCleanups.splice(0).reverse()) safely(cleanup)
    close(current)
  }
  const duringEvent = (action: () => void): void => {
    if (!owns()) return
    fence.depth++
    try { action() } finally { fence.depth-- }
  }
  const fresh = (invocation: ServiceInvocationContext): boolean => {
    try {
      const origin = getIpcInvocationOrigin(invocation)
      const frame = sender.mainFrame
      return invocation.methodName === INSTALLED_CATALOG_READ_METHOD &&
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
    const attempt = sequence
    let valid = false
    try {
      if (available() && fresh(read.invocation)) {
        const checkedAt = now()
        valid = Number.isFinite(checkedAt) && checkedAt < read.deadline
      }
    } catch { /* Fail closed. */ }
    if (read.closed || current !== read) return false
    // An observed invalidity is final even if a denied reentrant begin only changed sequence.
    if (!valid || !available()) { close(read); return false }
    return sequence === attempt
  }
  const admission: ManagementReadAdmission = Object.freeze({
    begin: (payload: unknown, invocation?: ServiceInvocationContext): ManagementReadLease | null => {
      const attempt = ++sequence // Every reentrant attempt fences terminal publication, including preflight denials.
      if (!available() || !emptyPayload(payload) || !invocation || !getIpcInvocationOrigin(invocation)) return null
      const stillOwns = (): boolean => sequence === attempt && available()
      if (!fresh(invocation) || !stillOwns()) return null
      close(current)
      if (!stillOwns() || !fresh(invocation) || !stillOwns()) return null
      let started: number
      try { started = now() } catch { return null }
      if (!Number.isFinite(started) || !stillOwns()) return null
      const read: Read = { controller: new AbortController(), invocation, deadline: started + timeout, closed: false, cleanupFailed: false, cleanups: [] }
      current = read
      const lease = Object.freeze({ signal: read.controller.signal, isCurrent: () => live(read), close: () => close(read) })
      terminalCompletions.set(lease, finalCheck => {
        const terminalSequence = sequence
        if (!live(read) || sequence !== terminalSequence) { close(read); return false }
        close(read) // The working lease is revoked; all external cleanup finishes before final authority.
        const terminalOwner = (): boolean => available() && sequence === terminalSequence && current === undefined
        if (read.cleanupFailed || !terminalOwner()) return false
        try {
          if (typeof finalCheck !== 'function') return false
          const checked = finalCheck()
          let finalDeadline = read.deadline, minimumTime = Number.NEGATIVE_INFINITY
          if (checked !== true) {
            if (!checked || typeof checked !== 'object' || isProxy(checked) || ![Object.prototype, null].includes(Object.getPrototypeOf(checked))) return false
            const keys = Reflect.ownKeys(checked), deadline = Object.getOwnPropertyDescriptor(checked, 'deadline'), minimum = Object.getOwnPropertyDescriptor(checked, 'minimumTime')
            if (keys.length !== 2 || !keys.includes('deadline') || !keys.includes('minimumTime') || !deadline || !minimum || !('value' in deadline) || !('value' in minimum)) return false
            if (!Number.isFinite(deadline.value) || !Number.isFinite(minimum.value) || minimum.value < 0 || deadline.value <= minimum.value || deadline.value > read.deadline) return false
            finalDeadline = deadline.value; minimumTime = minimum.value
          }
          if (!terminalOwner() || !fresh(read.invocation)) return false
          const checkedAt = now()
          // The final clock sample enforces the caller's captured tighter deadline AND observed monotonic floor.
          // No external callback/cleanup/await follows these internal identity and sequence checks.
          return Number.isFinite(checkedAt) && checkedAt >= minimumTime && checkedAt < finalDeadline && terminalOwner()
        } catch { return false }
      })
      // Subscription can synchronously revoke/replace us before returning its cleanup.
      try {
        const unsubscribe = onConfigCommitted(() => duringEvent(invalidate))
        if (typeof unsubscribe !== 'function') { close(read); return null }
        if (read.closed || current !== read || !stillOwns()) { safely(unsubscribe); close(read); return null }
        read.cleanups.push(unsubscribe)
        const timer = setTimeout(() => close(read), timeout)
        read.cleanups.push(() => clearTimeout(timer))
        if (!stillOwns() || !live(read) || !stillOwns()) { close(read); return null }
        return lease
      } catch { close(read); return null }
    },
    invalidate,
    dispose
  })
  if (fence.sender !== sender || !expectedUrl || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) { disposed = true; return admission }

  // Publish the new factory before abort callbacks from the old one can reenter.
  const previous = admissions.get(window)
  admissions.set(window, admission)
  previous?.dispose()
  if (!owns()) { dispose(); return admission }
  const hook = (emitter: ManagementReadEmitter, event: string, listener: (...args: unknown[]) => void): boolean => {
    const remove = (): void => { emitter.removeListener(event, listener) }
    lifecycleCleanups.push(remove)
    try { emitter.on(event, listener) } catch { safely(remove); throw new Error('Management read lifecycle unavailable.') }
    // EventEmitter.newListener can revoke us before on() actually inserts the hook.
    if (!owns()) { safely(remove); return false }
    return true
  }
  const startNavigation = (details: unknown, _url?: unknown, _sameDocument?: unknown, legacyMainFrame?: unknown): void => {
    const main = details && typeof details === 'object' ? (details as { isMainFrame?: unknown }).isMainFrame ?? legacyMainFrame : legacyMainFrame
    if (main === true) duringEvent(() => { fence.pending = true; invalidate() })
  }
  const inPageNavigation = (_event: unknown, _url?: unknown, mainFrame?: unknown): void => {
    if (mainFrame === true) duringEvent(() => { fence.pending = false; invalidate() })
  }
  try {
    const hooks: Array<[ManagementReadEmitter, string, (...args: unknown[]) => void]> = [
      [sender, 'did-start-navigation', startNavigation],
      [sender, 'did-navigate-in-page', inPageNavigation],
      [sender, 'did-navigate', () => duringEvent(() => { fence.pending = false; invalidate() })],
      [sender, 'render-process-gone', () => duringEvent(() => { fence.pending = true; invalidate() })],
      [sender, 'destroyed', dispose],
      [window, 'closed', dispose]
    ]
    for (const [emitter, event, listener] of hooks) if (!hook(emitter, event, listener)) { dispose(); return admission }
    installed = owns()
  } catch { dispose() }
  return admission
}
