/** Provider wire framing only. Tool definitions come from the main-owned allowlist;
 * parsing a call never authorizes it or runs a tool. */
export type LLMFunctionTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
export type LLMFunctionCall = {
  id: string
  name: string
  wireName: string
  arguments: string
}
export type LLMToolTurn = {
  content: string
  calls: LLMFunctionCall[]
  results: Array<{ callId: string; output: string }>
  /** Opaque provider output, including encrypted reasoning, for this request only. */
  responseItems?: Record<string, unknown>[]
}
const MAX_CALL_BYTES = 512 * 1024
export const MAX_NATIVE_TRANSCRIPT_BYTES = 8 * 1024 * 1024
export const MAX_AGENT_TOOL_CALLS = 64
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const byteLength = (v: string): number => new TextEncoder().encode(v).byteLength
const clone = <T>(value: T, limit = MAX_NATIVE_TRANSCRIPT_BYTES): T => {
  const text = JSON.stringify(value)
  if (byteLength(text) > limit) throw new Error('Native tool transcript exceeded its byte budget.')
  return JSON.parse(text) as T
}
const bindings = (tools: readonly LLMFunctionTool[]) => {
  if (tools.length > 128) throw new Error('Too many bound native tools (maximum 128).')
  const names = new Set<string>()
  return tools.map((tool, index) => {
    if (!tool.name || names.has(tool.name) || !record(tool.inputSchema))
      throw new Error('Invalid or duplicate native tool definition.')
    names.add(tool.name)
    // Function names cannot contain dots; keep a collision-free per-request map.
    return { tool, alias: `mp_tool_${index}` }
  })
}
export function buildNativeToolDefinitions(
  tools: readonly LLMFunctionTool[],
  mode: 'responses' | 'chat-completions'
): Record<string, unknown>[] {
  return bindings(tools).map(({ tool, alias }) => {
    const definition = {
      name: alias,
      description: `${tool.name}: ${tool.description}`,
      parameters: clone(tool.inputSchema, MAX_CALL_BYTES),
      // Do not mutate MCP schemas/optional argument semantics to fake strict compliance.
      strict: false
    }
    return mode === 'responses'
      ? { type: 'function', ...definition }
      : { type: 'function', function: definition }
  })
}
const hasControlCharacter = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !hasControlCharacter(value)
  )
}
export function prepareNativeToolBatch(
  calls: readonly LLMFunctionCall[],
  tools: readonly LLMFunctionTool[]
): Array<{ call: LLMFunctionCall; args: Record<string, unknown> }> {
  if (!calls.length || calls.length > MAX_AGENT_TOOL_CALLS)
    throw new Error('Invalid native tool batch size.')
  const mapping = new Map(bindings(tools).map(({ tool, alias }) => [alias, tool.name]))
  const ids = new Set<string>()
  // Validate the whole batch before the first effectful tool can start.
  return calls.map((call) => {
    if (!validId(call.id) || ids.has(call.id))
      throw new Error('Invalid or duplicate native tool call id.')
    ids.add(call.id)
    if (mapping.get(call.wireName) !== call.name)
      throw new Error('Model requested an unbound native tool.')
    if (typeof call.arguments !== 'string' || byteLength(call.arguments) > MAX_CALL_BYTES)
      throw new Error('Native tool arguments exceeded their byte budget.')
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      throw new Error('Native tool arguments are not valid JSON.')
    }
    if (!record(args)) throw new Error('Native tool arguments must be a JSON object.')
    return { call: { ...call }, args }
  })
}
export function extractNativeToolResult(
  payload: unknown,
  tools: readonly LLMFunctionTool[],
  mode: 'responses' | 'chat-completions'
): { toolCalls?: LLMFunctionCall[]; toolResponseItems?: Record<string, unknown>[] } {
  if (!record(payload)) return {}
  const first =
    Array.isArray(payload.choices) && record(payload.choices[0]) ? payload.choices[0] : undefined
  const message = record(first?.message) ? first.message : undefined
  const output = Array.isArray(payload.output) ? payload.output : []
  const raw =
    mode === 'responses'
      ? output.filter((item) => record(item) && item.type === 'function_call')
      : Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : []
  if (!raw.length) return {}
  if (
    (payload.status !== undefined && payload.status !== 'completed') ||
    first?.finish_reason === 'length' ||
    first?.finish_reason === 'content_filter'
  )
    throw new Error('Incomplete native tool calls are not executable.')
  const mapping = new Map(bindings(tools).map(({ tool, alias }) => [alias, tool.name]))
  const toolCalls = raw.map((item) => {
    if (
      !record(item) ||
      (mode === 'chat-completions' && item.type !== 'function') ||
      (item.status !== undefined && item.status !== 'completed')
    )
      throw new Error('Invalid native tool call frame.')
    const fn = mode === 'responses' ? item : record(item.function) ? item.function : {}
    const wireName = typeof fn.name === 'string' ? fn.name : ''
    const name = mapping.get(wireName)
    if (!name) throw new Error('Model requested an unbound native tool.')
    return {
      id: (mode === 'responses' ? item.call_id : item.id) as string,
      name,
      wireName,
      arguments: fn.arguments as string
    }
  })
  prepareNativeToolBatch(toolCalls, tools)
  return {
    toolCalls,
    ...(mode === 'responses' ? { toolResponseItems: clone(output.filter(record)) } : {})
  }
}
export function projectNativeToolTurns(
  turns: readonly LLMToolTurn[] = [],
  mode: 'responses' | 'chat-completions'
): Record<string, unknown>[] {
  const projected: Record<string, unknown>[] = []
  const ids = new Set<string>()
  for (const turn of turns) {
    if (turn.calls.length !== turn.results.length)
      throw new Error('Native tool calls/results are not paired.')
    const results = new Map(turn.results.map((result) => [result.callId, result.output]))
    if (results.size !== turn.calls.length) throw new Error('Duplicate native tool result.')
    for (const call of turn.calls) {
      if (
        !validId(call.id) ||
        ids.has(call.id) ||
        !results.has(call.id) ||
        typeof results.get(call.id) !== 'string'
      )
        throw new Error('Native tool calls/results are not paired.')
      ids.add(call.id)
    }
    if (mode === 'responses') {
      const output = turn.responseItems ?? [
        ...(turn.content
          ? [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: turn.content }]
              }
            ]
          : []),
        ...turn.calls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.wireName,
          arguments: call.arguments
        }))
      ]
      const emitted = output.filter((item) => item.type === 'function_call')
      if (
        emitted.length !== turn.calls.length ||
        emitted.some(
          (item, i) =>
            item.call_id !== turn.calls[i].id ||
            item.name !== turn.calls[i].wireName ||
            item.arguments !== turn.calls[i].arguments
        )
      )
        throw new Error('Native response items do not match executed tool calls.')
      projected.push(
        ...clone(output),
        ...turn.calls.map((call) => ({
          type: 'function_call_output',
          call_id: call.id,
          output: results.get(call.id)!
        }))
      )
    } else {
      projected.push({
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.wireName, arguments: call.arguments }
        }))
      })
      projected.push(
        ...turn.calls.map((call) => ({
          role: 'tool',
          tool_call_id: call.id,
          content: results.get(call.id)!
        }))
      )
    }
  }
  return clone(projected)
}

/** Fallback is only for an explicit pre-execution capability rejection, never a timeout/5xx. */
export function isNativeToolsUnsupportedError(error: unknown): boolean {
  if (!record(error) || ![400, 404, 422].includes(Number(error.statusCode ?? error.status)))
    return false
  if (error.retryBlocked === true || error.partialContent || error.partialResult) return false
  const text = [error.message, error.body]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .slice(0, 65536)
  return /(?:tools?|tool_choice|parallel_tool_calls|function(?:\s+calling)?)[^\n]{0,80}(?:not supported|unsupported|not allowed|unknown parameter)|(?:unsupported|unknown|unrecognized)\s+(?:parameter|field)[:\s"']+(?:tools|tool_choice|parallel_tool_calls)\b/i.test(
    text
  )
}
