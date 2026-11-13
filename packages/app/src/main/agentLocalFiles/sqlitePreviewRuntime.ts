import { mkdtempSync, writeFileSync, rmSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createOwnedDatabasePreview } from '../api/ownedDatabasePreview'
import { decodeSqlitePreviewSnapshot } from './sqlitePreviewProtocol'

/** Dedicated-child runtime only. Caller provides a trusted private scratch directory,
 * not a selected database path. Writes a sensitive bounded snapshot temporarily.
 * Must not run synchronously in MAIN; no live WAL/journal or source paths are read.
 * Caller supervisor must hold the operation until native child exit on cancellation.
 */
export function runOwnedSqliteSnapshotPreview(input: unknown, scratchRoot: string) {
  const { request, snapshot } = decodeSqlitePreviewSnapshot(input)
  const info = lstatSync(scratchRoot)
  if (!info.isDirectory() || info.isSymbolicLink() || !path.isAbsolute(scratchRoot)) throw new Error('Trusted private snapshot root unavailable.')
  const owned = mkdtempSync(path.join(scratchRoot, 'sqlite-preview-'))
  const databasePath = path.join(owned, 'snapshot.sqlite')
  let preview: ReturnType<typeof createOwnedDatabasePreview> | undefined
  let database: DatabaseSync | undefined
  try {
    writeFileSync(databasePath, snapshot, { flag: 'wx', mode: 0o600 })
    database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false, defensive: true })
    preview = createOwnedDatabasePreview(database)
    const result = preview.readTable(request.table, request.columns, request.limit)
    return { version: 1 as const, requestId: request.requestId, ...result,
      source: 'supplied-standalone-snapshot' as const, liveDatabaseConsistency: false as const }
  } finally {
    try { if (preview) preview.close(); else if (database?.isOpen) database.close() }
    finally { rmSync(owned, { recursive: true, force: true }) }
  }
}
