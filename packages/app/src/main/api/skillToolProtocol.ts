export type RequestedSkillToolInvocation = {
  toolName: string
  args: Record<string, unknown>
}

export type SkillToolParseResult =
  | { kind: 'text' }
  | { kind: 'tool'; invocation: RequestedSkillToolInvocation }
  | { kind: 'invalid'; reason: 'malformed' | 'ambiguous' }

const MAX_TOOL_BYTES = 512 * 1024
const TOOL_KEYS = new Set(['toolName', 'args'])
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Only a leading, explicit tool frame is executable; never search prose for commands. */
function unwrapPrefix(content: string): { text: string; fenced: boolean; pending: boolean } {
  const text = content.trimStart()
  if (!text.startsWith('`')) return { text, fenced: false, pending: false }
  const fence = /^```(?:json)?[ \t]*\r?\n/i.exec(text)
  if (fence) return { text: text.slice(fence[0].length).trimStart(), fenced: true, pending: false }
  const pending = /^(?:`{1,3}|```(?:j|js|jso|json)[ \t]*\r?)$/i.test(text)
  return { text, fenced: false, pending }
}

/** Shared by the streaming gate and the final dispatcher so fenced JSON cannot leak first. */
export function classifySkillToolPrefix(content: string): 'pending' | 'tool' | 'text' {
  const start = unwrapPrefix(content)
  if (start.pending || !start.text) return 'pending'
  if (!start.text.startsWith('{')) return 'text'
  const firstKey = /^\{\s*"([^"\\]*)"\s*:/.exec(start.text)?.[1]
  if (firstKey !== undefined) return TOOL_KEYS.has(firstKey) ? 'tool' : 'text'
  return /^\{\s*}/.test(start.text) ? 'text' : 'pending'
}

/** Extract one balanced object without modifying escapes, paths, or argument values. */
function objectEnd(text: string): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '{' || c === '[') {
      if (++depth > 64) return -1
    } else if (c === '}' || c === ']') {
      if (--depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

export function parseSkillToolInvocation(
  content: string,
  allowedToolNames: ReadonlySet<string>
): SkillToolParseResult {
  const prefix = classifySkillToolPrefix(content)
  const start = unwrapPrefix(content)
  if (prefix === 'text') return { kind: 'text' }
  if (prefix === 'pending' && !/^\{\s*"(?:toolName|args)"/.test(start.text)) return { kind: 'text' }
  if (Buffer.byteLength(content, 'utf8') > MAX_TOOL_BYTES)
    return { kind: 'invalid', reason: 'malformed' }
  const end = objectEnd(start.text)
  if (end < 0) return { kind: 'invalid', reason: 'malformed' }
  let suffix = start.text.slice(end).trimStart()
  if (start.fenced) {
    if (!suffix.startsWith('```')) return { kind: 'invalid', reason: 'malformed' }
    suffix = suffix.slice(3).trimStart()
  }
  // A second frame is ambiguous. Do not select one silently or run a hidden second command.
  if (/^[{\[]|^```|\{\s*"(?:toolName|args)"\s*:/.test(suffix))
    return { kind: 'invalid', reason: 'ambiguous' }
  let parsed: unknown
  try {
    parsed = JSON.parse(start.text.slice(0, end)) as unknown
  } catch {
    return { kind: 'invalid', reason: 'malformed' }
  }
  if (!record(parsed)) return { kind: 'invalid', reason: 'malformed' }
  if (Object.keys(parsed).some((key) => !TOOL_KEYS.has(key))) return { kind: 'text' }
  if (typeof parsed.toolName !== 'string' || !parsed.toolName.trim())
    return { kind: 'invalid', reason: 'malformed' }
  const toolName = parsed.toolName.trim()
  if (!allowedToolNames.has(toolName)) return { kind: 'text' }
  const args = record(parsed.args)
    ? parsed.args
    : parsed.args === undefined || parsed.args === null
      ? {}
      : { input: parsed.args }
  return { kind: 'tool', invocation: { toolName, args } }
}
