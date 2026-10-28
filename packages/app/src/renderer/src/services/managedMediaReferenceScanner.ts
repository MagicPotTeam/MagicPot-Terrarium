import { normalizeMediaReference, type MediaReference } from '../../../shared/mediaReference'

export type ManagedMediaReferenceScanResult =
  | { ok: true; ids: string[]; referenceCounts: Record<string, number> }
  | { ok: false; ids: []; referenceCounts: Record<string, number> }

export type ManagedMediaReferenceScannerSources = {
  readChatSessions: () => Promise<unknown>
  readChatDrafts: () => Promise<unknown>
  readCanvasItems: () => Promise<unknown>
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

function readDraftBackups(
  storage: ManagedMediaReferenceScannerSources['localStorage'],
  prefix: string
): unknown[] {
  const values: unknown[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null) throw new Error('Unable to enumerate localStorage')
    if (!key.startsWith(prefix)) continue
    const raw = storage.getItem(key)
    if (raw === null) throw new Error('Unable to read localStorage draft backup')
    values.push(JSON.parse(raw) as unknown)
  }
  return values
}

export async function scanManagedMediaReferenceIds(
  sources: ManagedMediaReferenceScannerSources
): Promise<ManagedMediaReferenceScanResult> {
  const references = new Map<string, number>()
  try {
    const [sessions, drafts, canvasItems] = await Promise.all([
      sources.readChatSessions(),
      sources.readChatDrafts(),
      sources.readCanvasItems()
    ])
    scanValue(sessions, references)
    scanValue(drafts, references)
    scanValue(
      readDraftBackups(
        sources.localStorage,
        sources.draftBackupKeyPrefix ?? DEFAULT_DRAFT_BACKUP_KEY_PREFIX
      ),
      references
    )
    scanValue(canvasItems, references)
    const ids = [...references.keys()].sort()
    const referenceCounts = Object.fromEntries(ids.map((id) => [id, references.get(id) as number]))
    return { ok: true, ids, referenceCounts }
  } catch {
    return { ok: false, ids: [], referenceCounts: {} }
  }
}

export type { MediaReference }
