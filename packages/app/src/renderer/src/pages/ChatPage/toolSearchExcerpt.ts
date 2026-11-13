import { formatToolCallValue } from './chatToolCallDisplay'

const OMITTED = '[Tool excerpt omitted: insufficient bounded redaction context.]'
const SECRET_KEY = '(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|secret|secret[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|credential|credentials|client[_-]?secret)'
/** Redact known credential forms in bounded SOURCE context before cropping.
 * Masks preserve UTF-16 length so matches/cursors remain raw-source coordinates.
 * This is not arbitrary secret detection or a modification of the saved receipt.
 */
export function formatToolSearchExcerpt(source: string, start: number, length = 500): { text: string; omitted: boolean } {
  const prelude = source.slice(0, 1024)
  if (/^[\s\uFEFF]*$/.test(prelude) && source.length > 1024) return { text: OMITTED, omitted: true }
  if (/^[\s\uFEFF]*(?:\{|\[)/.test(prelude)) {
    // A line boundary is NOT a JSON sensitivity boundary. A parent credential
    // object or escaped key may precede the matching line; inspect bounded JSON
    // structurally, and omit the body if any sensitive key or excess structure exists.
    if (source.length > 65536) return { text: OMITTED, omitted: true }
    try {
      const parsed: unknown = JSON.parse(source.replace(/^\uFEFF/, ''))
      const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }]
      let nodes = 0
      while (pending.length) {
        const { value, depth } = pending.pop()!
        if (++nodes > 2048 || depth > 16) return { text: OMITTED, omitted: true }
        if (typeof value === 'string' && formatToolCallValue(value).text !== value) return { text: OMITTED, omitted: true }
        if (!value || typeof value !== 'object') continue
        for (const [key, child] of Object.entries(value)) {
          if (new RegExp(`^${SECRET_KEY}$`, 'i').test(key) || pending.length >= 2048) return { text: OMITTED, omitted: true }
          pending.push({ value: child, depth: depth + 1 })
        }
      }
    } catch { return { text: OMITTED, omitted: true } }
  }
  const left = Math.max(0, start - 8192)
  const prefix = source.slice(left, start)
  const newline = [prefix.indexOf('\n'), prefix.indexOf('\r')].filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? -1
  if (left > 0 && newline < 0) return { text: OMITTED, omitted: true }
  const from = left === 0 ? 0 : left + newline + 1
  const to = Math.min(source.length, start + length + 512)
  const context = source.slice(from, to)
  // Do not parse an unbounded JSON object to locate nested sensitive container values.
  // Conservatively omit when such a value occurs in the available line context.
  if (new RegExp(`(?:["']?${SECRET_KEY}["']?)\\s*[:=]\\s*[\\[{]`, 'i').test(context)) return { text: OMITTED, omitted: true }
  const spans: Array<[number, number]> = []
  const collect = (pattern: RegExp) => {
    for (const match of context.matchAll(pattern)) {
      const prefixLength = match[1]?.length ?? 0
      spans.push([match.index! + prefixLength, match.index! + match[0].length])
    }
  }
  collect(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi)
  collect(/(\b(?:(?:proxy[-_])?authorization|set[-_]cookie|cookie)\s*[:=]\s*)[^\r\n]*/gi)
  collect(/(https?:\/\/)[^\s/@:]+:[^\s/@]*(?:@|$)/gi)
  // Scan quoted values deterministically: a trailing escape never causes a
  // fallback to first-word masking. Unknown termination stays masked to boundary.
  const keys = new RegExp(`(?:["']?${SECRET_KEY}["']?)\\s*[:=]\\s*`, 'gi')
  for (const match of context.matchAll(keys)) {
    const a = match.index! + match[0].length
    let b = a
    const quote = context[a]
    if (quote === '"' || quote === "'") {
      b++
      while (b < context.length) {
        if (context[b] === '\\') { b = Math.min(context.length, b + 2); continue }
        if (context[b++] === quote) break
      }
    } else {
      while (b < context.length && !/[\s&,;}]/.test(context[b])) b++
    }
    spans.push([a, b])
  }
  if (spans.length > 256) return { text: OMITTED, omitted: true }
  let text = context
  for (const [a, b] of spans) {
    const mask = '[redacted]'.padEnd(b - a, '*').slice(0, b - a)
    text = text.slice(0, a) + mask + text.slice(b)
  }
  const excerpt = text.slice(start - from, start - from + length)
  return { text: formatToolCallValue(excerpt).text.slice(0, length), omitted: false }
}
