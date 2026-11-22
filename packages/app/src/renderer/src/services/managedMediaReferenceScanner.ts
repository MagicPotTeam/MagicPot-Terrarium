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

/** Media values that named no managed media, by source and scope or board. */
export type ManagedMediaScanSkipped = ManagedMediaScanProblem & { count: number }

export type ManagedMediaReferenceScanResult =
  | {
      ok: true
      ids: string[]
      referenceCounts: Record<string, number>
      /** Present when media values that name no managed media were skipped. */
      skipped?: ManagedMediaScanSkipped[]
    }
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

type ScanState = {
  ids: Map<string, number>
  skipped: Map<string, ManagedMediaScanSkipped>
}

/** A 64-digit hex run not part of a longer one: the form of every managed media id. */
const EMBEDDED_SHA256_PATTERN = /(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])/g

/** Every managed media id a value could name: each 64-hex run in any of its strings. */
function collectEmbeddedIds(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(EMBEDDED_SHA256_PATTERN)) found.add(match[0].toLowerCase())
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectEmbeddedIds(entry, found)
    return
  }
  if (isRecord(value)) for (const child of Object.values(value)) collectEmbeddedIds(child, found)
}

function addId(id: string, state: ScanState): void {
  state.ids.set(id, (state.ids.get(id) ?? 0) + 1)
}

/**
 * The ids a stored `media` value protects. A managed reference names its id. Any other value
 * (malformed, another kind, a string) protects every id it could name: normalizeMediaReference
 * reads an id from `sha256`, and a managed file's path and URL carry it too, so every 64-hex run
 * in any of its strings counts. A value with none (a tool argument named media, a number) names
 * no managed media: it is skipped and counted, it does not fail the snapshot.
 */
function addMediaReference(
  value: unknown,
  state: ScanState,
  problem: ManagedMediaScanProblem
): void {
  const reference = normalizeMediaReference(value)
  if (reference?.kind === 'managed' && reference.sha256 && SHA256_PATTERN.test(reference.sha256)) {
    addId(reference.sha256, state)
    return
  }
  const found = new Set<string>()
  collectEmbeddedIds(value, found)
  if (found.size > 0) {
    for (const id of found) addId(id, state)
    return
  }
  const key = `${problem.source}\u0000${problem.context ?? ''}`
  const skipped = state.skipped.get(key)
  if (skipped) skipped.count += 1
  else state.skipped.set(key, { ...problem, count: 1 })
}

function scanValue(value: unknown, state: ScanState, problem: ManagedMediaScanProblem): void {
  if (Array.isArray(value)) {
    for (const entry of value) scanValue(entry, state, problem)
    return
  }
  if (!isRecord(value)) return

  if ('media' in value && value.media !== undefined && value.media !== null) {
    addMediaReference(value.media, state, problem)
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'media') scanValue(child, state, problem)
  }
}

/** Scans one value; a value it cannot walk fails the scan under `problem`. */
function scanValueOf(value: unknown, state: ScanState, problem: ManagedMediaScanProblem): void {
  try {
    scanValue(value, state, problem)
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
  state: ScanState
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
    scanValueOf(value, state, { source: 'draft-media', context: scope })
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
 * everything else, so any read or parse error fails the whole scan, and the result then names the
 * source. A media value that names no managed media is skipped and reported. Sources are read
 * one after another and only ids are kept.
 */
export async function scanManagedMediaReferenceIds(
  sources: ManagedMediaReferenceScannerSources
): Promise<ManagedMediaReferenceScanResult> {
  const state: ScanState = { ids: new Map(), skipped: new Map() }
  const prefix = sources.draftBackupKeyPrefix ?? DEFAULT_DRAFT_BACKUP_KEY_PREFIX
  // Draft backups are read before and after the other stores and both readings count: a
  // reference that moves out of a draft (a send) while the chat store is read is not lost.
  const draftsBefore: ScanState = { ids: new Map(), skipped: new Map() }
  try {
    await inPhase('local-storage', () =>
      scanDraftBackups(sources.localStorage, prefix, draftsBefore)
    )
    await inPhase('chat-store', () =>
      sources.visitChatRecords((record) =>
        scanValueOf(record, state, {
          source: 'chat-media',
          context: scopeOfChatRecord(record)
        })
      )
    )
    await inPhase('canvas-board', () =>
      sources.visitCanvasItems((items, boardId) =>
        scanValueOf(items, state, { source: 'canvas-media', context: boardId })
      )
    )
    await inPhase('local-storage', () => scanDraftBackups(sources.localStorage, prefix, state))
    for (const [id, count] of draftsBefore.ids) if (!state.ids.has(id)) state.ids.set(id, count)
    const ids = [...state.ids.keys()].sort()
    const referenceCounts = Object.fromEntries(ids.map((id) => [id, state.ids.get(id) as number]))
    const skipped = [...state.skipped.values()]
    return { ok: true, ids, referenceCounts, ...(skipped.length > 0 ? { skipped } : {}) }
  } catch (error) {
    const failure =
      error instanceof ManagedMediaScanSourceError
        ? error.problem
        : { source: 'chat-store' as const }
    return { ok: false, ids: [], referenceCounts: {}, failure }
  }
}

export type { MediaReference }
