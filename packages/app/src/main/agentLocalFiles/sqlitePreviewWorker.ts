import { runOwnedSqliteSnapshotPreview } from './sqlitePreviewRuntime'

export type SqlitePreviewPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(value: unknown): void
}
/** One bounded request per dedicated child. No source path, argv, env or repeated runs. */
export function runSqlitePreviewWorker(port: SqlitePreviewPort, scratchRoot: string, exit: (code: number) => void) {
  let consumed = false
  port.on('message', event => {
    if (consumed) { exit(2); return }
    consumed = true
    try {
      if (typeof event.data !== 'string' || event.data.length > 12 * 1024 * 1024) throw new Error('Invalid request frame')
      const result = runOwnedSqliteSnapshotPreview(JSON.parse(event.data), scratchRoot)
      port.postMessage(JSON.stringify({ ok: true, result }))
      exit(0)
    } catch {
      port.postMessage(JSON.stringify({ ok: false, code: 'SQLITE_PREVIEW_FAILED' }))
      exit(2)
    }
  })
}
