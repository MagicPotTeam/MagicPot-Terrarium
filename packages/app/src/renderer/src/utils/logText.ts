export const MAX_LOG_LINES = 1000
export const MAX_LOG_CHARACTERS = 256 * 1024
export const MAX_LOG_LINE_CHARACTERS = 2048
export const MAX_LOG_ENTRY_LINES = 32
export const MAX_LOG_ENTRY_CHARACTERS = 16 * 1024
export const MAX_LOG_SCAN_CHARACTERS = 32 * 1024
export const LOG_REDACTION = '[base64 redacted]'
export const LOG_TRUNCATION = '[log truncated]'
export const LOG_HISTORY_NOTICE = '[older logs omitted: display limit]'

// Strip terminal control bytes deliberately, preserving tabs and normalized newlines.
// eslint-disable-next-line no-control-regex
const LOG_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

// Match whole tokens, not a greedy expression with a failing suffix. All regexes
// see only bounded samples, never the original megabyte-sized stream payload.
function redactSample(text: string): string {
  // Normalize first: otherwise removing a control byte can rejoin two short
  // fragments into an unredacted long payload (the terminal normalizes just once).
  const rows = text
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(LOG_CONTROL_BYTES, '')
    .split('\n')
  let wrappedDataUri = false
  return rows
    .map((rawLine) => {
      let line = rawLine
      if (wrappedDataUri) {
        const trimmed = line.trimStart()
        const token = /^[A-Za-z0-9+/_-]+={0,2}/.exec(trimmed)?.[0]
        const suffix = token ? trimmed.slice(token.length) : ''
        // MIME wrapping commonly uses 64/76 columns. Accept a short final row
        // only with padding or a closing delimiter; keep normal error lines.
        const closingDelimiter = /^["';,)\]}]/.test(suffix)
        if (token && (token.length >= 32 || token.endsWith('=') || closingDelimiter)) {
          line = LOG_REDACTION + suffix
          wrappedDataUri = suffix.trim().length === 0 && !token.endsWith('=')
        } else {
          wrappedDataUri = false
        }
      }
      line = line.replace(
        /data:image\/[^,\s"'<>]{1,200};base64,[A-Za-z0-9+/_=-]*/gi,
        (match, offset: number) => {
          wrappedDataUri =
            line.slice(offset + match.length).trim().length === 0 && !match.endsWith('=')
          return LOG_REDACTION
        }
      )
      // Headerless MIME rows also occur in separate stdout chunks and tail
      // samples. Keep the larger threshold for tokens inside ordinary text.
      return line
        .replace(/^[ \t]*[A-Za-z0-9+/_=-]{64,}[ \t]*$/, LOG_REDACTION)
        .replace(/[A-Za-z0-9+/_=-]+/g, (token) => (token.length >= 256 ? LOG_REDACTION : token))
    })
    .join('\n')
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = ` ${LOG_TRUNCATION} `
  const head = Math.floor((limit - marker.length) / 2)
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head))
}

/** Display-only normalization: never retain or split the original oversized input. */
export function normalizeLogText(message: string): string[] {
  let sample: string
  if (message.length > MAX_LOG_SCAN_CHARACTERS) {
    const half = MAX_LOG_SCAN_CHARACTERS / 2
    // Drop cut tokens, even short fragments, before redacting the two samples.
    const head = message
      .slice(0, half)
      .replace(/[A-Za-z0-9+/_=-]+/g, (token, offset: number) =>
        offset + token.length === half ? LOG_REDACTION : token
      )
    const tail = message.slice(-half).replace(/^[A-Za-z0-9+/_=-]+/, LOG_REDACTION)
    sample = `${redactSample(head)}\n${LOG_TRUNCATION}\n${redactSample(tail)}`
  } else {
    sample = redactSample(message)
  }
  let lines = sample.split('\n')
  if (lines.length > MAX_LOG_ENTRY_LINES) {
    lines = [
      ...lines.slice(0, MAX_LOG_ENTRY_LINES / 2),
      LOG_TRUNCATION,
      ...lines.slice(-(MAX_LOG_ENTRY_LINES / 2 - 1))
    ]
  }
  // Share the entry budget among its physical rows. Keep both ends of long
  // diagnostics, including the final exception after a large multiline payload.
  const rowLimit = Math.min(
    MAX_LOG_LINE_CHARACTERS,
    Math.floor(MAX_LOG_ENTRY_CHARACTERS / lines.length) - 1
  )
  return lines.map((line) => truncateMiddle(line, rowLimit))
}

export interface BoundedLogResult {
  lines: string[]
  removed: number
}

/** Inputs are normalized rows; budgets include a newline per row. */
export function retainLogLines(
  previous: readonly string[],
  incoming: readonly string[],
  maxLines = MAX_LOG_LINES,
  maxCharacters = MAX_LOG_CHARACTERS
): BoundedLogResult {
  const count = previous.length + incoming.length
  let start = count
  let characters = 0
  while (start > 0 && count - start < maxLines) {
    const index = start - 1
    const line = index < previous.length ? previous[index] : incoming[index - previous.length]
    if (characters + line.length + 1 > maxCharacters) break
    characters += line.length + 1
    start -= 1
  }
  const lines =
    start < previous.length
      ? [...previous.slice(start), ...incoming]
      : incoming.slice(start - previous.length)
  return { lines, removed: start }
}

/** Walk newest first, so a huge batch never normalizes an unbounded number of entries. */
export function normalizeLogBatch(messages: readonly string[], maxLines = MAX_LOG_LINES): string[] {
  const limit = Math.max(0, Math.min(MAX_LOG_LINES, Math.floor(maxLines) || 0))
  const reversed: string[] = []
  let characters = 0
  for (let index = messages.length - 1; index >= 0 && reversed.length < limit; index -= 1) {
    const lines = normalizeLogText(messages[index])
    for (let row = lines.length - 1; row >= 0; row -= 1) {
      if (reversed.length >= limit || characters + lines[row].length + 1 > MAX_LOG_CHARACTERS) {
        return reversed.reverse()
      }
      reversed.push(lines[row])
      characters += lines[row].length + 1
    }
  }
  return reversed.reverse()
}
