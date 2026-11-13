import { MAGIC_AGENT_PACKAGE_ID_PATTERN } from '../magicAgentRuntime/packageContracts'

/** Platform-neutral installed-catalog wire data, not a grant or a filesystem path. */
export type InstalledCatalogReadRequest = Record<string, never>
export type InstalledCatalogPublicEntry = Readonly<{ id: string; name: string; version: string; installedAt: string }>
export type InstalledCatalogReadResponse =
  | Readonly<{ status: 'available'; entries: readonly InstalledCatalogPublicEntry[] }>
  | Readonly<{ status: 'unavailable'; reason: 'unavailable' }>
export const installedCatalogUnavailable = Object.freeze({ status: 'unavailable' as const, reason: 'unavailable' as const })
const invalidRequest = (): never => { throw new Error('Invalid installed catalog request.') }
const invalidResponse = (): never => { throw new Error('Invalid installed catalog response.') }
const plain = (value: unknown): value is object => !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) return invalidResponse()
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return invalidResponse()
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalidResponse()
    out[key] = descriptor.value
  }
  return out
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && [...value].every(character => { const code = character.charCodeAt(0); return code >= 32 && code !== 127 && code !== 0xfffd })
const validId = (value: unknown): value is string => typeof value === 'string' && MAGIC_AGENT_PACKAGE_ID_PATTERN.test(value) && !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)

/** Reject extra claims before normalization. Direct MAIN admission independently rejects proxies. */
export function parseInstalledCatalogReadRequest(value: unknown): InstalledCatalogReadRequest {
  try {
    if (!plain(value) || Reflect.ownKeys(value).length !== 0) return invalidRequest()
    return Object.freeze({})
  } catch { return invalidRequest() }
}

/** Passive bounded projection only. This parser never creates publication authority. */
export function parseInstalledCatalogReadResponse(value: unknown): InstalledCatalogReadResponse {
  try {
    if (!plain(value)) return invalidResponse()
    const statusDescriptor = Object.getOwnPropertyDescriptor(value, 'status')
    if (!statusDescriptor?.enumerable || !('value' in statusDescriptor)) return invalidResponse()
    if (statusDescriptor.value === 'unavailable') {
      if (fields(value, ['status', 'reason']).reason !== 'unavailable') return invalidResponse()
      return installedCatalogUnavailable
    }
    if (statusDescriptor.value !== 'available') return invalidResponse()
    const raw = fields(value, ['status', 'entries']).entries
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return invalidResponse()
    const length = Object.getOwnPropertyDescriptor(raw, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > 64 || Reflect.ownKeys(raw).length !== length + 1) return invalidResponse()
    const entries: InstalledCatalogPublicEntry[] = [], ids = new Set<string>()
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalidResponse()
      const item = fields(descriptor.value, ['id', 'name', 'version', 'installedAt'])
      if (!validId(item.id) || ids.has(item.id) || !text(item.name, 120) || !text(item.version, 128) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(item.version) || !text(item.installedAt, 24) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.installedAt)) return invalidResponse()
      const at = new Date(item.installedAt)
      if (!Number.isFinite(at.getTime()) || at.toISOString() !== item.installedAt) return invalidResponse()
      ids.add(item.id)
      entries.push(Object.freeze({ id: item.id, name: item.name, version: item.version, installedAt: item.installedAt }))
    }
    const result = Object.freeze({ status: 'available' as const, entries: Object.freeze(entries) })
    if (JSON.stringify(result).length > 131072) return invalidResponse()
    return result
  } catch { return invalidResponse() }
}
