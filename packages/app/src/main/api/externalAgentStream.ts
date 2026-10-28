import type {
  LLMExternalAgentStreamReq,
  LLMExternalAgentStreamResp,
  LLMChatStreamResp
} from '@shared/api/svcLLMProxy'
import type { Config } from '@shared/config/config'
import { remoteFetch } from './remoteFetch'

const MAX_FRAME_BYTES = 512 * 1024
const MAX_EVENTS = 4096
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    const error =
      signal.reason instanceof Error
        ? signal.reason
        : new Error('External Agent request cancelled.')
    if (error.name === 'Error') error.name = 'AbortError'
    throw error
  }
}

/** Parse only response events, never execute tool instructions returned by a remote server. */
export const createExternalAgentEventDecoder = (options: {
  runId: string
  emit: (event: LLMExternalAgentStreamResp) => void
  validate?: (event: LLMChatStreamResp) => void
  signal?: AbortSignal
}) => {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let mode: 'sse' | 'ndjson' | 'json' = 'json'
  let pending = ''
  let content = ''
  let textBytes = 0
  let events = 0
  let terminal = false
  const ids = new Map<string, string>()
  const output = (event: LLMExternalAgentStreamResp): void => {
    abortIfNeeded(options.signal)
    options.validate?.(event)
    options.emit({ ...event, runId: options.runId })
    abortIfNeeded(options.signal)
  }
  const processValue = (value: unknown, eventId?: string): void => {
    if (terminal) return
    if (!record(value)) throw new Error('External Agent stream event must be an object.')
    if (++events > MAX_EVENTS) throw new Error('External Agent stream exceeded its event limit.')
    const id = eventId || (typeof value.eventId === 'string' ? value.eventId : undefined)
    if (id) {
      if (id.length > 512) throw new Error('External Agent event ID is too long.')
      const serialized = JSON.stringify(value)
      const previous = ids.get(id)
      if (previous !== undefined) {
        if (previous !== serialized)
          throw new Error('External Agent reused an event ID with conflicting data.')
        return
      }
      ids.set(id, serialized)
    }
    const type = value.type
    if (!['text-delta', 'attachment', 'session', 'done', 'error'].includes(String(type))) {
      throw new Error('External Agent returned an unsupported event type.')
    }
    if (type === 'text-delta') {
      if (typeof value.delta !== 'string')
        throw new Error('External Agent text delta must be a string.')
      textBytes += Buffer.byteLength(value.delta, 'utf8')
      if (textBytes > MAX_TEXT_BYTES)
        throw new Error('External Agent text exceeded its byte limit.')
      content += value.delta
    }
    const event = {
      type,
      delta: typeof value.delta === 'string' ? value.delta : '',
      done: type === 'done',
      ...(id ? { eventId: id } : {}),
      ...(typeof value.content === 'string' ? { content: value.content } : {}),
      ...(typeof value.fullContent === 'string' ? { fullContent: value.fullContent } : {}),
      ...(record(value.attachment) ? { attachment: value.attachment } : {}),
      ...(Array.isArray(value.attachments) ? { attachments: value.attachments } : {}),
      ...(typeof value.sessionUrl === 'string' ? { sessionUrl: value.sessionUrl } : {}),
      ...(typeof value.imageUrl === 'string' ? { imageUrl: value.imageUrl } : {}),
      ...(record(value.ocrResult) ? { ocrResult: value.ocrResult } : {}),
      ...(record(value.usage) ? { usage: value.usage } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(typeof value.finishReason === 'string' ? { finishReason: value.finishReason } : {}),
      metadata: { ...(record(value.metadata) ? value.metadata : {}), streaming: mode !== 'json' }
    } as LLMExternalAgentStreamResp
    if (type === 'done') {
      event.fullContent ??= event.content ?? content
      event.content ??= event.fullContent
      event.terminal = true
      terminal = true
    }
    if (type === 'error') {
      output(event)
      terminal = true
      output({
        type: 'done',
        delta: '',
        done: true,
        terminal: true,
        content,
        error: event.error || 'External Agent stream failed.',
        finishReason: 'error'
      })
      return
    }
    output(event)
  }
  const processFrame = (frame: string): void => {
    if (!frame.trim() || terminal) return
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES)
      throw new Error('External Agent stream frame is too large.')
    if (mode === 'ndjson') {
      processValue(JSON.parse(frame))
      return
    }
    let id: string | undefined
    const data: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('id:')) id = line.slice(3).trim()
    }
    if (!data.length) return
    const payload = data.join('\n').trim()
    if (payload === '[DONE]') {
      processValue({ type: 'done', content }, id)
      return
    }
    processValue(JSON.parse(payload), id)
  }
  const consume = (text: string): void => {
    pending += text
    if (mode === 'json') return
    const separator = mode === 'sse' ? /\r?\n\r?\n/ : /\r?\n/
    let match: RegExpExecArray | null
    while (!terminal && (match = separator.exec(pending))) {
      const frame = pending.slice(0, match.index)
      pending = pending.slice(match.index + match[0].length)
      processFrame(frame)
    }
    if (!terminal && Buffer.byteLength(pending, 'utf8') > MAX_FRAME_BYTES)
      throw new Error('External Agent stream frame is too large.')
  }
  return {
    headers(response: { status: number; statusText: string; contentType: string }): void {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `External Agent request failed (${response.status} ${response.statusText}).`
        )
      }
      const mime = response.contentType.toLowerCase().split(';')[0].trim()
      mode =
        mime === 'text/event-stream'
          ? 'sse'
          : ['application/x-ndjson', 'application/ndjson'].includes(mime)
            ? 'ndjson'
            : 'json'
    },
    chunk(chunk: Buffer): boolean {
      abortIfNeeded(options.signal)
      consume(decoder.decode(chunk, { stream: true }))
      return !terminal
    },
    end(): void {
      abortIfNeeded(options.signal)
      if (terminal) return
      consume(decoder.decode())
      if (terminal) return
      if (mode === 'json') {
        const parsed: unknown = JSON.parse(pending)
        const value = record(parsed)
          ? parsed
          : typeof parsed === 'string'
            ? { content: parsed }
            : null
        if (!value) throw new Error('External Agent returned an invalid JSON response.')
        const text =
          typeof value.content === 'string'
            ? value.content
            : typeof value.response === 'string'
              ? value.response
              : typeof value.text === 'string'
                ? value.text
                : ''
        processValue({
          ...value,
          type: 'done',
          content: text,
          metadata: { ...(record(value.metadata) ? value.metadata : {}), streaming: false }
        })
      } else {
        if (pending.trim()) processFrame(pending)
        if (!terminal)
          throw new Error(
            'incomplete-stream: External Agent stream ended without a terminal event.'
          )
      }
    },
    get completed(): boolean {
      return terminal
    },
    get partialContent(): string {
      return content
    }
  }
}

export const streamExternalAgent = async (
  req: LLMExternalAgentStreamReq,
  config: Config,
  options: {
    signal?: AbortSignal
    emit: (event: LLMExternalAgentStreamResp) => void
    validate?: (event: LLMChatStreamResp) => void
  }
): Promise<void> => {
  const decoder = createExternalAgentEventDecoder({
    ...options,
    runId: req.runId || crypto.randomUUID()
  })
  try {
    await remoteFetch(req, config, options.signal, {
      onResponse: decoder.headers,
      onChunk: decoder.chunk
    })
    decoder.end()
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { partialContent: decoder.partialContent })
    throw error
  }
}
