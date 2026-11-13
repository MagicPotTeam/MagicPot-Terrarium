import { z } from 'zod'
import { sqlitePreviewRequestSchema } from './sqlitePreviewProtocol'
const responseSchema = z.object({ ok: z.literal(true), result: z.object({
  version: z.literal(1), requestId: z.string().max(64),
  rows: z.array(z.record(z.string().max(64), z.union([z.string().max(4096).refine(value => Buffer.byteLength(value) <= 4096), z.number().finite(), z.null()]))).max(100),
  truncated: z.boolean(), returnedBytes: z.number().int().min(2).max(65536),
  source: z.literal('supplied-standalone-snapshot'), nativeWorkBounded: z.literal(false), liveDatabaseConsistency: z.literal(false)
}).strict() }).strict()
export type SqlitePreviewChild = {
  postMessage(frame: string): void; kill(): void
  on(event: 'message' | 'exit' | 'error' | 'spawn', callback: (value: unknown) => void): void
  removeAllListeners(): void
}
/** Dedicated child lifecycle only. Trusted caller supplies fixed verified entry/scratch.
 * Timeout/cancel requests kill, but never releases the slot before confirmed exit.
 * A child which never exits deliberately quarantines this one-slot supervisor.
 */
export function createSqlitePreviewSupervisor(spawn: () => SqlitePreviewChild, cleanupAfterExit: () => void) {
  let occupied = false
  return Object.freeze({
    isOccupied: () => occupied,
    async run(input: unknown, signal: AbortSignal, timeoutMs = 5000): Promise<unknown> {
      signal.throwIfAborted()
      const request = sqlitePreviewRequestSchema.parse(input)
      if (occupied) throw new Error('SQLite preview is active or awaiting child exit.')
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('Invalid SQLite preview deadline.')
      occupied = true
      let child: SqlitePreviewChild
      try { child = spawn() } catch {
        try { cleanupAfterExit(); occupied = false } catch { /* Keep quarantined if snapshot cleanup fails. */ }
        throw new Error('SQLite preview child unavailable.')
      }
      return new Promise((resolve, reject) => {
        let failed = false, response: unknown, seen = false, exited = false
        const stop = () => { failed = true; try { child.kill() } catch { /* Await native exit, never fake closure. */ } }
        const timer = setTimeout(stop, timeoutMs)
        const abort = () => stop()
        signal.addEventListener('abort', abort, { once: true })
        child.on('message', frame => {
          if (failed || seen) { stop(); return }
          seen = true
          try {
            if (typeof frame !== 'string' || Buffer.byteLength(frame) > 131072) throw new Error('Invalid SQLite response.')
            const parsed = responseSchema.parse(JSON.parse(frame))
            if (!parsed || parsed.ok !== true || parsed.result?.requestId !== request.requestId || parsed.result?.version !== 1 ||
              parsed.result?.source !== 'supplied-standalone-snapshot' || parsed.result?.nativeWorkBounded !== false ||
              parsed.result?.liveDatabaseConsistency !== false || !Array.isArray(parsed.result.rows) || parsed.result.rows.length > request.limit ||
              Buffer.byteLength(JSON.stringify(parsed.result.rows)) > 65536 ||
              parsed.result.rows.some(row => Object.keys(row).length !== request.columns.length || Object.keys(row).some(key => !request.columns.includes(key)))) throw new Error('Invalid SQLite response.')
            response = parsed.result
          } catch { stop() }
        })
        child.on('error', stop)
        child.on('exit', code => {
          if (exited) return
          exited = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
          child.removeAllListeners()
          try { cleanupAfterExit(); occupied = false }
          catch { reject(new Error('SQLite snapshot cleanup failed; operation quarantined.')); return }
          if (failed || signal.aborted || code !== 0 || !seen || !response) reject(new Error('SQLite preview failed or cancelled.'))
          else resolve(response)
        })
        child.on('spawn', () => {
          if (failed || signal.aborted) { stop(); return }
          try { child.postMessage(JSON.stringify(request)) } catch { stop() }
        })
        if (signal.aborted) stop()
      })
    }
  })
}
