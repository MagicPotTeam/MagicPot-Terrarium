import { isProxy } from 'node:util/types'
import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'
import { getIpcInvocationOrigin } from './ipcInvocationOrigin'

export const INSTALLED_CATALOG_PUBLICATION_METHOD = 'svcMagicAgentPlatform.readInstalledCatalog'
export type InstalledCatalogPublicationCapsule = Readonly<{ complete(): boolean; cancel(): void }>
type Entry = { complete: () => boolean; cancel: () => void; phase: 'pending' | 'completing' | 'spent'; interfered: boolean; cancelled: boolean }
const capsules = new WeakMap<ServiceInvocationContext, Entry>()
const unavailable = Object.freeze({ status: 'unavailable' as const, reason: 'unavailable' as const })
const exactOrigin = (invocation: ServiceInvocationContext | undefined): invocation is ServiceInvocationContext =>
  !!invocation && invocation.methodName === INSTALLED_CATALOG_PUBLICATION_METHOD && !!getIpcInvocationOrigin(invocation)
const cancel = (entry: Entry): void => {
  if (entry.cancelled) return
  entry.cancelled = true; entry.phase = 'spent'
  const cancelOwner = entry.cancel
  try { cancelOwner() } catch { /* Authority is already consumed; no callback failure may restore it. */ }
}

/** MAIN-only exact-invocation owner transfer. No authority is serialized or accepted from renderer claims. */
export function registerInstalledCatalogPublication(invocation: ServiceInvocationContext | undefined, capsule: InstalledCatalogPublicationCapsule): boolean {
  if (!exactOrigin(invocation) || !capsule || typeof capsule !== 'object' || isProxy(capsule)) return false
  const previous = capsules.get(invocation)
  if (previous) { if (previous.phase === 'completing') previous.interfered = true; return false }
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(capsule))) return false
    const keys = Reflect.ownKeys(capsule)
    if (keys.length !== 2 || !keys.includes('complete') || !keys.includes('cancel')) return false
    const complete = Object.getOwnPropertyDescriptor(capsule, 'complete'), cleanup = Object.getOwnPropertyDescriptor(capsule, 'cancel')
    if (!complete || !cleanup || !('value' in complete) || !('value' in cleanup) || typeof complete.value !== 'function' || typeof cleanup.value !== 'function') return false
    capsules.set(invocation, { complete: complete.value, cancel: cleanup.value, phase: 'pending', interfered: false, cancelled: false })
    return true
  } catch { return false }
}

/** Final synchronous userland transform only; not native Electron emission, serialization or UI acknowledgement. */
export function finalizeInstalledCatalogPublication<T>(method: string, invocation: ServiceInvocationContext | undefined, candidate: T): T | typeof unavailable {
  if (method !== INSTALLED_CATALOG_PUBLICATION_METHOD) return candidate
  if (!exactOrigin(invocation)) return unavailable
  const entry = capsules.get(invocation)
  if (!entry) { capsules.set(invocation, { complete: () => false, cancel: () => {}, phase: 'spent', interfered: false, cancelled: true }); return unavailable }
  if (entry.phase !== 'pending') { if (entry.phase === 'completing') entry.interfered = true; return unavailable }
  entry.phase = 'completing' // Consume before any owner callback; retain spent marker until invocation is collected.
  let status: unknown
  if (candidate && typeof candidate === 'object' && !isProxy(candidate)) {
    const prototype = Object.getPrototypeOf(candidate)
    if ([Object.prototype, null].includes(prototype) && !Object.hasOwn(candidate, 'then')) status = Object.getOwnPropertyDescriptor(candidate, 'status')?.value
  }
  if (status !== 'available') {
    cancel(entry)
    return status === 'unavailable' ? candidate : unavailable
  }
  let completed = false
  const completeOwner = entry.complete
  try { completed = completeOwner() === true } catch { /* Fail closed, then exact idempotent cancellation. */ }
  if (!completed || entry.interfered) { cancel(entry); return unavailable }
  entry.phase = 'spent'
  // No cancellation/cleanup/callback/await after owner completion's final authority check.
  return candidate
}

export function cancelInstalledCatalogPublication(invocation: ServiceInvocationContext | undefined): void {
  if (!exactOrigin(invocation)) return
  const entry = capsules.get(invocation)
  if (!entry || entry.phase === 'spent') return
  if (entry.phase === 'completing') entry.interfered = true
  cancel(entry)
}
