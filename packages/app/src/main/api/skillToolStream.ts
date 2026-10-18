import type { LLMDeltaEvent } from '@shared/llm'

const MAX_PENDING_TOOL_BYTES = 512 * 1024

/** Keep ambiguous tool JSON private, but release ordinary prose as soon as it is identifiable. */
export const createSkillToolStream = (emit?: (event: LLMDeltaEvent) => void) => {
  let pending: LLMDeltaEvent[] = []
  let prefix = ''
  let ordinaryText = false
  let finished = false
  let pendingBytes = 0

  const flush = (): void => {
    ordinaryText = true
    const events = pending
    pending = []
    prefix = ''
    pendingBytes = 0
    for (const event of events) emit?.(event)
  }

  const onDelta = (event: LLMDeltaEvent): void => {
    // Provider-step completion must never terminate the outer multi-step Agent turn.
    if (finished || event.type === 'done') return
    if (ordinaryText || event.type === 'error') {
      emit?.(event)
      return
    }
    pending.push(event)
    pendingBytes += Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (pendingBytes > MAX_PENDING_TOOL_BYTES) {
      throw new Error('Ambiguous skill-tool response exceeded the bounded stream buffer.')
    }
    if (event.type !== 'text-delta' || !event.delta) return
    prefix += event.delta
    const candidate = prefix.trimStart()
    if (!candidate) return
    if (candidate[0] !== '{') {
      flush()
      return
    }
    // Only the exact toolName/args object protocol can become a tool call.
    const firstKey = /^\{\s*"([^"\\]*)"\s*:/.exec(candidate)?.[1]
    if (firstKey !== undefined && firstKey !== 'toolName' && firstKey !== 'args') flush()
  }

  const finish = (isToolCall: boolean): void => {
    if (finished) return
    if (!isToolCall) flush()
    else {
      // Continuation and artifact references are separate from private invocation text.
      for (const event of pending) {
        if (event.type !== 'text-delta') emit?.(event)
      }
      pending = []
      prefix = ''
      pendingBytes = 0
    }
    finished = true
  }
  return { onDelta, finish }
}
