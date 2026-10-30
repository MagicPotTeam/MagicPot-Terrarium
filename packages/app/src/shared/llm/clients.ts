/**
 * Shared LLM API Client implementations — used by both main process and renderer process.
 *
 * These classes were previously duplicated in:
 *   - packages/app/src/renderer/.../api/LLM.ts (OpenAIAPICli, GeminiAPICli, ClaudeAPICli, OllamaAPICli)
 *   - packages/app/src/main/api/svcLLMProxyImpl.ts (OpenAIAPICli, GeminiAPICli, ClaudeAPICli)
 *
 * Now unified here as the single source of truth for all chat() implementations.
 * Renderer-only features (generatePrompt, compressImage) remain in the renderer LLM.ts.
 */

import { retryModelCapacity, parseModelRetryAfter, modelCapacityReason } from './modelCapacityRetry'
import { ModelConnectionError } from './modelConnectionError'
import type { LLMModelUse } from '@shared/config/config'
import {
  buildNativeToolDefinitions,
  extractNativeToolResult,
  projectNativeToolTurns
} from './nativeTools'
import { selectMessagesForImageHistoryPolicy } from './imageHistory'
import { validateImageRequestContract } from './imageRequestContract'
import {
  type LLMCli,
  type LLMChatMetadata,
  type LLMChatParams,
  type LLMChatResult,
  type LLMImageHistoryPolicy,
  normalizeLLMChatResult
} from './types'
import {
  assertOpenAIResponsesRequestBodySize,
  buildDefaultOpenAIResponsesInclude,
  buildOpenAIResponsesInput,
  buildDefaultOpenAIWebSearchTool,
  buildOpenAIImageGenerationTool,
  DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY,
  OPENAI_RESPONSES_IMAGE_URL_ERROR,
  normalizeOpenAIImageGenerationOptions,
  serializeOpenAIResponsesOutput,
  shouldUseOpenAIImageGeneration,
  validateOpenAIResponsesImages
} from './openaiResponses'
import { buildOpenAIFileSearchTool, createOpenAIFileSearchSession } from './openaiFileSearch'
import {
  OpenAIRequestControl,
  ProviderRequestControl,
  OPENAI_CHAT_DEADLINE_MS,
  OPENAI_INTERACTIVE_IDLE_TIMEOUT_MS,
  OPENAI_IMAGE_DEADLINE_MS,
  OPENAI_JSON_MAX_BYTES,
  OPENAI_IMAGE_JSON_MAX_BYTES,
  OPENAI_ERROR_MAX_BYTES,
  PROVIDER_CHAT_DEADLINE_MS,
  PROVIDER_JSON_MAX_BYTES
} from './openaiRequestControl'
import { readOpenAIStream } from './openaiStreaming'
import {
  normalizeReasoningEffort,
  resolveChatProfileCapabilities,
  type ChatCapabilityProfile
} from './profileCapabilities'
import { normalizeLLMStructuredOutput } from './structuredOutput'
import { buildModelInvocationHeaders } from './modelInvocationContract'
import {
  OPENCODE_ZEN_API_BASE_URL,
  resolveOpencodeZenAlias,
  resolveOpencodeZenModelApi
} from './opencodeZenModels'

type OpenAIServiceTier = 'auto' | 'default' | 'flex' | 'priority'
export type OpenAIClientApiMode = 'auto' | 'responses' | 'chat-completions' | 'images'
export type OpenAIClientOptions = {
  modelUse?: LLMModelUse
  serviceTier?: OpenAIServiceTier
  callType?: string
  maxInputImages?: number
  fetchImpl?: FetchImpl
  imageAttachmentLoader?: OpenAIImageAttachmentLoader
  requireImageAttachmentLoader?: boolean
  apiMode?: OpenAIClientApiMode
  enableHostedTools?: boolean
  /** Enable provider-hosted web search without creating hosted file-search resources. */
  enableHostedWebSearch?: boolean
  /** Force Responses requests to use SSE even when the caller did not provide onDelta. */
  forceStreaming?: boolean
  /** Internal per-call override; finite, clamped by the request controller. */
  requestTimeoutMs?: number
  extraHeaders?: Record<string, string>
  reasoningProfile?: ChatCapabilityProfile
}
type GeminiAuthMode = 'query-key' | 'bearer' | 'x-goog-api-key'
type GeminiClientOptions = {
  fetchImpl?: FetchImpl
  authMode?: GeminiAuthMode
  extraHeaders?: Record<string, string>
  /** Per-call wall-clock deadline; bounded by ProviderRequestControl. */
  requestTimeoutMs?: number
}
type ClaudeClientOptions = {
  fetchImpl?: FetchImpl
  authAsBearer?: boolean
  extraHeaders?: Record<string, string>
  maxTokens?: number
  /** Per-call wall-clock deadline; bounded by ProviderRequestControl. */
  requestTimeoutMs?: number
}
type ProviderClientOptions = {
  fetchImpl?: FetchImpl
  requestTimeoutMs?: number
}

export type FetchImpl = typeof fetch
export type OpenAIImageAttachmentLoader = (
  url: URL,
  signal?: AbortSignal
) => Promise<{ blob: Blob; finalUrl?: URL }>

type OpenAIUpstreamStreamingMetadata = {
  upstreamProtocol: 'sse' | 'json'
  upstreamIncremental: boolean
  fallbackReason?: 'upstream-json'
}

type OpenAIUpstreamStreamingMetadataRef = {
  current?: OpenAIUpstreamStreamingMetadata
}

const withOpenAIUpstreamStreamingMetadata = (
  metadata: LLMChatMetadata | undefined,
  streaming: OpenAIUpstreamStreamingMetadata
): LLMChatMetadata => ({
  ...(metadata || {}),
  streaming
})

const invocationHeaders = (params: Pick<LLMChatParams, 'invocation'>): Record<string, string> =>
  params.invocation ? buildModelInvocationHeaders(params.invocation) : {}

/** Unary providers still honor the shared stream contract with one safe delta. */
const emitUnaryProviderDelta = (params: LLMChatParams, content: string): void => {
  if (!params.onDelta || params.structuredOutput || !content) return
  params.onDelta({
    type: 'text-delta',
    delta: content,
    content,
    finishReason: 'stop'
  })
}

const getDefaultFetchImpl = (): FetchImpl => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Fetch API is unavailable in this runtime.')
  }

  return globalThis.fetch.bind(globalThis) as FetchImpl
}

const normalizeErrorText = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

const normalizeTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const normalizeProviderTokenUsage = (payload: unknown): LLMChatResult['usage'] | undefined => {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined
  const rawUsage =
    record?.usage && typeof record.usage === 'object'
      ? (record.usage as Record<string, unknown>)
      : record?.usageMetadata && typeof record.usageMetadata === 'object'
        ? (record.usageMetadata as Record<string, unknown>)
        : record
  const promptTokens = normalizeTokenCount(
    rawUsage?.promptTokens ??
      rawUsage?.prompt_tokens ??
      rawUsage?.inputTokens ??
      rawUsage?.input_tokens ??
      rawUsage?.promptTokenCount ??
      rawUsage?.prompt_eval_count
  )
  const completionTokens = normalizeTokenCount(
    rawUsage?.completionTokens ??
      rawUsage?.completion_tokens ??
      rawUsage?.outputTokens ??
      rawUsage?.output_tokens ??
      rawUsage?.candidatesTokenCount ??
      rawUsage?.eval_count
  )
  const totalTokens = normalizeTokenCount(
    rawUsage?.totalTokens ?? rawUsage?.total_tokens ?? rawUsage?.totalTokenCount
  )

  return promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
    ? {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {})
      }
    : undefined
}

const collectFetchFailureFragments = (error: unknown, fragments: Set<string>, depth = 0): void => {
  if (!error || depth > 6) {
    return
  }

  if (typeof AggregateError !== 'undefined' && error instanceof AggregateError) {
    for (const nestedError of error.errors) {
      collectFetchFailureFragments(nestedError, fragments, depth + 1)
    }
  }

  if (error instanceof Error) {
    const code =
      typeof (error as NodeJS.ErrnoException).code === 'string'
        ? String((error as NodeJS.ErrnoException).code).trim()
        : ''
    const message = normalizeErrorText(error.message)

    if (message && message.toLowerCase() !== 'fetch failed') {
      fragments.add(
        code && !message.toLowerCase().includes(code.toLowerCase()) ? `${code} ${message}` : message
      )
    } else if (code) {
      fragments.add(code)
    }

    const cause = (error as Error & { cause?: unknown }).cause
    if (cause) {
      collectFetchFailureFragments(cause, fragments, depth + 1)
    }
    return
  }

  const fallback = normalizeErrorText(error)
  if (fallback && fallback.toLowerCase() !== 'fetch failed') {
    fragments.add(fallback)
  }
}

export function describeFetchFailure(error: unknown): string {
  const fragments = new Set<string>()
  collectFetchFailureFragments(error, fragments)

  if (fragments.size > 0) {
    const detail = [...fragments].join(' | ')
    if (/198\.18\.\d+\.\d+/.test(detail)) {
      return `${detail} The connection target resolved to a 198.18.x.x Fake-IP address. If you use Clash/V2Ray/TUN/Fake-IP mode, route this app through that proxy or use a directly reachable model endpoint.`
    }
    return detail
  }

  if (error instanceof Error) {
    const message = normalizeErrorText(error.message)
    return message || 'fetch failed'
  }

  return normalizeErrorText(error) || 'fetch failed'
}

const sanitizeEndpointForMessage = (endpoint: string): string => {
  try {
    const parsed = new URL(endpoint)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return endpoint
  }
}

export class UpstreamHttpError extends Error {
  readonly statusCode: number
  readonly statusText: string
  readonly body: string
  readonly retryAfterMs?: number

  constructor(
    provider: string,
    response: Pick<Response, 'status' | 'statusText'> & Partial<Pick<Response, 'headers'>>,
    body: string
  ) {
    const detail = body.trim()
    const safeDetail = detail.slice(0, OPENAI_ERROR_MAX_BYTES)
    super(
      `${provider} API error: ${response.status} ${response.statusText}${safeDetail ? ` Server message: ${safeDetail}` : ''}`
    )
    this.name = 'UpstreamHttpError'
    this.statusCode = response.status
    this.statusText = response.statusText
    this.body = body
    this.retryAfterMs = parseModelRetryAfter(response.headers)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

const buildUpstreamHttpError = (
  provider: string,
  response: Pick<Response, 'status' | 'statusText'>,
  body: string
): UpstreamHttpError => new UpstreamHttpError(provider, response, body)

const readProviderHttpError = async (
  provider: string,
  response: Response,
  control: ProviderRequestControl
): Promise<UpstreamHttpError> => {
  let body = '',
    bodyReadFailed = false,
    bodyReadError: unknown
  const decoder = new TextDecoder()
  try {
    if (!response.body) body = await control.text(response, OPENAI_ERROR_MAX_BYTES, true)
    else {
      let bytesRead = 0
      for await (const bytes of control.chunks(response, Number.MAX_SAFE_INTEGER)) {
        const count = Math.min(bytes.byteLength, OPENAI_ERROR_MAX_BYTES - bytesRead)
        body += decoder.decode(bytes.subarray(0, count), { stream: true })
        bytesRead += count
        if (bytesRead === OPENAI_ERROR_MAX_BYTES) break
      }
      control.check()
    }
  } catch (error) {
    bodyReadFailed = true
    bodyReadError = error
  }
  body += decoder.decode()
  // Status was already received. A broken diagnostic body is a secondary cause,
  // not permission to replace a real 502/504 with a transport/timeout error.
  const failure = buildUpstreamHttpError(provider, response, body)
  if (bodyReadFailed)
    Object.defineProperty(failure, 'cause', { value: bodyReadError, configurable: true })
  return failure
}

const buildFetchFailureError = (label: string, endpoint: string, error: unknown): Error => {
  if (
    error instanceof Error &&
    /(?:API error:|Images API returned|Responses API returned)/i.test(error.message)
  ) {
    return error
  }
  const detail = describeFetchFailure(error)
  const sanitizedEndpoint = sanitizeEndpointForMessage(endpoint)
  const message =
    detail && detail.toLowerCase() !== 'fetch failed'
      ? `${label} request failed for ${sanitizedEndpoint}: ${detail}`
      : `${label} request failed for ${sanitizedEndpoint}`
  return error instanceof ModelConnectionError
    ? new ModelConnectionError(message, error)
    : new Error(message, { cause: error })
}

// ==================== Helper: convertImageToBase64 ====================

/**
 * Convert an image URL (data URL or remote URL) to raw base64 string.
 * Works in both Node.js and browser environments because it uses the
 * Fetch API (available in Node 18+ and all modern browsers).
 */
export async function convertImageToBase64(
  imageUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchImpl = getDefaultFetchImpl()
): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    const base64Part = imageUrl.split(',')[1]
    if (base64Part) {
      return base64Part
    }
  }
  const resp = await fetchImpl(imageUrl, { signal })
  const blob = await readImageResponseBlob(resp, 'Image download')
  const arrayBuffer = await blobToArrayBuffer(blob)
  // Buffer is available in both Node.js and Electron renderer
  const base64 = Buffer.from(arrayBuffer).toString('base64')
  return base64
}

export function normalizeGeminiModelName(modelName: string): string {
  const trimmed = modelName.trim()
  if (!trimmed) return trimmed

  const withoutPrefix = trimmed.replace(/^models\//i, '')
  return withoutPrefix.toLowerCase()
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/responses\/?$/i, '')
    .replace(/\/$/, '')
}

const isOfficialOpenAIBaseUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(normalizeOpenAIBaseUrl(baseUrl))
    return parsed.protocol === 'https:' && parsed.hostname === 'api.openai.com'
  } catch {
    return false
  }
}

const isOpenAIImagesEndpoint = (endpoint: string): boolean => {
  const fallbackPath = endpoint.trim().replace(/\/+$/g, '').toLowerCase()
  try {
    const parsed = new URL(endpoint)
    const pathname = parsed.pathname.replace(/\/+$/g, '').toLowerCase()
    return pathname.endsWith('/images/generations') || pathname.endsWith('/images/edits')
  } catch {
    return fallbackPath.endsWith('/images/generations') || fallbackPath.endsWith('/images/edits')
  }
}

const resolveOpenAIImagesEndpoint = (
  configuredUrl: string,
  operation: 'generations' | 'edits'
): string => {
  const normalized = configuredUrl.trim().replace(/\/+$/g, '')
  if (/\/images\/(?:generations|edits)$/i.test(normalized)) {
    return normalized.replace(/\/(?:generations|edits)$/i, `/${operation}`)
  }
  if (/\/images$/i.test(normalized)) {
    return `${normalized}/${operation}`
  }
  const withoutKnownOperation = normalized.replace(/\/(?:responses|chat\/completions)$/i, '')
  return `${withoutKnownOperation}/images/${operation}`
}

const isGPTImageModel = (modelName: string): boolean => /^gpt-image-/i.test(modelName.trim())

const isExplicitImagesApiBaseUrl = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(baseUrl)
    return /(?:\/v1)?\/images(?:\/|$)/i.test(parsed.pathname)
  } catch {
    return /(?:\/v1)?\/images(?:\/|$)/i.test(baseUrl.trim())
  }
}

// Keep preflight policy and dispatch on the same pure routing decision. This
// helper must not inspect attachments, create clients, or perform network I/O.
export const resolveOpenAIClientApiMode = (
  baseUrl: string,
  modelName: string,
  options?: Pick<OpenAIClientOptions, 'apiMode' | 'modelUse'> & { callType?: string }
): Exclude<OpenAIClientApiMode, 'auto'> => {
  const apiMode = options?.apiMode || 'auto'
  if (apiMode !== 'auto') return apiMode
  if (options?.callType === 'cliproxyapi') {
    return 'responses'
  }
  if (
    isExplicitImagesApiBaseUrl(baseUrl) ||
    options?.modelUse === 'image' ||
    (isGPTImageModel(modelName) && !options?.modelUse)
  ) {
    return 'images'
  }
  return isOfficialOpenAIBaseUrl(baseUrl) ? 'responses' : 'chat-completions'
}

const parseIPv4Host = (hostname: string): [number, number, number, number] | undefined => {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return undefined
  const parts = match.slice(1).map(Number) as [number, number, number, number]
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined
}

const isPrivateOrLocalIPv4 = (parts: [number, number, number, number]): boolean => {
  const [first, second, third, fourth] = parts
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224 ||
    (first === 255 && second === 255 && third === 255 && fourth === 255)
  )
}

const parseIPv6Words = (hostname: string): number[] | undefined => {
  const withoutZone = hostname.split('%', 1)[0]
  if (!withoutZone.includes(':')) return undefined
  const [leftPart, rightPart, ...extraParts] = withoutZone.split('::')
  if (extraParts.length > 0) return undefined

  const parsePart = (part: string): number[] => {
    if (!part) return []
    const pieces = part.split(':')
    const words: number[] = []
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIPv4Host(piece)
        if (!ipv4) return []
        words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3])
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        words.push(Number.parseInt(piece, 16))
      } else {
        return []
      }
    }
    return words
  }

  const left = parsePart(leftPart)
  const right = parsePart(rightPart)
  if (left.length + right.length > 8) return undefined
  if (withoutZone.includes('::')) {
    return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
  }
  return left.length === 8 ? left : undefined
}

const isPrivateOrLocalImageHost = (hostname: string): boolean => {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized === 'ip6-loopback' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.localdomain')
  ) {
    return true
  }

  const ipv4 = parseIPv4Host(normalized)
  if (ipv4) return isPrivateOrLocalIPv4(ipv4)

  const words = parseIPv6Words(normalized)
  if (!words) return normalized.includes(':')
  const embeddedIPv4: [number, number, number, number] = [
    words[6] >> 8,
    words[6] & 0xff,
    words[7] >> 8,
    words[7] & 0xff
  ]
  const isMappedIPv4 =
    words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)
  if (isMappedIPv4 && isPrivateOrLocalIPv4(embeddedIPv4)) return true

  const first = words[0]
  return (
    (first & 0xfe00) === 0xfc00 || // RFC 4193 unique-local
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0 && words.slice(1).every((word) => word === 0)) ||
    (first === 0x2001 && words[1] === 0x0db8) // documentation-only range
  )
}

const validateOpenAIImageDownloadUrl = (value: string, redirect = false): URL => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      redirect
        ? 'OpenAI reference image redirect URL is invalid.'
        : 'OpenAI reference image URL is invalid.'
    )
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(
      redirect
        ? 'OpenAI reference image redirect must not include credentials or fragments.'
        : 'OpenAI Images API reference image URL must not include credentials or fragments.'
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      redirect
        ? 'OpenAI reference image redirects must use HTTPS.'
        : 'OpenAI Images API reference image URL must use HTTPS.'
    )
  }
  if (isPrivateOrLocalImageHost(parsed.hostname)) {
    throw new Error(
      redirect
        ? 'OpenAI reference image redirect must target a public host.'
        : 'OpenAI Images API reference image URL must target a public host.'
    )
  }
  return parsed
}

const readImageResponseBlob = async (response: Response, label: string): Promise<Blob> => {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${label} failed: ${response.status} ${text}`)
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`${label} did not return an image.`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error(`${label} did not provide a readable body.`)
  }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      totalBytes += value.byteLength
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  if (totalBytes === 0) throw new Error(`${label} returned an empty body.`)
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const blob = new Blob([bytes.buffer], { type: contentType || '' })
  if (!blob.type.startsWith('image/')) {
    throw new Error(`${label} did not return an image.`)
  }
  return blob
}

const readOpenAIImageResponseBlob = async (response: Response): Promise<Blob> =>
  readImageResponseBlob(response, 'OpenAI reference image download')

const blobToArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }
  const reader = new FileReader()
  return new Promise<ArrayBuffer>((resolve, reject) => {
    reader.onerror = () => reject(reader.error || new Error('Unable to read image bytes.'))
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('Unable to read image bytes.'))
    }
    reader.readAsArrayBuffer(blob)
  })
}

const getSelectedUserImageAttachments = (messages: LLMChatParams['messages']) =>
  messages.flatMap((message) =>
    message.role === 'user'
      ? (message.attachments || []).filter((attachment) => attachment.type === 'image')
      : []
  )

const selectImageHistoryMessages = (
  messages: LLMChatParams['messages'],
  policy?: LLMImageHistoryPolicy
): LLMChatParams['messages'] => selectMessagesForImageHistoryPolicy(messages, policy)

/** Project only already-selected generated images into provider-readable user references.
 * Keep the assistant prose and non-image history intact, without mutating stored messages.
 */
const projectAssistantImageReferenceTurns = (
  messages: LLMChatParams['messages']
): LLMChatParams['messages'] =>
  messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message]
    const images = (message.attachments || []).filter((attachment) => attachment.type === 'image')
    if (!images.length) return [message]
    const attachments = message.attachments!.filter((attachment) => attachment.type !== 'image')
    const original = { ...message, attachments: attachments.length ? attachments : undefined }
    return [
      ...(message.content.trim() || attachments.length ? [original] : []),
      {
        role: 'user' as const,
        content: 'Reference image(s) from the previous assistant response:',
        attachments: images
      }
    ]
  })

const decodeBase64Bytes = (value: string): Uint8Array => {
  const normalized = value.replace(/\s+/g, '')
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(normalized, 'base64'))
  }
  const binary = globalThis.atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const getImageAttachmentMimeType = (attachment: { url: string; mimeType?: string }): string => {
  const fromAttachment = normalizeOpenAIImageMimeType(attachment.mimeType)
  if (attachment.mimeType) return fromAttachment
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(attachment.url.trim())
  return normalizeOpenAIImageMimeType(match?.[1] || 'image/png')
}

const getImageAttachmentFileName = (
  attachment: { url: string; fileName?: string; mimeType?: string },
  index: number
): string => {
  const candidate = attachment.fileName?.split(/[\\/]/).pop()?.trim()
  const hasControlCharacter = candidate
    ? Array.from(candidate).some(
        (character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f
      )
    : false
  if (candidate && !hasControlCharacter) return candidate
  return `reference-${index + 1}.${extensionFromOpenAIImageMimeType(getImageAttachmentMimeType(attachment))}`
}

const imageAttachmentToBlob = async (
  attachment: { url: string; mimeType?: string; media?: unknown },
  signal: AbortSignal | undefined,
  fetchImpl: FetchImpl,
  imageAttachmentLoader?: OpenAIImageAttachmentLoader,
  control?: OpenAIRequestControl
): Promise<Blob> => {
  const url = attachment.url.trim()
  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url)
  if (dataUrlMatch) {
    // Data URLs are provider-bound reference images, not the streamed text/event
    // payload. Do not apply the former 8 MiB text budget here; retain the
    // per-call deadline/cancellation checks around the synchronous decode.
    control?.check()
    const bytes = decodeBase64Bytes(dataUrlMatch[2])
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const blob = new Blob([copy.buffer], {
      type: normalizeOpenAIImageMimeType(dataUrlMatch[1])
    })
    control?.check()
    return blob
  }

  if (attachment.media && typeof attachment.media === 'object') {
    throw new Error(
      'OpenAI Images API managed reference images must be materialized as data URLs before editing.'
    )
  }

  if (/^local-media:\/\//i.test(url)) {
    let response: Response
    try {
      response = await fetchImpl(url, { signal, redirect: 'error' })
    } catch (error) {
      control?.check()
      throw buildFetchFailureError('OpenAI local reference image', url, error)
    }
    if (control) {
      if (!response.ok) {
        throw await readProviderHttpError('OpenAI reference image', response, control)
      }
      // Guarded local-media/safeRemoteDownload owns the remote byte ceiling;
      // this client must not reintroduce the legacy 8 MiB reference-image cap.
      const blob = await control.blob(response, Number.MAX_SAFE_INTEGER)
      if (!blob.size) throw new Error('OpenAI reference image download returned an empty body.')
      if (!blob.type.startsWith('image/'))
        throw new Error('OpenAI reference image download did not return an image.')
      return blob
    }
    return readOpenAIImageResponseBlob(response)
  }

  if (/^file:\/\//i.test(url)) {
    throw new Error(
      'OpenAI Images API file reference images must be normalized to a guarded local-media URL before editing.'
    )
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      'OpenAI Images API reference images must use a data:image base64 URL, a local-media URL, or an HTTP(S) URL.'
    )
  }

  if (!imageAttachmentLoader) {
    throw new Error(
      'OpenAI Images API remote reference images require the guarded main-process image loader.'
    )
  }

  const parsedUrl = validateOpenAIImageDownloadUrl(url)
  try {
    const loading = imageAttachmentLoader(parsedUrl, signal)
    const loaded = await (control ? control.wait(loading) : loading)
    if (!loaded.blob.size) {
      throw new Error('OpenAI reference image download returned an empty body.')
    }
    if (!loaded.blob.type.startsWith('image/')) {
      throw new Error('OpenAI reference image download did not return an image.')
    }
    return loaded.blob
  } catch (error) {
    control?.check()
    if (error instanceof Error && /OpenAI reference image/.test(error.message)) throw error
    throw buildFetchFailureError('OpenAI reference image', url, error)
  }
}

const normalizeImageRequestOption = (value: string | undefined): string | undefined => {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized
}

const normalizeOpenAIImageMimeType = (value: unknown): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'png' || normalized === 'image/png') {
    return 'image/png'
  }
  if (normalized === 'webp' || normalized === 'image/webp') {
    return 'image/webp'
  }
  if (['jpeg', 'jpg', 'image/jpeg', 'image/jpg'].includes(normalized)) {
    return 'image/jpeg'
  }
  return 'image/png'
}

const extensionFromOpenAIImageMimeType = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType.replace(/^image\//, '') || 'png'

const buildGeneratedImageFileName = (mimeType: string, imageIndex: number): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `openai-image_${timestamp}_${imageIndex + 1}.${extensionFromOpenAIImageMimeType(mimeType)}`
}

const normalizeOpenAIImageDataUrl = (value: string, mimeType: string): string => {
  const trimmed = value.trim()
  return trimmed.startsWith('data:') ? trimmed : `data:${mimeType};base64,${trimmed}`
}

const resolveOpenAIImagesGenerationPrompt = (params: LLMChatParams): string => {
  const latestUserMessage = [...params.messages]
    .reverse()
    .find((message) => message.role === 'user')
  const latestUserPrompt = latestUserMessage?.content.trim()
  if (latestUserPrompt) {
    return latestUserPrompt
  }

  // Image-only turns must not accidentally replay an older user/assistant prompt.
  // Keep the request scoped to the current turn and use the system instruction only
  // when the current user supplied no text at all.
  return params.systemPrompt?.trim() || 'Generate an image.'
}

const extractOpenAIImagesGenerationResult = (
  payload: unknown,
  fallbackMimeType = 'image/png'
): LLMChatResult | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const record = payload as Record<string, unknown>
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.output)
      ? record.output
      : []
  const attachments: NonNullable<LLMChatResult['attachments']> = []
  const textParts: string[] = []

  for (const [imageIndex, item] of data.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }

    const itemRecord = item as Record<string, unknown>
    const mimeType = normalizeOpenAIImageMimeType(
      itemRecord.mime_type ?? itemRecord.output_format ?? itemRecord.format ?? fallbackMimeType
    )
    const rawUrl =
      typeof itemRecord.url === 'string'
        ? itemRecord.url.trim()
        : typeof itemRecord.image_url === 'string'
          ? itemRecord.image_url.trim()
          : itemRecord.image_url && typeof itemRecord.image_url === 'object'
            ? String((itemRecord.image_url as { url?: unknown }).url || '').trim()
            : ''
    const rawBase64 =
      typeof itemRecord.b64_json === 'string'
        ? itemRecord.b64_json.trim()
        : typeof itemRecord.result === 'string'
          ? itemRecord.result.trim()
          : ''
    const imageUrl = rawUrl || (rawBase64 ? normalizeOpenAIImageDataUrl(rawBase64, mimeType) : '')

    if (typeof itemRecord.revised_prompt === 'string' && itemRecord.revised_prompt.trim()) {
      textParts.push(itemRecord.revised_prompt.trim())
    }

    if (!imageUrl) {
      continue
    }

    attachments.push({
      type: 'image',
      url: imageUrl,
      mimeType,
      fileName: buildGeneratedImageFileName(mimeType, imageIndex)
    })
  }

  if (!attachments.length) {
    return null
  }

  return {
    content: textParts.join('\n').trim(),
    imageUrl: attachments[0]?.url,
    attachments
  }
}

export function normalizeGeminiBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/models\/[^/?#:]+(?::generateContent)?\/?$/i, '')
    .replace(/\/openai\/?$/i, '')
    .replace(/\/$/, '')
}

export function normalizeClaudeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/v1\/messages\/?$/i, '')
    .replace(/\/v1\/?$/i, '')
    .replace(/\/$/, '')
}

export function normalizeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/api\/(?:chat|generate)\/?$/i, '')
    .replace(/\/$/, '')
}

// ==================== OpenAI-compatible API Client ====================

type OpenAICapacityRetryContext = {
  requestId: string
  fileSearchSession?: Awaited<ReturnType<typeof createOpenAIFileSearchSession>> | null
}

export class OpenAIAPICli implements LLMCli {
  get supportsNativeTools(): boolean {
    return (
      this.options?.modelUse !== 'image' &&
      resolveOpenAIClientApiMode(this.baseUrl, this.modelName, this.options) !== 'images'
    )
  }
  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    protected readonly options?: OpenAIClientOptions
  ) {}

  private getFetchImpl(): FetchImpl {
    return this.options?.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    if (!params.retryCapacity) return this.chatOnce(params)
    const retryContext: OpenAICapacityRetryContext = { requestId: globalThis.crypto.randomUUID() }
    try {
      return await retryModelCapacity(params, (onDelta) =>
        this.chatOnce({ ...params, onDelta }, retryContext)
      )
    } finally {
      await retryContext.fileSearchSession?.cleanup()
    }
  }

  private async chatOnce(
    params: LLMChatParams,
    retryContext?: OpenAICapacityRetryContext
  ): Promise<LLMChatResult> {
    const base = normalizeOpenAIBaseUrl(this.baseUrl)
    const apiMode = resolveOpenAIClientApiMode(this.baseUrl, this.modelName, this.options)
    const imageTask =
      apiMode === 'images' ||
      shouldUseOpenAIImageGeneration({
        messages: params.messages,
        modelUse: this.options?.modelUse,
        imageGenerationOptions: params.imageGenerationOptions
      })
    if (params.imageRequest) {
      validateImageRequestContract(params.imageRequest, params.messages)
    }
    const requestId = retryContext?.requestId
    const fetchImpl = this.getFetchImpl()
    let modelRequestStarted = false
    const stableFetch: FetchImpl = (input, init) => {
      // Hosted upload setup and reference-image reads must not be replayed as model timeouts.
      if (init?.method === 'POST') modelRequestStarted = true
      if (requestId && init?.method === 'POST') {
        const headers = init.headers as Record<string, string> | undefined
        const alreadySet = Object.keys(headers || {}).some(
          (key) => key.toLowerCase() === 'idempotency-key'
        )
        const nextHeaders = {
          ...headers,
          ...(alreadySet ? {} : { 'Idempotency-Key': requestId }),
          ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {}),
          ...invocationHeaders(params)
        }
        return fetchImpl(input, {
          ...init,
          headers: nextHeaders
        })
      }
      if (params.correlationId && init?.method === 'POST') {
        const headers = init.headers as Record<string, string> | undefined
        return fetchImpl(input, {
          ...init,
          headers: {
            ...headers,
            'X-MagicPot-Correlation-Id': params.correlationId,
            ...invocationHeaders(params)
          }
        })
      }
      if (init?.method === 'POST' && params.invocation) {
        const headers = init.headers as Record<string, string> | undefined
        return fetchImpl(input, {
          ...init,
          headers: { ...headers, ...invocationHeaders(params) }
        })
      }
      return fetchImpl(input, init)
    }
    const control = new OpenAIRequestControl(
      stableFetch,
      params.signal,
      this.options?.requestTimeoutMs ??
        (imageTask
          ? OPENAI_IMAGE_DEADLINE_MS
          : retryContext
            ? OPENAI_INTERACTIVE_IDLE_TIMEOUT_MS
            : OPENAI_CHAT_DEADLINE_MS),
      {
        idleTimeout: Boolean(retryContext),
        // Responses image edits retain one JSON body/key across pre-output retries.
        // A compatible gateway still has to honor the key to prevent duplicate billing.
        // Streaming image/tool progress keeps its existing no-replay boundary.
        retryConnectionErrors: Boolean(retryContext) && (!imageTask || apiMode === 'responses')
      }
    )
    let callbackFailed = false
    let callbackError: unknown
    const upstreamStreamingMetadataRef: OpenAIUpstreamStreamingMetadataRef = {}
    const controlled: LLMChatParams = {
      ...params,
      signal: control.signal,
      onDelta: params.onDelta
        ? (event) => {
            control.check()
            try {
              params.onDelta!({
                ...event,
                ...(upstreamStreamingMetadataRef.current
                  ? {
                      metadata: withOpenAIUpstreamStreamingMetadata(
                        event.metadata,
                        upstreamStreamingMetadataRef.current
                      )
                    }
                  : {})
              })
            } catch (error) {
              callbackFailed = true
              callbackError = error
              throw error
            }
            control.check()
          }
        : undefined
    }
    try {
      control.check()
      const result =
        apiMode === 'images'
          ? await this.chatViaImagesApi(controlled, control)
          : apiMode === 'responses'
            ? await this.chatViaResponsesApi(
                controlled,
                base,
                control,
                upstreamStreamingMetadataRef,
                retryContext
              )
            : await this.chatViaChatCompletions(
                controlled,
                this.baseUrl
                  .trim()
                  .replace(/\/$/, '')
                  .replace(/\/images$/i, ''),
                control,
                upstreamStreamingMetadataRef
              )
      control.check()
      return result
    } catch (error) {
      if (callbackFailed) throw callbackError
      const retryReason = modelCapacityReason(error)
      if (
        error instanceof Error &&
        ((!modelRequestStarted &&
          (retryReason === 'request-timeout' || retryReason === 'connection-error')) ||
          (imageTask && retryReason === 'request-timeout') ||
          (imageTask && apiMode !== 'responses' && retryReason === 'connection-error'))
      ) {
        // Reference preparation must not be retried as a model request. Preserve
        // unknown image-timeout protection and the non-Responses image boundary.
        Object.assign(error, { retryBlocked: true })
      }
      // Suboperations resolve cancellation at the point of failure. Re-reading
      // the signal here, after independent hosted cleanup, would mask that cause.
      throw error
    } finally {
      control.dispose()
    }
  }

  private async chatViaImagesApi(
    params: LLMChatParams,
    control: OpenAIRequestControl
  ): Promise<LLMChatResult> {
    const selectedMessages = projectAssistantImageReferenceTurns(
      selectImageHistoryMessages(
        params.messages,
        params.imageGenerationOptions?.action === 'edit' ? 'all' : params.imageHistoryPolicy
      )
    )
    const references = getSelectedUserImageAttachments(selectedMessages)
    const selectedImageMessages = selectedMessages.filter((message) => message.role === 'user')
    const imagePolicy = {
      ...DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY,
      ...(this.options?.maxInputImages !== undefined
        ? { maxImages: this.options.maxInputImages }
        : {})
    }
    validateOpenAIResponsesImages(selectedImageMessages, imagePolicy)
    const options = normalizeOpenAIImageGenerationOptions(params.imageGenerationOptions)
    const action = options?.action || (references.length > 0 ? 'auto' : 'generate')
    if (action === 'edit' && references.length === 0) {
      throw new Error('OpenAI Images edit requests require at least one reference image.')
    }
    const useEdits = references.length > 0 && action !== 'generate'
    const endpoint = resolveOpenAIImagesEndpoint(this.baseUrl, useEdits ? 'edits' : 'generations')
    const prompt = resolveOpenAIImagesGenerationPrompt(params)
    const requestOptions: Record<string, unknown> = {
      model: this.modelName,
      prompt
    }

    const copyOption = (key: string, value: string | undefined): void => {
      const normalized = normalizeImageRequestOption(value)
      if (normalized) requestOptions[key] = normalized
    }
    copyOption('size', options?.size)
    copyOption('quality', options?.quality)
    copyOption('output_format', options?.outputFormat)
    copyOption('background', options?.background)

    const headers: Record<string, string> = {
      ...(this.options?.extraHeaders || {}),
      ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {})
    }
    if (this.apiKey.trim() && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    let body: BodyInit
    if (!useEdits) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(requestOptions)
      assertOpenAIResponsesRequestBodySize(String(body), DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY)
    } else {
      const formData = new FormData()
      for (const [key, value] of Object.entries(requestOptions)) {
        formData.append(key, String(value))
      }
      const fetchImpl = control.fetch
      let materializedImageBytes = 0
      for (const [index, attachment] of references.entries()) {
        control.check()
        const blob = await imageAttachmentToBlob(
          attachment,
          params.signal,
          fetchImpl,
          this.options?.imageAttachmentLoader,
          control
        )
        if (blob.size > DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxDecodedBytesPerImage) {
          throw new Error(
            `Image exceeds the ${DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxDecodedBytesPerImage}-byte decoded limit.`
          )
        }
        materializedImageBytes += blob.size
        if (
          materializedImageBytes > DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxAggregateDecodedBytes
        ) {
          throw new Error(
            `Images exceed the ${DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxAggregateDecodedBytes}-byte aggregate decoded limit.`
          )
        }
        const name = getImageAttachmentFileName(attachment, index)
        formData.append(references.length === 1 ? 'image' : 'image[]', blob, name)
      }
      // Do not set Content-Type here: fetch must add the multipart boundary.
      body = formData
    }

    let response: Response
    try {
      response = await control.fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: params.signal
      })
    } catch (error) {
      control.check()
      throw buildFetchFailureError('OpenAI API', endpoint, error)
    }

    if (!response.ok) {
      throw await readProviderHttpError('OpenAI', response, control)
    }

    const data = await control.json(response, OPENAI_IMAGE_JSON_MAX_BYTES)
    const imageResult = extractOpenAIImagesGenerationResult(data, options?.outputFormat)
    if (!imageResult) {
      throw new Error(
        `OpenAI Images API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    const usage = normalizeProviderTokenUsage(data)
    return {
      ...imageResult,
      ...(usage ? { usage } : {})
    }
  }

  private async chatViaResponsesApi(
    params: LLMChatParams,
    base: string,
    control: OpenAIRequestControl,
    upstreamStreamingMetadataRef: OpenAIUpstreamStreamingMetadataRef,
    retryContext?: OpenAICapacityRetryContext
  ): Promise<LLMChatResult> {
    let fileSearchSession: Awaited<ReturnType<typeof createOpenAIFileSearchSession>> | null = null
    const selectedMessages = selectMessagesForImageHistoryPolicy(
      params.messages,
      params.imageHistoryPolicy
    )
    const selectedProviderMessages = selectedMessages.filter((message) => message.role !== 'system')
    try {
      const imagePolicy = {
        ...DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY,
        ...(this.options?.maxInputImages !== undefined
          ? { maxImages: this.options.maxInputImages }
          : {})
      }
      validateOpenAIResponsesImages(selectedProviderMessages, imagePolicy)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Images must be supported base64 data URLs or public HTTP(S) URLs.'
      ) {
        throw new Error(OPENAI_RESPONSES_IMAGE_URL_ERROR)
      }
      throw error
    }
    const responsesInput = buildOpenAIResponsesInput(params.messages, {
      imageHistory: params.imageHistoryPolicy
    })
    const useImageGeneration = shouldUseOpenAIImageGeneration({
      messages: params.messages,
      modelUse: this.options?.modelUse,
      imageGenerationOptions: params.imageGenerationOptions
    })
    const responseMainlineModel = useImageGeneration
      ? this.options?.reasoningProfile?.model_name?.trim() || 'gpt-5.4'
      : this.modelName
    const responseImageToolModel =
      useImageGeneration && /^gpt-image-/i.test(this.modelName.trim())
        ? this.modelName.trim()
        : undefined
    const forceStreaming = this.options?.forceStreaming === true
    const shouldStreamResponses = Boolean(params.onDelta) || forceStreaming
    const requestBody: Record<string, unknown> = {
      // Responses image generation uses a supported mainline model at the top level;
      // the GPT Image model is selected on the image_generation tool itself.
      model: responseMainlineModel,
      input: [...responsesInput, ...projectNativeToolTurns(params.toolTurns, 'responses')],
      instructions: params.systemPrompt?.trim() || 'You are a helpful assistant.',
      store: false,
      ...(shouldStreamResponses ? { stream: true } : {})
    }
    // Native JSON schema output is a provider hint only. The caller still
    // validates the final content, and image-generation requests do not mix
    // this text contract with the image tool.
    const structuredOutput = normalizeLLMStructuredOutput(params.structuredOutput)
    if (structuredOutput && !useImageGeneration) {
      requestBody.text = {
        format: {
          type: 'json_schema',
          name: structuredOutput.name,
          strict: structuredOutput.strict ?? true,
          schema: structuredOutput.schema
        }
      }
    }
    if (params.temperature !== undefined) requestBody.temperature = params.temperature
    if (useImageGeneration) {
      requestBody.tools = [
        buildOpenAIImageGenerationTool({
          messages: params.messages,
          imageGenerationOptions: {
            ...params.imageGenerationOptions,
            ...(responseImageToolModel && !params.imageGenerationOptions?.model
              ? { model: responseImageToolModel }
              : {})
          }
        })
      ]
      // CLIProxyAPI/Codex accepts the image-generation tool declaration but
      // its Responses compatibility enum does not accept the native
      // `{ type: "image_generation" }` tool_choice object. `auto` lets the
      // gateway's Codex image bridge select the declared tool without making
      // the request fail during JSON deserialization.
      const compatibilityCallType = this.options?.callType?.trim().toLowerCase()
      requestBody.tool_choice =
        compatibilityCallType === 'cliproxyapi' || compatibilityCallType === 'codex'
          ? 'auto'
          : { type: 'image_generation' }
    }
    if (params.maxOutputTokens) {
      requestBody.max_output_tokens = params.maxOutputTokens
    }
    const reasoningCapabilities = resolveChatProfileCapabilities(
      this.options?.reasoningProfile || { model_name: this.modelName }
    )
    const reasoningEffort = normalizeReasoningEffort(
      params.reasoningEffort,
      this.options?.reasoningProfile && reasoningCapabilities.reasoningEfforts.length === 0
        ? undefined
        : reasoningCapabilities.reasoningEfforts
    )

    if (reasoningEffort && !useImageGeneration) {
      requestBody.reasoning = { effort: reasoningEffort }
    }
    if (this.options?.serviceTier) {
      requestBody.service_tier = this.options.serviceTier
    }
    // Reject input that cannot fit before hosted file-search creates remote resources.
    // Recheck the final body below after server-issued vector-store IDs are included.
    assertOpenAIResponsesRequestBodySize(
      JSON.stringify(requestBody),
      DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY
    )

    try {
      const hostedFileSearch = this.options?.enableHostedTools ?? isOfficialOpenAIBaseUrl(base)
      const hostedWebSearch = this.options?.enableHostedWebSearch ?? hostedFileSearch
      if (!useImageGeneration && (hostedFileSearch || hostedWebSearch)) {
        if (hostedFileSearch) {
          try {
            fileSearchSession =
              retryContext?.fileSearchSession !== undefined
                ? retryContext.fileSearchSession
                : await createOpenAIFileSearchSession({
                    apiKey: this.apiKey,
                    baseUrl: base,
                    messages: params.messages,
                    signal: params.signal,
                    fetchImpl: this.getFetchImpl()
                  })
            if (retryContext) retryContext.fileSearchSession = fileSearchSession
          } catch (error) {
            // Hosted setup uses its own error normalization; restore a parent
            // cancellation only for its explicit AbortError, not an earlier failure.
            if (control.signal.aborted && error instanceof Error && error.name === 'AbortError') {
              throw control.signal.reason
            }
            throw error
          }
        }

        requestBody.tools = [
          ...(fileSearchSession?.vectorStoreIds?.length
            ? [buildOpenAIFileSearchTool(fileSearchSession.vectorStoreIds)]
            : []),
          ...(hostedWebSearch ? [buildDefaultOpenAIWebSearchTool()] : [])
        ]
        requestBody.include = buildDefaultOpenAIResponsesInclude({
          includeFileSearchResults: Boolean(fileSearchSession?.vectorStoreIds?.length),
          includeWebSearchSources: hostedWebSearch
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

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.options?.extraHeaders || {}),
        ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {})
      }
      if (this.apiKey.trim() && !headers.Authorization) {
        headers.Authorization = `Bearer ${this.apiKey}`
      }

      const serializedBody = JSON.stringify(requestBody)
      assertOpenAIResponsesRequestBodySize(serializedBody, DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY)
      let resp: Response
      try {
        resp = await control.fetch(`${base}/responses`, {
          method: 'POST',
          headers,
          body: serializedBody,
          signal: params.signal
        })
      } catch (error) {
        control.check()
        throw buildFetchFailureError('OpenAI API', `${base}/responses`, error)
      }

      if (!resp.ok) {
        throw await readProviderHttpError('OpenAI', resp, control)
      }

      const isSse =
        shouldStreamResponses &&
        resp.headers?.get('content-type')?.toLowerCase().startsWith('text/event-stream')
      upstreamStreamingMetadataRef.current = shouldStreamResponses
        ? isSse
          ? { upstreamProtocol: 'sse', upstreamIncremental: true }
          : {
              upstreamProtocol: 'json',
              upstreamIncremental: false,
              fallbackReason: 'upstream-json'
            }
        : undefined
      const streamed = isSse
        ? await readOpenAIStream(resp, control, 'responses', params.onDelta ?? (() => undefined), {
            imageGeneration: useImageGeneration
          })
        : undefined
      const data =
        streamed?.payload ??
        (await control.json(
          resp,
          useImageGeneration ? OPENAI_IMAGE_JSON_MAX_BYTES : OPENAI_JSON_MAX_BYTES
        ))
      const native = params.tools?.length
        ? extractNativeToolResult(data, params.tools, 'responses')
        : {}
      if (native.toolCalls?.length && streamed?.finishReason === 'length')
        throw new Error('Incomplete native tool calls are not executable.')
      const serialized = serializeOpenAIResponsesOutput(data)
      if (!serialized && !native.toolCalls?.length && streamed?.finishReason !== 'length') {
        throw new Error(
          `OpenAI Responses API returned empty or invalid content. Response: ${JSON.stringify(data)}`
        )
      }

      const result = normalizeLLMChatResult(serialized ?? { content: '' })
      const usage = normalizeProviderTokenUsage(data)
      control.check()
      if (!streamed && params.onDelta && result.content) {
        params.onDelta({
          type: 'text-delta',
          delta: result.content,
          metadata: withOpenAIUpstreamStreamingMetadata(
            result.metadata,
            upstreamStreamingMetadataRef.current!
          )
        })
      }
      return {
        ...result,
        ...native,
        ...(streamed ? { finishReason: streamed.finishReason } : {}),
        ...(native.toolCalls?.length ? { finishReason: 'tool_call' as const } : {}),
        ...(usage ? { usage } : {}),
        ...(upstreamStreamingMetadataRef.current
          ? {
              metadata: withOpenAIUpstreamStreamingMetadata(
                result.metadata,
                upstreamStreamingMetadataRef.current
              )
            }
          : {})
      }
    } finally {
      if (fileSearchSession && !retryContext) {
        await fileSearchSession.cleanup()
      }
    }
  }

  private async chatViaChatCompletions(
    params: LLMChatParams,
    base: string,
    control: OpenAIRequestControl,
    upstreamStreamingMetadataRef: OpenAIUpstreamStreamingMetadataRef
  ): Promise<LLMChatResult> {
    const { messages, systemPrompt, signal } = params
    const endpoint = base

    type Role = 'system' | 'user' | 'assistant'
    type TextMessage = { role: Role; content: string }
    type VisionContent =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'low' } }
    type VisionMessage = { role: 'user'; content: VisionContent[] }
    type APIMessage = TextMessage | VisionMessage

    const apiMessages: APIMessage[] = []
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt })
    }

    const selectedMessages =
      params.imageHistoryPolicy === undefined
        ? messages
        : selectImageHistoryMessages(messages, params.imageHistoryPolicy)
    for (const msg of projectAssistantImageReferenceTurns(selectedMessages)) {
      if (msg.attachments && msg.attachments.length > 0) {
        const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
        if (imageAttachments.length > 0 && msg.role === 'user') {
          const content: VisionContent[] = []
          const textContent = msg.content.trim() || '请分析这张图片'
          content.push({ type: 'text', text: textContent })
          for (const attachment of imageAttachments) {
            content.push({
              type: 'image_url',
              image_url: {
                url: attachment.url,
                ...(attachment.imageDetail === 'low' ? { detail: 'low' as const } : {})
              }
            })
          }
          apiMessages.push({ role: 'user', content })
        } else {
          apiMessages.push({ role: msg.role, content: msg.content })
        }
      } else {
        apiMessages.push({ role: msg.role, content: msg.content })
      }
    }

    const usesImagesGenerationEndpoint = isOpenAIImagesEndpoint(endpoint)
    const imageGenerationOptions = params.imageGenerationOptions
    const requestBody: Record<string, unknown> = usesImagesGenerationEndpoint
      ? {
          model: this.modelName,
          prompt: resolveOpenAIImagesGenerationPrompt(params)
        }
      : {
          model: this.modelName,
          messages: [
            ...apiMessages,
            ...projectNativeToolTurns(params.toolTurns, 'chat-completions')
          ],
          temperature: params.temperature ?? 0.7,
          stream: Boolean(params.onDelta),
          ...(params.onDelta ? { stream_options: { include_usage: true } } : {})
        }
    const structuredOutput = normalizeLLMStructuredOutput(params.structuredOutput)
    if (structuredOutput && !usesImagesGenerationEndpoint) {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: {
          name: structuredOutput.name,
          strict: structuredOutput.strict ?? true,
          schema: structuredOutput.schema
        }
      }
    }
    if (params.tools?.length && !usesImagesGenerationEndpoint) {
      requestBody.tools = buildNativeToolDefinitions(params.tools, 'chat-completions')
      requestBody.parallel_tool_calls = false
    }
    if (params.maxOutputTokens && !usesImagesGenerationEndpoint) {
      requestBody.max_tokens = params.maxOutputTokens
    }
    if (usesImagesGenerationEndpoint) {
      const normalizedSize = imageGenerationOptions?.size?.trim()
      const normalizedQuality = imageGenerationOptions?.quality?.trim()
      const normalizedOutputFormat = imageGenerationOptions?.outputFormat?.trim()
      const normalizedBackground = imageGenerationOptions?.background?.trim()
      if (normalizedSize) {
        requestBody.size = normalizedSize
      }
      if (normalizedQuality) {
        requestBody.quality = normalizedQuality
      }
      if (normalizedOutputFormat) {
        requestBody.output_format = normalizedOutputFormat
      }
      if (normalizedBackground) {
        requestBody.background = normalizedBackground
      }
    }
    if (this.options?.serviceTier) {
      requestBody.service_tier = this.options.serviceTier
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.options?.extraHeaders || {}),
      ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {})
    }
    if (this.apiKey.trim() && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    let resp: Response
    try {
      resp = await control.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      })
    } catch (error) {
      control.check()
      throw buildFetchFailureError('OpenAI API', endpoint, error)
    }

    if (!resp.ok) {
      throw await readProviderHttpError('OpenAI', resp, control)
    }

    const isSse =
      Boolean(params.onDelta) &&
      !usesImagesGenerationEndpoint &&
      resp.headers?.get('content-type')?.toLowerCase().startsWith('text/event-stream')
    upstreamStreamingMetadataRef.current = params.onDelta
      ? isSse
        ? { upstreamProtocol: 'sse', upstreamIncremental: true }
        : { upstreamProtocol: 'json', upstreamIncremental: false, fallbackReason: 'upstream-json' }
      : undefined
    const streamed = isSse
      ? await readOpenAIStream(resp, control, 'chat-completions', params.onDelta!)
      : undefined
    const rawData =
      streamed?.payload ??
      (await control.json(
        resp,
        usesImagesGenerationEndpoint ? OPENAI_IMAGE_JSON_MAX_BYTES : OPENAI_JSON_MAX_BYTES
      ))
    const data = rawData as {
      output?: unknown[]
      choices?: Array<{
        message?: { content?: unknown; images?: unknown[]; tool_calls?: unknown[] }
        content?: unknown
      }>
      message?: { content?: unknown }
      content?: unknown
    }
    if (usesImagesGenerationEndpoint) {
      const imageResult = extractOpenAIImagesGenerationResult(
        data,
        imageGenerationOptions?.outputFormat
      )
      if (!imageResult) {
        throw new Error(
          `OpenAI Images API returned empty or invalid content. Response: ${JSON.stringify(data)}`
        )
      }
      const usage = normalizeProviderTokenUsage(data)
      return {
        ...imageResult,
        ...(usage ? { usage } : {})
      }
    }

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.content ??
      data?.message?.content ??
      data?.output?.flatMap((entry) =>
        entry &&
        typeof entry === 'object' &&
        Array.isArray((entry as { content?: unknown }).content)
          ? ((entry as { content: unknown[] }).content ?? [])
          : []
      )

    const native = params.tools?.length
      ? extractNativeToolResult(data, params.tools, 'chat-completions')
      : {}
    if (params.tools?.length && streamed?.finishReason === 'tool_call' && !native.toolCalls?.length)
      throw new Error('Native tool response is missing its call frames.')
    if (native.toolCalls?.length && streamed?.finishReason === 'length')
      throw new Error('Incomplete native tool calls are not executable.')
    if (native.toolCalls?.length) {
      const text = typeof content === 'string' ? content : ''
      if (!streamed && text) params.onDelta?.({ type: 'text-delta', delta: text })
      return {
        content: text,
        ...native,
        finishReason: 'tool_call',
        usage: normalizeProviderTokenUsage(data),
        ...(upstreamStreamingMetadataRef.current
          ? {
              metadata: withOpenAIUpstreamStreamingMetadata(
                undefined,
                upstreamStreamingMetadataRef.current
              )
            }
          : {})
      }
    }

    const toolCalls = data?.choices?.[0]?.message?.tool_calls
    const toolMetadata =
      Array.isArray(toolCalls) && toolCalls.length ? { metadata: { toolCalls } } : {}

    // Compatible endpoints can interleave text and multiple images. Never drop
    // all but the first image or fetch output URLs while normalizing the result.
    const parts = [
      ...(Array.isArray(content) ? content : []),
      ...(data.choices?.[0]?.message?.images || [])
    ]
    if (parts.length) {
      const attachments: NonNullable<LLMChatResult['attachments']> = []
      let text = typeof content === 'string' ? content : ''
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        const value = part as {
          text?: unknown
          url?: unknown
          image_url?: { url?: unknown } | string
        }
        if (typeof value.text === 'string') text += value.text
        const url =
          value.url ??
          (typeof value.image_url === 'string' ? value.image_url : value.image_url?.url)
        if (typeof url === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(url)) {
          attachments.push({ type: 'image', url })
        }
      }
      if (text || attachments.length) {
        const usage = normalizeProviderTokenUsage(data)
        control.check()
        if (!streamed && params.onDelta && text)
          params.onDelta({
            type: 'text-delta',
            delta: text,
            metadata: withOpenAIUpstreamStreamingMetadata(
              undefined,
              upstreamStreamingMetadataRef.current!
            )
          })
        return {
          content: text.trim(),
          ...(attachments.length ? { attachments, imageUrl: attachments[0].url } : {}),
          ...toolMetadata,
          ...(streamed ? { finishReason: streamed.finishReason } : {}),
          ...(usage ? { usage } : {}),
          ...(upstreamStreamingMetadataRef.current
            ? {
                metadata: withOpenAIUpstreamStreamingMetadata(
                  'metadata' in toolMetadata
                    ? (toolMetadata.metadata as LLMChatMetadata)
                    : undefined,
                  upstreamStreamingMetadataRef.current!
                )
              }
            : {})
        }
      }
    }
    if (streamed?.finishReason === 'tool_call' && !content) {
      const usage = normalizeProviderTokenUsage(data)
      return {
        content: '',
        finishReason: 'tool_call',
        metadata: {
          ...withOpenAIUpstreamStreamingMetadata(undefined, upstreamStreamingMetadataRef.current!),
          toolCalls: data.choices?.[0]?.message?.tool_calls || []
        },
        ...(usage ? { usage } : {})
      }
    }

    if (typeof content !== 'string' || (!content && streamed?.finishReason !== 'length')) {
      throw new Error(
        `OpenAI API returned empty or invalid content. Response: ${JSON.stringify(data)}`
      )
    }
    const usage = normalizeProviderTokenUsage(data)
    control.check()
    if (!streamed && params.onDelta)
      params.onDelta({
        type: 'text-delta',
        delta: content,
        metadata: withOpenAIUpstreamStreamingMetadata(
          'metadata' in toolMetadata ? (toolMetadata.metadata as LLMChatMetadata) : undefined,
          upstreamStreamingMetadataRef.current!
        )
      })
    return normalizeLLMChatResult({
      content: content.trim(),
      ...toolMetadata,
      ...(streamed ? { finishReason: streamed.finishReason } : {}),
      ...(usage ? { usage } : {}),
      ...(upstreamStreamingMetadataRef.current
        ? {
            metadata: withOpenAIUpstreamStreamingMetadata(
              'metadata' in toolMetadata ? (toolMetadata.metadata as LLMChatMetadata) : undefined,
              upstreamStreamingMetadataRef.current
            )
          }
        : {})
    })
  }
}

// ==================== Gemini API Client ====================

const normalizeGeminiClientOptions = (
  fetchImplOrOptions?: FetchImpl | GeminiClientOptions
): GeminiClientOptions =>
  typeof fetchImplOrOptions === 'function'
    ? { fetchImpl: fetchImplOrOptions }
    : fetchImplOrOptions || {}

export class GeminiAPICli implements LLMCli {
  protected readonly options: GeminiClientOptions

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    fetchImplOrOptions?: FetchImpl | GeminiClientOptions
  ) {
    this.options = normalizeGeminiClientOptions(fetchImplOrOptions)
  }

  protected getNormalizedModelName(): string {
    return normalizeGeminiModelName(this.modelName)
  }

  private getFetchImpl(): FetchImpl {
    return this.options.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    if (params.retryCapacity) {
      return retryModelCapacity(params, (onDelta) =>
        this.chat({ ...params, retryCapacity: false, onDelta })
      )
    }
    const { messages, systemPrompt, signal } = params
    let base = normalizeGeminiBaseUrl(this.baseUrl)

    // Ensure base URL has API version. OpenCode Zen already includes /v1.
    if (!base.includes('/v1') && !base.includes('/v1beta')) {
      base = base.replace(/\/$/, '') + '/v1beta'
    }

    const modelName = this.getNormalizedModelName()
    const endpoint = `${base}/models/${modelName}:generateContent`
    const control = new ProviderRequestControl(
      this.getFetchImpl(),
      signal,
      this.options.requestTimeoutMs ?? PROVIDER_CHAT_DEADLINE_MS,
      {},
      'Gemini'
    )

    type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } }
    type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

    let callbackFailed = false
    try {
      const contents: GeminiContent[] = []

      for (const msg of messages) {
        const parts: GeminiPart[] = []

        // Process image attachments
        if (msg.attachments && msg.attachments.length > 0) {
          const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
          for (const attachment of imageAttachments) {
            try {
              const base64 = await convertImageToBase64(
                attachment.url,
                control.signal,
                control.fetch
              )
              let mimeType = attachment.mimeType || 'image/jpeg'
              if (attachment.url.startsWith('data:')) {
                const mimeMatch = attachment.url.match(/data:([^;]+)/)
                if (mimeMatch) {
                  mimeType = mimeMatch[1]
                }
              }
              parts.push({
                inlineData: {
                  mimeType,
                  data: base64
                }
              })
            } catch (err) {
              if (control.signal.aborted) throw control.signal.reason
              console.error('[GeminiAPICli] Failed to process image attachment:', err)
            }
          }
        }

        // Add text content
        if (msg.content.trim()) {
          parts.push({ text: msg.content })
        }

        if (parts.length > 0) {
          const role = msg.role === 'assistant' ? 'model' : 'user'
          contents.push({ role, parts })
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestBody: Record<string, any> = {
        contents
      }
      if (params.temperature !== undefined) {
        requestBody.generationConfig = {
          ...(requestBody.generationConfig || {}),
          temperature: params.temperature
        }
      }
      if (params.maxOutputTokens) {
        requestBody.generationConfig = {
          ...(requestBody.generationConfig || {}),
          maxOutputTokens: params.maxOutputTokens
        }
      }

      if (systemPrompt) {
        requestBody.systemInstruction = {
          parts: [{ text: systemPrompt }]
        }
      }

      const url = new URL(endpoint)
      const authMode = this.options.authMode || 'query-key'
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.options.extraHeaders || {}),
        ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {}),
        ...invocationHeaders(params)
      }
      if (authMode === 'bearer') {
        if (this.apiKey.trim() && !headers.Authorization) {
          headers.Authorization = `Bearer ${this.apiKey}`
        }
      } else if (authMode === 'x-goog-api-key') {
        if (this.apiKey.trim() && !headers['x-goog-api-key']) {
          headers['x-goog-api-key'] = this.apiKey
        }
      } else {
        url.searchParams.set('key', this.apiKey)
      }

      const resp = await control.fetch(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      })

      if (!resp.ok) {
        throw await readProviderHttpError('Gemini', resp, control)
      }

      const data = (await control.json(resp, PROVIDER_JSON_MAX_BYTES)) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>
      }
      const content = data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')

      if (typeof content !== 'string' || !content) {
        throw new Error(`Gemini API returned empty or invalid content.`)
      }
      const usage = normalizeProviderTokenUsage(data)
      const result = normalizeLLMChatResult({
        content: content.trim(),
        ...(usage ? { usage } : {})
      })
      try {
        emitUnaryProviderDelta(params, result.content)
      } catch (error) {
        callbackFailed = true
        throw error
      }
      return result
    } catch (error) {
      if (callbackFailed) throw error
      if (control.signal.aborted) throw control.signal.reason
      throw buildFetchFailureError('Gemini API', endpoint, error)
    } finally {
      control.dispose()
    }
  }
}

// ==================== Claude API Client ====================

const normalizeClaudeClientOptions = (
  fetchImplOrOptions?: FetchImpl | ClaudeClientOptions
): ClaudeClientOptions =>
  typeof fetchImplOrOptions === 'function'
    ? { fetchImpl: fetchImplOrOptions }
    : fetchImplOrOptions || {}

const isBearerClaudeEndpoint = (baseUrl: string): boolean => {
  try {
    const parsed = new URL(baseUrl.trim())
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    return (
      (hostname === 'api.kimi.com' && pathname.includes('/coding')) ||
      (hostname === 'open.bigmodel.cn' && pathname.includes('/api/anthropic'))
    )
  } catch {
    return false
  }
}

export class ClaudeAPICli implements LLMCli {
  protected readonly options: ClaudeClientOptions

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    fetchImplOrOptions?: FetchImpl | ClaudeClientOptions
  ) {
    this.options = normalizeClaudeClientOptions(fetchImplOrOptions)
  }

  private getFetchImpl(): FetchImpl {
    return this.options.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    if (params.retryCapacity) {
      return retryModelCapacity(params, (onDelta) =>
        this.chat({ ...params, retryCapacity: false, onDelta })
      )
    }
    const { messages, systemPrompt, signal } = params
    const base = normalizeClaudeBaseUrl(this.baseUrl)
    const endpoint = `${base}/v1/messages`
    const control = new ProviderRequestControl(
      this.getFetchImpl(),
      signal,
      this.options.requestTimeoutMs ?? PROVIDER_CHAT_DEADLINE_MS,
      {},
      'Claude'
    )

    type ContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

    type ClaudeMessage = {
      role: 'user' | 'assistant'
      content: string | ContentBlock[]
    }

    let callbackFailed = false
    try {
      const claudeMessages: ClaudeMessage[] = []

      const selectedMessages =
        params.imageHistoryPolicy === undefined
          ? messages
          : selectImageHistoryMessages(messages, params.imageHistoryPolicy)
      for (const msg of projectAssistantImageReferenceTurns(selectedMessages)) {
        // Skip system messages (handled as a separate parameter in Claude API)
        if (msg.role === 'system') continue

        if (msg.attachments && msg.attachments.length > 0) {
          const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
          if (imageAttachments.length > 0 && msg.role === 'user') {
            const content: ContentBlock[] = []

            for (const attachment of imageAttachments) {
              try {
                const base64 = await convertImageToBase64(
                  attachment.url,
                  control.signal,
                  control.fetch
                )
                let mediaType = attachment.mimeType || 'image/jpeg'
                if (attachment.url.startsWith('data:')) {
                  const mimeMatch = attachment.url.match(/data:([^;]+)/)
                  if (mimeMatch) {
                    mediaType = mimeMatch[1]
                  }
                }
                content.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64
                  }
                })
              } catch (err) {
                if (control.signal.aborted) throw control.signal.reason
                console.error('[ClaudeAPICli] Failed to process image attachment:', err)
              }
            }

            if (msg.content.trim()) {
              content.push({ type: 'text', text: msg.content })
            }

            claudeMessages.push({
              role: msg.role as 'user' | 'assistant',
              content
            })
          } else {
            claudeMessages.push({
              role: msg.role as 'user' | 'assistant',
              content: msg.content
            })
          }
        } else {
          claudeMessages.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          })
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestBody: Record<string, any> = {
        model: this.modelName,
        max_tokens: params.maxOutputTokens || this.options.maxTokens || 4096,
        messages: claudeMessages,
        ...(params.temperature === undefined ? {} : { temperature: params.temperature })
      }

      if (systemPrompt) {
        requestBody.system = systemPrompt
      }

      const authAsBearer = this.options.authAsBearer ?? isBearerClaudeEndpoint(base)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(this.options.extraHeaders || {}),
        ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {}),
        ...invocationHeaders(params)
      }
      if (this.apiKey.trim()) {
        if (authAsBearer) {
          headers.Authorization = headers.Authorization || `Bearer ${this.apiKey}`
        } else {
          headers['x-api-key'] = headers['x-api-key'] || this.apiKey
        }
      }

      const resp = await control.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      })

      if (!resp.ok) {
        throw await readProviderHttpError('Claude', resp, control)
      }

      const data = (await control.json(resp, PROVIDER_JSON_MAX_BYTES)) as {
        content?: Array<{ text?: unknown }>
      }
      const contentText = Array.isArray(data?.content)
        ? data.content
            .map((block: { text?: unknown }) => (typeof block?.text === 'string' ? block.text : ''))
            .join('')
        : undefined

      if (typeof contentText !== 'string' || !contentText) {
        throw new Error(`Claude API returned empty or invalid content.`)
      }
      const usage = normalizeProviderTokenUsage(data)
      const result = normalizeLLMChatResult({
        content: contentText.trim(),
        ...(usage ? { usage } : {})
      })
      try {
        emitUnaryProviderDelta(params, result.content)
      } catch (error) {
        callbackFailed = true
        throw error
      }
      return result
    } catch (error) {
      if (callbackFailed) throw error
      if (control.signal.aborted) throw control.signal.reason
      throw buildFetchFailureError('Claude API', endpoint, error)
    } finally {
      control.dispose()
    }
  }
}

// ==================== OpenCode Zen API Client ====================

export class OpencodeZenAPICli implements LLMCli {
  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    protected readonly options?: ProviderClientOptions
  ) {}

  private getBaseUrl(): string {
    const trimmed = normalizeOpenAIBaseUrl(this.baseUrl || OPENCODE_ZEN_API_BASE_URL)
      .replace(/\/messages\/?$/i, '')
      .replace(/\/models\/[^/?#:]+(?::generateContent)?\/?$/i, '')
      .replace(/\/$/, '')
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

    try {
      const parsed = new URL(normalized)
      if (parsed.hostname.toLowerCase() !== 'opencode.ai') {
        return normalized
      }

      const pathname = parsed.pathname.replace(/\/+$/g, '') || '/zen/v1'
      if (pathname === '/zen') {
        return `${parsed.origin}/zen/v1`
      }
      const versionMatch = pathname.match(
        /^(\/zen\/v\d+)(?:\/(?:responses|messages|chat\/completions))?$/i
      )
      if (versionMatch) {
        return `${parsed.origin}${versionMatch[1]}`
      }
    } catch {
      // Fall back to the string normalization above.
    }

    return normalized
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const modelName = resolveOpencodeZenAlias(this.modelName)
    const baseUrl = this.getBaseUrl()
    const modelApi = resolveOpencodeZenModelApi(modelName)

    switch (modelApi) {
      case 'openai-responses':
        return new OpenAIAPICli(this.apiKey, baseUrl, modelName, {
          apiMode: 'responses',
          enableHostedTools: false,
          fetchImpl: this.options?.fetchImpl,
          requestTimeoutMs: this.options?.requestTimeoutMs
        }).chat(params)
      case 'anthropic-messages':
        return new ClaudeAPICli(this.apiKey, baseUrl, modelName, {
          authAsBearer: false,
          fetchImpl: this.options?.fetchImpl,
          requestTimeoutMs: this.options?.requestTimeoutMs
        }).chat(params)
      case 'google-generative-ai':
        return new GeminiAPICli(this.apiKey, baseUrl, modelName, {
          authMode: 'x-goog-api-key',
          fetchImpl: this.options?.fetchImpl,
          requestTimeoutMs: this.options?.requestTimeoutMs
        }).chat(params)
      case 'openai-completions':
      default:
        return new OpenAIAPICli(
          this.apiKey,
          `${baseUrl.replace(/\/$/, '')}/chat/completions`,
          modelName,
          {
            apiMode: 'chat-completions',
            fetchImpl: this.options?.fetchImpl,
            requestTimeoutMs: this.options?.requestTimeoutMs
          }
        ).chat(params)
    }
  }
}

// ==================== Ollama API Client ====================

export class OllamaAPICli implements LLMCli {
  private readonly options: ProviderClientOptions

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    protected readonly modelName: string,
    fetchImplOrOptions?: FetchImpl | ProviderClientOptions
  ) {
    this.options =
      typeof fetchImplOrOptions === 'function'
        ? { fetchImpl: fetchImplOrOptions }
        : fetchImplOrOptions || {}
  }

  private getFetchImpl(): FetchImpl {
    return this.options.fetchImpl ?? getDefaultFetchImpl()
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    if (params.retryCapacity) {
      return retryModelCapacity(params, (onDelta) =>
        this.chat({ ...params, retryCapacity: false, onDelta })
      )
    }
    const { messages, systemPrompt, signal } = params
    const base = normalizeOllamaBaseUrl(this.baseUrl)
    const endpoint = `${base}/api/chat`
    const control = new ProviderRequestControl(
      this.getFetchImpl(),
      signal,
      this.options.requestTimeoutMs ?? PROVIDER_CHAT_DEADLINE_MS,
      {},
      'Ollama'
    )

    type Role = 'system' | 'user' | 'assistant'
    type OllamaMessage = {
      role: Role
      content: string
      images?: string[]
    }

    let callbackFailed = false
    try {
      const ollamaMessages: OllamaMessage[] = []
      if (systemPrompt) {
        ollamaMessages.push({ role: 'system', content: systemPrompt })
      }

      for (const msg of messages) {
        const ollamaMsg: OllamaMessage = { role: msg.role, content: msg.content }

        // Handle image attachments for Ollama
        if (msg.attachments && msg.attachments.length > 0) {
          const imageAttachments = msg.attachments.filter((a) => a.type === 'image')
          if (imageAttachments.length > 0) {
            ollamaMsg.images = []
            for (const attachment of imageAttachments) {
              try {
                const base64 = await convertImageToBase64(
                  attachment.url,
                  control.signal,
                  control.fetch
                )
                ollamaMsg.images.push(base64)
              } catch (err) {
                if (control.signal.aborted) throw control.signal.reason
                console.error('[OllamaAPICli] Failed to process image attachment:', err)
              }
            }
          }
        }

        ollamaMessages.push(ollamaMsg)
      }

      const requestBody = {
        model: this.modelName,
        messages: ollamaMessages,
        stream: false,
        ...(params.maxOutputTokens || params.temperature !== undefined
          ? {
              options: {
                ...(params.maxOutputTokens ? { num_predict: params.maxOutputTokens } : {}),
                ...(params.temperature === undefined ? {} : { temperature: params.temperature })
              }
            }
          : {})
      }

      const resp = await control.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(params.correlationId ? { 'X-MagicPot-Correlation-Id': params.correlationId } : {}),
          ...invocationHeaders(params)
        },
        body: JSON.stringify(requestBody)
      })

      if (!resp.ok) {
        throw await readProviderHttpError('Ollama', resp, control)
      }

      const data = (await control.json(resp, PROVIDER_JSON_MAX_BYTES)) as {
        message?: { content?: unknown }
      }
      const content = data?.message?.content

      if (typeof content !== 'string' || !content) {
        throw new Error(`Ollama API returned empty or invalid content.`)
      }
      const usage = normalizeProviderTokenUsage(data)
      const result = normalizeLLMChatResult({
        content: content.trim(),
        ...(usage ? { usage } : {})
      })
      try {
        emitUnaryProviderDelta(params, result.content)
      } catch (error) {
        callbackFailed = true
        throw error
      }
      return result
    } catch (error) {
      if (callbackFailed) throw error
      if (control.signal.aborted) throw control.signal.reason
      throw buildFetchFailureError('Ollama API', endpoint, error)
    } finally {
      control.dispose()
    }
  }
}
