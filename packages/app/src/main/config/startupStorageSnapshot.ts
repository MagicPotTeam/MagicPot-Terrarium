import { isProxy } from 'node:util/types'

/** Startup-applied origin/layout only: neither a storage-health assertion nor an IPC grant. */
export type StartupStorageMetadata = Readonly<{
  source: 'default' | 'persisted' | 'env'
  legacyLayout: boolean
}>
export type StartupStorageCapture = Readonly<{
  snapshot: StartupStorageMetadata
  isCurrent(): boolean
}>
export type StartupStorageSnapshotOwner = Readonly<{
  publish(value: unknown): boolean
  capture(): StartupStorageCapture | null
  invalidate(): void
}>

/** Passive memory owner. Normal startup publishes once; any failed/repeated attempt or fence is terminal. */
export function createStartupStorageSnapshot(): StartupStorageSnapshotOwner {
  let attempted = false
  let current: StartupStorageMetadata | null = null
  const invalidate = (): void => {
    attempted = true
    current = null
  }
  const publish = (value: unknown): boolean => {
    if (attempted) {
      invalidate()
      return false
    }
    // Consume before inspecting input. Never read through an accessor/proxy or retry with guessed defaults.
    attempted = true
    if (!value || typeof value !== 'object' || isProxy(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 2 || !keys.includes('source') || !keys.includes('legacyLayout')) return false
    const source = Object.getOwnPropertyDescriptor(value, 'source')
    const legacyLayout = Object.getOwnPropertyDescriptor(value, 'legacyLayout')
    if (!source || !source.enumerable || !Object.hasOwn(source, 'value') ||
        !legacyLayout || !legacyLayout.enumerable || !Object.hasOwn(legacyLayout, 'value')) return false
    if (!['default', 'persisted', 'env'].includes(source.value) || typeof legacyLayout.value !== 'boolean') return false
    current = Object.freeze({ source: source.value, legacyLayout: legacyLayout.value })
    return true
  }
  const capture = (): StartupStorageCapture | null => {
    const snapshot = current
    if (!snapshot) return null
    return Object.freeze({ snapshot, isCurrent: () => current === snapshot })
  }
  return Object.freeze({ publish, capture, invalidate })
}

/** MAIN-only; importing or capturing never resolves paths, configuration, stores or runtime. */
export const startupStorageSnapshot = createStartupStorageSnapshot()
