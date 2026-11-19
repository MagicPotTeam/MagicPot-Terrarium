import { normalizeMediaReference, type MediaReference } from '../../../shared/mediaReference'

/** Where a scan could not read, or found a media value it could not use. */
export type ManagedMediaScanSource =
  | 'chat-store'
  | 'chat-media'
  | 'canvas-board'
  | 'canvas-file'
  | 'canvas-media'
  | 'project-index'
  | 'draft-backup'
  | 'draft-media'
  | 'local-storage'

/** A source and, where known, its scope name or board id. Never a media id or a file path. */
export type ManagedMediaScanProblem = { source: ManagedMediaScanSource; context?: string }

export type ManagedMediaReferenceScanResult =
  | { ok: true; ids: string[]; referenceCounts: Record<string, number> }
  | {
      ok: false
      ids: []
      referenceCounts: Record<string, number>
      /** What made the snapshot incomplete. */
      failure: ManagedMediaScanProblem
    }

/** Fails a scan and names the source; thrown by sources that know more than the scanner. */
export class ManagedMediaScanSourceError extends Error {
  constructor(
    readonly problem: ManagedMediaScanProblem,
    options?: { cause?: unknown }
  ) {
    super(`Managed media reference scan failed: ${problem.source}`, options)
    this.name = 'ManagedMediaScanSourceError'
  }
}

/**
 * Hands stored values to `visit` one at a time; rejects on any read error. A source of several
 * boards passes the board id with its values.
 */
export type ManagedMediaReferenceSource = (
  visit: (value: unknown, context?: string) => void
) => Promise<void>

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

/** Scans one value; a media value it cannot use fails the scan under `problem`. */
function scanValueOf(
  value: unknown,
  ids: Map<string, number>,
  problem: ManagedMediaScanProblem
): void {
  try {
    scanValue(value, ids)
  } catch (error) {
    throw new ManagedMediaScanSourceError(problem, { cause: error })
  }
}

const scopeOfChatRecord = (record: unknown): string | undefined =>
  isRecord(record) && typeof record.storageScope === 'string' ? record.storageScope : undefined

/** The scope in a draft backup key (`<prefix><scope>:<session id>`). */
const scopeOfDraftBackupKey = (key: string, prefix: string): string => {
  const rest = key.slice(prefix.length)
  const separator = rest.lastIndexOf(':')
  return separator > 0 ? rest.slice(0, separator) : rest
}

/** Every composer draft backup in localStorage, of every scope, parsed and scanned one at a time. */
function scanDraftBackups(
  storage: ManagedMediaReferenceScannerSources['localStorage'],
  prefix: string,
  ids: Map<string, number>
): void {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null) throw new ManagedMediaScanSourceError({ source: 'local-storage' })
    if (!key.startsWith(prefix)) continue
    const scope = scopeOfDraftBackupKey(key, prefix)
    let value: unknown
    try {
      const raw = storage.getItem(key)
      if (raw === null) throw new Error('Unable to read localStorage draft backup')
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new ManagedMediaScanSourceError(
        { source: 'draft-backup', context: scope },
        { cause: error }
      )
    }
    scanValueOf(value, ids, { source: 'draft-media', context: scope })
  }
}

/** Runs one phase of the scan; an error that names no source is put down to `source`. */
async function inPhase(source: ManagedMediaScanSource, run: () => unknown): Promise<void> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ManagedMediaScanSourceError) throw error
    throw new ManagedMediaScanSourceError({ source }, { cause: error })
  }
}

/**
 * The managed media ids referenced anywhere in the stores. The result authorises deletion of
 * everything else, so any read or parse error, and any malformed reference, fails the whole scan;
 * the result then names the source. Sources are read one after another and only ids are kept.
 */
export async function scanManagedMediaReferenceIds(
  sources: ManagedMediaReferenceScannerSources
): Promise<ManagedMediaReferenceScanResult> {
  const references = new Map<string, number>()
  const prefix = sources.draftBackupKeyPrefix ?? DEFAULT_DRAFT_BACKUP_KEY_PREFIX
  try {
    await inPhase('chat-store', () =>
      sources.visitChatRecords((record) =>
        scanValueOf(record, references, {
          source: 'chat-media',
          context: scopeOfChatRecord(record)
        })
      )
    )
    await inPhase('canvas-board', () =>
      sources.visitCanvasItems((items, boardId) =>
        scanValueOf(items, references, { source: 'canvas-media', context: boardId })
      )
    )
    await inPhase('local-storage', () => scanDraftBackups(sources.localStorage, prefix, references))
    const ids = [...references.keys()].sort()
    const referenceCounts = Object.fromEntries(ids.map((id) => [id, references.get(id) as number]))
    return { ok: true, ids, referenceCounts }
  } catch (error) {
    const failure =
      error instanceof ManagedMediaScanSourceError
        ? error.problem
        : { source: 'chat-store' as const }
    return { ok: false, ids: [], referenceCounts: {}, failure }
  }
}

export type { MediaReference }
