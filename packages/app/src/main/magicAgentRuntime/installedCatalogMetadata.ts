import { isProxy } from 'node:util/types'
import { MAGIC_AGENT_PACKAGE_ID_PATTERN } from '@shared/magicAgentRuntime/packageContracts'
import { validateMagicAgentPackageManifest } from './package/manifest'

export const INSTALLED_CATALOG_METADATA_MAX_BYTES = 65536
export type InstalledCatalogEntry = Readonly<{ id: string; name: string; version: string; installedAt: string }>
const topKeys = new Set(['id', 'name', 'version', 'description', 'author', 'installedAt', 'sourcePath', 'packagePath', 'manifest'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const writerText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() &&
  [...value].every(character => { const code = character.charCodeAt(0); return code >= 32 && code !== 127 && code !== 0xfffd })

/** Directory names remain exact; no Windows device/ADS/trailing-dot alias normalization. */
export function isInstalledCatalogDirectoryId(value: unknown): value is string {
  return typeof value === 'string' && MAGIC_AGENT_PACKAGE_ID_PATTERN.test(value) &&
    !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
}

// Parsed JSON is bounded independently before validating a manifest; config is never executed.
function boundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const next = pending.pop()!
    if (++nodes > 4096 || next.depth > 16) return false
    if (typeof next.value === 'string' && (next.value.length > 16384 || next.value.includes('\u0000'))) return false
    if (next.value && typeof next.value === 'object') {
      const entries = Object.entries(next.value)
      if (entries.length > 256) return false
      for (const [key, item] of entries) {
        if (key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key)) return false
        pending.push({ value: item, depth: next.depth + 1 })
      }
    }
  }
  return true
}

/** Four-field display projection only. No IO, path dereference, normalization, repair or authority. */
export function projectInstalledCatalogMetadata(directoryId: string, bytes: Uint8Array): InstalledCatalogEntry | null {
  if (!isInstalledCatalogDirectoryId(directoryId) || !bytes || isProxy(bytes) || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > INSTALLED_CATALOG_METADATA_MAX_BYTES) return null
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const raw: unknown = JSON.parse(decoded.startsWith('\ufeff') ? decoded.slice(1) : decoded)
    if (!record(raw) || !boundedJson(raw) || Object.keys(raw).some(key => !topKeys.has(key))) return null
    if (raw.id !== directoryId || !boundedText(raw.name, 120) || !boundedText(raw.version, 128) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw.version)) return null
    if (!boundedText(raw.installedAt, 24) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.installedAt) ||
      new Date(raw.installedAt).toISOString() !== raw.installedAt) return null
    // Persisted paths are bounded opaque writer fields, never resolved/read or compared to this location.
    if (!boundedText(raw.sourcePath, 8192) || !boundedText(raw.packagePath, 8192)) return null
    if (Object.hasOwn(raw, 'description') && !writerText(raw.description, 2000)) return null
    if (Object.hasOwn(raw, 'author') && !writerText(raw.author, 512)) return null
    if (!record(raw.manifest) || raw.manifest.id !== raw.id || raw.manifest.name !== raw.name || raw.manifest.version !== raw.version) return null
    const validation = validateMagicAgentPackageManifest(raw.manifest)
    if (!validation.ok) return null
    return Object.freeze({ id: directoryId, name: raw.name, version: raw.version, installedAt: raw.installedAt })
  } catch { return null }
}
