/** Two startup-applied fields only; no storage-health, backup, path or time assertion. */
export type StartupStorageMetadataRequest = Record<string, never>
export type StartupStorageMetadataResponse =
  | Readonly<{ status: 'available'; source: 'default' | 'persisted' | 'env'; legacyLayout: boolean }>
  | Readonly<{ status: 'unavailable'; reason: 'unavailable' }>
export const startupStorageMetadataUnavailable = Object.freeze({ status: 'unavailable' as const, reason: 'unavailable' as const })

// Platform-neutral structural parsing only; MAIN must independently reject proxies before
// any inspection. Descriptor access avoids invoking own getters; no parser grants authority.
function ownData(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null
  const result: Record<string, unknown> = {}
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) return null
    result[key] = descriptor.value
  }
  return result
}
export function parseStartupStorageMetadataRequest(value: unknown): StartupStorageMetadataRequest {
  try { if (ownData(value, [])) return Object.freeze({}) } catch { /* Static failure, no raw diagnostic inspection. */ }
  throw new Error('Invalid startup storage metadata request.')
}
export function parseStartupStorageMetadataResponse(value: unknown): StartupStorageMetadataResponse {
  try {
    const available = ownData(value, ['status', 'source', 'legacyLayout'])
    if (available?.status === 'available' && (available.source === 'default' || available.source === 'persisted' || available.source === 'env') && typeof available.legacyLayout === 'boolean') {
      return Object.freeze({ status: 'available', source: available.source, legacyLayout: available.legacyLayout })
    }
    const unavailable = ownData(value, ['status', 'reason'])
    if (unavailable?.status === 'unavailable' && unavailable.reason === 'unavailable') return startupStorageMetadataUnavailable
  } catch { /* Static failure, no raw diagnostic inspection. */ }
  throw new Error('Invalid startup storage metadata response.')
}
