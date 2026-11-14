import { AGENT_THREAD_CARD_ICON_LIMIT } from '@shared/api/agentThreadCardDisplay'
import type { ToolHistoryEntry } from '@shared/llm/types'

const MAX_TEXT = 16_384

/** Untrusted card data can select only fixed theme tokens, never CSS or execution status. */
export function getToolCardAccent(accent: unknown): { borderColor: string; headerColor: string } | undefined {
  switch (accent) {
    case 'primary': return { borderColor: 'primary.main', headerColor: 'primary.main' }
    case 'info': return { borderColor: 'info.main', headerColor: 'info.main' }
    case 'success': return { borderColor: 'success.main', headerColor: 'success.main' }
    case 'warning': return { borderColor: 'warning.main', headerColor: 'warning.main' }
    case 'danger': return { borderColor: 'error.main', headerColor: 'error.main' }
    case 'neutral': return { borderColor: 'divider', headerColor: 'text.primary' }
    default: return undefined
  }
}
/** Only trusted fixed button props, never model CSS, a link, a default answer or approval. */
export function getToolCardActionStyle(style: unknown): { variant: 'contained' | 'outlined'; color: 'primary' | 'error' } | undefined {
  switch (style) {
    case 'primary': return { variant: 'contained', color: 'primary' }
    case 'secondary': return { variant: 'outlined', color: 'primary' }
    case 'danger': return { variant: 'contained', color: 'error' }
    default: return undefined
  }
}
const MAX_NODES = 512
const REDACTED = '[redacted]'
const sensitiveKey =
  /^(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|secret[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|credential|credentials|client[_-]?secret)$/i

// Display only. Never mutate the saved receipt or use the formatted text to replay calls.
const redactText = (value: string): string =>
  value
    .slice(0, MAX_TEXT)
    // eslint-disable-next-line no-control-regex -- Strip terminal ANSI escape sequences from display text.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex -- Strip invisible control and bidi formatting characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    // Headers may contain spaces (Basic auth) or multiple semicolon-separated
    // cookies. Conceal the whole line, not just the first token.
    .replace(
      /\b((?:proxy[-_])?authorization|set[-_]cookie|cookie)\s*[:=]\s*[^\r\n]*/gi,
      `$1: ${REDACTED}`
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /((?:["']?(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|secret[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi,
      `$1${REDACTED}`
    )

/** Decorative escaped text only; never an image, icon-class lookup, status or authority. */
export function getToolCardIcon(icon: unknown): string | undefined {
  if (typeof icon !== 'string' || icon.length > AGENT_THREAD_CARD_ICON_LIMIT) return undefined
  const text = redactText(icon)
  return text.trim() ? text : undefined
}

export function formatToolCallValue(value: unknown): { text: string; truncated: boolean } {
  let nodes = 0
  let remaining = MAX_TEXT
  let truncated = false
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > 8 || remaining <= 0) {
      truncated = true
      return '…'
    }
    if (typeof item === 'string') {
      if (item.length > remaining) truncated = true
      const text = redactText(item.slice(0, remaining))
      remaining -= Math.min(item.length, remaining)
      return text
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item !== 'object') return String(item)
    if (seen.has(item)) return '[circular]'
    seen.add(item)
    const entries = Object.entries(item)
    const rowLabel = entries.find(([key]) => key === 'label')?.[1]
    const sensitiveRow = !Array.isArray(item) && typeof rowLabel === 'string' && sensitiveKey.test(redactText(rowLabel).trim()) &&
      entries.some(([key]) => key === 'value') && entries.every(([key]) => ['label', 'value', 'inline'].includes(key))
    const output: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : {}
    for (const [key, child] of entries) {
      if (nodes >= MAX_NODES || remaining <= 0) {
        truncated = true
        break
      }
      const cleanKey = redactText(key.slice(0, 128))
      remaining -= Math.min(key.length, remaining)
      const result =
        sensitiveKey.test(key) || sensitiveKey.test(cleanKey) || key === 'value' && sensitiveRow ? REDACTED : visit(child, depth + 1)
      if (Array.isArray(output)) output.push(result)
      else
        Object.defineProperty(output, cleanKey, {
          value: result,
          enumerable: true,
          configurable: true
        })
    }
    seen.delete(item)
    return output
  }
  let input = value
  if (
    typeof value === 'string' &&
    value.length <= MAX_TEXT &&
    (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))
  ) {
    try {
      input = JSON.parse(value)
    } catch {
      /* Plain tool output need not be JSON. */
    }
  }
  const formatted = visit(input, 0)
  const text =
    typeof formatted === 'string' ? formatted : (JSON.stringify(formatted, null, 2) ?? '')
  return { text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT }
}

export function formatToolCardField(label: string, value: string): string {
  const cleanLabel = redactText(label)
  return formatToolCallValue(`${cleanLabel}: ${sensitiveKey.test(cleanLabel.trim()) ? REDACTED : value}`).text
}

export const toolCallSummary = (args: Record<string, unknown>): string =>
  formatToolCallValue(args).text.replace(/\s+/g, ' ').slice(0, 240)

const SUMMARY_VALUE_LIMIT = 50
const SUMMARY_LIMIT = 240

/**
 * One-line `key=value key=value` summary for the Agent column. It is built from
 * the output of formatToolCallValue, so sensitive keys and credential patterns
 * are masked exactly as in the expanded detail; each value is cut to 50
 * characters and the whole line to 240.
 */
export function toolCallArgumentSummary(args: Record<string, unknown>): string {
  const formatted = formatToolCallValue(args)
  let safe: unknown
  try {
    safe = JSON.parse(formatted.text)
  } catch {
    safe = undefined
  }
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return formatted.text.replace(/\s+/g, ' ').slice(0, SUMMARY_LIMIT)
  }
  const parts: string[] = []
  let length = 0
  for (const [key, value] of Object.entries(safe)) {
    if (length >= SUMMARY_LIMIT) break
    const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).replace(
      /\s+/g,
      ' '
    )
    const cut = text.length > SUMMARY_VALUE_LIMIT ? `${text.slice(0, SUMMARY_VALUE_LIMIT)}…` : text
    // Second pass on the joined pair: a credential pattern may only appear once key and value meet.
    const part = redactText(`${key}=${cut}`)
    parts.push(part)
    length += part.length + 1
  }
  return parts.join(' ').slice(0, SUMMARY_LIMIT)
}

export type ToolCallDisplayStatus = ToolHistoryEntry['status'] | 'unknown'

/** A saved call that never finished is shown as unknown, not as running or cancelled. */
export const toolCallDisplayStatus = (
  entry: ToolHistoryEntry,
  live: boolean
): ToolCallDisplayStatus => (entry.status === 'running' && !live ? 'unknown' : entry.status)

export const toolCallDisplayName = (entry: ToolHistoryEntry): string =>
  entry.toolName.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 128) || 'tool'

export const toolCallKey = (entry: ToolHistoryEntry): string =>
  JSON.stringify([entry.runId, entry.toolCallId])

export const TOOL_CALL_BATCH_THRESHOLD = 3

export type ToolCallGroup =
  | { kind: 'single'; key: string; entry: ToolHistoryEntry }
  | { kind: 'batch'; key: string; entries: ToolHistoryEntry[] }

/**
 * Folds every run of three or more consecutive plain calls into one batch. A
 * call that is not plain (it pins content under its line) stays a line of its
 * own and ends the run. The batch key comes from its first call, so calls
 * streamed into a running batch do not reset its expanded state.
 */
export function groupToolCalls(
  entries: readonly ToolHistoryEntry[],
  isPlain: (entry: ToolHistoryEntry) => boolean = () => true
): ToolCallGroup[] {
  const groups: ToolCallGroup[] = []
  let run: ToolHistoryEntry[] = []
  const flush = (): void => {
    if (run.length >= TOOL_CALL_BATCH_THRESHOLD) {
      groups.push({ kind: 'batch', key: `batch:${toolCallKey(run[0])}`, entries: run })
    } else {
      for (const entry of run) groups.push({ kind: 'single', key: toolCallKey(entry), entry })
    }
    run = []
  }
  for (const entry of entries) {
    if (isPlain(entry)) {
      run.push(entry)
      continue
    }
    flush()
    groups.push({ kind: 'single', key: toolCallKey(entry), entry })
  }
  flush()
  return groups
}

export interface ToolCallBatchSummary {
  /** Running first, then failed, cancelled, unknown; completed only when nothing else applies. */
  status: ToolCallDisplayStatus
  counts: Record<ToolCallDisplayStatus, number>
  /** Tool names with their number of calls, most frequent first. */
  names: Array<[name: string, count: number]>
}

export function summarizeToolCallBatch(
  entries: readonly ToolHistoryEntry[],
  live: boolean
): ToolCallBatchSummary {
  const counts: Record<ToolCallDisplayStatus, number> = {
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0
  }
  const names = new Map<string, number>()
  for (const entry of entries) {
    counts[toolCallDisplayStatus(entry, live)] += 1
    const name = toolCallDisplayName(entry)
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  const status = (['running', 'failed', 'cancelled', 'unknown'] as const).find(
    (key) => counts[key] > 0
  )
  return {
    status: status ?? 'completed',
    counts,
    // Array.prototype.sort is stable: equal counts keep the order of first use.
    names: [...names.entries()].sort((a, b) => b[1] - a[1])
  }
}

export function visibleToolCalls(
  history: readonly ToolHistoryEntry[] | undefined
): ToolHistoryEntry[] {
  const entries = new Map<string, ToolHistoryEntry>()
  if (!Array.isArray(history)) return []
  for (const entry of history.slice(-64)) {
    if (
      !entry ||
      typeof entry.runId !== 'string' ||
      typeof entry.toolCallId !== 'string' ||
      typeof entry.toolName !== 'string' ||
      !entry.args ||
      typeof entry.args !== 'object' ||
      Array.isArray(entry.args) ||
      !['running', 'completed', 'failed', 'cancelled'].includes(entry.status)
    )
      continue
    const key = JSON.stringify([entry.runId, entry.toolCallId])
    const old = entries.get(key)
    if (old && old.status !== 'running') continue
    entries.set(key, entry)
  }
  return [...entries.values()]
}
