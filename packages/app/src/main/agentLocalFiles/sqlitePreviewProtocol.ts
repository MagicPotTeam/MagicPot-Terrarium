import { z } from 'zod'

export const SQLITE_PREVIEW_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const identifier = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)
/** Child receives only an owned bounded snapshot, never a source path, grant or SQL. */
export const sqlitePreviewRequestSchema = z.object({
  version: z.literal(1), requestId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  snapshotBase64: z.string().min(1).max(Math.ceil(SQLITE_PREVIEW_MAX_SNAPSHOT_BYTES / 3) * 4),
  table: identifier, columns: z.array(identifier).min(1).max(16).refine(value => new Set(value).size === value.length),
  limit: z.number().int().min(1).max(100)
}).strict()
export type SqlitePreviewRequest = z.infer<typeof sqlitePreviewRequestSchema>

export function decodeSqlitePreviewSnapshot(input: unknown): { request: SqlitePreviewRequest; snapshot: Uint8Array } {
  const request = sqlitePreviewRequestSchema.parse(input)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.snapshotBase64)) throw new Error('Invalid snapshot encoding.')
  const snapshot = Buffer.from(request.snapshotBase64, 'base64')
  if (snapshot.length < 100 || snapshot.length > SQLITE_PREVIEW_MAX_SNAPSHOT_BYTES ||
    snapshot.toString('base64') !== request.snapshotBase64 || snapshot.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
    throw new Error('Invalid bounded SQLite snapshot.')
  }
  return { request, snapshot }
}
