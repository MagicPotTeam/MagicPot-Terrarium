import { constants, type DatabaseSync, type SQLInputValue } from 'node:sqlite'

/** Installs a restrictive policy on a dedicated, caller-owned connection only.
 * Never use this on EventStore/shared application connections. Does not open databases,
 * grant a path read, enforce a native CPU deadline or make arbitrary databases safe.
 */
export function createOwnedDatabasePreview(db: DatabaseSync) {
  if (!db.isOpen || typeof db.setAuthorizer !== 'function') throw new Error('Owned SQLite authorizer unavailable.')
  db.enableDefensive(true)
  db.setAuthorizer(action => [constants.SQLITE_SELECT, constants.SQLITE_READ].includes(action)
    ? constants.SQLITE_OK : constants.SQLITE_DENY)
  let closed = false
  return Object.freeze({
    readTable(table: string, columns: readonly string[], limit = 100) {
      if (closed || !db.isOpen) throw new Error('Database preview closed.')
      const identifier = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/
      if (!identifier.test(table) || !columns.length || columns.length > 16 || columns.some(column => !identifier.test(column)) ||
        new Set(columns).size !== columns.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid bounded table selection.')
      const sql = `SELECT ${columns.map(column => `"${column}"`).join(',')} FROM "${table}" LIMIT ?`
      const rows: Array<Record<string, string | number | null>> = []
      let bytes = 2
      let truncated = false
      for (const row of db.prepare(sql).iterate(limit + 1 as SQLInputValue)) {
        if (rows.length >= limit) { truncated = true; break }
        const projected: Record<string, string | number | null> = Object.create(null)
        for (const column of columns) {
          const value = row[column]
          if (value instanceof Uint8Array || typeof value === 'bigint' || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Unsupported database preview value.')
          if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error('Unsupported database preview value.')
          if (typeof value === 'string' && (value.length > 4096 || Buffer.byteLength(value) > 4096)) throw new Error('Database preview cell exceeds return cap.')
          projected[column] = value
        }
        const next = Buffer.byteLength(JSON.stringify(projected)) + 1
        if (bytes + next > 65536) { truncated = true; break }
        bytes += next; rows.push(projected)
      }
      return { rows, truncated, returnedBytes: bytes, nativeWorkBounded: false as const }
    },
    close() { closed = true; if (db.isOpen) db.close() }
  })
}
