import { OpenAIRequestControl, OPENAI_IMAGE_JSON_MAX_BYTES } from './openaiRequestControl'
import type { LLMChatFinishReason, LLMChatMetadata, LLMChatParams } from './types'

const MAX_EVENT_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 100_000
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const isResponseImageItemType = (value: Record<string, unknown>): boolean => {
  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : ''
  return type === 'image_generation_call'
}

const responseImageSource = (value: Record<string, unknown>, depth = 0): string | undefined => {
  if (depth > 2) return undefined
  const candidates = [value.result, value.b64_json, value.url, value.image_url]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const nested = record(item)
        const source = nested ? responseImageSource(nested, depth + 1) : undefined
        if (source) return source
      }
    } else {
      const nested = record(candidate)
      const source = nested ? responseImageSource(nested, depth + 1) : undefined
      if (source) return source
    }
  }
  return undefined
}

const isFinalResponseImageItem = (value: Record<string, unknown>): boolean =>
  isResponseImageItemType(value) && Boolean(responseImageSource(value))

const normalizeOutputIndex = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const responseItemKeys = (
  value: Record<string, unknown>,
  fallbackOutputIndex?: unknown
): string[] => {
  const keys: string[] = []
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (id) keys.push(`id:${id}`)
  const outputIndex =
    normalizeOutputIndex(value.output_index) ?? normalizeOutputIndex(fallbackOutputIndex)
  if (outputIndex !== undefined) keys.push(`output_index:${outputIndex}`)
  if (!keys.length && isFinalResponseImageItem(value)) {
    const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : ''
    const source = responseImageSource(value)
    if (source) keys.push(`image:${type}:${source}`)
  }
  return keys
}

/** UTF-8 and SSE framing are incremental; neither fetch nor a frame read can outlive control. */
async function* events(response: Response, control: OpenAIRequestControl): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  let lineParts: string[] = [],
    lineBytes = 0,
    skipLF = false,
    data: string[] = [],
    dataBytes = 0,
    count = 0
  const add = (line: string) => {
    if (line === 'data' || line.startsWith('data:')) {
      const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '')
      dataBytes += encoder.encode(value).byteLength + 1
      if (dataBytes > MAX_EVENT_BYTES)
        throw new Error('OpenAI stream event exceeds its byte limit.')
      data.push(value)
    }
  }
  const appendLinePart = (part: string) => {
    lineBytes += encoder.encode(part).byteLength
    if (lineBytes + dataBytes > MAX_EVENT_BYTES) {
      throw new Error('OpenAI stream event exceeds its byte limit.')
    }
    if (part) lineParts.push(part)
  }
  for await (const bytes of control.chunks(response, OPENAI_IMAGE_JSON_MAX_BYTES)) {
    // Each character is scanned once; fragmented large image events must not cause
    // quadratic whole-buffer rescans. CR, LF and split CRLF all delimit lines.
    for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
      control.check()
      const fragment = decoder.decode(bytes.subarray(offset, offset + 16_384), { stream: true })
      let start = 0
      for (let index = 0; index < fragment.length; index += 1) {
        const character = fragment[index]
        if (skipLF) {
          skipLF = false
          if (character === '\n') {
            start = index + 1
            continue
          }
        }
        if (character !== '\r' && character !== '\n') continue
        appendLinePart(fragment.slice(start, index))
        const line = lineParts.join('')
        lineParts = []
        lineBytes = 0
        skipLF = character === '\r'
        start = index + 1
        if (!line) {
          if (data.length) {
            if (++count > MAX_EVENTS) throw new Error('OpenAI stream has too many events.')
            const value = data.join('\n')
            data = []
            dataBytes = 0
            yield value
          }
        } else add(line)
      }
      appendLinePart(fragment.slice(start))
    }
  }
  appendLinePart(decoder.decode())
  // A terminal event must have been fully delimited. EOF is not a completion signal.
  if (lineParts.length || data.length)
    throw new Error('OpenAI stream ended with an incomplete event.')
}

export async function readOpenAIStream(
  response: Response,
  control: OpenAIRequestControl,
  mode: 'responses' | 'chat-completions',
  onDelta: NonNullable<LLMChatParams['onDelta']>
): Promise<{ payload: Record<string, unknown>; finishReason: LLMChatFinishReason }> {
  let text = '',
    textBytes = 0,
    finish: LLMChatFinishReason | undefined
  let usage: unknown
  let hostedWorkStarted = false
  const imageParts: Record<string, unknown>[] = []
  const responseImageFallbacks: Array<{
    item: Record<string, unknown>
    keys: string[]
  }> = []
  const responseImageKeys = new Set<string>()
  const toolCalls = new Map<
    number,
    { id?: string; type: 'function'; function: { name: string; arguments: string } }
  >()
  const encoder = new TextEncoder()
  const cacheResponseImageItem = (item: Record<string, unknown>, outputIndex?: unknown) => {
    if (!isFinalResponseImageItem(item)) return
    const keys = responseItemKeys(item, outputIndex)
    if (keys.some((key) => responseImageKeys.has(key))) return
    for (const key of keys) responseImageKeys.add(key)
    responseImageFallbacks.push({ item, keys })
  }
  const streamMetadata: LLMChatMetadata = {
    streaming: {
      upstreamProtocol: 'sse',
      upstreamIncremental: true
    }
  }
  const emit = (delta: unknown) => {
    if (typeof delta !== 'string' || !delta) return
    control.check()
    textBytes += encoder.encode(delta).byteLength
    if (textBytes > MAX_TEXT_BYTES) throw new Error('OpenAI streamed text exceeds its byte limit.')
    text += delta
    onDelta({ type: 'text-delta', delta, metadata: streamMetadata })
    control.check()
  }
  for await (const data of events(response, control)) {
    control.check()
    if (data === '[DONE]') {
      if (mode !== 'chat-completions' || !finish) {
        throw new Error('OpenAI stream ended before its terminal completion.')
      }
      const content = imageParts.length ? [{ type: 'text', text }, ...imageParts] : text
      const payload = {
        choices: [
          {
            message: { content, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) }
          }
        ],
        usage
      }
      control.check()
      return { payload, finishReason: finish }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new Error('OpenAI stream contains malformed JSON.')
    }
    control.check()
    const event = record(parsed)
    if (!event) throw new Error('OpenAI stream contains an invalid event.')
    if (event.error || event.type === 'error' || event.type === 'response.failed') {
      const error = record(event.error) || record(record(event.response)?.error)
      const detail = error?.message || event.message
      throw Object.assign(
        new Error(
          typeof detail === 'string' ? detail : 'OpenAI stream reported a provider failure.'
        ),
        {
          providerError: error,
          retryBlocked:
            hostedWorkStarted || Boolean(text) || toolCalls.size > 0 || imageParts.length > 0
        }
      )
    }
    if (
      typeof event.type === 'string' &&
      (/^response\.(?:image_generation_call|web_search_call|file_search_call|code_interpreter_call)\./.test(
        event.type
      ) ||
        (event.type === 'response.output_item.added' &&
          /(?:_call|tool)$/.test(String(record(event.item)?.type ?? ''))))
    )
      hostedWorkStarted = true
    if (mode === 'responses') {
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        emit(event.delta)
      } else if (event.type === 'response.image_generation_call.partial_image') {
        // A preview is not a completed image. partial_image_index counts previews,
        // not output items; never promote it to an output_index or a final result.
        // Only completed image calls may be used by the final attachment serializer.
        continue
      } else if (event.type === 'response.output_item.done') {
        // Some Responses-compatible gateways surface the image-generation call only
        // on the item event. Keep it in the final payload so normal extraction can
        // materialize the returned base64 image.
        const item = record(event.item)
        if (item) cacheResponseImageItem(item, event.output_index)
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const payload = record(event.response)
        if (!payload) throw new Error('OpenAI stream completion has no response.')
        const reason = record(payload.incomplete_details)?.reason
        if (event.type === 'response.incomplete' && reason !== 'max_output_tokens') {
          throw new Error(
            `OpenAI response is incomplete: ${typeof reason === 'string' ? reason : 'unknown reason'}.`
          )
        }
        // Refusals use a separate SDK field; retain them as visible text for the existing serializer.
        const completedOutput = Array.isArray(payload.output)
          ? payload.output.map((item) => {
              const value = record(item)
              if (!value || !Array.isArray(value.content)) return item
              return {
                ...value,
                content: value.content.map((part) => {
                  const content = record(part)
                  return content?.type === 'refusal' && typeof content.refusal === 'string'
                    ? { ...content, type: 'output_text', text: content.refusal }
                    : part
                })
              }
            })
          : []
        const completedOutputKeys = new Set<string>()
        for (let outputIndex = 0; outputIndex < completedOutput.length; outputIndex += 1) {
          const value = record(completedOutput[outputIndex])
          if (!value) continue
          for (const key of responseItemKeys(value, outputIndex)) completedOutputKeys.add(key)
        }
        const missingCachedImages = responseImageFallbacks
          .filter(({ keys }) => !keys.some((key) => completedOutputKeys.has(key)))
          .map(({ item }) => item)
        const normalizedOutput =
          completedOutput.length || missingCachedImages.length
            ? [...completedOutput, ...missingCachedImages]
            : undefined
        const normalized = {
          ...payload,
          ...(normalizedOutput ? { output: normalizedOutput } : {})
        }
        control.check()
        return {
          payload: normalized,
          finishReason: event.type === 'response.incomplete' ? 'length' : 'stop'
        }
      }
    } else {
      if (event.usage) usage = event.usage
      const choices = Array.isArray(event.choices) ? event.choices : []
      const choice = choices.map(record).find((entry) => entry?.index === 0)
      if (!choice) continue
      const delta = record(choice.delta)
      if (finish && (delta?.content || delta?.refusal || delta?.images || delta?.tool_calls)) {
        throw new Error('OpenAI stream returned content after its finish marker.')
      }
      if (Array.isArray(delta?.content)) {
        for (const part of delta.content) {
          const value = record(part)
          if (!value) continue
          emit(value.text)
          if (value.type === 'image_url' || value.url || value.image_url) imageParts.push(value)
        }
      } else emit(delta?.content)
      if (Array.isArray(delta?.images)) {
        for (const part of delta.images) {
          const value = record(part)
          if (value) imageParts.push(value)
        }
      }
      emit(delta?.refusal)
      if (Array.isArray(delta?.tool_calls)) {
        for (const part of delta.tool_calls) {
          const value = record(part)
          if (
            !value ||
            !Number.isSafeInteger(value.index) ||
            Number(value.index) < 0 ||
            Number(value.index) > 1023
          ) {
            throw new Error('OpenAI stream has an invalid tool-call index.')
          }
          const index = Number(value.index)
          const call = toolCalls.get(index) || {
            type: 'function' as const,
            function: { name: '', arguments: '' }
          }
          if (typeof value.id === 'string') call.id = value.id
          const fn = record(value.function)
          if (typeof fn?.name === 'string') call.function.name += fn.name
          if (typeof fn?.arguments === 'string') call.function.arguments += fn.arguments
          toolCalls.set(index, call)
        }
      }
      if (choice.finish_reason) {
        if (choice.finish_reason === 'content_filter')
          throw new Error('OpenAI stream was stopped by a content filter.')
        if (
          !['stop', 'length', 'tool_calls', 'function_call'].includes(String(choice.finish_reason))
        ) {
          throw new Error('OpenAI stream returned an unknown finish reason.')
        }
        finish =
          choice.finish_reason === 'length'
            ? 'length'
            : ['tool_calls', 'function_call'].includes(String(choice.finish_reason))
              ? 'tool_call'
              : 'stop'
      }
    }
  }
  throw new Error('OpenAI stream ended before its terminal completion.')
}
