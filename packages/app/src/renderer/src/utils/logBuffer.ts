import { normalizeLogText } from './logText'

export const LOG_FLUSH_INTERVAL_MS = 300
export const LOG_BATCH_LINES = 200
export const LOG_BATCH_CHARACTERS = 64 * 1024

/** A fixed ring: neither a burst nor a stalled timer can grow the pending queue. */
export function createLogBuffer(onFlush: (lines: string[]) => void) {
  const rows = new Array<string | undefined>(LOG_BATCH_LINES)
  let start = 0
  let count = 0
  let characters = 0
  let omitted = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    rows.fill(undefined)
    start = 0
    count = 0
    characters = 0
    omitted = 0
  }

  const flush = () => {
    const output: string[] = []
    if (omitted > 0) output.push(`[${omitted} pending log rows omitted: display limit]`)
    for (let index = 0; index < count; index += 1) {
      output.push(rows[(start + index) % LOG_BATCH_LINES]!)
    }
    clear()
    if (!disposed && output.length > 0) onFlush(output)
  }

  return {
    push(message: string) {
      if (disposed) return
      for (const line of normalizeLogText(message)) {
        // Reserve one row and 128 characters for the overflow diagnostic.
        while (
          count >= LOG_BATCH_LINES - 1 ||
          characters + line.length + 1 > LOG_BATCH_CHARACTERS - 128
        ) {
          characters -= rows[start]!.length + 1
          rows[start] = undefined
          start = (start + 1) % LOG_BATCH_LINES
          count -= 1
          omitted += 1
        }
        rows[(start + count) % LOG_BATCH_LINES] = line
        count += 1
        characters += line.length + 1
      }
      // Never flush synchronously at the size threshold, even during huge replays.
      if (timer === undefined) timer = setTimeout(flush, LOG_FLUSH_INTERVAL_MS)
    },
    clear,
    dispose() {
      disposed = true
      clear()
    }
  }
}
