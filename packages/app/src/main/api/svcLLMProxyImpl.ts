// Main-process LLM proxy service used by chat, OCR, skill routing, and local model integrations.
// This file centralizes provider selection and media-aware request handling.

import { net } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { normalizeModelRetryStatus } from '@shared/llm/modelCapacityRetry'
import { withCanvasFileTools } from './canvasFileTools'
import { createCanvasPathReadHandler, type CanvasPathReadHandler } from './canvasPathReadApproval'
import { createSkillToolStream } from './skillToolStream'
import { parseSkillToolInvocation } from './skillToolProtocol'
import {
  MAX_AGENT_TOOL_CALLS,
  MAX_NATIVE_TRANSCRIPT_BYTES,
  prepareNativeToolBatch,
  isNativeToolsUnsupportedError,
  type LLMFunctionCall,
  type LLMToolTurn
} from '@shared/llm/nativeTools'
import { streamExternalAgent } from './externalAgentStream'
import type { LLMExternalAgentStreamReq, LLMExternalAgentStreamResp } from '@shared/api/svcLLMProxy'
import {
  LLMProxySvc,
  LLMChatReq,
  LLMChatOptions,
  LLMChatResp,
  LLMChatStreamReq,
  LLMChatStreamResp,
  LLMListProfilesReq,
  LLMListProfilesResp,
  LLMServerStatusReq,
  LLMServerStatusResp,
  LLMRemoteFetchReq,
  LLMRemoteFetchResp,
  LLMCancelConversationReq,
  LLMCancelConversationResp,
  LLMUploadHy3DModelReq,
  LLMUploadHy3DModelResp,
  LLMSignHy3DModelReq,
  LLMSignHy3DModelResp,
  LLMClearHy3DCosPrefixReq,
  LLMClearHy3DCosPrefixResp,
  LLMToolStatus,
  ChatMessage,
  ChatAttachment,
  OCRResult
} from '@shared/api/svcLLMProxy'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { getConfig, onConfigCommitted } from '../config/config'
import { Config, LLMAPIProfile, resolveCustomSkillContextMessageLimit } from '@shared/config/config'
import {
  findHunyuan3DQAppProfile,
  getQAppApiProfiles,
  isConfiguredHunyuan3DProfile,
  isHunyuan3DCompatibleProfile
} from '@shared/config/apiProfileSelectors'
import {
  cliFromProfile,
  describeFetchFailure,
  type FetchImpl,
  isRunnableProfile,
  normalizeLLMChatResult,
  normalizeOpenAIBaseUrl,
  parseStructuredLLMChatResult,
  resolveChatProfileCapabilities,
  resolveProfileDeployment,
  resolveProfileProvider,
  resolveProfileModelUse,
  selectProviderAttachmentTransport,
  resolveTaggerProviderDescriptor,
  resolveTaggerRuntimeDescriptor,
  isTaggerSkillRuntime,
  getTaggerProviderDisplayLabel,
  type LLMChatResult,
  type LLMDeltaEvent
} from '@shared/llm'
import { resolveRemoteProfileRouting } from '@shared/llm/remoteProfileRouting'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import { normalizeAllowedToolNames } from '../assistantRuntime/toolAccess'
import type { AssistantRoute } from '../assistantRuntime/types'
import { buildAgentRoute, normalizeAgentRoute } from '@shared/agent'
import { Hunyuan3DClient } from '../llmProxy/hunyuan3dClient'
import {
  clearHy3dCosPrefix,
  signHy3dCosModel,
  uploadBufferedHy3dModel,
  uploadLocalHy3dModel
} from '../llmProxy/hunyuan3dCos'
import { validateStructuredSkillOutput } from './skillRuntimeStructuredOutput'
import { syncMcpClientManager } from '../mcp/runtime'
import fs from 'node:fs/promises'
import { isLocalFileSource } from '../utils/localFileUrl'
import { isPrivateOrLocalRemoteFetchHost } from './remoteFetchPolicy'
import { remoteFetch as executeRemoteFetch } from './remoteFetch'
import { consumeTrustedLocalFileSelection } from './trustedFileSelection'
import { safeRemoteDownload } from './safeRemoteDownload'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { LlmProfileRevision } from './llmProfileRevision'
import { RemoteProjectComparisonClient } from './remoteProjectComparison'
import {
  DEFAULT_HY3D_API_REGION,
  normalizeConfiguredSecret,
  normalizeHunyuan3DError,
  parseHy3dProfileExtras
} from './hunyuan3dUtils'
// Browser automation snapshots may arrive through file URLs; normalize them before downstream handling.

const isMockFetchFunction = (value: unknown): value is FetchImpl =>
  typeof value === 'function' && 'mock' in (value as unknown as { mock?: unknown })

const applySkillRuntimeContextMessageLimit = (req: LLMChatReq): LLMChatReq => {
  if (!req.skillRuntime) {
    return req
  }

  const contextMessageLimit = resolveCustomSkillContextMessageLimit(req.skillRuntime.execution)
  if (contextMessageLimit === 'all') {
    return req
  }

  const messageLimit = contextMessageLimit === 0 ? 1 : contextMessageLimit + 1
  return {
    ...req,
    messages: req.messages.slice(-messageLimit),
    sessionUrl: undefined
  }
}

const getElectronNetFetch = (): typeof net.fetch | null => {
  const candidate = (net as unknown as { fetch?: typeof net.fetch } | undefined)?.fetch
  return typeof candidate === 'function' ? candidate : null
}

export type ElectronIncomingMessageLike = {
  headers: Record<string, string | string[] | undefined>
  on: {
    (event: 'data', listener: (chunk: Buffer | string) => void): unknown
    (event: 'error', listener: (error: unknown) => void): unknown
  }
  pause?: () => void
  resume?: () => void
  once: {
    (event: 'aborted' | 'end', listener: () => void): unknown
    (event: 'error', listener: (error: unknown) => void): unknown
  }
  statusCode: number
  statusMessage: string
}

export type ElectronClientRequestLike = {
  abort: () => void
  end: (chunk?: string | Buffer) => unknown
  on: (event: 'error', listener: (error: unknown) => void) => unknown
  once: {
    (event: 'response', listener: (response: ElectronIncomingMessageLike) => void): unknown
    (event: 'abort', listener: () => void): unknown
    (event: 'error', listener: (error: unknown) => void): unknown
  }
  setHeader: (name: string, value: string) => void
}

export type ElectronRequestFactory = (options: {
  method: string
  url: string
  redirect: 'follow' | 'error' | 'manual'
  credentials?: 'omit' | 'include'
  useSessionCookies?: boolean
}) => ElectronClientRequestLike

export const createElectronRequestFetch = (electronRequest: ElectronRequestFactory): FetchImpl =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      throw init.signal.reason || new DOMException('The operation was aborted.', 'AbortError')
    }

    const request = new Request(input, init)
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null

    if (request.signal.aborted) {
      throw request.signal.reason || new DOMException('The operation was aborted.', 'AbortError')
    }

    return await new Promise<Response>((resolve, reject) => {
      const clientRequest = electronRequest({
        method: request.method,
        url: request.url,
        redirect:
          request.redirect === 'manual'
            ? 'manual'
            : request.redirect === 'error'
              ? 'error'
              : 'follow',
        // Electron's same-origin mode requires an origin; retain legacy defaults otherwise.
        ...(request.credentials === 'omit'
          ? { credentials: 'omit' as const, useSessionCookies: false }
          : request.credentials === 'include'
            ? { credentials: 'include' as const }
            : {})
      })
      let settled = false
      let requestAborted = false
      let abortResponseStream: ((reason: unknown) => void) | null = null

      const cleanup = (): void => request.signal.removeEventListener('abort', handleAbort)
      const abortClientRequest = (): void => {
        if (requestAborted) return
        requestAborted = true
        clientRequest.abort()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const failRequest = (error: unknown): void => {
        if (settled && !abortResponseStream) return
        abortResponseStream?.(error)
        fail(error)
        abortClientRequest()
      }
      const handleAbort = (): void => {
        const reason =
          request.signal.reason || new DOMException('The operation was aborted.', 'AbortError')
        failRequest(reason)
      }

      // Keep error listeners installed so late errors after cancellation remain harmless.
      clientRequest.on('error', failRequest)
      clientRequest.once('abort', () => {
        requestAborted = true
        failRequest(new DOMException('The operation was aborted.', 'AbortError'))
      })
      clientRequest.once('response', (incoming) => {
        let streamFinished = false
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
        const finishStream = (reason?: unknown): void => {
          if (streamFinished) return
          streamFinished = true
          abortResponseStream = null
          cleanup()
          if (!streamController) return
          if (reason === undefined) {
            streamController.close()
          } else {
            streamController.error(reason instanceof Error ? reason : new Error(String(reason)))
          }
        }

        incoming.on('error', failRequest)
        incoming.once('aborted', () =>
          failRequest(new Error('Electron network response was aborted.'))
        )
        incoming.once('end', () => finishStream())
        if (settled) {
          finishStream()
          abortClientRequest()
          return
        }
        abortResponseStream = (reason) => finishStream(reason)

        try {
          const headers = new Headers()
          for (const [name, values] of Object.entries(incoming.headers)) {
            for (const value of typeof values === 'string' ? [values] : (values ?? [])) {
              headers.append(name, value)
            }
          }
          const hasNullBody =
            request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)
          const responseStream = hasNullBody
            ? null
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  streamController = controller
                  incoming.on('data', (chunk: Buffer | string) => {
                    if (streamFinished) return
                    controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                    if (controller.desiredSize != null && controller.desiredSize <= 0)
                      incoming.pause?.()
                  })
                },
                pull() {
                  if (!streamFinished) incoming.resume?.()
                },
                cancel() {
                  if (streamFinished) return
                  streamFinished = true
                  abortResponseStream = null
                  cleanup()
                  abortClientRequest()
                }
              })
          const response = new Response(responseStream, {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers
          })
          Object.defineProperty(response, 'url', { configurable: true, value: request.url })
          settled = true
          resolve(response)
          if (hasNullBody) {
            // Do not read or drain a body Fetch cannot expose, even if the peer keeps sending.
            finishStream()
            abortClientRequest()
          }
        } catch (error) {
          failRequest(error)
        }
      })

      request.signal.addEventListener('abort', handleAbort, { once: true })
      if (request.signal.aborted) {
        handleAbort()
        return
      }
      try {
        request.headers.forEach((value, name) => {
          if (name.toLowerCase() === 'content-length') return
          clientRequest.setHeader(name, value)
        })
        clientRequest.end(body || undefined)
      } catch (error) {
        failRequest(error)
      }
    })
  }) as FetchImpl

const createMainProcessElectronRequestFetch = (): FetchImpl | null => {
  const electronRequest = (net as unknown as { request?: typeof net.request } | undefined)?.request
  if (typeof electronRequest !== 'function') return null

  return createElectronRequestFetch(
    (options) => electronRequest.call(net, options) as unknown as ElectronClientRequestLike
  )
}
const createMainProcessElectronFetch = (): FetchImpl | null => {
  const electronFetch = getElectronNetFetch()
  const electronRequestFetch = createMainProcessElectronRequestFetch()
  if (!electronFetch && !electronRequestFetch) return null

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(
      init?.method || (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    const hasBody = init?.body != null || (input instanceof Request && input.body != null)
    if (hasBody && method !== 'GET' && method !== 'HEAD' && electronRequestFetch) {
      return electronRequestFetch(input, init)
    }
    if (electronFetch) {
      return electronFetch(
        input instanceof URL ? input.toString() : (input as unknown as string | Request),
        init as Parameters<typeof electronFetch>[1]
      )
    }
    return electronRequestFetch!(input, init)
  }) as FetchImpl
}

// ==================== Chat execution helpers ====================

type ChatExecutionOptions = LLMChatOptions & {
  readExternalFile?: CanvasPathReadHandler
  runId?: string
  executeTool?: (invocation: {
    toolName: string
    args: Record<string, unknown>
    runId: string
    toolCallId: string
    signal?: AbortSignal
  }) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  onDelta?: (event: LLMDeltaEvent) => void
}

const dedupeChatAttachments = (
  attachments: ChatAttachment[] | undefined
): ChatAttachment[] | undefined => {
  if (!attachments?.length) {
    return undefined
  }

  const unique: ChatAttachment[] = []
  const seen = new Set<string>()
  for (const attachment of attachments) {
    const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(attachment)
  }

  return unique
}

const mergeChatMetadata = (
  primary?: Record<string, unknown>,
  secondary?: Record<string, unknown>
): Record<string, unknown> | undefined => {
  if (!primary && !secondary) {
    return undefined
  }

  return {
    ...(primary || {}),
    ...(secondary || {})
  }
}

const STRICT_RASTER_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/
const QAPP_INLINE_IMAGE_POLICY_MARKER = 'qapp-renderer-materialized-v1'
const MAX_PROVIDER_ACCESSIBLE_URL_LENGTH = 8 * 1024
const RASTER_SIGNATURE_BASE64_LENGTH = 16
const REMOTE_STREAM_ENDPOINTS = [
  '/api/chat',
  '/api/bot/chat',
  '/api/bot/message',
  '/api/message'
] as const
export const REMOTE_STREAM_DEADLINE_MS = 2 * 60 * 1000
const REMOTE_STREAM_MAX_REQUEST_BYTES = 16 * 1024 * 1024
const REMOTE_STREAM_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const REMOTE_STREAM_MAX_FRAME_BYTES = 512 * 1024
const REMOTE_STREAM_MAX_EVENTS = 4096
const REMOTE_STREAM_MAX_TEXT_BYTES = 4 * 1024 * 1024
const REMOTE_ERROR_DETAIL_MAX_BYTES = 64 * 1024
const REMOTE_OUTPUT_URL_MAX_LENGTH = 8192

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  return `${bytes.subarray(0, maxBytes).toString('utf8')}…`
}

const redactRemoteErrorText = (value: string): string =>
  value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(
      /(["']?(?:access[_-]?token|api[_-]?key|authorization|cookie|password|secret)["']?\s*[:=]\s*["']?)[^"'&,\s}]+/gi,
      '$1[redacted]'
    )

const extractRemoteErrorDetail = (body: string): string => {
  const trimmed = body.trim()
  if (!trimmed) return '(empty response body)'
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isPlainRecord(parsed)) {
      const values: string[] = []
      const collect = (value: unknown): void => {
        if (typeof value === 'string' && value.trim()) values.push(value.trim())
        else if (isPlainRecord(value)) {
          for (const key of ['code', 'type', 'message', 'detail', 'error']) collect(value[key])
        }
      }
      collect(parsed)
      if (values.length > 0) return values.join(': ')
    }
  } catch {
    // Fall through to bounded plain-text detail.
  }
  return trimmed
}

const boundRemoteErrorDetail = (body: string): string =>
  truncateUtf8(redactRemoteErrorText(extractRemoteErrorDetail(body)), REMOTE_ERROR_DETAIL_MAX_BYTES)

const createRemoteErrorBody = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isPlainRecord(parsed)) {
      const safeKeys = new Set([
        'code',
        'type',
        'status',
        'continuation',
        'is_continuation',
        'error_code',
        'error_type',
        'errorType',
        'message',
        'detail',
        'error',
        'details',
        'cause'
      ])
      const project = (value: unknown, depth: number): unknown => {
        if (depth > 3) return undefined
        if (typeof value === 'string') return truncateUtf8(redactRemoteErrorText(value), 16 * 1024)
        if (!isPlainRecord(value)) return undefined
        const result: Record<string, unknown> = {}
        for (const [key, nested] of Object.entries(value)) {
          if (!safeKeys.has(key)) continue
          const projected = project(nested, depth + 1)
          if (projected !== undefined) result[key] = projected
        }
        return result
      }
      const projected = project(parsed, 0)
      if (isPlainRecord(projected) && Object.keys(projected).length > 0) {
        return truncateUtf8(JSON.stringify(projected), REMOTE_ERROR_DETAIL_MAX_BYTES)
      }
    }
  } catch {
    // Fall through to bounded, redacted plain text.
  }
  return truncateUtf8(redactRemoteErrorText(body), REMOTE_ERROR_DETAIL_MAX_BYTES)
}

type RemoteUpstreamError = Error & {
  status: number
  statusCode: number
  body: string
}

export const createRemoteUpstreamError = (
  status: number,
  statusText: string,
  body: string
): RemoteUpstreamError =>
  Object.assign(
    new Error(
      `Remote LLM streaming request failed (HTTP ${status}${statusText ? ` ${statusText}` : ''}): ${boundRemoteErrorDetail(body)}`
    ),
    { status, statusCode: status, body: createRemoteErrorBody(body) }
  )

const isSafeRemoteOutputUrl = (value: string, trustedRemoteOrigin?: string): boolean => {
  if (!value || value.length > REMOTE_OUTPUT_URL_MAX_LENGTH) return false
  try {
    const parsed = new URL(value)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return false
    }
    if (trustedRemoteOrigin && parsed.origin === trustedRemoteOrigin) return true
    return parsed.protocol === 'https:' && !isPrivateOrLocalRemoteFetchHost(parsed.hostname)
  } catch {
    return false
  }
}

const isSafeRemoteSessionRef = (value: string, trustedRemoteOrigin?: string): boolean => {
  const trimmed = value.trim()
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  if (!trimmed || trimmed.length > REMOTE_OUTPUT_URL_MAX_LENGTH || hasControlCharacter) {
    return false
  }
  if (/^(?:blob|data|file|javascript|local-media):/i.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return isSafeRemoteOutputUrl(trimmed, trustedRemoteOrigin)
    }
  } catch {
    // Opaque session references are intentionally not parsed as fetch URLs.
  }
  return true
}

const assertSafeRemoteOutputUrl = (
  value: string | undefined,
  label: string,
  trustedRemoteOrigin?: string
): void => {
  if (value !== undefined && value !== '' && !isSafeRemoteOutputUrl(value, trustedRemoteOrigin)) {
    throw new Error(`Remote LLM streaming response contained an unsafe ${label} URL.`)
  }
}

const assertSafeRemoteSessionRef = (
  value: string | undefined,
  trustedRemoteOrigin?: string
): void => {
  if (value !== undefined && value !== '' && !isSafeRemoteSessionRef(value, trustedRemoteOrigin)) {
    throw new Error('Remote LLM streaming response contained an unsafe session reference.')
  }
}

const assertSafeRemoteOcrResult = (
  ocrResult: OCRResult | undefined,
  label: string,
  trustedRemoteOrigin?: string
): void => {
  assertSafeRemoteOutputUrl(
    ocrResult?.sourceImageUrl,
    `${label} OCR source image`,
    trustedRemoteOrigin
  )
}

const assertSafeRemoteAttachment = (
  attachment: ChatAttachment,
  label: string,
  trustedRemoteOrigin?: string
): void => {
  if (
    !attachment ||
    typeof attachment.url !== 'string' ||
    !isSafeRemoteOutputUrl(attachment.url, trustedRemoteOrigin)
  ) {
    throw new Error(`Remote LLM streaming response contained an unsafe ${label} attachment URL.`)
  }
  assertSafeRemoteOcrResult(attachment.ocrResult, label, trustedRemoteOrigin)
}

const assertSafeRemoteEventUrls = (
  event: LLMChatStreamResp,
  trustedRemoteOrigin?: string
): void => {
  assertSafeRemoteOutputUrl(event.imageUrl, 'image', trustedRemoteOrigin)
  assertSafeRemoteSessionRef(event.sessionUrl, trustedRemoteOrigin)
  assertSafeRemoteOcrResult(event.ocrResult, 'event', trustedRemoteOrigin)
  if (event.attachment) assertSafeRemoteAttachment(event.attachment, 'event', trustedRemoteOrigin)
  for (const attachment of event.attachments || []) {
    assertSafeRemoteAttachment(attachment, 'event', trustedRemoteOrigin)
  }
}

const REMOTE_STALE_CONTINUATION_CODES = new Set([
  'conversation_expired',
  'conversation_not_found',
  'continuation_expired',
  'continuation_not_found',
  'continuation_stale',
  'invalid_continuation',
  'invalid_session',
  'previous_response_not_found',
  'session_expired',
  'session_not_found',
  'stale_session'
])

type RemoteErrorRecord = Record<string, unknown>

const normalizeRemoteErrorCode = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_')
  return normalized || undefined
}

const parseRemoteErrorRecords = (body: string): RemoteErrorRecord[] => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isPlainRecord(parsed)) return []
    const records: RemoteErrorRecord[] = [parsed]
    for (const key of ['error', 'details', 'cause']) {
      const value = parsed[key]
      if (isPlainRecord(value)) records.push(value)
    }
    return records
  } catch {
    return []
  }
}

const isRemoteContinuationDetail = (
  status: number,
  body: string,
  hasSessionUrl: boolean
): boolean => {
  if (![404, 405, 410].includes(status) || !hasSessionUrl) return false

  const records = parseRemoteErrorRecords(body)
  for (const record of records) {
    const code = normalizeRemoteErrorCode(record.code)
    const type = normalizeRemoteErrorCode(record.type)
    if ([code, type].some((value) => value && REMOTE_STALE_CONTINUATION_CODES.has(value))) {
      return true
    }
  }

  // Unstructured route errors are deliberately not treated as stale continuation
  // details. This keeps legacy endpoint probing safe when a generic body happens
  // to mention a session or continuation.
  return false
}

const inferRasterMimeTypeFromBytes = (bytes: Buffer): string | undefined => {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  const gifSignature = bytes.toString('ascii', 0, 6)
  if (gifSignature === 'GIF87a' || gifSignature === 'GIF89a') {
    return 'image/gif'
  }
  return undefined
}

const stripQAppInlineImagePolicyMarker = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => ({
    ...message,
    ...(message.attachments
      ? {
          attachments: message.attachments.map((attachment) => {
            if (attachment.metadata?.internalTransport !== QAPP_INLINE_IMAGE_POLICY_MARKER) {
              return attachment
            }
            const metadata = { ...attachment.metadata }
            delete metadata.internalTransport
            return {
              ...attachment,
              ...(Object.keys(metadata).length > 0 ? { metadata } : { metadata: undefined })
            }
          })
        }
      : {})
  }))

const countProviderBoundImageAttachments = (messages: readonly ChatMessage[]): number => {
  const expandedReportBundleIds = new Set(
    messages.flatMap((message) =>
      (message.attachments || [])
        .filter(
          (attachment) =>
            attachment.type === 'image' &&
            attachment.reportBundleRole === 'report-image' &&
            Boolean(attachment.reportBundleId)
        )
        .map((attachment) => attachment.reportBundleId as string)
    )
  )

  return messages.reduce(
    (total, message) =>
      total +
      (message.role === 'system'
        ? 0
        : (message.attachments || []).reduce((count, attachment) => {
            if (attachment.type === 'image') return count + 1
            if (
              expandedReportBundleIds.has(attachment.reportBundleId || '') ||
              typeof attachment.reportBundleImageCount !== 'number' ||
              !Number.isSafeInteger(attachment.reportBundleImageCount) ||
              attachment.reportBundleImageCount < 0
            ) {
              return count
            }
            return count + attachment.reportBundleImageCount
          }, 0)),
    0
  )
}

const validateInlineImageAttachmentTransport = (
  profile: LLMAPIProfile,
  messages: ChatMessage[],
  profileScope?: LLMChatReq['profileScope'],
  requestApiMode?: LLMChatReq['apiMode']
): void => {
  // Match discovery and client dispatch, including overrides and Zen aliases.
  const routing = resolveRemoteProfileRouting({
    ...profile,
    ...(requestApiMode ? { api_mode: requestApiMode } : {})
  })
  const provider = routing.provider ?? resolveProfileProvider(profile)
  const isOpenAIImageProfile = routing.provider === 'openai' && routing.api_mode === 'images'
  const supportsAccessibleUrl =
    routing.provider === 'openai' &&
    (routing.api_mode === 'responses' || routing.api_mode === 'chat-completions')
  if (
    !isOpenAIImageProfile &&
    !supportsAccessibleUrl &&
    provider !== 'openai' &&
    provider !== 'gemini' &&
    provider !== 'claude' &&
    provider !== 'ollama'
  ) {
    return
  }

  const imageAttachments = messages.flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type === 'image')
  )
  if (imageAttachments.length === 0) {
    return
  }

  const capabilities = resolveChatProfileCapabilities(profile)
  const effectiveImageCount = countProviderBoundImageAttachments(messages)
  if (
    capabilities.maxInputImages !== undefined &&
    effectiveImageCount > capabilities.maxInputImages
  ) {
    throw new Error(`Too many images; the limit is ${capabilities.maxInputImages}.`)
  }

  const hasValidatedQAppInlineImagePolicy =
    profileScope === 'qapp' &&
    imageAttachments.every(
      (attachment) => attachment.metadata?.internalTransport === QAPP_INLINE_IMAGE_POLICY_MARKER
    )
  const requestDataUrlTransport = selectProviderAttachmentTransport(capabilities, {
    available: { 'request-data-url': true },
    requested: 'request-data-url'
  })
  if (isOpenAIImageProfile) {
    return
  }

  const accessibleUrlTransport = selectProviderAttachmentTransport(capabilities, {
    available: { 'accessible-url': supportsAccessibleUrl },
    requested: 'accessible-url'
  })

  for (const attachment of imageAttachments) {
    if (supportsAccessibleUrl && !attachment.url.startsWith('data:')) {
      if (accessibleUrlTransport !== 'accessible-url') {
        throw new Error(
          `Attachment transport error: ${provider} profile "${profile.id}" must declare "accessible-url" before accepting image URLs.`
        )
      }
      // This only validates a provider-bound URL, not a download. Materialization
      // and Images edits retain their guarded DNS/redirect-aware loader.
      try {
        if (
          attachment.url.length > MAX_PROVIDER_ACCESSIBLE_URL_LENGTH ||
          !/^https:\/\/[^\s\\]+$/i.test(attachment.url) ||
          attachment.url.slice('https://'.length).startsWith('/')
        ) {
          throw new Error('invalid URL')
        }
        const parsed = new URL(attachment.url)
        if (
          parsed.protocol !== 'https:' ||
          parsed.username ||
          parsed.password ||
          parsed.hash ||
          (!parsed.hostname.includes('.') && !parsed.hostname.includes(':')) ||
          isPrivateOrLocalRemoteFetchHost(parsed.hostname)
        ) {
          throw new Error('unsafe URL')
        }
      } catch {
        throw new Error(
          `Attachment transport error: ${provider} profile "${profile.id}" requires a public HTTPS image URL without credentials or fragments; local references and file IDs are not supported.`
        )
      }
      continue
    }

    if (!hasValidatedQAppInlineImagePolicy && requestDataUrlTransport !== 'request-data-url') {
      throw new Error(
        `Attachment transport error: ${provider} profile "${profile.id}" must declare "request-data-url" before accepting inline image attachments.`
      )
    }

    const match = STRICT_RASTER_DATA_URL.exec(attachment.url)
    if (!match) {
      throw new Error(
        `Attachment transport error: ${provider} profile "${profile.id}" accepts only non-empty canonical base64 data URLs for PNG, JPEG, WebP, or GIF images; URLs, file IDs, and local references are not supported by the built-in client.`
      )
    }

    const base64 = match[2]
    if (base64.length % 4 !== 0) {
      throw new Error(
        `Attachment transport error: ${provider} profile "${profile.id}" received malformed image base64.`
      )
    }

    const signatureBase64 = base64.slice(0, RASTER_SIGNATURE_BASE64_LENGTH)
    const signatureBytes = Buffer.from(signatureBase64, 'base64')
    const finalQuartet = base64.slice(-4)
    if (
      signatureBytes.toString('base64') !== signatureBase64 ||
      Buffer.from(finalQuartet, 'base64').toString('base64') !== finalQuartet
    ) {
      throw new Error(
        `Attachment transport error: ${provider} profile "${profile.id}" received non-canonical image base64.`
      )
    }
    const byteMimeType = inferRasterMimeTypeFromBytes(signatureBytes)
    if (!byteMimeType) {
      throw new Error(
        `Attachment transport error: ${provider} profile "${profile.id}" received unsupported raster image bytes.`
      )
    }
    if (
      byteMimeType !== match[1] ||
      (attachment.mimeType && attachment.mimeType !== byteMimeType)
    ) {
      throw new Error(
        `Attachment transport error: ${provider} profile "${profile.id}" received an image MIME mismatch.`
      )
    }
  }
}

const validateVideoImageAttachmentTransport = (
  profile: LLMAPIProfile,
  messages: ChatMessage[]
): void => {
  const imageAttachments = messages.flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type === 'image')
  )
  for (const attachment of imageAttachments) {
    const value = attachment.url
    if (!value || value.length > MAX_PROVIDER_ACCESSIBLE_URL_LENGTH) {
      throw new Error(
        `Video attachment transport error: profile "${profile.id}" requires a non-empty image URL of at most ${MAX_PROVIDER_ACCESSIBLE_URL_LENGTH} characters.`
      )
    }
    try {
      const parsed = new URL(value)
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        isPrivateOrLocalRemoteFetchHost(parsed.hostname)
      ) {
        throw new Error('unsafe')
      }
    } catch {
      throw new Error(
        `Video attachment transport error: profile "${profile.id}" requires public HTTPS image URLs without credentials; data, blob, file, local-media, localhost, and private-network URLs are not supported.`
      )
    }
  }
}

const toLLMChatResp = (value: string | LLMChatResult): LLMChatResp => {
  const normalized = normalizeLLMChatResult(value)
  const structuredContent = parseStructuredLLMChatResult(normalized.content)
  const attachments = dedupeChatAttachments([
    ...(structuredContent?.attachments || []),
    ...(normalized.attachments || [])
  ])
  const metadata = mergeChatMetadata(structuredContent?.metadata, normalized.metadata)
  const usage = structuredContent?.usage || normalized.usage

  return {
    content: structuredContent ? structuredContent.content : normalized.content,
    ...(normalized.imageUrl || structuredContent?.imageUrl
      ? { imageUrl: normalized.imageUrl || structuredContent?.imageUrl }
      : {}),
    ...(normalized.sessionUrl || structuredContent?.sessionUrl
      ? { sessionUrl: normalized.sessionUrl || structuredContent?.sessionUrl }
      : {}),
    ...(attachments ? { attachments } : {}),
    ...(normalized.ocrResult || structuredContent?.ocrResult
      ? { ocrResult: normalized.ocrResult || structuredContent?.ocrResult }
      : {}),
    ...(normalized.finishReason || structuredContent?.finishReason
      ? { finishReason: normalized.finishReason || structuredContent?.finishReason }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(usage ? { usage } : {})
  }
}

// ==================== 服务实现 ====================

const parseStructuredChatResponse = (content: string): LLMChatResp | null => {
  const parsed = parseStructuredLLMChatResult(content)
  return parsed ? toLLMChatResp(parsed) : null
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return

  const reason = signal.reason
  if (reason instanceof Error) {
    throw reason
  }

  const error = new Error(typeof reason === 'string' ? reason : 'The request was aborted.')
  error.name = 'AbortError'
  throw error
}

const createAbortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export const LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE = 'LLM_CONVERSATION_REQUEST_ACTIVE'

const createConversationRequestActiveError = (conversationId: string): ServiceError =>
  new ServiceError(`A request is already active for conversation "${conversationId}".`, {
    code: LLM_CONVERSATION_REQUEST_ACTIVE_ERROR_CODE
  })

type ExplicitToolCommand =
  | {
      kind: 'tools'
      toolName?: string
    }
  | {
      kind: 'tool'
      toolName: string
      args: Record<string, unknown>
    }

type ToolSummary = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

type RequestedToolInvocation = {
  toolName: string
  args: Record<string, unknown>
}

type ToolLoopUsage = NonNullable<LLMChatResult['usage']>

const addToolLoopUsage = (
  total: ToolLoopUsage | undefined,
  step: ToolLoopUsage | undefined
): ToolLoopUsage | undefined => {
  if (!total && !step) return undefined
  const result: ToolLoopUsage = { ...(total || {}) }
  for (const key of [
    'promptTokens',
    'inputTextTokens',
    'inputImageTokens',
    'completionTokens',
    'totalTokens'
  ] as const) {
    const value = step?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      const previous = result[key]
      result[key] = (typeof previous === 'number' ? previous : 0) + value
    }
  }
  return result
}

const MAX_SKILL_RUNTIME_TOOL_CALLS = MAX_AGENT_TOOL_CALLS

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeRemoteToolStatus = (value: unknown): LLMToolStatus => {
  if (!isPlainRecord(value)) {
    throw new Error('Remote LLM streaming tool-status event was invalid.')
  }

  const runId = typeof value.runId === 'string' ? value.runId.trim() : ''
  const toolCallId = typeof value.toolCallId === 'string' ? value.toolCallId.trim() : ''
  const toolName = typeof value.toolName === 'string' ? value.toolName.trim() : ''
  const status = value.status
  if (
    !runId ||
    !toolCallId ||
    !toolName ||
    !(
      status === 'running' ||
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
    )
  ) {
    throw new Error('Remote LLM streaming tool-status event was invalid.')
  }

  return { runId, toolCallId, toolName, status }
}

const parseExplicitToolCommand = (text?: string | null): ExplicitToolCommand | null => {
  const normalized = String(text || '').trim()
  if (!normalized) {
    return null
  }

  if (normalized === '/tools') {
    return { kind: 'tools' }
  }

  const toolsMatch = normalized.match(/^\/tools\s+([a-z0-9._-]+)\s*$/i)
  if (toolsMatch) {
    return {
      kind: 'tools',
      toolName: String(toolsMatch[1] || '').trim() || undefined
    }
  }

  const toolMatch = normalized.match(/^\/tool\s+([a-z0-9._-]+)(?:\s+(.+))?$/i)
  if (!toolMatch) {
    return null
  }

  const toolName = String(toolMatch[1] || '').trim()
  const argsPayload = String(toolMatch[2] || '').trim()
  if (!toolName) {
    return null
  }

  if (!argsPayload) {
    return {
      kind: 'tool',
      toolName,
      args: {}
    }
  }

  try {
    return {
      kind: 'tool',
      toolName,
      args: JSON.parse(argsPayload) as Record<string, unknown>
    }
  } catch {
    return {
      kind: 'tool',
      toolName,
      args: { input: argsPayload }
    }
  }
}

const formatToolSchema = (inputSchema: Record<string, unknown>): string =>
  JSON.stringify(inputSchema || {}, null, 2)

const formatToolList = (tools: ToolSummary[]): string => {
  if (!tools.length) {
    return 'No chat tools are available.'
  }

  return [
    'Available chat tools:',
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    '',
    'Use /tools <name> to inspect a tool and its input schema.'
  ].join('\n')
}

const formatToolDetail = (tool: ToolSummary): string =>
  [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    '',
    'Input schema:',
    formatToolSchema(tool.inputSchema)
  ].join('\n')

const buildSkillRuntimeToolInstructions = (
  tools: ToolSummary[],
  options?: {
    outputMode?: string
  }
): string => {
  if (!tools.length) {
    return ''
  }

  const outputMode = String(options?.outputMode || '')
    .trim()
    .toLowerCase()

  return [
    'You may use the following bound tools when they help answer the user request.',
    'Only request a tool when it is genuinely needed.',
    'If you want a tool to run, respond with JSON only using this exact shape:',
    '{"toolName":"<tool-name>","args":{...}}',
    'Do not wrap the JSON in Markdown fences or append a normal answer before the tool result.',
    'Use valid JSON escaping for backslashes, or use forward slashes for Windows paths (D:/folder/file.docx).',
    ...(tools.some((tool) => tool.name === 'files.read')
      ? [
          'files.read is an actual local file tool. For an absolute local path, the application requests permission for that exact file. It can extract passive text from DOCX. Do not claim you cannot read a local document before using the tool; summarize only the returned content.'
        ]
      : []),
    outputMode === 'structured'
      ? 'After tool results are provided, your final answer must still satisfy the required structured output schema.'
      : 'After tool results are provided, answer normally to the user unless another tool call is still required.',
    '',
    ...tools.map((tool) =>
      [
        `Tool: ${tool.name}`,
        `Description: ${tool.description || 'No description provided.'}`,
        'Input schema:',
        formatToolSchema(tool.inputSchema)
      ].join('\n')
    )
  ].join('\n\n')
}

const buildToolResultMessage = (
  invocation: RequestedToolInvocation,
  result: string
): ChatMessage => ({
  role: 'assistant',
  content: [
    '[Tool Result]',
    `toolName: ${invocation.toolName}`,
    'args:',
    JSON.stringify(invocation.args, null, 2),
    '',
    result.trim() || '(empty result)'
  ].join('\n')
})

const extractSkillRuntimeAllowedToolNames = (req: LLMChatReq): string[] | null => {
  const explicitToolBindings =
    req.skillRuntime?.bindings?.filter((binding) => Array.isArray(binding.toolNames)) || []
  if (!explicitToolBindings.length) {
    return null
  }

  return (
    normalizeAllowedToolNames(explicitToolBindings.flatMap((binding) => binding.toolNames || [])) ||
    []
  )
}

const buildSkillRuntimeRoute = (req: LLMChatReq): AssistantRoute =>
  (req.route
    ? normalizeAgentRoute(req.route)
    : buildAgentRoute({
        channel: 'generic',
        scopeType: 'dm',
        scopeIdCandidates: [
          req.conversationId,
          req.sessionUrl,
          req.skillRuntime?.skillId,
          req.profileId
        ],
        fallbackScopeId: 'skill-runtime'
      })) as AssistantRoute

const tryHandleSkillRuntimeToolCommand = async (req: LLMChatReq): Promise<LLMChatResp | null> => {
  const allowedToolNames = extractSkillRuntimeAllowedToolNames(req)
  if (allowedToolNames === null) {
    return null
  }

  const lastMessage = req.messages.at(-1)
  if (!lastMessage || lastMessage.role !== 'user') {
    return null
  }

  const command = parseExplicitToolCommand(lastMessage.content)
  if (!command) {
    return null
  }

  const runtime = getAssistantRuntime()

  if (command.kind === 'tools') {
    const tools = runtime.listTools(allowedToolNames) as ToolSummary[]
    if (command.toolName) {
      const tool = tools.find((item) => item.name === command.toolName)
      return {
        content: tool
          ? formatToolDetail(tool)
          : `Tool not found: ${command.toolName}\nUse /tools to list available chat tools.`
      }
    }

    return {
      content: formatToolList(tools)
    }
  }

  const toolResult = await runtime.callTool(
    buildSkillRuntimeRoute(req),
    command.toolName,
    command.args,
    {
      allowedToolNames
    }
  )

  return {
    content: toolResult.content
  }
}

const BIGMODEL_OCR_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const BIGMODEL_OCR_MAX_FILE_BYTES = 50 * 1024 * 1024

const normalizeAttachmentMimeType = (value?: string): string =>
  String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

const parseDataUrl = (value: string): { mimeType: string; base64: string } | null => {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/i)
  if (!match) return null
  return {
    mimeType: normalizeAttachmentMimeType(match[1]),
    base64: match[2]
  }
}

const inferAttachmentExtension = (attachment: Pick<ChatAttachment, 'fileName' | 'url'>): string => {
  const candidates = [attachment.fileName || '', attachment.url || '']
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed || trimmed.startsWith('data:')) continue
    const normalized = trimmed.split(/[?#]/)[0]
    const fileName = normalized.split(/[\\/]/).pop() || ''
    const lastDot = fileName.lastIndexOf('.')
    if (lastDot >= 0 && lastDot < fileName.length - 1) {
      return fileName.slice(lastDot + 1).toLowerCase()
    }
  }
  return ''
}

const inferBigModelOcrAttachmentMimeType = (attachment: ChatAttachment): string => {
  const explicitMimeType = normalizeAttachmentMimeType(attachment.mimeType)
  if (explicitMimeType) return explicitMimeType

  const parsedDataUrl = parseDataUrl(attachment.url)
  if (parsedDataUrl?.mimeType) {
    return parsedDataUrl.mimeType
  }

  const extension = inferAttachmentExtension(attachment)
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'pdf') return 'application/pdf'
  return ''
}

const isBigModelOcrSupportedAttachment = (attachment: ChatAttachment): boolean => {
  const mimeType = inferBigModelOcrAttachmentMimeType(attachment)
  const extension = inferAttachmentExtension(attachment)

  if (attachment.type === 'image') {
    if (
      typeof attachment.sizeBytes === 'number' &&
      Number.isFinite(attachment.sizeBytes) &&
      attachment.sizeBytes > BIGMODEL_OCR_MAX_IMAGE_BYTES
    ) {
      return false
    }

    return (
      mimeType === 'image/png' ||
      mimeType === 'image/jpeg' ||
      extension === 'png' ||
      extension === 'jpg' ||
      extension === 'jpeg'
    )
  }

  if (attachment.type === 'file') {
    if (
      typeof attachment.sizeBytes === 'number' &&
      Number.isFinite(attachment.sizeBytes) &&
      attachment.sizeBytes > BIGMODEL_OCR_MAX_FILE_BYTES
    ) {
      return false
    }

    return mimeType === 'application/pdf' || extension === 'pdf'
  }

  return false
}

const isRemoteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value)

const isBigModelOcrProfile = (profile: LLMAPIProfile): boolean => {
  if (resolveProfileProvider(profile) !== 'openai') {
    return false
  }

  const normalizedBaseUrl = profile.base_url.trim().toLowerCase()
  const normalizedModelName = profile.model_name.trim().toLowerCase()
  const isOcrModel =
    resolveProfileModelUse(profile) === 'ocr' || normalizedModelName.includes('glm-ocr')

  return (
    isOcrModel &&
    (normalizedBaseUrl.includes('bigmodel.cn') || normalizedModelName.includes('glm-ocr'))
  )
}

const getScopedApiProfiles = (
  config: Config,
  profileScope?: LLMChatReq['profileScope']
): LLMAPIProfile[] =>
  profileScope === 'qapp' ? getQAppApiProfiles(config) : config.llm_config.api_profiles

const getScopedApiProfileSettingsLabel = (profileScope?: LLMChatReq['profileScope']): string =>
  profileScope === 'qapp' ? 'Quick App API' : 'Agent API'

const isGenericQAppTextProfile = (profile: LLMAPIProfile): boolean =>
  !profile.is_vision_model && resolveProfileModelUse(profile) !== 'video'

const getDefaultScopedApiProfile = (
  profiles: LLMAPIProfile[],
  profileScope?: LLMChatReq['profileScope']
): LLMAPIProfile | undefined => {
  if (profileScope !== 'qapp') {
    return profiles[0]
  }

  return (
    profiles.find(isGenericQAppTextProfile) ||
    profiles.find((profile) => resolveProfileModelUse(profile) !== 'video')
  )
}

const isCanvasTargetSelectionSnapshotAttachment = (attachment: ChatAttachment): boolean => {
  const fileName = attachment.fileName?.trim().toLowerCase()
  return fileName === 'canvas-target-selection.png' || fileName === 'canvas-check-selection.png'
}

const TAGGER_INFERENCE_ENDPOINT_PATH = '/tagger/v2/infer'
const BUILTIN_TAGGING_SKILL_ID = 'builtin-tagging'

const isTaggerSkillRequest = (req: LLMChatReq): boolean =>
  isTaggerSkillRuntime(req.skillRuntime) || req.skillRuntime?.skillId === BUILTIN_TAGGING_SKILL_ID

const buildTaggerEndpoint = (profile: LLMAPIProfile): string => {
  const endpoint = profile.tagger_endpoint?.trim() || profile.base_url.trim()
  if (!endpoint) {
    throw new Error('Tagger providers require a base URL or tagger endpoint.')
  }

  return `${endpoint.replace(/\/$/, '')}${TAGGER_INFERENCE_ENDPOINT_PATH}`
}

const parseTaggerProviderResponse = (content: string): LLMChatResp => {
  const structured = parseStructuredChatResponse(content)
  if (structured) {
    return structured
  }

  const trimmed = content.trim()
  if (!trimmed) {
    return { content: '' }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed === 'string') {
      return { content: parsed }
    }

    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const response: LLMChatResp = {
        content: typeof record.content === 'string' ? record.content : JSON.stringify(record)
      }
      if (Array.isArray(record.attachments)) {
        response.attachments = record.attachments as ChatAttachment[]
      }
      if (record.ocrResult && typeof record.ocrResult === 'object') {
        response.ocrResult = record.ocrResult as NonNullable<LLMChatResp['ocrResult']>
      }
      return response
    }
  } catch {
    return { content }
  }

  return { content }
}

const collectBigModelOcrAttachments = (messages: ChatMessage[]): ChatAttachment[] => {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && Array.isArray(message.attachments))
  const supportedAttachments = (lastUserMessage?.attachments || []).filter(
    isBigModelOcrSupportedAttachment
  )
  if (supportedAttachments.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const dedupedAttachments = supportedAttachments.filter((attachment) => {
    const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}:${attachment.sizeBytes || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const primaryAttachments = dedupedAttachments.filter(
    (attachment) => !isCanvasTargetSelectionSnapshotAttachment(attachment)
  )
  const snapshotAttachments = dedupedAttachments.filter(isCanvasTargetSelectionSnapshotAttachment)

  return [...primaryAttachments, ...snapshotAttachments]
}

const buildBigModelOcrBoxes = (payload: {
  layout_details?: unknown
  data_info?: unknown
}): NonNullable<NonNullable<LLMChatResp['ocrResult']>['boxes']> => {
  const layoutDetails = Array.isArray(payload.layout_details) ? payload.layout_details : []
  const pageEntries =
    payload.data_info && typeof payload.data_info === 'object'
      ? Array.isArray((payload.data_info as { pages?: unknown[] }).pages)
        ? (payload.data_info as { pages?: Array<{ width?: unknown; height?: unknown }> }).pages ||
          []
        : []
      : []

  return layoutDetails.flatMap((pageValue, pageIndex) => {
    const page = Array.isArray(pageValue) ? pageValue : []
    const pageWidthRaw = pageEntries[pageIndex]?.width
    const pageHeightRaw = pageEntries[pageIndex]?.height
    const pageWidth =
      typeof pageWidthRaw === 'number' && Number.isFinite(pageWidthRaw) && pageWidthRaw > 0
        ? pageWidthRaw
        : 1
    const pageHeight =
      typeof pageHeightRaw === 'number' && Number.isFinite(pageHeightRaw) && pageHeightRaw > 0
        ? pageHeightRaw
        : 1

    return page.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []

      const bbox = Array.isArray((entry as { bbox_2d?: unknown[] }).bbox_2d)
        ? (entry as { bbox_2d: unknown[] }).bbox_2d
        : []
      if (bbox.length !== 4) return []

      const [x1, y1, x2, y2] = bbox
      if (![x1, y1, x2, y2].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return []
      }

      return [
        {
          x: Number(x1) * pageWidth,
          y: Number(y1) * pageHeight,
          width: Math.max(0, Number(x2) - Number(x1)) * pageWidth,
          height: Math.max(0, Number(y2) - Number(y1)) * pageHeight,
          page: pageIndex + 1,
          label:
            typeof (entry as { label?: unknown }).label === 'string'
              ? (entry as { label?: string }).label
              : undefined
        }
      ]
    })
  })
}

export class LLMProxySvcImpl implements LLMProxySvc {
  private readonly conversationAbortControllers = new Map<string, AbortController>()
  private readonly profileRevisions = new LlmProfileRevision()
  private readonly remoteComparisons = new RemoteProjectComparisonClient((input, init) =>
    this.getFetchImpl()(input, init)
  )

  private getFetchImpl(): FetchImpl {
    if (isMockFetchFunction(globalThis.fetch)) {
      return globalThis.fetch.bind(globalThis) as FetchImpl
    }

    const electronFetch = createMainProcessElectronFetch()
    if (electronFetch) {
      return electronFetch
    }

    if (process.env.NODE_ENV === 'test' && typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis) as FetchImpl
    }

    throw new Error('Electron network APIs are unavailable in the main process runtime.')
  }

  private loadOpenAIReferenceImage = async (
    url: URL,
    signal?: AbortSignal
  ): Promise<{ blob: Blob; finalUrl?: URL }> => {
    const downloaded = await safeRemoteDownload(url.toString(), {
      allowedContentTypes: ['image/'],
      // Do not add an application image-size cap here. The downloader still
      // enforces HTTPS/public-host, MIME, redirect, timeout, and abort safety.
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxRedirects: 3,
      errorLabel: 'OpenAI reference image',
      signal
    })
    const bytes = new Uint8Array(downloaded.buffer.byteLength)
    bytes.set(downloaded.buffer)
    return {
      blob: new Blob([bytes.buffer], { type: downloaded.contentType }),
      finalUrl: downloaded.finalUrl
    }
  }

  private createConversationAbortContext(
    conversationId?: string,
    signal?: AbortSignal
  ): {
    signal?: AbortSignal
    abort: (reason?: unknown) => void
    cleanup: () => void
  } {
    const normalizedConversationId = String(conversationId || '').trim()
    if (
      normalizedConversationId &&
      this.conversationAbortControllers.has(normalizedConversationId)
    ) {
      throw createConversationRequestActiveError(normalizedConversationId)
    }

    if (!normalizedConversationId && !signal) {
      return {
        signal,
        abort: () => undefined,
        cleanup: () => undefined
      }
    }

    const controller = new AbortController()
    if (normalizedConversationId) {
      this.conversationAbortControllers.set(normalizedConversationId, controller)
    }

    const abort = (reason?: unknown) => {
      if (controller.signal.aborted) return

      if (reason instanceof Error) {
        controller.abort(reason)
        return
      }

      controller.abort(
        createAbortError(typeof reason === 'string' ? reason : 'The request was aborted.')
      )
    }
    const handleAbort = () => abort(signal?.reason)

    if (signal?.aborted) {
      handleAbort()
    } else if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true })
    }

    return {
      signal: controller.signal,
      abort,
      cleanup: () => {
        if (signal) {
          signal.removeEventListener('abort', handleAbort)
        }
        const current = this.conversationAbortControllers.get(normalizedConversationId)
        if (current === controller) {
          this.conversationAbortControllers.delete(normalizedConversationId)
        }
      }
    }
  }
  // Keep per-endpoint round-robin counters stable across requests so load-balanced profile selection stays deterministic.
  private static loadBalancingCounters: Map<string, number> = new Map()

  private normalizeRequestedProfileId(profileId: string | undefined): string | undefined {
    let nextProfileId = profileId
    for (const extension of mainHostExtensionApiV1.llmProxy) {
      const resolvedProfileId = extension.normalizeRequestedProfileId?.(nextProfileId)
      if (resolvedProfileId !== undefined) {
        nextProfileId = resolvedProfileId
      }
    }
    return nextProfileId
  }

  private findHunyuan3DProfile(config: Config, profileId?: string): LLMAPIProfile | undefined {
    const requestedProfileId = profileId?.trim()
    if (requestedProfileId) {
      const requestedProfile = getQAppApiProfiles(config).find(
        (profile) =>
          profile.id === requestedProfileId &&
          isHunyuan3DCompatibleProfile(profile) &&
          isConfiguredHunyuan3DProfile(profile)
      )
      if (requestedProfile) {
        return requestedProfile
      }
    }

    return findHunyuan3DQAppProfile(config)
  }

  private readHunyuan3DCredentials(
    config: Config,
    profileId?: string
  ): { secretId: string; secretKey: string } {
    const hunyuanProfile = this.findHunyuan3DProfile(config, profileId)
    return {
      secretId: normalizeConfiguredSecret(
        hunyuanProfile?.tencent_secret_id || config.aigc3d_config?.tencent_secret_id
      ),
      secretKey: normalizeConfiguredSecret(
        hunyuanProfile?.tencent_secret_key || config.aigc3d_config?.tencent_secret_key
      )
    }
  }

  private getHunyuan3DCredentials(
    config: Config,
    profileId?: string
  ): { secretId: string; secretKey: string } {
    const { secretId, secretKey } = this.readHunyuan3DCredentials(config, profileId)

    const missing: string[] = []
    if (!secretId) missing.push('SecretId')
    if (!secretKey) missing.push('SecretKey')
    if (missing.length > 0) {
      throw new Error('Missing required Tencent API credentials: ' + missing.join(' / '))
    }

    return { secretId, secretKey }
  }

  private getHunyuan3DCosConfig(
    config: Config,
    profileId?: string
  ): {
    bucket: string
    region: string
    keyPrefix: string
  } {
    const hunyuanProfile = this.findHunyuan3DProfile(config, profileId)
    const bucket =
      hunyuanProfile?.cos_bucket?.trim() || config.aigc3d_config?.cos_bucket?.trim() || ''
    const region =
      hunyuanProfile?.cos_region?.trim() || config.aigc3d_config?.cos_region?.trim() || ''
    const keyPrefix =
      hunyuanProfile?.cos_key_prefix?.trim() ||
      config.aigc3d_config?.cos_key_prefix?.trim() ||
      'magicpot/hunyuan3d'

    const missing: string[] = []
    if (!bucket) missing.push('COS Bucket')
    if (!region) missing.push('COS Region')
    if (missing.length > 0) {
      throw new Error('Missing required COS configuration fields: ' + missing.join(' / '))
    }

    return { bucket, region, keyPrefix }
  }

  private getHunyuan3DApiRegion(config: Config, profileId?: string): string {
    const hunyuanProfile = this.findHunyuan3DProfile(config, profileId)
    return (
      hunyuanProfile?.api_region?.trim() ||
      config.aigc3d_config?.api_region?.trim() ||
      DEFAULT_HY3D_API_REGION
    )
  }

  private async buildBigModelOcrFilePayload(attachment: ChatAttachment): Promise<string> {
    const parsedDataUrl = parseDataUrl(attachment.url)
    if (parsedDataUrl?.base64) {
      return parsedDataUrl.base64
    }

    if (isLocalFileSource(attachment.url)) {
      throw new Error('GLM-OCR does not accept local file attachments.')
    }

    if (isRemoteHttpUrl(attachment.url)) {
      let response: Response
      try {
        response = await this.getFetchImpl()(attachment.url)
      } catch (error) {
        throw new Error(`GLM-OCR download failed: ${describeFetchFailure(error)}`)
      }
      if (!response.ok) {
        throw new Error(`GLM-OCR download failed: ${response.status} ${response.statusText}`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      return buffer.toString('base64')
    }

    throw new Error('GLM-OCR requires a PNG/JPG/JPEG/PDF attachment with a readable source URL.')
  }

  private buildBigModelOcrResponseFromPayload(options: {
    attachment: ChatAttachment
    payload: {
      md_results?: unknown
      layout_visualization?: unknown
      layout_details?: unknown
      data_info?: unknown
    }
  }): LLMChatResp {
    const markdown =
      typeof options.payload.md_results === 'string' && options.payload.md_results.trim()
        ? options.payload.md_results.trim()
        : ''
    const boxes = buildBigModelOcrBoxes(options.payload)
    const visualizationUrls = Array.isArray(options.payload.layout_visualization)
      ? options.payload.layout_visualization.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        )
      : []

    return {
      content: markdown,
      attachments:
        visualizationUrls.length > 0
          ? visualizationUrls.map((url, index) => ({
              type: 'image' as const,
              url,
              fileName: `glm-ocr-layout-${index + 1}.png`,
              mimeType: 'image/png'
            }))
          : undefined,
      ocrResult: markdown
        ? {
            kind: 'document',
            text: markdown,
            sourceImageUrl: options.attachment.url,
            boxes: boxes.length > 0 ? boxes : undefined
          }
        : undefined
    }
  }

  private mergeBigModelOcrResponses(
    entries: Array<{
      attachment: ChatAttachment
      response: LLMChatResp
    }>
  ): LLMChatResp {
    if (entries.length === 1) {
      return entries[0].response
    }

    const content = entries
      .map(({ attachment, response }, index) => {
        const label = attachment.fileName?.trim() || `attachment-${index + 1}`
        const body = response.content?.trim() || response.ocrResult?.text?.trim() || ''
        if (!body) return ''
        return `## ${label}\n\n${body}`
      })
      .filter(Boolean)
      .join('\n\n')

    const attachments = entries.flatMap(({ response }) => response.attachments || [])

    return {
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      ocrResult: content
        ? {
            kind: 'document',
            text: content
          }
        : undefined
    }
  }

  private async chatViaBigModelOcr(
    req: LLMChatReq,
    profile: LLMAPIProfile,
    options?: LLMChatOptions
  ): Promise<LLMChatResp> {
    const candidateAttachments = collectBigModelOcrAttachments(req.messages)
    if (candidateAttachments.length === 0) {
      throw new Error('GLM-OCR requires one PNG/JPG/JPEG/PDF attachment.')
    }

    const endpoint = `${normalizeOpenAIBaseUrl(profile.base_url)}/layout_parsing`
    const primaryAttachments = candidateAttachments.filter(
      (attachment) => !isCanvasTargetSelectionSnapshotAttachment(attachment)
    )
    const snapshotAttachments = candidateAttachments.filter(
      isCanvasTargetSelectionSnapshotAttachment
    )
    const successfulResponses: Array<{
      attachment: ChatAttachment
      response: LLMChatResp
    }> = []
    let firstError: Error | null = null
    const tryAttachments = async (attachments: ChatAttachment[]): Promise<void> => {
      for (const attachment of attachments) {
        throwIfAborted(options?.signal)
        try {
          let response: Response
          try {
            response = await this.getFetchImpl()(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${profile.api_key}`
              },
              signal: options?.signal,
              body: JSON.stringify({
                model: 'glm-ocr',
                file: await this.buildBigModelOcrFilePayload(attachment)
              })
            })
          } catch (error) {
            throw new Error(
              `GLM-OCR request failed for ${endpoint}: ${describeFetchFailure(error)}`
            )
          }

          if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`GLM-OCR API error: ${response.status} ${response.statusText} ${text}`)
          }

          const payload = (await response.json()) as {
            md_results?: unknown
            layout_visualization?: unknown
            layout_details?: unknown
            data_info?: unknown
          }
          successfulResponses.push({
            attachment,
            response: this.buildBigModelOcrResponseFromPayload({
              attachment,
              payload
            })
          })
        } catch (error) {
          if (!firstError) {
            firstError =
              error instanceof Error
                ? error
                : new Error(typeof error === 'string' ? error : String(error))
          }
        }
      }
    }

    await tryAttachments(primaryAttachments.length > 0 ? primaryAttachments : snapshotAttachments)

    if (successfulResponses.length > 0) {
      return this.mergeBigModelOcrResponses(successfulResponses)
    }

    if (primaryAttachments.length > 0 && snapshotAttachments.length > 0) {
      await tryAttachments(snapshotAttachments)
      if (successfulResponses.length > 0) {
        return this.mergeBigModelOcrResponses(successfulResponses)
      }
    }

    if (firstError) {
      throw firstError
    }

    throw new Error(
      snapshotAttachments.length > 0
        ? 'GLM-OCR could not read the provided screenshot attachment.'
        : 'GLM-OCR could not read any supported attachment.'
    )
  }

  private async chatViaTaggerProvider(
    req: LLMChatReq,
    profile: LLMAPIProfile,
    options?: LLMChatOptions
  ): Promise<LLMChatResp> {
    const runtime = resolveTaggerRuntimeDescriptor(profile, req.skillRuntime)
    if (!runtime) {
      throw new Error(`Tagger provider is unavailable for profile "${profile.id}".`)
    }

    const descriptor = resolveTaggerProviderDescriptor(profile)
    const endpoint = buildTaggerEndpoint(profile)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (profile.api_key.trim()) {
      headers.Authorization = `Bearer ${profile.api_key}`
    }

    let response: Response
    try {
      response = await this.getFetchImpl()(endpoint, {
        method: 'POST',
        headers,
        signal: options?.signal,
        body: JSON.stringify({
          provider: {
            id: runtime.providerId,
            name: runtime.providerName,
            family: runtime.family,
            endpoint: runtime.endpoint,
            cacheKey: runtime.cacheKey
          },
          profile: {
            id: profile.id,
            modelName: profile.model_name,
            taggerProvider: profile.tagger_provider,
            taggerEndpoint: profile.tagger_endpoint
          },
          request: {
            skillId: req.skillRuntime?.skillId,
            outputMode: req.skillRuntime?.execution?.outputMode || runtime.outputMode,
            messages: req.messages,
            systemPrompt: req.systemPrompt
          }
        })
      })
    } catch (error) {
      throw new Error(
        `Tagger provider ${descriptor?.name || runtime.providerName} request failed for ${endpoint}: ${describeFetchFailure(error)}`
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `Tagger provider ${descriptor?.name || runtime.providerName} error: ${response.status} ${
          response.statusText
        } ${text}`
      )
    }

    const rawText = await response.text()
    return parseTaggerProviderResponse(rawText)
  }

  chat = async (
    req: LLMChatReq,
    options?: LLMChatOptions & Partial<ServiceInvocationContext>
  ): Promise<LLMChatResp> => {
    const readExternalFile = getConfig().use_remote_llm
      ? undefined
      : createCanvasPathReadHandler(
          req,
          options?.methodName ? (options as ServiceInvocationContext) : undefined
        )
    req = withCanvasFileTools(
      req,
      options?.methodName ? (options as ServiceInvocationContext) : undefined
    )
    const abortContext = this.createConversationAbortContext(req.conversationId, options?.signal)
    console.log('[LLMProxy] received chat request at top-level handler', {
      profileId: req.profileId,
      sessionUrl: req.sessionUrl,
      messageCount: req.messages.length,
      conversationId: req.conversationId
    })

    try {
      if (req.comparisonRouting === 'configured') {
        const config = structuredClone(getConfig())
        if (config.use_remote_llm) {
          const { conversationId: _conversationId, ...remoteRequest } = req
          return await this.remoteComparisons.chat(config, remoteRequest, abortContext.signal)
        }
      }
      // Standard API chat remains the fallback path after specialized handlers decline the request.
      console.log('[LLMProxy] routing request through the standard API path')
      return await this.chatViaAPI(req, {
        ...options,
        readExternalFile,
        signal: abortContext.signal
      })
    } catch (e: unknown) {
      const err =
        e instanceof Error
          ? e
          : new Error(
              'LLM request failed: ' + (typeof e === 'object' ? JSON.stringify(e) : String(e))
            )
      console.error('[LLMProxy] chat failed at the top level:', err.message)
      throw err
    } finally {
      abortContext.cleanup()
    }
  }

  private chatViaAPI = async (
    req: LLMChatReq,
    options?: ChatExecutionOptions
  ): Promise<LLMChatResp> => {
    throwIfAborted(options?.signal)
    req = applySkillRuntimeContextMessageLimit(req)
    const config =
      req.expectedProfileRevision === undefined ? getConfig() : structuredClone(getConfig())
    if (req.expectedProfileRevision !== undefined) {
      this.profileRevisions.verify(
        config,
        req.profileId,
        req.expectedProfileRevision,
        req.comparisonRouting === 'local'
      )
    }
    const requestedProfileId = this.normalizeRequestedProfileId(req.profileId)

    for (const extension of mainHostExtensionApiV1.llmProxy) {
      const extensionResponse = await extension.handleChatRequest?.(req, {
        config,
        fetchImpl: this.getFetchImpl(),
        rawProfileId: req.profileId,
        requestedProfileId,
        signal: options?.signal
      })
      if (extensionResponse) {
        throwIfAborted(options?.signal)
        return extensionResponse
      }
    }

    const [
      baseProfileId,
      hunyuanMode,
      modelVersion,
      generateType,
      faceCount,
      targetFormat,
      faceLevel,
      polygonType,
      enablePBR,
      profileTemplate,
      ...hy3dProfileExtraSegments
    ] = (requestedProfileId || '').split('::')

    if (baseProfileId === 'hunyuan3d-pro') {
      console.log('[LLMProxy] routing request to Hunyuan 3D handler')
      const hunyuanProfile = this.findHunyuan3DProfile(config)
      const { secretId, secretKey } = this.readHunyuan3DCredentials(config)
      const apiRegion = this.getHunyuan3DApiRegion(config)
      const resolvedMode = hunyuanMode || 'SubmitHunyuanTo3DProJob'
      const hasTencentCredentials = !!(secretId && secretKey)
      const hasApiTokenPath = !!(hunyuanProfile?.api_key && hunyuanProfile?.base_url)

      if (
        !hasTencentCredentials &&
        !(resolvedMode === 'SubmitHunyuanTo3DProJob' && hasApiTokenPath)
      ) {
        throw new Error(
          'No valid Hunyuan 3D configuration found. Configure the API Key/Base URL or Tencent SecretId/SecretKey in Settings.'
        )
      }

      if (hasTencentCredentials && !apiRegion) {
        throw new Error(
          '[Hunyuan3D] Missing Tencent API region. Fill in Tencent API Region or COS Region in Settings.'
        )
      }

      const client = new Hunyuan3DClient(
        hunyuanProfile?.api_key || '',
        hunyuanProfile?.base_url || '',
        secretId,
        secretKey,
        apiRegion
      )
      let content: string
      const decodedSourceFileName = parseHy3dProfileExtras(hy3dProfileExtraSegments).sourceFileName
      try {
        const resolvedTargetFormat =
          targetFormat && targetFormat !== 'DEFAULT' ? targetFormat : undefined
        content = await client.generateFromMessages(req.messages, resolvedMode, {
          Model: modelVersion,
          GenerateType: generateType,
          FaceCount: faceCount ? parseInt(faceCount, 10) : undefined,
          TargetFormat: resolvedTargetFormat,
          FaceLevel: faceLevel || 'low',
          PolygonType: polygonType || 'triangle',
          EnablePBR: enablePBR === '1',
          ProfileTemplate: profileTemplate || 'DEFAULT',
          SourceFileName: decodedSourceFileName
        })
      } catch (error) {
        throw normalizeHunyuan3DError(error, {
          mode: resolvedMode,
          sourceFileName: decodedSourceFileName
        })
      }
      throwIfAborted(options?.signal)
      return { content }
    }

    const skillRuntimeToolResp = await tryHandleSkillRuntimeToolCommand(req)
    if (skillRuntimeToolResp) {
      throwIfAborted(options?.signal)
      return skillRuntimeToolResp
    }

    const validProfiles = getScopedApiProfiles(config, req.profileScope).filter(isRunnableProfile)
    const profileForTaggerRoute = requestedProfileId
      ? validProfiles.find((p) => p.id === requestedProfileId)
      : getDefaultScopedApiProfile(validProfiles, req.profileScope)
    const taggerRuntime = profileForTaggerRoute
      ? resolveTaggerRuntimeDescriptor(profileForTaggerRoute, req.skillRuntime)
      : null
    if (profileForTaggerRoute && taggerRuntime && isTaggerSkillRequest(req)) {
      console.log('[LLMProxySvc] routing request to Tagger Provider V2', {
        profileId: profileForTaggerRoute.id,
        providerId: taggerRuntime.providerId,
        providerName:
          getTaggerProviderDisplayLabel(profileForTaggerRoute) || taggerRuntime.providerName,
        model: profileForTaggerRoute.model_name,
        outputMode: taggerRuntime.outputMode
      })

      const taggerResponse = await this.chatViaTaggerProvider(req, profileForTaggerRoute, options)
      const structuredSkillContent = validateStructuredSkillOutput(
        taggerResponse.content,
        req.skillRuntime
      )
      if (structuredSkillContent !== null) {
        return { ...taggerResponse, content: structuredSkillContent }
      }
      return taggerResponse
    }

    if (validProfiles.length === 0) {
      throw new Error(
        `No LLM profile available. Add one in Settings -> ${getScopedApiProfileSettingsLabel(req.profileScope)}.`
      )
    }

    let profile: LLMAPIProfile | undefined
    if (requestedProfileId) {
      profile = validProfiles.find((p) => p.id === requestedProfileId)
      if (!profile) {
        throw new Error(
          `Requested LLM profile "${req.profileId}" not found. Available profiles: ${validProfiles.map((p) => p.id).join(', ')}`
        )
      }
    } else {
      profile = getDefaultScopedApiProfile(validProfiles, req.profileScope)
    }

    if (!profile) {
      throw new Error(
        `No suitable LLM profile available. Add one in Settings -> ${getScopedApiProfileSettingsLabel(req.profileScope)}.`
      )
    }

    let selectedApiKey = profile?.api_key || ''

    // A named conversation keeps one identity from its first request onward.
    // Stateless batch callers can still opt into the existing rotation behavior.
    if (profile && !req.sessionUrl?.trim() && !req.conversationId?.trim()) {
      const allKeys = [profile.api_key, ...(profile.backup_api_keys || [])].filter((k) => k)

      if (allKeys.length > 1) {
        const poolKey = `profile:${profile.id}`
        let nextIndex = LLMProxySvcImpl.loadBalancingCounters.get(poolKey)
        if (nextIndex === undefined) {
          nextIndex = 0
        } else {
          nextIndex = (nextIndex + 1) % allKeys.length
        }
        LLMProxySvcImpl.loadBalancingCounters.set(poolKey, nextIndex)

        selectedApiKey = allKeys[nextIndex]
        console.log(
          `[LLMProxy] load balancing (Profile Keys): selected key ${nextIndex + 1}/${allKeys.length}`
        )
      } else {
        const siblings = validProfiles.filter(
          (p) => p.model_name === profile?.model_name && p.base_url === profile?.base_url
        )

        if (siblings.length > 1 && req.expectedProfileRevision === undefined) {
          const poolKey = `${profile.base_url}|${profile.model_name}`
          let nextIndex = LLMProxySvcImpl.loadBalancingCounters.get(poolKey)
          if (nextIndex === undefined) {
            nextIndex = 0
          } else {
            nextIndex = (nextIndex + 1) % siblings.length
          }
          LLMProxySvcImpl.loadBalancingCounters.set(poolKey, nextIndex)

          profile = siblings[nextIndex]
          selectedApiKey = profile.api_key
          console.log(
            '[LLMProxy] load balancing (Sibling Profiles): switched to config ' +
              (nextIndex + 1) +
              '/' +
              siblings.length
          )
        }
      }
    }

    const profileWithSelectedKey = {
      ...profile,
      api_key: selectedApiKey
    }

    if (isBigModelOcrProfile(profileWithSelectedKey)) {
      console.log('[LLMProxySvc] routing request to BigModel GLM-OCR layout_parsing', {
        profileId: profile.id,
        model: profile.model_name
      })
      return await this.chatViaBigModelOcr(req, profileWithSelectedKey, options)
    }

    const extensionContext = {
      config,
      fetchImpl: this.getFetchImpl(),
      rawProfileId: req.profileId,
      requestedProfileId,
      signal: options?.signal
    }
    const extensionCli = mainHostExtensionApiV1.llmProxy
      .map((extension) =>
        extension.createCli?.(profileWithSelectedKey, {
          ...extensionContext,
          imageAttachmentLoader: this.loadOpenAIReferenceImage,
          requireImageAttachmentLoader: true
        })
      )
      .find((client) => Boolean(client))
    const modelUse = resolveProfileModelUse(profileWithSelectedKey)
    if (!extensionCli && modelUse !== 'video') {
      validateInlineImageAttachmentTransport(
        profileWithSelectedKey,
        req.messages,
        req.profileScope,
        req.apiMode
      )
    }
    if (modelUse === 'video') {
      validateVideoImageAttachmentTransport(profileWithSelectedKey, req.messages)
    }
    const cli =
      extensionCli ??
      cliFromProfile(
        {
          ...profileWithSelectedKey,
          ...(req.apiMode ? { api_mode: req.apiMode } : {}),
          ...(req.apiMode === 'responses' || req.apiMode === 'chat-completions'
            ? { attachment_transports: profileWithSelectedKey.attachment_transports ?? [] }
            : {})
        },
        {
          fetchImpl: this.getFetchImpl(),
          imageAttachmentLoader: this.loadOpenAIReferenceImage,
          requireImageAttachmentLoader: true
        }
      )
    if (!cli) {
      throw new Error('Unable to create an LLM client.')
    }

    const effectiveMessages = stripQAppInlineImagePolicyMarker(req.messages)

    console.log('[LLMProxySvc] chat request:', {
      profileId: profile.id,
      model: profileWithSelectedKey.model_name,
      messageCount: effectiveMessages.length
    })

    const allowedToolNames = extractSkillRuntimeAllowedToolNames(req)
    const hasAllowedMcpTools = Boolean(
      allowedToolNames?.some((toolName) => toolName.toLowerCase().startsWith('mcp.'))
    )
    if (hasAllowedMcpTools) {
      try {
        await syncMcpClientManager(config)
      } catch (error) {
        console.warn('[LLMProxySvc] Failed to sync MCP client manager before tool exposure:', error)
      }
    }
    const runtime = getAssistantRuntime()
    const availableSkillTools = allowedToolNames
      ? (runtime.listTools(allowedToolNames) as ToolSummary[])
      : []
    const availableSkillToolNames = new Set(availableSkillTools.map((tool) => tool.name))
    let nativeToolsEnabled = cli.supportsNativeTools === true && availableSkillTools.length > 0
    const toolAwareSystemPrompt = (): string | undefined => {
      const toolInstructionBlock = nativeToolsEnabled
        ? 'Use the provided native functions when needed. Do not print tool invocation JSON as an answer. Wait for actual tool results before claiming a file was read or an operation succeeded. Local file permissions remain enforced by the application.'
        : buildSkillRuntimeToolInstructions(availableSkillTools, {
            outputMode: req.skillRuntime?.execution?.outputMode
          })
      return (
        [req.systemPrompt?.trim() || '', toolInstructionBlock].filter(Boolean).join('\n\n') ||
        undefined
      )
    }
    const conversationMessages = [...effectiveMessages]
    let content = ''
    let chatResult: LLMChatResult = { content: '' }

    const runId = options?.runId || `run-${crypto.randomUUID()}`
    let totalUsage: ToolLoopUsage | undefined
    let lastStepUsage: ToolLoopUsage | undefined
    let continuationUrl = req.sessionUrl
    let modelStepCount = 0
    let toolProtocolRepairs = 0
    const toolHistory: Array<Record<string, unknown>> = []
    const nativeTurns: LLMToolTurn[] = []
    const executedNativeIds = new Set<string>()
    let transcriptBytes = 0
    const emitToolStatus = (toolStatus: LLMToolStatus): void => {
      if (options?.signal?.aborted) return
      options?.onDelta?.({ type: 'tool-status', delta: '', toolStatus })
    }

    try {
      for (let step = 0; ;) {
        throwIfAborted(options?.signal)
        if (modelStepCount >= MAX_SKILL_RUNTIME_TOOL_CALLS + 2)
          throw new Error(
            'Agent model-step budget exhausted. Completed tool results have been retained.'
          )
        const stepStream =
          availableSkillTools.length > 0 ? createSkillToolStream(options?.onDelta) : undefined
        let nativeOutputStarted = false
        let nextChatResult: LLMChatResult
        try {
          nextChatResult = await cli.chat({
            ...(req.conversationId && options?.signal && !req.videoGenerationOptions
              ? { retryCapacity: true }
              : {}),
            ...(nativeToolsEnabled ? { tools: availableSkillTools, toolTurns: nativeTurns } : {}),
            messages: conversationMessages,
            systemPrompt: toolAwareSystemPrompt(),
            reasoningEffort: req.reasoningEffort,
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature,
            imageGenerationOptions: req.imageGenerationOptions,
            imageRequest: req.imageRequest,
            imageHistoryPolicy: req.imageHistoryPolicy,
            videoGenerationOptions: req.videoGenerationOptions,
            signal: options?.signal,
            sessionUrl: continuationUrl,
            conversationId: req.conversationId,
            onDelta: (event) => {
              if (
                (event.type === 'text-delta' && event.delta) ||
                event.type === 'attachment' ||
                event.type === 'tool-status'
              )
                nativeOutputStarted = true
              if (stepStream) stepStream.onDelta(event)
              else if (event.type !== 'done') options?.onDelta?.(event)
            }
          })
        } catch (error) {
          throwIfAborted(options?.signal)
          if (
            nativeToolsEnabled &&
            modelStepCount === 0 &&
            !nativeOutputStarted &&
            isNativeToolsUnsupportedError(error)
          ) {
            nativeToolsEnabled = false
            continue
          }
          throw error
        }
        chatResult = normalizeLLMChatResult(nextChatResult)
        modelStepCount += 1
        lastStepUsage = chatResult.usage
        totalUsage = addToolLoopUsage(totalUsage, lastStepUsage)
        content = chatResult.content
        if (chatResult.sessionUrl) continuationUrl = chatResult.sessionUrl
        throwIfAborted(options?.signal)

        if (
          nativeToolsEnabled &&
          chatResult.toolCalls?.length &&
          ['length', 'cancelled', 'error'].includes(chatResult.finishReason || '')
        )
          throw new Error('Incomplete native tool calls are not executable.')
        const nativeBatch =
          nativeToolsEnabled && chatResult.toolCalls?.length
            ? prepareNativeToolBatch(chatResult.toolCalls, availableSkillTools)
            : []
        const parsedTool = nativeBatch.length
          ? { kind: 'text' as const }
          : availableSkillTools.length > 0
            ? parseSkillToolInvocation(content, availableSkillToolNames)
            : { kind: 'text' as const }
        if (parsedTool.kind === 'invalid') {
          stepStream?.finish(true)
          throwIfAborted(options?.signal)
          if (
            parsedTool.reason === 'malformed' &&
            toolProtocolRepairs++ === 0 &&
            nativeTurns.length === 0
          ) {
            conversationMessages.push({ role: 'assistant', content })
            conversationMessages.push({
              role: 'user',
              content:
                '[Tool Protocol Correction] No tool has run. Return one valid JSON tool invocation only: {"toolName":"<bound-tool>","args":{...}}. Preserve the user-requested file identity; use forward slashes for Windows paths. Do not append an apology or summary before receiving the actual tool result.'
            })
            continue
          }
          throw new Error(
            'The model returned an invalid or ambiguous tool call. No tool was executed; please retry.'
          )
        }
        const legacy = parsedTool.kind === 'tool' ? parsedTool.invocation : null
        const requested = nativeBatch.length
          ? nativeBatch.map(({ call, args }) => ({
              toolName: call.name,
              args,
              call: call as LLMFunctionCall | undefined
            }))
          : legacy
            ? [
                {
                  ...legacy,
                  call: nativeToolsEnabled
                    ? {
                        id: `${runId}:tool:${step}`,
                        name: legacy.toolName,
                        wireName: `mp_tool_${availableSkillTools.findIndex((tool) => tool.name === legacy.toolName)}`,
                        arguments: JSON.stringify(legacy.args)
                      }
                    : undefined
                }
              ]
            : []
        stepStream?.finish(requested.length > 0)
        throwIfAborted(options?.signal)
        if (!requested.length) break
        if (step + requested.length > MAX_SKILL_RUNTIME_TOOL_CALLS)
          throw new Error(
            `Agent tool-call budget exhausted (${MAX_SKILL_RUNTIME_TOOL_CALLS} calls). Completed tool results have been retained.`
          )
        // Reject an ambiguous replay before any member of this batch can have effects.
        for (const item of requested) {
          if (item.call && executedNativeIds.has(item.call.id))
            throw new Error('Duplicate native tool call id; the operation was not executed again.')
        }
        const turn: LLMToolTurn = {
          content: nativeBatch.length ? content : '',
          calls: requested.flatMap((item) => (item.call ? [item.call] : [])),
          results: [],
          ...(nativeBatch.length && chatResult.toolResponseItems
            ? { responseItems: chatResult.toolResponseItems }
            : {})
        }
        for (const requestedTool of requested) {
          throwIfAborted(options?.signal)
          const toolCallId = `${runId}:tool:${step}`
          const toolOptions = {
            allowedToolNames,
            signal: options?.signal,
            runId,
            toolCallId,
            readExternalFile: options?.readExternalFile
          }
          const record: Record<string, unknown> = {
            runId,
            toolCallId,
            toolName: requestedTool.toolName,
            args: requestedTool.args,
            status: 'running'
          }
          if (requestedTool.call) {
            executedNativeIds.add(requestedTool.call.id)
            record.metadata = {
              nativeCallId: requestedTool.call.id,
              nativeName: requestedTool.call.wireName
            }
          }
          toolHistory.push(record)
          try {
            emitToolStatus({
              runId,
              toolCallId,
              toolName: requestedTool.toolName,
              status: 'running'
            })
            throwIfAborted(options?.signal)
            const toolResult = options?.executeTool
              ? await options.executeTool({
                  toolName: requestedTool.toolName,
                  args: requestedTool.args,
                  runId,
                  toolCallId,
                  signal: options.signal
                })
              : await runtime.callTool(
                  buildSkillRuntimeRoute(req),
                  requestedTool.toolName,
                  requestedTool.args,
                  toolOptions
                )
            record.status = 'completed'
            record.content = toolResult.content
            if (toolResult.metadata)
              record.metadata = {
                ...((record.metadata as Record<string, unknown>) || {}),
                ...toolResult.metadata
              }
            emitToolStatus({
              runId,
              toolCallId,
              toolName: requestedTool.toolName,
              status: 'completed'
            })
            throwIfAborted(options?.signal)
            if (requestedTool.call)
              turn.results.push({ callId: requestedTool.call.id, output: toolResult.content })
            else {
              conversationMessages.push({
                role: 'assistant',
                content: JSON.stringify({
                  toolName: requestedTool.toolName,
                  args: requestedTool.args
                })
              })
              conversationMessages.push(buildToolResultMessage(requestedTool, toolResult.content))
            }
            step += 1
          } catch (error) {
            if (record.status !== 'completed') {
              const status = options?.signal?.aborted ? 'cancelled' : 'failed'
              record.status = status
              record.error = error instanceof Error ? error.message : String(error)
              emitToolStatus({ runId, toolCallId, toolName: requestedTool.toolName, status })
            }
            throw error
          }
        }
        // A bounded transcript is distinct from the number of calls. Never silently truncate results.
        transcriptBytes +=
          Buffer.byteLength(JSON.stringify(nativeToolsEnabled ? turn : requested), 'utf8') +
          (nativeToolsEnabled
            ? 0
            : Buffer.byteLength(String(toolHistory.at(-1)?.content || ''), 'utf8'))
        if (transcriptBytes > MAX_NATIVE_TRANSCRIPT_BYTES)
          throw new Error(
            'Agent tool transcript budget exhausted. Completed tool results have been retained.'
          )
        if (nativeToolsEnabled) nativeTurns.push(turn)
      }
    } catch (error) {
      if (error instanceof Error) {
        Object.assign(error, {
          ...(totalUsage ? { usage: totalUsage } : {}),
          metadata: { runId, lastStepUsage, toolHistory }
        })
      }
      throw error
    }
    if (totalUsage) chatResult.usage = totalUsage
    if (modelStepCount > 1 || toolHistory.length > 0) {
      chatResult.metadata = { ...(chatResult.metadata || {}), runId, lastStepUsage, toolHistory }
    }

    const structuredSkillContent = validateStructuredSkillOutput(content, req.skillRuntime)
    if (structuredSkillContent !== null) {
      chatResult = {
        ...chatResult,
        content: structuredSkillContent
      }
      content = chatResult.content
    }

    const isImageUrl = (url: string): boolean => {
      try {
        const urlObj = new URL(url)
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
          return false
        }
        const pathname = urlObj.pathname.toLowerCase()
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
        return imageExtensions.some((ext) => pathname.includes(ext))
      } catch {
        return false
      }
    }

    if (isImageUrl(content)) {
      return toLLMChatResp({
        ...chatResult,
        content: '',
        imageUrl: content
      })
    }

    return toLLMChatResp(chatResult)
  }

  chatStream = async (
    req: LLMChatStreamReq,
    resp: ServerStreaming<LLMChatStreamResp>,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const streamAbortController = new AbortController()
    const abortContext = this.createConversationAbortContext(
      req.conversationId,
      streamAbortController.signal
    )
    const rendererAbortMessage = 'Streaming request aborted by the renderer.'
    const userCancellationMessage = 'Conversation cancelled by the user.'
    let streamClosed = false
    let terminalStarted = false
    let streamedText = ''
    let lastSessionUrl = req.sessionUrl?.trim() || undefined
    const seenAttachmentKeys = new Set<string>()

    const isUserCancellation = (): boolean => {
      const reason = abortContext.signal?.reason
      return (
        !streamClosed &&
        abortContext.signal?.aborted === true &&
        reason instanceof Error &&
        reason.name === 'AbortError' &&
        reason.message === userCancellationMessage
      )
    }

    const canWriteData = (): boolean =>
      !streamClosed && !terminalStarted && !abortContext.signal?.aborted
    const canWriteTerminal = (): boolean =>
      !streamClosed && (!abortContext.signal?.aborted || isUserCancellation())

    const emitData = (data: LLMChatStreamResp): boolean => {
      if (!canWriteData()) return false
      resp.onData(data)
      return canWriteData()
    }

    const emitCancelledTerminal = (): void => {
      if (!canWriteTerminal() || terminalStarted) return
      terminalStarted = true
      resp.onData({
        type: 'done',
        delta: '',
        done: true,
        fullContent: streamedText || undefined,
        content: streamedText || '',
        finishReason: 'cancelled'
      })
    }

    const emitErrorTerminal = (message: string, error?: unknown): void => {
      if (!canWriteTerminal() || terminalStarted) return
      terminalStarted = true
      const diagnostic =
        error && typeof error === 'object'
          ? (error as { status?: unknown; statusCode?: unknown; body?: unknown })
          : undefined
      const status =
        typeof diagnostic?.status === 'number'
          ? diagnostic.status
          : typeof diagnostic?.statusCode === 'number'
            ? diagnostic.statusCode
            : undefined
      const body = typeof diagnostic?.body === 'string' ? diagnostic.body : undefined
      const diagnosticFields = {
        ...(status !== undefined ? { status } : {}),
        ...(body !== undefined ? { body } : {})
      }
      resp.onData({
        type: 'error',
        delta: '',
        done: false,
        fullContent: streamedText || undefined,
        content: streamedText || '',
        error: message,
        finishReason: 'error',
        ...diagnosticFields
      })
      if (canWriteTerminal()) {
        resp.onData({
          type: 'done',
          delta: '',
          done: true,
          fullContent: streamedText || undefined,
          content: streamedText || '',
          error: message,
          finishReason: 'error',
          ...diagnosticFields
        })
      }
    }

    const rememberAttachment = (attachment: ChatAttachment): boolean => {
      const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
      if (seenAttachmentKeys.has(key)) {
        return false
      }
      seenAttachmentKeys.add(key)
      return true
    }

    const emitEvent = (event: LLMDeltaEvent): boolean => {
      if (!canWriteData()) return false

      if (event.type === 'text-delta' && event.delta) {
        streamedText += event.delta
      }

      if (event.type === 'attachment' && event.attachment) {
        if (!rememberAttachment(event.attachment)) return true
      }

      if (event.type === 'session' && event.sessionUrl) {
        lastSessionUrl = event.sessionUrl
      }

      return emitData({
        type: event.type,
        delta: event.delta || '',
        done: false,
        fullContent: streamedText || undefined,
        ...(event.content !== undefined ? { content: event.content } : {}),
        ...(event.attachment ? { attachment: event.attachment } : {}),
        ...(event.attachments ? { attachments: event.attachments } : {}),
        ...(event.sessionUrl ? { sessionUrl: event.sessionUrl } : {}),
        ...(event.ocrResult ? { ocrResult: event.ocrResult } : {}),
        ...(event.finishReason ? { finishReason: event.finishReason } : {}),
        ...(event.error ? { error: event.error } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
        ...(event.toolStatus ? { toolStatus: event.toolStatus } : {}),
        ...(event.retry ? { retry: event.retry } : {})
      })
    }

    let cleanupRemoteStream: (() => void) | undefined
    const remoteStream = async (): Promise<void> => {
      const remoteConfig = getConfig().remote_llm_server_config
      const origin = remoteConfig?.server_origin?.trim()
      const accessToken = remoteConfig?.access_token?.trim()
      if (!origin || !accessToken) {
        throw new Error('Remote LLM streaming is enabled but the remote server is not configured.')
      }

      let endpointOrigin: string
      let trustedRemoteOrigin: string
      try {
        const parsedOrigin = new URL(origin)
        if (
          !['http:', 'https:'].includes(parsedOrigin.protocol) ||
          parsedOrigin.username ||
          parsedOrigin.password ||
          parsedOrigin.hash
        ) {
          throw new Error('only HTTP(S) origins without credentials or fragments are allowed')
        }
        endpointOrigin = parsedOrigin.toString()
        trustedRemoteOrigin = parsedOrigin.origin
      } catch {
        throw new Error('Remote LLM streaming server origin is invalid.')
      }

      let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const cancelReader = (reader?: ReadableStreamDefaultReader<Uint8Array>): void => {
        try {
          if (reader) void reader.cancel().catch(() => undefined)
        } catch {
          // Cleanup must still abort the request and release the captured reader.
        }
      }
      const remoteAbortController = new AbortController()
      const abortRemoteStream = (reason?: unknown): void => {
        cancelReader(activeReader)
        if (!remoteAbortController.signal.aborted) remoteAbortController.abort(reason)
      }
      const runWithRemoteAbort = async <T>(operation: () => Promise<T>): Promise<T> => {
        const signal = remoteAbortController.signal
        throwIfAborted(signal)
        let onAbort!: () => void
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () =>
            reject(signal.reason || createAbortError('Remote LLM streaming was aborted.'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          const result = await Promise.race([operation(), aborted])
          throwIfAborted(signal)
          return result
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
      const relayAbort = (): void => {
        abortRemoteStream(
          abortContext.signal?.reason || createAbortError('Remote LLM streaming was aborted.')
        )
      }
      const deadlineTimer = setTimeout(
        () => abortRemoteStream(createAbortError('Remote LLM streaming deadline exceeded.')),
        REMOTE_STREAM_DEADLINE_MS
      )
      abortContext.signal?.addEventListener('abort', relayAbort, { once: true })
      cleanupRemoteStream = () => {
        clearTimeout(deadlineTimer)
        abortContext.signal?.removeEventListener('abort', relayAbort)
        abortRemoteStream()
      }
      let responseBytes = 0
      let eventCount = 0
      let textBytes = 0
      const readResponseBody = async (
        response: Response,
        enforceFrameLimit = false
      ): Promise<string> => {
        if (!response.body) return ''
        const reader = response.body.getReader()
        activeReader = reader
        const chunks: Uint8Array[] = []
        let total = 0
        try {
          while (true) {
            const next = await runWithRemoteAbort(() => reader.read())
            if (next.done) break
            total += next.value.byteLength
            responseBytes += next.value.byteLength
            if (responseBytes > REMOTE_STREAM_MAX_RESPONSE_BYTES) {
              throw new Error('Remote LLM streaming response exceeded the byte limit.')
            }
            chunks.push(next.value)
          }
          if (enforceFrameLimit && total > REMOTE_STREAM_MAX_FRAME_BYTES) {
            throw new Error('Remote LLM streaming frame exceeded the byte limit.')
          }
          const bytes = new Uint8Array(total)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          return new TextDecoder().decode(bytes)
        } finally {
          cancelReader(reader)
          if (activeReader === reader) activeReader = undefined
          reader.releaseLock()
        }
      }

      const requestBody = JSON.stringify({ ...req, stream: true })
      if (new TextEncoder().encode(requestBody).byteLength > REMOTE_STREAM_MAX_REQUEST_BYTES) {
        throw new Error('Remote LLM streaming request exceeded the request byte limit.')
      }
      const headers = {
        Accept: 'text/event-stream, application/x-ndjson, application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-MagicPot-Proxy-Token': accessToken,
        'X-MagicPot-Bot-Secret': accessToken,
        'X-Bot-Secret': accessToken
      }
      let response: Response | undefined
      let responseBodyText = ''
      for (const path of REMOTE_STREAM_ENDPOINTS) {
        response = await runWithRemoteAbort(() => {
          const pendingResponse = this.getFetchImpl()(new URL(path, endpointOrigin).toString(), {
            method: 'POST',
            headers,
            body: requestBody,
            signal: remoteAbortController.signal
          })
          void pendingResponse.then(
            (lateResponse) => {
              if (remoteAbortController.signal.aborted) {
                void lateResponse.body?.cancel().catch(() => undefined)
              }
            },
            () => undefined
          )
          return pendingResponse
        })
        if (response.ok) break
        responseBodyText = await readResponseBody(response)
        const isLastEndpoint = path === REMOTE_STREAM_ENDPOINTS.at(-1)
        if (
          !isLastEndpoint &&
          [404, 405, 410].includes(response.status) &&
          !isRemoteContinuationDetail(
            response.status,
            responseBodyText,
            Boolean(req.sessionUrl?.trim())
          )
        ) {
          continue
        }
        throw createRemoteUpstreamError(response.status, response.statusText, responseBodyText)
      }
      const successfulResponse = response
      if (!successfulResponse || !successfulResponse.ok) {
        throw createRemoteUpstreamError(
          successfulResponse?.status ?? 502,
          successfulResponse?.statusText ?? 'Bad Gateway',
          responseBodyText
        )
      }
      const responseBody = async (): Promise<string> => readResponseBody(successfulResponse, true)

      const accountRemoteEvent = (event: LLMChatStreamResp): void => {
        eventCount += 1
        if (eventCount > REMOTE_STREAM_MAX_EVENTS) {
          throw new Error('Remote LLM streaming response exceeded the event limit.')
        }
        if (event.type === 'text-delta' && event.delta) {
          textBytes += new TextEncoder().encode(event.delta).byteLength
          if (textBytes > REMOTE_STREAM_MAX_TEXT_BYTES) {
            throw new Error('Remote LLM streaming response exceeded the text limit.')
          }
        }
      }

      const emitRemoteEvent = (event: LLMChatStreamResp, trustedRemoteOrigin?: string): boolean => {
        if (!isPlainRecord(event) || typeof event.type !== 'string') {
          throw new Error('Remote LLM streaming response contained an invalid event.')
        }
        const safeEvent: LLMChatStreamResp =
          event.type === 'error' && event.error
            ? { ...event, error: boundRemoteErrorDetail(event.error) }
            : event.type === 'tool-status'
              ? {
                  type: 'tool-status',
                  delta: '',
                  done: false,
                  toolStatus: normalizeRemoteToolStatus(event.toolStatus)
                }
              : event.type === 'retry'
                ? {
                    type: 'retry',
                    delta: '',
                    done: false,
                    retry: normalizeModelRetryStatus(event.retry)
                  }
                : event
        if (safeEvent.type === 'retry' && !safeEvent.retry)
          throw new Error('Invalid model retry event.')
        assertSafeRemoteEventUrls(safeEvent, trustedRemoteOrigin)
        accountRemoteEvent(safeEvent)
        if (
          ![
            'text-delta',
            'attachment',
            'session',
            'tool-status',
            'retry',
            'done',
            'error'
          ].includes(safeEvent.type)
        ) {
          throw new Error(
            `Remote LLM streaming response contained an unknown event type: ${safeEvent.type}`
          )
        }
        if (safeEvent.type === 'text-delta' && safeEvent.delta) streamedText += safeEvent.delta
        if (safeEvent.type === 'attachment' && safeEvent.attachment) {
          if (!rememberAttachment(safeEvent.attachment)) return true
        }
        if (safeEvent.type === 'session' && safeEvent.sessionUrl)
          lastSessionUrl = safeEvent.sessionUrl
        if (safeEvent.type === 'done') {
          if (terminalStarted || !canWriteData()) return false
          terminalStarted = true
          resp.onData({ ...safeEvent, type: 'done', done: true })
          return false
        }
        if (safeEvent.type === 'error') {
          if (terminalStarted || !canWriteData()) return false
          if (!emitData(safeEvent)) return false
          terminalStarted = true
          resp.onData({
            type: 'done',
            delta: '',
            done: true,
            fullContent: streamedText || undefined,
            content: streamedText || '',
            ...(safeEvent.attachments ? { attachments: safeEvent.attachments } : {}),
            ...(safeEvent.imageUrl ? { imageUrl: safeEvent.imageUrl } : {}),
            ...(safeEvent.sessionUrl ? { sessionUrl: safeEvent.sessionUrl } : {}),
            ...(safeEvent.ocrResult ? { ocrResult: safeEvent.ocrResult } : {}),
            error: safeEvent.error || 'Remote LLM streaming request failed.',
            finishReason: 'error'
          })
          return false
        }
        return emitData(safeEvent)
      }

      const emitRemoteResponse = (result: LLMChatResp, trustedRemoteOrigin?: string): void => {
        assertSafeRemoteOutputUrl(result.imageUrl, 'image', trustedRemoteOrigin)
        assertSafeRemoteSessionRef(result.sessionUrl, trustedRemoteOrigin)
        assertSafeRemoteOcrResult(result.ocrResult, 'response', trustedRemoteOrigin)
        for (const attachment of result.attachments || []) {
          assertSafeRemoteAttachment(attachment, 'response', trustedRemoteOrigin)
        }
        if (result.content) {
          emitRemoteEvent(
            {
              type: 'text-delta',
              delta: result.content,
              done: false,
              fullContent: result.content,
              content: result.content,
              ...(result.usage ? { usage: result.usage } : {})
            },
            trustedRemoteOrigin
          )
        }
        for (const attachment of result.attachments || []) {
          emitRemoteEvent(
            {
              type: 'attachment',
              delta: '',
              done: false,
              fullContent: streamedText || undefined,
              attachment
            },
            trustedRemoteOrigin
          )
        }
        if (result.sessionUrl && result.sessionUrl !== lastSessionUrl) {
          emitRemoteEvent(
            {
              type: 'session',
              delta: '',
              done: false,
              fullContent: streamedText || undefined,
              sessionUrl: result.sessionUrl
            },
            trustedRemoteOrigin
          )
        }
        emitRemoteEvent(
          {
            type: 'done',
            delta: '',
            done: true,
            fullContent: streamedText || undefined,
            content: result.content,
            ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
            ...(result.attachments ? { attachments: result.attachments } : {}),
            ...(result.sessionUrl ? { sessionUrl: result.sessionUrl } : {}),
            ...(result.ocrResult ? { ocrResult: result.ocrResult } : {}),
            ...(result.finishReason
              ? { finishReason: result.finishReason }
              : { finishReason: 'stop' }),
            ...(result.metadata ? { metadata: result.metadata } : {}),
            ...(result.usage ? { usage: result.usage } : {})
          },
          trustedRemoteOrigin
        )
      }

      const fallbackHeader =
        response!.headers.get('X-MagicPot-Stream-Fallback')?.trim().toLowerCase() ===
        'non-stream-json'
      const contentType = response!.headers.get('content-type')?.toLowerCase() || ''
      const isNdjson = contentType.includes('application/x-ndjson')
      const isSse = contentType.includes('text/event-stream')
      if (fallbackHeader || contentType.includes('application/json')) {
        const body = await responseBody()
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          throw new Error(
            `Remote LLM streaming response was not valid JSON: ${boundRemoteErrorDetail(body)}`
          )
        }
        if (isPlainRecord(parsed) && typeof parsed.type === 'string') {
          emitRemoteEvent(parsed as unknown as LLMChatStreamResp, trustedRemoteOrigin)
        } else if (isPlainRecord(parsed)) {
          emitRemoteResponse(parsed as unknown as LLMChatResp, trustedRemoteOrigin)
        } else {
          throw new Error('Remote LLM streaming response was not an object.')
        }
        return
      }

      if (!successfulResponse.body) throw new Error('Remote LLM streaming response had no body.')
      if (!isSse && !isNdjson) {
        throw new Error(
          `Remote LLM streaming response has unsupported content type: ${contentType || '(missing)'}`
        )
      }
      const reader = successfulResponse.body.getReader()
      activeReader = reader
      const decoder = new TextDecoder()
      let buffer = ''
      let dataLines: string[] = []
      let pendingFrameBytes = 0
      let sawDone = false
      const dispatch = (payload: string): void => {
        const normalizedPayload = payload.trim()
        if (!normalizedPayload) return
        if (normalizedPayload === '[DONE]') {
          if (!terminalStarted && canWriteData()) {
            terminalStarted = true
            resp.onData({
              type: 'done',
              delta: '',
              done: true,
              fullContent: streamedText || undefined,
              content: streamedText,
              finishReason: 'stop'
            })
          }
          sawDone = true
          return
        }
        if (
          new TextEncoder().encode(normalizedPayload).byteLength > REMOTE_STREAM_MAX_FRAME_BYTES
        ) {
          throw new Error('Remote LLM streaming frame exceeded the byte limit.')
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(normalizedPayload)
        } catch {
          throw new Error(
            `Remote LLM streaming ${isNdjson ? 'NDJSON record' : 'SSE frame'} was not valid JSON: ${boundRemoteErrorDetail(normalizedPayload)}`
          )
        }
        const keepReading = emitRemoteEvent(parsed as LLMChatStreamResp, trustedRemoteOrigin)
        if (!keepReading) sawDone = terminalStarted
      }
      const flushSseFrame = (): void => {
        if (dataLines.length === 0) return
        const payload = dataLines.join('\n')
        dataLines = []
        pendingFrameBytes = 0
        dispatch(payload)
      }
      const processChunk = (chunk: string): void => {
        buffer += chunk
        const lines = buffer.split(/\n/)
        buffer = lines.pop() || ''
        if (new TextEncoder().encode(buffer).byteLength > REMOTE_STREAM_MAX_FRAME_BYTES) {
          throw new Error('Remote LLM streaming frame exceeded the byte limit.')
        }
        for (const line of lines) {
          if (sawDone || streamClosed || remoteAbortController.signal.aborted) break
          const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
          if (isNdjson) {
            if (normalized.trim()) dispatch(normalized)
          } else if (normalized === '') {
            flushSseFrame()
          } else if (normalized.startsWith('data:')) {
            const data = normalized.slice(5).trimStart()
            pendingFrameBytes += new TextEncoder().encode(data).byteLength
            if (dataLines.length > 0) pendingFrameBytes += 1
            if (pendingFrameBytes > REMOTE_STREAM_MAX_FRAME_BYTES) {
              throw new Error('Remote LLM streaming frame exceeded the byte limit.')
            }
            dataLines.push(data)
          }
        }
      }
      try {
        while (true) {
          const next = await runWithRemoteAbort(() => reader.read())
          if (next.done) break
          responseBytes += next.value.byteLength
          if (responseBytes > REMOTE_STREAM_MAX_RESPONSE_BYTES) {
            throw new Error('Remote LLM streaming response exceeded the byte limit.')
          }
          processChunk(decoder.decode(next.value, { stream: true }))
          if (sawDone || streamClosed || abortContext.signal?.aborted) return
        }
        processChunk(decoder.decode())
        if (buffer.trim()) processChunk('\n')
        if (isSse) flushSseFrame()
        if (!sawDone && !streamClosed && !abortContext.signal?.aborted) {
          throw new Error('Remote LLM streaming response ended without a done event.')
        }
      } finally {
        cancelReader(reader)
        if (activeReader === reader) activeReader = undefined
        reader.releaseLock()
      }
    }

    try {
      const closeRenderer = () => {
        streamClosed = true
        cleanupRemoteStream?.()
        abortContext.abort(createAbortError(rendererAbortMessage))
      }
      resp.abortReceiver?.onAbort(closeRenderer)
      if (resp.abortReceiver?.isAborted()) closeRenderer()
      if (streamClosed) return
      if (getConfig().use_remote_llm) {
        await remoteStream()
        return
      }

      // Keep local workspace tools out of the remote transport. The remote
      // server has its own policy and must not receive this renderer-scoped
      // binding or its local workspace instructions.
      const readExternalFile = createCanvasPathReadHandler(req, invocation)
      req = withCanvasFileTools(req, invocation)
      const result = await this.chatViaAPI(req, {
        readExternalFile,
        signal: abortContext.signal,
        onDelta: emitEvent
      })

      if (streamClosed) return
      if (isUserCancellation()) {
        emitCancelledTerminal()
        return
      }
      if (abortContext.signal?.aborted) return

      const firstAttachmentUrl = result.attachments?.[0]?.url || ''
      const finalFullContent =
        result.content || streamedText || result.imageUrl || firstAttachmentUrl || undefined

      if (!streamedText && result.content) {
        streamedText = result.content
        if (
          !emitData({
            type: 'text-delta',
            delta: result.content,
            done: false,
            fullContent: result.content,
            content: result.content,
            ...(result.usage ? { usage: result.usage } : {})
          })
        ) {
          if (isUserCancellation()) emitCancelledTerminal()
          return
        }
      }

      for (const attachment of result.attachments || []) {
        if (!rememberAttachment(attachment)) {
          continue
        }

        if (
          !emitData({
            type: 'attachment',
            delta: '',
            done: false,
            fullContent: finalFullContent,
            attachment
          })
        ) {
          if (isUserCancellation()) emitCancelledTerminal()
          return
        }
      }

      if (result.sessionUrl && result.sessionUrl !== lastSessionUrl) {
        lastSessionUrl = result.sessionUrl
        if (
          !emitData({
            type: 'session',
            delta: '',
            done: false,
            fullContent: finalFullContent,
            sessionUrl: result.sessionUrl
          })
        ) {
          if (isUserCancellation()) emitCancelledTerminal()
          return
        }
      }

      if (!canWriteData()) {
        if (isUserCancellation()) emitCancelledTerminal()
        return
      }
      terminalStarted = true
      resp.onData({
        type: 'done',
        delta: '',
        done: true,
        fullContent: finalFullContent,
        content: result.content,
        ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
        ...(result.attachments ? { attachments: result.attachments } : {}),
        ...(result.sessionUrl ? { sessionUrl: result.sessionUrl } : {}),
        ...(result.ocrResult ? { ocrResult: result.ocrResult } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : { finishReason: 'stop' }),
        ...(result.metadata ? { metadata: result.metadata } : {}),
        ...(result.usage ? { usage: result.usage } : {})
      })
    } catch (error) {
      if (streamClosed) return
      if (isUserCancellation()) {
        emitCancelledTerminal()
        return
      }
      const message = boundRemoteErrorDetail(error instanceof Error ? error.message : String(error))
      emitErrorTerminal(message, error)
    } finally {
      cleanupRemoteStream?.()
      cleanupRemoteStream = undefined
      terminalStarted = true
      abortContext.cleanup()
    }
  }

  /** Main-process only; deliberately absent from the renderer service definition. No metadata discovery/network. */
  isProfileRevisionCurrent(profileId: string, revision: string): boolean {
    try {
      this.profileRevisions.verify(structuredClone(getConfig()), profileId, revision)
      return true
    } catch {
      return false
    }
  }

  /** Main-only lifetime subscription. Not registered as renderer IPC or exposed to a host. */
  onProfileConfigurationChanged(listener: () => void): () => void {
    return onConfigCommitted(listener)
  }

  listProfiles = async (req: LLMListProfilesReq): Promise<LLMListProfilesResp> => {
    const config = structuredClone(getConfig())
    if (req.comparisonRouting === 'configured' && config.use_remote_llm) {
      return this.remoteComparisons.list(config)
    }
    const validProfiles = config.llm_config.api_profiles.filter(isRunnableProfile)

    let profiles: LLMListProfilesResp['profiles'] = validProfiles.map((p) => {
      const modelUse = resolveProfileModelUse(p)
      const isVisionModel =
        modelUse === 'agent' ||
        modelUse === 'multimodal' ||
        modelUse === 'vision' ||
        modelUse === 'ocr' ||
        Boolean(p.is_vision_model)
      const isOcrModel = modelUse === 'ocr' || Boolean(p.is_ocr_model)
      const taggerDescriptor = resolveTaggerRuntimeDescriptor(p)
      const capabilities = resolveChatProfileCapabilities(p)

      return {
        id: p.id,
        model_name: p.model_name,
        ...resolveRemoteProfileRouting(p),
        deployment: resolveProfileDeployment(p),
        model_use: modelUse,
        is_vision_model: isVisionModel,
        is_ocr_model: isOcrModel,
        attachment_transports: capabilities.attachmentTransports,
        ...(capabilities.preferredAttachmentTransport
          ? { preferred_attachment_transport: capabilities.preferredAttachmentTransport }
          : {}),
        supports_session_continuation: capabilities.supportsSessionContinuation,
        ...(capabilities.maxInputImages !== undefined
          ? {
              max_input_images: capabilities.maxInputImages,
              maxInputImages: capabilities.maxInputImages,
              max_images: capabilities.maxInputImages,
              maxImages: capabilities.maxInputImages
            }
          : {}),
        ...(p.tagger_provider ? { tagger_provider: p.tagger_provider } : {}),
        ...(p.tagger_endpoint?.trim() ? { tagger_endpoint: p.tagger_endpoint.trim() } : {}),
        ...(p.tagger_runtime_cache_scope
          ? { tagger_runtime_cache_scope: p.tagger_runtime_cache_scope }
          : {}),
        ...(typeof p.context_window_tokens === 'number'
          ? { context_window_tokens: p.context_window_tokens }
          : {}),
        ...(typeof p.context_budget_tokens === 'number'
          ? { context_budget_tokens: p.context_budget_tokens }
          : {}),
        ...(taggerDescriptor ? { tagger_runtime_key: taggerDescriptor.cacheKey } : {})
      }
    })

    const extensionContext = {
      config,
      fetchImpl: this.getFetchImpl()
    }
    for (const extension of mainHostExtensionApiV1.llmProxy) {
      if (extension.transformListedProfiles) {
        profiles = await extension.transformListedProfiles(profiles, extensionContext)
      }
    }

    return {
      ...(req.comparisonRouting ? { comparisonDestination: { kind: 'local' as const } } : {}),
      profiles: profiles.map((profile) => ({
        ...profile,
        ...(req.includeConfigurationRevision === true &&
        (!config.use_remote_llm || req.comparisonRouting === 'local')
          ? { configurationRevision: this.profileRevisions.create(config, profile.id) }
          : {})
      }))
    }
  }

  serverStatus = async (req: LLMServerStatusReq): Promise<LLMServerStatusResp> => {
    const config = getConfig()
    const validProfiles = config.llm_config.api_profiles.filter(isRunnableProfile)

    return {
      online: true,
      version: '1.0.0',
      availableProfiles: validProfiles.length
    }
  }

  uploadHy3DModel = async (req: LLMUploadHy3DModelReq): Promise<LLMUploadHy3DModelResp> => {
    const config = getConfig()
    const credentials = this.getHunyuan3DCredentials(config)
    const cosConfig = this.getHunyuan3DCosConfig(config)

    try {
      if (req.filePath) {
        const trustedPath = consumeTrustedLocalFileSelection(req.filePath)
        return await uploadLocalHy3dModel(credentials, cosConfig, trustedPath)
      }

      if (req.fileName && req.fileDataBase64) {
        return await uploadBufferedHy3dModel(
          credentials,
          cosConfig,
          req.fileName,
          Buffer.from(req.fileDataBase64, 'base64')
        )
      }

      throw new Error('[Hunyuan3D] Missing model file to upload.')
    } catch (error) {
      throw normalizeHunyuan3DError(error)
    }
  }
  signHy3DModel = async (req: LLMSignHy3DModelReq): Promise<LLMSignHy3DModelResp> => {
    const config = getConfig()
    const credentials = this.getHunyuan3DCredentials(config)
    const cosConfig = this.getHunyuan3DCosConfig(config)

    try {
      if (req.bucket.trim() !== cosConfig.bucket || req.region.trim() !== cosConfig.region) {
        throw new Error(
          '[Hunyuan3D] Refusing to sign a COS object outside the configured bucket and region.'
        )
      }

      return signHy3dCosModel(credentials, cosConfig, req.key)
    } catch (error) {
      throw normalizeHunyuan3DError(error)
    }
  }

  clearHy3DCosPrefix = async (
    req: LLMClearHy3DCosPrefixReq
  ): Promise<LLMClearHy3DCosPrefixResp> => {
    const config = getConfig()
    const profileId = typeof req.profileId === 'string' ? req.profileId : undefined
    const credentials = this.getHunyuan3DCredentials(config, profileId)
    const cosConfig = this.getHunyuan3DCosConfig(config, profileId)

    try {
      return await clearHy3dCosPrefix(credentials, cosConfig)
    } catch (error) {
      throw normalizeHunyuan3DError(error)
    }
  }

  cancelConversation = async (
    req: LLMCancelConversationReq
  ): Promise<LLMCancelConversationResp> => {
    const conversationId = String(req.conversationId || '').trim()
    if (!conversationId) {
      return { cancelled: false }
    }

    const controller = this.conversationAbortControllers.get(conversationId)
    if (!controller || controller.signal.aborted) {
      return { cancelled: false }
    }

    controller.abort(createAbortError('Conversation cancelled by the user.'))
    return { cancelled: true }
  }

  externalAgentStream = async (
    req: LLMExternalAgentStreamReq,
    resp: ServerStreaming<LLMExternalAgentStreamResp>
  ): Promise<void> => {
    const context = this.createConversationAbortContext(req.conversationId)
    let closed = false
    let terminal = false
    const close = (): void => {
      closed = true
      context.abort(createAbortError('External Agent stream closed by the renderer.'))
    }
    resp.abortReceiver?.onAbort(close)
    if (resp.abortReceiver?.isAborted()) close()
    try {
      if (closed) return
      const origin = new URL(req.url).origin
      await streamExternalAgent(req, getConfig(), {
        signal: context.signal,
        validate: (event) => assertSafeRemoteEventUrls(event, origin),
        emit: (event) => {
          if (closed || terminal || context.signal?.aborted) return
          if (event.type === 'done') terminal = true
          resp.onData(event)
        }
      })
    } catch (error) {
      if (closed || terminal) return
      terminal = true
      const cancelled = context.signal?.aborted === true
      const partialContent =
        error &&
        typeof error === 'object' &&
        'partialContent' in error &&
        typeof error.partialContent === 'string'
          ? error.partialContent
          : ''
      resp.onData({
        type: 'done',
        delta: '',
        done: true,
        terminal: true,
        content: partialContent,
        fullContent: partialContent,
        ...(req.runId ? { runId: req.runId } : {}),
        error: boundRemoteErrorDetail(error instanceof Error ? error.message : String(error)),
        finishReason: cancelled ? 'cancelled' : 'error'
      })
    } finally {
      terminal = true
      context.cleanup()
    }
  }

  remoteFetch = async (req: LLMRemoteFetchReq): Promise<LLMRemoteFetchResp> => {
    // Register before validation/DNS so cancellation covers the entire bounded operation.
    const abortContext = this.createConversationAbortContext(req.conversationId)
    try {
      return await executeRemoteFetch(req, getConfig(), abortContext.signal)
    } finally {
      abortContext.cleanup()
    }
  }
}
