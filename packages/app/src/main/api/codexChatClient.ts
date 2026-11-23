import crypto from 'node:crypto'
import {
  buildNativeToolDefinitions,
  extractNativeToolResult,
  projectNativeToolTurns
} from '@shared/llm/nativeTools'
import {
  OpenAIRequestControl,
  OPENAI_INTERACTIVE_IDLE_TIMEOUT_MS,
  OPENAI_ERROR_MAX_BYTES
} from '@shared/llm/openaiRequestControl'
import {
  retryModelCapacity,
  parseModelRetryAfter,
  modelCapacityReason
} from '@shared/llm/modelCapacityRetry'
import { nativeImage } from 'electron'
import type { LLMModelUse } from '@shared/config/config'
import type {
  ChatAttachment,
  FetchImpl,
  LLMCli,
  LLMChatParams,
  LLMChatResult,
  LLMChatMetadata
} from '@shared/llm'
import { describeFetchFailure, normalizeLLMChatResult } from '@shared/llm'
import { normalizeCodexModelName } from '@shared/extensions/codexModelCatalog'
import { normalizeReasoningEffort, resolveChatProfileCapabilities } from '@shared/llm'
import { selectMessagesForImageHistoryPolicy } from '@shared/llm/imageHistory'
import {
  buildDefaultOpenAIResponsesInclude,
  buildOpenAIResponsesInput,
  DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY,
  buildDefaultOpenAIWebSearchTool,
  buildOpenAIImageGenerationTool,
  assertOpenAIResponsesRequestBodySize,
  validateOpenAIResponsesImages,
  extractOpenAIResponsesOutput,
  serializeOpenAIResponsesOutput,
  shouldUseOpenAIImageGeneration
} from '@shared/llm/openaiResponses'
import {
  buildOpenAIFileSearchTool,
  createOpenAIFileSearchSession
} from '@shared/llm/openaiFileSearch'
import { persistCodexImageArtifacts } from '../llmProxy/codexAttachmentArtifacts'
import { ensureCodexCliAuthTokens, forceRefreshCodexCliAuthTokens, readExistingCodexReviewSession } from './codexOAuth'
import {
  assertCodexReviewParams,
  createCodexChatFingerprintPayload,
  createCodexOAuthGovernorIdentity,
  runWithCodexRequestGovernor
} from './codexRequestGovernor'

const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'

type CodexServiceTier = 'auto' | 'default' | 'flex' | 'priority'

type CodexStreamParseResult = {
  result: LLMChatResult
  error?: string
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const mergeMetadata = (
  existing: LLMChatMetadata | undefined,
  next: LLMChatMetadata | undefined
): LLMChatMetadata | undefined => {
  if (!existing && !next) {
    return undefined
  }

  return {
    ...(existing || {}),
    ...(next || {})
  }
}

const dedupeAttachments = (attachments: ChatAttachment[]): ChatAttachment[] => {
  const unique: ChatAttachment[] = []
  const seen = new Set<string>()

  for (const attachment of attachments) {
    const key =
      attachment.type === 'image'
        ? `${attachment.type}:${attachment.url}`
        : `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(attachment)
  }

  return unique
}

const readStringField = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

const extractCodexMetadata = (payload: Record<string, unknown>): LLMChatMetadata | undefined => {
  const metadata: LLMChatMetadata = {}

  const responseRecord = isPlainRecord(payload.response) ? payload.response : null
  const responseId =
    readStringField(payload, ['response_id', 'responseId']) ||
    (responseRecord ? readStringField(responseRecord, ['id']) : undefined)
  if (responseId) {
    metadata.responseId = responseId
  }

  const conversationId =
    readStringField(payload, ['conversation_id', 'conversationId']) ||
    (responseRecord
      ? readStringField(responseRecord, ['conversation_id', 'conversationId'])
      : undefined)
  if (conversationId) {
    metadata.conversationId = conversationId
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

const normalizeUsageCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const extractCodexUsage = (
  payload: Record<string, unknown>
): LLMChatResult['usage'] | undefined => {
  const response = isPlainRecord(payload.response) ? payload.response : undefined
  const usage = isPlainRecord(response?.usage)
    ? response.usage
    : isPlainRecord(payload.usage)
      ? payload.usage
      : undefined
  if (!usage) return undefined
  const details = isPlainRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const promptTokens = normalizeUsageCount(usage.input_tokens)
  const completionTokens = normalizeUsageCount(usage.output_tokens)
  const totalTokens = normalizeUsageCount(usage.total_tokens)
  const inputTextTokens = normalizeUsageCount(details?.text_tokens)
  const inputImageTokens = normalizeUsageCount(details?.image_tokens)
  return promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
    ? {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(inputTextTokens !== undefined ? { inputTextTokens } : {}),
        ...(inputImageTokens !== undefined ? { inputImageTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {})
      }
    : undefined
}

const extractSessionUrl = (payload: Record<string, unknown>): string | undefined => {
  const direct = readStringField(payload, ['session_url', 'sessionUrl'])
  if (direct) {
    return direct
  }

  const responseRecord = isPlainRecord(payload.response) ? payload.response : null
  if (!responseRecord) {
    return undefined
  }

  return readStringField(responseRecord, ['session_url', 'sessionUrl'])
}

function parseServerSentEventBlock(block: string): { data: string; event?: string } | null {
  const trimmed = block.trim()
  if (!trimmed) {
    return null
  }

  let eventName: string | undefined
  const dataLines: string[] = []

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }

  if (dataLines.length === 0) {
    return null
  }

  return {
    event: eventName,
    data: dataLines.join('\n')
  }
}

function findSseSeparator(buffer: string): { index: number; length: number } | null {
  const match = buffer.match(/\r?\n\r?\n/)
  if (!match || typeof match.index !== 'number') {
    return null
  }

  return {
    index: match.index,
    length: match[0].length
  }
}

type CodexStreamTerminalState =
  'completed' | 'failed' | 'truncated' | 'incomplete' | 'aborted' | 'timeout'

class CodexStreamError extends Error {
  readonly terminalState: Exclude<CodexStreamTerminalState, 'completed'>
  readonly finishReason: NonNullable<LLMChatResult['finishReason']>
  readonly partialResult: LLMChatResult

  constructor(
    message: string,
    terminalState: Exclude<CodexStreamTerminalState, 'completed'>,
    finishReason: NonNullable<LLMChatResult['finishReason']>,
    partialResult: LLMChatResult
  ) {
    super(message)
    this.name = 'CodexStreamError'
    this.terminalState = terminalState
    this.finishReason = finishReason
    this.partialResult = partialResult
  }
}

const CODEX_STREAM_MAX_BYTES = 128 * 1024 * 1024
const CODEX_STREAM_MAX_EVENT_BYTES = 64 * 1024 * 1024
const CODEX_STREAM_MAX_TEXT_BYTES = 8 * 1024 * 1024
const CODEX_STREAM_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const CODEX_STREAM_MAX_EVENTS = 100_000
const CODEX_STREAM_TIMEOUT_MS = 120_000

const normalizeCodexResponsesOutputEnvelope = (payload: unknown): unknown => {
  if (!isPlainRecord(payload)) {
    return payload
  }

  const type = typeof payload.type === 'string' ? payload.type : ''
  if (type === 'response.image_generation_call.partial_image') {
    const partialImage = payload.partial_image_b64
    if (typeof partialImage === 'string' && partialImage.trim()) {
      return {
        ...payload,
        type: 'image_generation_call',
        result: partialImage
      }
    }
  }

  if (type === 'response.output_item.done' && 'item' in payload) {
    return {
      ...payload,
      output: [payload.item]
    }
  }

  if (type === 'response.completed' && isPlainRecord(payload.response)) {
    return payload.response
  }

  return payload
}

async function readCodexStreamingText(
  response: Response,
  options?: {
    imageGeneration?: boolean
    onDelta?: LLMChatParams['onDelta']
    signal?: AbortSignal
    tools?: LLMChatParams['tools']
    streamTimeoutMs?: number
    control?: OpenAIRequestControl
  }
): Promise<CodexStreamParseResult> {
  if (!response.body) {
    throw new Error('Codex API returned an empty stream body.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const encoder = new TextEncoder()
  const signal = options?.signal
  const timeoutMs =
    typeof options?.streamTimeoutMs === 'number' &&
    Number.isFinite(options.streamTimeoutMs) &&
    options.streamTimeoutMs > 0
      ? options.streamTimeoutMs
      : CODEX_STREAM_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  let accumulated = ''
  let finalContent = ''
  let finishReason: LLMChatResult['finishReason']
  let sessionUrl: string | undefined
  let metadata: LLMChatMetadata | undefined
  let usage: LLMChatResult['usage'] | undefined
  let streamBytes = 0
  let textBytes = 0
  let eventCount = 0
  let hostedWorkStarted = false
  let onlyImageProgress = true
  let refusalReceived = false
  let nativeResult: Pick<LLMChatResult, 'toolCalls' | 'toolResponseItems'> = {}
  const completedNativeItems = new Map<number, Record<string, unknown>>()
  const imageAttachments: ChatAttachment[] = []

  const getErrorMessage = (error: unknown, fallback: string): string =>
    error instanceof Error && error.message.trim() ? error.message : fallback

  const checkAborted = (): void => {
    if (!signal?.aborted) return
    if (
      signal.reason instanceof Error &&
      'code' in signal.reason &&
      signal.reason.code === 'MODEL_REQUEST_TIMEOUT'
    )
      throw signal.reason
    const error = new Error('Codex stream was aborted.')
    error.name = 'AbortError'
    throw error
  }

  const setFinalText = (value: string): void => {
    const nextBytes = encoder.encode(value).byteLength
    if (nextBytes > CODEX_STREAM_MAX_TEXT_BYTES) {
      throw new Error('Codex streamed text exceeds its byte limit.')
    }
    finalContent = value
  }

  const setFinalStructuredOutput = (value: string): void => {
    const outputBytes = encoder.encode(value).byteLength
    if (outputBytes > CODEX_STREAM_MAX_OUTPUT_BYTES) {
      throw new Error('Codex structured output exceeds its byte limit.')
    }
    const normalized = normalizeLLMChatResult(value)
    if (encoder.encode(normalized.content).byteLength > CODEX_STREAM_MAX_TEXT_BYTES) {
      throw new Error('Codex streamed text exceeds its byte limit.')
    }
    finalContent = value
  }

  const pushImagesFromPayload = (payload: unknown): void => {
    checkAborted()
    const { images } = extractOpenAIResponsesOutput(normalizeCodexResponsesOutputEnvelope(payload))
    for (const image of images) {
      if (!image.url) {
        continue
      }

      const attachment: ChatAttachment = {
        type: 'image',
        url: image.url,
        ...(image.mimeType ? { mimeType: image.mimeType } : {}),
        ...(image.fileName ? { fileName: image.fileName } : {})
      }
      const deduped = dedupeAttachments([...imageAttachments, attachment])
      if (deduped.length === imageAttachments.length) {
        continue
      }

      imageAttachments.splice(0, imageAttachments.length, ...deduped)
      options?.onDelta?.({
        type: 'attachment',
        attachment
      })
      checkAborted()
    }
  }

  const buildResult = (state: CodexStreamTerminalState, partial: boolean): LLMChatResult => {
    const text = accumulated.trim()
    const normalized = normalizeLLMChatResult(finalContent.trim() || text)
    const attachments = dedupeAttachments([...(normalized.attachments || []), ...imageAttachments])
    const mergedMetadata = mergeMetadata(normalized.metadata, metadata) || {}
    const streamMetadata = {
      ...mergedMetadata,
      codexStream: {
        complete: !partial,
        partial,
        state
      }
    }

    const content =
      attachments.length > 0 && options?.imageGeneration ? '' : normalized.content || text || ''

    return {
      ...normalized,
      ...nativeResult,
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(sessionUrl ? { sessionUrl } : {}),
      ...(finishReason ? { finishReason } : {}),
      metadata: streamMetadata,
      ...(usage ? { usage } : {})
    }
  }

  function throwStreamFailure(
    terminalState: Exclude<CodexStreamTerminalState, 'completed'>,
    message: string,
    reason: NonNullable<LLMChatResult['finishReason']>
  ): never {
    finishReason = reason
    throw new CodexStreamError(message, terminalState, reason, buildResult(terminalState, true))
  }

  const readWithControl = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    checkAborted()
    if (options?.control)
      return options.control.wait(reader.read(), () => {
        void reader.cancel().catch(() => undefined)
      })
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      const error = new Error('Codex stream timed out.')
      error.name = 'TimeoutError'
      throw error
    }

    const readPromise = reader.read()
    void readPromise.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined
    const controlPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Codex stream timed out.')
        error.name = 'TimeoutError'
        void reader.cancel().catch(() => undefined)
        reject(error)
      }, remainingMs)
      abortHandler = () => {
        const error = new Error('Codex stream was aborted.')
        error.name = 'AbortError'
        void reader.cancel().catch(() => undefined)
        reject(error)
      }
      signal?.addEventListener('abort', abortHandler, { once: true })
      if (signal?.aborted) abortHandler()
    })

    try {
      return await Promise.race([readPromise, controlPromise])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (abortHandler) signal?.removeEventListener('abort', abortHandler)
    }
  }

  const processBlock = (block: string): LLMChatResult | undefined => {
    const parsedBlock = parseServerSentEventBlock(block)
    if (!parsedBlock) return undefined
    if (++eventCount > CODEX_STREAM_MAX_EVENTS) {
      throw new Error('Codex stream has too many events.')
    }

    const data = parsedBlock.data.trim()
    if (data === '[DONE]') {
      throwStreamFailure('truncated', 'Codex stream ended before response.completed.', 'error')
    }

    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(data) as unknown
      if (!isPlainRecord(parsed)) throw new Error('event is not an object')
      payload = parsed
    } catch (error) {
      throwStreamFailure(
        'failed',
        `Codex stream contains malformed JSON: ${getErrorMessage(error, 'invalid event')}`,
        'error'
      )
    }

    checkAborted()
    const nextSessionUrl = extractSessionUrl(payload)
    if (nextSessionUrl && nextSessionUrl !== sessionUrl) {
      sessionUrl = nextSessionUrl
      options?.onDelta?.({
        type: 'session',
        sessionUrl
      })
      checkAborted()
    }
    metadata = mergeMetadata(metadata, extractCodexMetadata(payload))
    usage = extractCodexUsage(payload) || usage

    const type = typeof payload.type === 'string' ? payload.type : ''
    const item = isPlainRecord(payload.item) ? payload.item : undefined
    refusalReceived ||=
      /^response\.refusal\./.test(type) ||
      (isPlainRecord(payload.part) && payload.part.type === 'refusal') ||
      (Array.isArray(item?.content) &&
        item.content.some((part) => isPlainRecord(part) && part.type === 'refusal'))
    if (type === 'response.failed' || type === 'error') {
      finishReason = 'error'
      const responseRecord = isPlainRecord(payload.response) ? payload.response : undefined
      const responseError = isPlainRecord(responseRecord?.error) ? responseRecord.error : undefined
      const payloadError = isPlainRecord(payload.error) ? payload.error : undefined
      const message =
        readStringField(responseError || {}, ['message']) ||
        readStringField(payloadError || {}, ['message']) ||
        readStringField(payload, ['message']) ||
        'Codex stream reported a provider failure.'
      const terminalOutput = extractOpenAIResponsesOutput(responseRecord)
      const hasTerminalOutput =
        Boolean(terminalOutput.text) ||
        terminalOutput.images.length > 0 ||
        (responseRecord?.output !== undefined &&
          (!Array.isArray(responseRecord.output) || responseRecord.output.length > 0))
      // Only relax the hosted-work guard for explicitly failed image progress.
      // Completed work, partial output and ambiguous transport failures still block retries.
      const failedImageWithoutOutput =
        options?.imageGeneration === true &&
        type === 'response.failed' &&
        onlyImageProgress &&
        responseRecord !== undefined &&
        (responseRecord.status === undefined || responseRecord.status === 'failed') &&
        !hasTerminalOutput
      try {
        throwStreamFailure('failed', message, 'error')
      } catch (error) {
        if (error instanceof Error)
          Object.assign(error, {
            providerError: responseError || payloadError || payload,
            retryAfterMs: parseModelRetryAfter(response.headers),
            retryBlocked:
              refusalReceived ||
              hasTerminalOutput ||
              (hostedWorkStarted && !failedImageWithoutOutput) ||
              Boolean(accumulated || finalContent) ||
              imageAttachments.length > 0
          })
        throw error
      }
    }

    if (type === 'response.incomplete') {
      const responseRecord = isPlainRecord(payload.response) ? payload.response : undefined
      const incompleteDetails = isPlainRecord(responseRecord?.incomplete_details)
        ? responseRecord.incomplete_details
        : undefined
      const reason = readStringField(incompleteDetails || {}, ['reason'])
      const serialized = serializeOpenAIResponsesOutput(responseRecord)
      if (serialized) setFinalStructuredOutput(serialized)
      finishReason = reason === 'max_output_tokens' ? 'length' : 'error'
      throwStreamFailure('incomplete', 'Codex response was incomplete.', finishReason)
    }

    if (
      /^response\.[a-z_]*_call(?:_[a-z_]+)?\./.test(type) ||
      ((type === 'response.output_item.added' || type === 'response.output_item.done') &&
        /(?:_call|tool)$/.test(String(item?.type ?? '')))
    ) {
      hostedWorkStarted = true
      const itemOutput = extractOpenAIResponsesOutput(item)
      onlyImageProgress &&=
        type === 'response.image_generation_call.in_progress' ||
        type === 'response.image_generation_call.generating' ||
        (type === 'response.output_item.added' &&
          item?.type === 'image_generation_call' &&
          item.status === 'in_progress' &&
          !itemOutput.text &&
          itemOutput.images.length === 0)
    }
    pushImagesFromPayload(payload)

    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      const deltaBytes = encoder.encode(payload.delta).byteLength
      if (textBytes + deltaBytes > CODEX_STREAM_MAX_TEXT_BYTES) {
        throw new Error('Codex streamed text exceeds its byte limit.')
      }
      textBytes += deltaBytes
      accumulated += payload.delta
      options?.onDelta?.({
        type: 'text-delta',
        delta: payload.delta
      })
      checkAborted()
    } else if (type === 'response.output_text.done' && typeof payload.text === 'string') {
      setFinalText(payload.text)
    } else if (type === 'response.content_part.done') {
      const serialized = serializeOpenAIResponsesOutput(payload.part)
      if (serialized) setFinalStructuredOutput(serialized)
    } else if (type === 'response.output_item.done') {
      if (
        isPlainRecord(payload.item) &&
        ['function_call', 'reasoning', 'message'].includes(String(payload.item.type)) &&
        Number.isSafeInteger(payload.output_index)
      )
        completedNativeItems.set(Number(payload.output_index), payload.item)
      const serialized = serializeOpenAIResponsesOutput(payload.item)
      if (serialized) setFinalStructuredOutput(serialized)
    } else if (type === 'response.completed') {
      const completed = isPlainRecord(payload.response) ? payload.response : {}
      const output: Record<string, unknown>[] = Array.isArray(completed.output)
        ? completed.output.filter(isPlainRecord)
        : []
      for (const [index, item] of [...completedNativeItems].sort((a, b) => a[0] - b[0])) {
        if (
          !output.some(
            (existing) =>
              (item.id && existing.id === item.id) ||
              (item.call_id && existing.call_id === item.call_id)
          )
        )
          output.splice(Math.min(index, output.length), 0, item)
      }
      if (options?.tools?.length)
        nativeResult = extractNativeToolResult({ ...completed, output }, options.tools, 'responses')
      const serialized = serializeOpenAIResponsesOutput({ ...completed, output })
      if (serialized) setFinalStructuredOutput(serialized)
      finishReason = nativeResult.toolCalls?.length ? 'tool_call' : 'stop'
      return buildResult('completed', false)
    }

    return undefined
  }

  const consumeDecoded = (decoded: string): LLMChatResult | undefined => {
    if (decoded) {
      buffer += decoded
      if (encoder.encode(buffer).byteLength > CODEX_STREAM_MAX_EVENT_BYTES) {
        throw new Error('Codex stream event exceeds its byte limit.')
      }
    }

    let separator = findSseSeparator(buffer)
    while (separator) {
      const block = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator.length)
      const result = processBlock(block)
      if (result) return result
      separator = findSseSeparator(buffer)
    }
    return undefined
  }

  try {
    checkAborted()
    while (true) {
      const { value, done } = await readWithControl()
      if (done) {
        const flushed = decoder.decode()
        const completed = consumeDecoded(flushed)
        if (completed) return { result: completed }
        if (buffer.trim()) {
          const finalBlock = buffer
          buffer = ''
          const finalResult = processBlock(finalBlock)
          if (finalResult) return { result: finalResult }
        }
        throwStreamFailure('truncated', 'Codex stream ended before response.completed.', 'error')
      }

      if (!value) throw new Error('Codex stream returned an empty chunk.')
      if (streamBytes + value.byteLength > CODEX_STREAM_MAX_BYTES) {
        throw new Error('Codex stream exceeds its byte limit.')
      }
      streamBytes += value.byteLength
      if (value.byteLength > 0) options?.control?.noteProgress()
      const decoded = decoder.decode(value, { stream: true })
      const completed = consumeDecoded(decoded)
      if (completed) return { result: completed }
    }
  } catch (error) {
    if (error instanceof CodexStreamError) throw error
    const isTimeout = error instanceof Error && error.name === 'TimeoutError'
    const isAborted =
      !isTimeout && (signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
    if (isAborted) {
      finishReason = 'cancelled'
      throwStreamFailure(
        'aborted',
        getErrorMessage(error, 'Codex stream was aborted.'),
        'cancelled'
      )
    }
    if (isTimeout) {
      finishReason = 'error'
      throw Object.assign(
        new CodexStreamError(
          getErrorMessage(error, 'Codex stream timed out.'),
          'timeout',
          'error',
          buildResult('timeout', true)
        ),
        {
          code: 'MODEL_REQUEST_TIMEOUT',
          retryBlocked:
            refusalReceived ||
            hostedWorkStarted ||
            Boolean(accumulated || finalContent) ||
            imageAttachments.length > 0 ||
            options?.imageGeneration === true
        }
      )
    }
    finishReason = 'error'
    return throwStreamFailure('failed', getErrorMessage(error, 'Codex stream failed.'), 'error')
  } finally {
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      // Reader cleanup must not mask the terminal stream result.
    }
    try {
      reader.releaseLock()
    } catch {
      // Reader cleanup must not mask the terminal stream result.
    }
  }
}

export const CODEX_IMAGE_TRANSFORM_POLICY = {
  version: 'native-image-original-v1',
  maxBytes: Infinity,
  maxPixels: Infinity,
  maxDimension: Infinity,
  patchSize: Infinity,
  maxPatches: Infinity,
  jpegQualities: [] as const
}
const CODEX_IMAGE_POLICY_CACHE_KEY = JSON.stringify(CODEX_IMAGE_TRANSFORM_POLICY)
const CODEX_IMAGE_CACHE_MAX_ENTRIES = 64
const CODEX_IMAGE_CACHE_MAX_ENCODED_BYTES = 64 * 1024 * 1024
type ProcessedImageCacheEntry = {
  attachment: Partial<ChatAttachment>
  encodedBytes: number
}
const processedImageCache = new Map<string, ProcessedImageCacheEntry>()
let processedImageCacheEncodedBytes = 0

const getProcessedImageCache = (key: string): Partial<ChatAttachment> | undefined => {
  const entry = processedImageCache.get(key)
  if (!entry) return undefined
  processedImageCache.delete(key)
  processedImageCache.set(key, entry)
  return entry.attachment
}

const setProcessedImageCache = (key: string, attachment: Partial<ChatAttachment>): void => {
  const encodedBytes = Buffer.byteLength(attachment.url || '', 'utf8')
  const existing = processedImageCache.get(key)
  if (existing) {
    processedImageCacheEncodedBytes -= existing.encodedBytes
    processedImageCache.delete(key)
  }
  processedImageCache.set(key, { attachment, encodedBytes })
  processedImageCacheEncodedBytes += encodedBytes
  while (
    processedImageCache.size > CODEX_IMAGE_CACHE_MAX_ENTRIES ||
    processedImageCacheEncodedBytes > CODEX_IMAGE_CACHE_MAX_ENCODED_BYTES
  ) {
    const oldestKey = processedImageCache.keys().next().value as string | undefined
    if (!oldestKey) break
    const oldest = processedImageCache.get(oldestKey)
    processedImageCache.delete(oldestKey)
    processedImageCacheEncodedBytes -= oldest?.encodedBytes || 0
  }
}

export const __resetCodexProcessedImageCacheForTests = (): void => {
  processedImageCache.clear()
  processedImageCacheEncodedBytes = 0
}

export const __getCodexProcessedImageCacheStatsForTests = (): {
  entries: number
  encodedBytes: number
} => ({
  entries: processedImageCache.size,
  encodedBytes: processedImageCacheEncodedBytes
})

export const resolveCodexImageTargetDimensions = (
  width: number,
  height: number
): { width: number; height: number } => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 }
  }

  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height))
  }
}

type CodexImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const CODEX_IMAGE_DATA_URL_PREFIX = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i

const detectCodexImageMimeType = (bytes: Buffer): CodexImageMimeType | null => {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif'
  }
  return null
}

export const parseCodexImageDataUrl = (
  value: string
): { mimeType: CodexImageMimeType; base64: string; bytes: Buffer } | null => {
  const trimmed = value.trim()
  const prefix = CODEX_IMAGE_DATA_URL_PREFIX.exec(trimmed)
  if (!prefix) return null

  const base64 = trimmed.slice(prefix[0].length)
  if (!base64 || base64.length % 4 !== 0) {
    throw new Error('Image data URL contains invalid base64 data.')
  }
  const paddingBytes = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const decodedBytes = (base64.length / 4) * 3 - paddingBytes
  if (decodedBytes > DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxDecodedBytesPerImage) {
    throw new Error(
      `Image exceeds the ${DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxDecodedBytesPerImage}-byte decoded limit.`
    )
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) {
    throw new Error('Image data URL contains invalid base64 data.')
  }

  return {
    mimeType: prefix[1].toLowerCase() as CodexImageMimeType,
    base64,
    bytes
  }
}

const preprocessCodexImageAttachment = (attachment: ChatAttachment): ChatAttachment => {
  const parsed = parseCodexImageDataUrl(attachment.url)
  if (!parsed) return attachment

  const detectedMimeType = detectCodexImageMimeType(parsed.bytes)
  if (!detectedMimeType) {
    throw new Error('Image bytes are invalid or use an unsupported format.')
  }
  if (detectedMimeType !== parsed.mimeType) {
    throw new Error(
      `Image MIME type mismatch: declared ${parsed.mimeType}, detected ${detectedMimeType}.`
    )
  }

  const attachmentMimeType = attachment.mimeType?.trim().toLowerCase()
  if (attachmentMimeType && attachmentMimeType !== parsed.mimeType) {
    throw new Error(
      `Image attachment MIME type mismatch: attachment declares ${attachmentMimeType}, data URL declares ${parsed.mimeType}.`
    )
  }

  const identity = crypto.createHash('sha256').update(parsed.bytes).digest('hex')
  const cacheKey = `${identity}:${CODEX_IMAGE_POLICY_CACHE_KEY}`
  const cached = getProcessedImageCache(cacheKey)
  if (cached) return { ...attachment, ...cached, media: attachment.media }

  const decoded = nativeImage.createFromBuffer(parsed.bytes)
  if (decoded.isEmpty()) throw new Error('Image bytes are invalid or use an unsupported format.')
  const size = decoded.getSize()
  if (!size.width || !size.height) throw new Error('Image dimensions are invalid.')
  const validated = {
    url: attachment.url,
    mimeType: parsed.mimeType,
    sourceWidth: size.width,
    sourceHeight: size.height,
    sizeBytes: parsed.bytes.byteLength
  }
  setProcessedImageCache(cacheKey, validated)
  return { ...attachment, ...validated }
}

const preprocessCodexImages = (messages: LLMChatParams['messages']): LLMChatParams['messages'] =>
  messages.map((message) => ({
    ...message,
    ...(message.attachments
      ? {
          attachments: message.attachments.map((attachment) =>
            attachment.type === 'image' ? preprocessCodexImageAttachment(attachment) : attachment
          )
        }
      : {})
  }))

type PreparedCodexResponsesInput = ReturnType<typeof buildOpenAIResponsesInput>

export const buildCodexResponsesInput = (
  messages: LLMChatParams['messages'],
  imageHistoryPolicy: NonNullable<LLMChatParams['imageHistoryPolicy']> = 'latest-user-turn'
): PreparedCodexResponsesInput => {
  const selectedMessages = selectMessagesForImageHistoryPolicy(messages, imageHistoryPolicy)
  const preprocessedMessages = preprocessCodexImages(selectedMessages)
  validateOpenAIResponsesImages(preprocessedMessages)
  return buildOpenAIResponsesInput(preprocessedMessages, {
    imageHistory: 'all'
  })
}

export class CodexChatGPTCli implements LLMCli {
  get toolFreeImageReviewEndpoint(): string | undefined {
    return this.supportsToolFreeImageReview && this.modelName.trim()
      ? `${CODEX_BACKEND_BASE_URL}/responses` : undefined
  }

  get supportsToolFreeImageReview(): boolean {
    return this.options?.modelUse !== 'image' && this.options?.modelUse !== 'video'
  }

  get supportsNativeTools(): boolean {
    return this.options?.modelUse !== 'image'
  }
  constructor(
    private readonly modelName: string,
    private readonly options?: {
      modelUse?: LLMModelUse
      serviceTier?: CodexServiceTier
      fetchImpl?: FetchImpl
      requestTimeoutMs?: number
    }
  ) {}

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    assertCodexReviewParams(params, this.modelName)
    if (params.readOnlyImageReview && !this.toolFreeImageReviewEndpoint) throw new Error('Select a chat model for image review.')
    // With provider tools off (subagents, memory helpers, side runs), text that merely
    // mentions drawing stays a text answer: only an image model or an explicit enable
    // asks for hosted image generation, and that is refused below.
    const useImageGeneration = this.shouldUseImageGeneration(
      params.disableProviderTools ? { ...params, disableAutomaticImageGeneration: true } : params
    )
    if (params.disableProviderTools && useImageGeneration) {
      throw new Error('Provider tools are disabled for this image generation request.')
    }
    const session = params.readOnlyImageReview
      ? await readExistingCodexReviewSession()
      : await ensureCodexCliAuthTokens()
    const requestId = crypto.randomUUID()
    return runWithCodexRequestGovernor(
      {
        identity: createCodexOAuthGovernorIdentity(session.accountId),
        endpoint: `${CODEX_BACKEND_BASE_URL}/responses`,
        fingerprint: createCodexChatFingerprintPayload(params, this.modelName)
      },
      () => this.chatWithFreshAuth(params, useImageGeneration, session, requestId)
    )
  }

  private shouldUseImageGeneration(
    params: Pick<
      LLMChatParams,
      'messages' | 'imageGenerationOptions' | 'disableAutomaticImageGeneration'
    >
  ): boolean {
    return shouldUseOpenAIImageGeneration({
      messages: params.messages,
      modelUse: this.options?.modelUse,
      imageGenerationOptions: params.imageGenerationOptions,
      disableAutomaticImageGeneration: params.disableAutomaticImageGeneration
    })
  }

  private async chatWithFreshAuth(
    params: LLMChatParams,
    useImageGeneration: boolean,
    initialSession: Awaited<ReturnType<typeof readExistingCodexReviewSession>>,
    requestId: string
  ): Promise<LLMChatResult> {
    let session = initialSession

    let fileSearchSession: Awaited<ReturnType<typeof createOpenAIFileSearchSession>> | null = null

    const selectedInput = buildCodexResponsesInput(params.messages, params.imageHistoryPolicy)
    const requestBody: Record<string, unknown> = {
      instructions: params.systemPrompt?.trim() || 'You are a helpful assistant.',
      input: [...selectedInput, ...projectNativeToolTurns(params.toolTurns, 'responses')],
      store: false,
      stream: true
    }
    const modelName = this.modelName.trim()
    if (modelName) {
      requestBody.model = normalizeCodexModelName(modelName)
    }
    const reasoningEffort = normalizeReasoningEffort(
      params.reasoningEffort,
      resolveChatProfileCapabilities({
        model_name: this.modelName,
        auth_mode: 'codex_oauth'
      }).reasoningEfforts
    )

    if (useImageGeneration) {
      requestBody.tools = [
        buildOpenAIImageGenerationTool({
          messages: params.messages,
          imageGenerationOptions: params.imageGenerationOptions
        })
      ]
      requestBody.tool_choice = {
        type: 'image_generation'
      }
    } else if (!params.disableProviderTools) {
      fileSearchSession = await createOpenAIFileSearchSession({
        apiKey: session.accessToken,
        baseUrl: OPENAI_API_BASE_URL,
        messages: params.messages,
        signal: params.signal,
        fetchImpl: this.options?.fetchImpl
      })

      requestBody.tools = [
        ...(fileSearchSession?.vectorStoreIds?.length
          ? [buildOpenAIFileSearchTool(fileSearchSession.vectorStoreIds)]
          : []),
        buildDefaultOpenAIWebSearchTool()
      ]
      requestBody.include = buildDefaultOpenAIResponsesInclude({
        includeFileSearchResults: Boolean(fileSearchSession?.vectorStoreIds?.length)
      })
    }

    if (params.tools?.length && !useImageGeneration) {
      requestBody.tools = [
        ...(Array.isArray(requestBody.tools) ? requestBody.tools : []),
        ...buildNativeToolDefinitions(params.tools, 'responses')
      ]
      requestBody.parallel_tool_calls = false
      requestBody.include = [
        ...(Array.isArray(requestBody.include) ? requestBody.include : []),
        'reasoning.encrypted_content'
      ]
    }
    if (this.options?.serviceTier) {
      requestBody.service_tier = this.options.serviceTier
    }

    if (reasoningEffort) {
      requestBody.reasoning = {
        effort: reasoningEffort
      }
    }

    const serializedBody = JSON.stringify(requestBody)
    assertOpenAIResponsesRequestBodySize(serializedBody)
    const endpoint = `${CODEX_BACKEND_BASE_URL}/responses`
    const fetchImpl = this.options?.fetchImpl ?? globalThis.fetch.bind(globalThis)

    try {
      let refreshed = false
      const sample = async (onDelta: LLMChatParams['onDelta']): Promise<CodexStreamParseResult> => {
        params.signal?.throwIfAborted()
        const control = new OpenAIRequestControl(
          fetchImpl,
          params.signal,
          this.options?.requestTimeoutMs ??
            (params.retryCapacity ? OPENAI_INTERACTIVE_IDLE_TIMEOUT_MS : CODEX_STREAM_TIMEOUT_MS),
          { idleTimeout: Boolean(params.retryCapacity) }
        )
        try {
          const send = () =>
            control.fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.accessToken}`,
                'Idempotency-Key': requestId
              },
              body: serializedBody,
              signal: params.signal
            })
          let response: Response
          try {
            response = await send()
          } catch (error) {
            params.signal?.throwIfAborted()
            control.check()
            const detail = describeFetchFailure(error)
            throw new Error(
              detail && detail.toLowerCase() !== 'fetch failed'
                ? `Codex API request failed for ${endpoint}: ${detail}`
                : `Codex API request failed for ${endpoint}`
            )
          }
          if (response.status === 401 && params.readOnlyImageReview) {
            await response.body?.cancel().catch(() => undefined)
            throw new Error('Codex image review session was rejected. Sign in separately and try again.')
          }
          if (response.status === 401 && !refreshed) {
            await response.body?.cancel().catch(() => undefined)
            refreshed = true
            session = await forceRefreshCodexCliAuthTokens()
            params.signal?.throwIfAborted()
            response = await send()
          }
          if (!response.ok) {
            const text = await control.text(response, OPENAI_ERROR_MAX_BYTES, true)
            throw Object.assign(
              new Error(`Codex API error: ${response.status} ${response.statusText} ${text}`),
              {
                statusCode: response.status,
                body: text,
                retryAfterMs: parseModelRetryAfter(response.headers)
              }
            )
          }
          return await readCodexStreamingText(response, {
            imageGeneration: useImageGeneration,
            tools: params.tools,
            onDelta,
            signal: control.signal,
            control
          })
        } catch (error) {
          if (
            useImageGeneration &&
            error instanceof Error &&
            modelCapacityReason(error) === 'request-timeout'
          )
            Object.assign(error, { retryBlocked: true })
          throw error
        } finally {
          control.dispose()
        }
      }
      const streamResult = params.retryCapacity
        ? await retryModelCapacity(params, sample)
        : await sample(params.onDelta)
      const persistedResult = await persistCodexImageArtifacts(streamResult.result, {
        enabled: useImageGeneration,
        conversationId:
          typeof params.conversationId === 'string' ? params.conversationId : undefined,
        responseId:
          typeof streamResult.result.metadata?.responseId === 'string'
            ? streamResult.result.metadata.responseId
            : undefined
      })
      const hasImageGenerationOutput =
        Boolean(persistedResult.imageUrl) || Boolean(persistedResult.attachments?.length)
      const hasUsableResult = useImageGeneration
        ? hasImageGenerationOutput
        : Boolean(persistedResult.content) ||
          hasImageGenerationOutput ||
          Boolean(persistedResult.toolCalls?.length)

      if (!hasUsableResult) {
        throw new Error(
          streamResult.error ||
            (useImageGeneration
              ? 'Codex API returned empty or invalid image generation content.'
              : 'Codex API returned empty or invalid streaming content.')
        )
      }

      return persistedResult
    } finally {
      if (fileSearchSession) {
        await fileSearchSession.cleanup()
      }
    }
  }
}
