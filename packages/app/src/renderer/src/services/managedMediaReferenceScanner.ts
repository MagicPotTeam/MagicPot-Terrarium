import { normalizeMediaReference, type MediaReference } from '../../../shared/mediaReference'

export type ManagedMediaReferenceScanResult =
  | { ok: true; ids: string[]; referenceCounts: Record<string, number> }
  | { ok: false; ids: []; referenceCounts: Record<string, number> }

/** Hands stored values to `visit` one at a time; rejects on any read error. */
export type ManagedMediaReferenceSource = (visit: (value: unknown) => void) => Promise<void>

export type ManagedMediaReferenceScannerSources = {
  /** Every record of the chat store, of every scope, as stored. */
  visitChatRecords: ManagedMediaReferenceSource
  /** The stored items of every canvas. */
  visitCanvasItems: ManagedMediaReferenceSource
  localStorage: {
    length: number
    key: (index: number) => string | null
    getItem: (key: string) => string | null
  }
  draftBackupKeyPrefix?: string
}

const DEFAULT_DRAFT_BACKUP_KEY_PREFIX = 'magicpot-chat-draft:'
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function addMediaReference(value: unknown, ids: Map<string, number>): void {
  const reference = normalizeMediaReference(value)
  if (!reference || reference.kind !== 'managed' || !reference.sha256) {
    throw new Error('Invalid managed media reference')
  }
  const id = reference.sha256.toLowerCase()
  if (!SHA256_PATTERN.test(id)) throw new Error('Invalid managed media id')
  ids.set(id, (ids.get(id) ?? 0) + 1)
}

function scanValue(value: unknown, ids: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const entry of value) scanValue(entry, ids)
    return
  }
  if (!isRecord(value)) return

  if ('media' in value && value.media !== undefined && value.media !== null) {
    addMediaReference(value.media, ids)
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'media') scanValue(child, ids)
  }
}

/** Every composer draft backup in localStorage, of every scope, parsed and scanned one at a time. */
function scanDraftBackups(
  storage: ManagedMediaReferenceScannerSources['localStorage'],
  prefix: string,
  ids: Map<string, number>
): void {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null) throw new Error('Unable to enumerate localStorage')
    if (!key.startsWith(prefix)) continue
    const raw = storage.getItem(key)
    if (raw === null) throw new Error('Unable to read localStorage draft backup')
    scanValue(JSON.parse(raw) as unknown, ids)
  }
}

/**
 * The managed media ids referenced anywhere in the stores. The result authorises deletion of
 * everything else, so any read or parse error, and any malformed reference, fails the whole scan.
 * Sources are read one after another and only ids are kept.
 */
export async function scanManagedMediaReferenceIds(
  sources: ManagedMediaReferenceScannerSources
): Promise<ManagedMediaReferenceScanResult> {
  const references = new Map<string, number>()
  const visit = (value: unknown): void => scanValue(value, references)
  try {
    await sources.visitChatRecords(visit)
    await sources.visitCanvasItems(visit)
    scanDraftBackups(
      sources.localStorage,
      sources.draftBackupKeyPrefix ?? DEFAULT_DRAFT_BACKUP_KEY_PREFIX,
      references
    )
    const ids = [...references.keys()].sort()
    const referenceCounts = Object.fromEntries(ids.map((id) => [id, references.get(id) as number]))
    return { ok: true, ids, referenceCounts }
  } catch {
    return { ok: false, ids: [], referenceCounts: {} }
  }
}

export type { MediaReference }
