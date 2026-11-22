import { isProxy } from 'node:util/types'
import type { ServiceInvocationContext } from '../apiUtils/serviceInvocation'
import { parseStartupStorageMetadataResponse, startupStorageMetadataUnavailable as unavailable } from '../startupStorageMetadata'
import { getIpcInvocationOrigin } from './ipcInvocationOrigin'

export const STARTUP_STORAGE_PUBLICATION_METHOD = 'svcState.readStartupStorageMetadata'
export type StartupStoragePublicationCapsule = Readonly<{ complete(): boolean; cancel(): void }>
type Entry = { complete: () => boolean; cancel: () => void; phase: 'pending' | 'completing' | 'spent'; interfered: boolean; cancelled: boolean }
const capsules = new WeakMap<ServiceInvocationContext, Entry>()
const exactOrigin = (invocation: ServiceInvocationContext | undefined): invocation is ServiceInvocationContext =>
  !!invocation && !!getIpcInvocationOrigin(invocation) && invocation.methodName === STARTUP_STORAGE_PUBLICATION_METHOD
const cancel = (entry: Entry): void => {
  if (entry.cancelled) return
  entry.cancelled = true; entry.phase = 'spent'
  const cancelOwner = entry.cancel
  try { cancelOwner() } catch { /* Consumed authority cannot revive; no raw error diagnostics. */ }
}

/** Independent exact-invocation transfer; not catalog registration, a renderer token or policy grant. */
export function registerStartupStoragePublication(invocation: ServiceInvocationContext | undefined, capsule: StartupStoragePublicationCapsule): boolean {
  if (!exactOrigin(invocation) || !capsule || typeof capsule !== 'object' || isProxy(capsule)) return false
  const previous = capsules.get(invocation)
  if (previous) { if (previous.phase === 'completing') previous.interfered = true; return false }
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(capsule))) return false
    const keys = Reflect.ownKeys(capsule)
    if (keys.length !== 2 || !keys.includes('complete') || !keys.includes('cancel')) return false
    const complete = Object.getOwnPropertyDescriptor(capsule, 'complete'), cleanup = Object.getOwnPropertyDescriptor(capsule, 'cancel')
    if (!complete?.enumerable || !cleanup?.enumerable || !('value' in complete) || !('value' in cleanup) || typeof complete.value !== 'function' || typeof cleanup.value !== 'function' || isProxy(complete.value) || isProxy(cleanup.value)) return false
    capsules.set(invocation, { complete: complete.value, cancel: cleanup.value, phase: 'pending', interfered: false, cancelled: false })
    return true
  } catch { return false }
}
/** Last synchronous JS transform, not native Electron serialization/emission or renderer acknowledgement. */
export function finalizeStartupStoragePublication<T>(method: string, invocation: ServiceInvocationContext | undefined, candidate: T): T | typeof unavailable {
  if (method !== STARTUP_STORAGE_PUBLICATION_METHOD) return candidate
  if (!exactOrigin(invocation)) return unavailable
  const entry = capsules.get(invocation)
  if (!entry) { capsules.set(invocation, { complete: () => false, cancel: () => {}, phase: 'spent', interfered: false, cancelled: true }); return unavailable }
  if (entry.phase !== 'pending') { if (entry.phase === 'completing') entry.interfered = true; return unavailable }
  entry.phase = 'completing'
  let output: ReturnType<typeof parseStartupStorageMetadataResponse>
  try {
    if (candidate && (typeof candidate === 'object' || typeof candidate === 'function') && isProxy(candidate)) { cancel(entry); return unavailable }
    output = parseStartupStorageMetadataResponse(candidate)
  } catch { cancel(entry); return unavailable }
  if (output.status !== 'available') { cancel(entry); return unavailable }
  let completed = false
  const completeOwner = entry.complete
  try { completed = completeOwner() === true } catch { /* Static failure only; never inspect diagnostics. */ }
  if (!completed || entry.interfered) { cancel(entry); return unavailable }
  entry.phase = 'spent'
  // The exact detached frozen candidate was prepared before completion. No callback/cleanup/
  // parser/await occurs after the owner's last authority check.
  return output as T
}
export function cancelStartupStoragePublication(invocation: ServiceInvocationContext | undefined): void {
  if (!exactOrigin(invocation)) return
  const entry = capsules.get(invocation)
  if (!entry || entry.phase === 'spent') return
  if (entry.phase === 'completing') entry.interfered = true
  cancel(entry)
}
