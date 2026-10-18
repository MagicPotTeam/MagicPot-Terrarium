import type { Config, CustomSkill, LLMAPIProfile, LLMOpenAIApiMode } from '@shared/config/config'
import type {
  LLMChatSkillRuntime,
  LLMChatStreamResp,
  LLMExternalAgentStreamReq,
  OCRResult
} from '@shared/api/svcLLMProxy'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { AgentRouteLike } from '@shared/agent'
import {
  isOpenAIFileSearchAttachment,
  normalizeOpenAIBaseUrl,
  resolveProfileDeployment,
  resolveProfileProvider,
  resolveChatProfileCapabilities,
  selectProviderAttachmentTransport,
  type LLMImageHistoryPolicy,
  type LLMReasoningEffort,
  resolveProfileModelUse,
  type OpenAIImageGenerationOptions,
  type ImageRequestContract
} from '@shared/llm'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  augmentMessageContentWithFileAttachments,
  expandReportBundleAttachments
} from './chatAttachmentPromptUtils'
import { getBaseProfileId, HUNYUAN_3D_PROFILE_ID } from './chatPageShared'
import {
  buildRemoteLlmServerErrorMessage,
  buildRemoteLlmServerHeaders,
  getRemoteLlmServerOrigin
} from '@renderer/utils/llmProfileUtils'
import { normalizeLocalMediaUrl } from './chatPageShared'
import { api } from '@renderer/utils/windowUtils'
import type { ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import { normalizeMediaReference } from '@shared/mediaReference'
import {
  applySkillOutputModeContract,
  resolveSkillOutputImageGenerationOptions
} from './chatSkillOutputMode'
import { selectMessagesForImageHistoryPolicy } from '@shared/llm/imageHistory'
import { isRunnableProfile, usesOpenAIResponsesImagePolicy } from '@shared/llm/utils'
import { DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY } from '@shared/llm/openaiResponses'
export { resolveChatPageRequestExecutionImagePolicy } from './imageRequestPolicy'

type ChatRequestPayload = {
  messages: Array<{
    role: ChatMessage['role']
    content: string
    attachments?: ChatAttachment[]
    toolHistory?: ChatMessage['toolHistory']
  }>
  route?: AgentRouteLike
  profileId?: string
  stream?: boolean
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  maxOutputTokens?: number
  imageGenerationOptions?: OpenAIImageGenerationOptions
  imageRequest?: ImageRequestContract
  imageHistoryPolicy?: LLMImageHistoryPolicy
  apiMode?: LLMOpenAIApiMode
  skillRuntime?: LLMChatSkillRuntime
  sessionUrl?: string
  conversationId?: string
  isEdit?: boolean
}

type OpenAIRequestMode = Exclude<LLMOpenAIApiMode, 'auto'>
type RemoteOpenAIModeMap = Record<'default' | LLMOpenAIApiMode, OpenAIRequestMode>

type RemoteRequestProfile = Pick<
  LLMAPIProfile,
  | 'id'
  | 'model_name'
  | 'base_url'
  | 'provider'
  | 'model_use'
  | 'api_mode'
  | 'call_type'
  | 'auth_mode'
  | 'deployment'
  | 'attachment_transports'
  | 'preferred_attachment_transport'
  | 'max_input_images'
  | 'maxInputImages'
  | 'max_images'
  | 'supports_session_continuation'
  | 'supportsSessionContinuation'
  | 'maxImages'
  | 'is_ocr_model'
  | 'is_vision_model'
> & { openai_api_modes?: RemoteOpenAIModeMap }

type RequestChatCompletionInput = {
  config: Config
  messages: ChatMessage[]
  // Discovery metadata from the selected remote destination; never serialized.
  remoteProfile?: RemoteRequestProfile | null
  route?: AgentRouteLike
  storageScope?: string
  profileId?: string | null
  stream?: boolean
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  maxOutputTokens?: number
  imageGenerationOptions?: OpenAIImageGenerationOptions
  imageRequest?: ImageRequestContract
  imageHistoryPolicy?: LLMImageHistoryPolicy
  apiMode?: LLMOpenAIApiMode
  skillRuntime?: LLMChatSkillRuntime
  externalAgentSkill?: CustomSkill | null
  sessionUrl?: string
  conversationId?: string
  isEdit?: boolean
  signal?: AbortSignal
}

export type RequestChatTokenUsage = {
  promptTokens?: number
  inputTextTokens?: number
  inputImageTokens?: number
  completionTokens?: number
  totalTokens?: number
}

type RequestChatCompletionResult = {
  content: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  finishReason?: LLMChatStreamResp['finishReason']
  metadata?: Record<string, unknown>
  usage?: RequestChatTokenUsage
}

export type RequestChatCompletionStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'attachment'; attachment: ChatAttachment }
  | { type: 'session'; sessionUrl: string }
  | { type: 'done' }
  | { type: 'error'; error: string }

type RequestChatCompletionStreamInput = RequestChatCompletionInput & {
  onEvent: (event: RequestChatCompletionStreamEvent) => void
}

type RendererStreamResponse = {
  abortReceiver: ReturnType<typeof newAbortHandler>[1]
  onData: (chunk: LLMChatStreamResp) => void
}

type RendererStreamInvoker = (request: unknown, response: RendererStreamResponse) => Promise<void>

export type RequestChatCompletionStreamResult = {
  result: RequestChatCompletionResult
  response: string
}

const createAbortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const createLocalTimeoutError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'TimeoutError'
  return error
}

const createRemoteDeadlineError = (): Error =>
  createLocalTimeoutError('Remote chat request timed out locally after 15 minutes.')

const IPC_STREAM_DEADLINE_MS = 15 * 60 * 1000

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return

  const reason = signal.reason
  if (reason instanceof Error) {
    throw reason
  }

  throw createAbortError(typeof reason === 'string' ? reason : 'The request was aborted.')
}

const awaitWithAbort = async <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void
): Promise<T> => {
  if (!signal) return promise

  let rejectAbort!: (reason: unknown) => void
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const handleAbort = (): void => {
    onAbort?.()
    const reason = signal.reason
    rejectAbort(reason instanceof Error ? reason : createAbortError('The request was aborted.'))
  }

  signal.addEventListener('abort', handleAbort, { once: true })
  if (signal.aborted) handleAbort()

  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    signal.removeEventListener('abort', handleAbort)
    void promise.catch(() => undefined)
  }
}

const RESPONSES_SCOPE_ERROR_FRAGMENT = 'Missing scopes: api.responses.write'
const RESPONSES_SCOPE_ERROR_MESSAGE =
  'The current OpenAI account is missing the required Responses permission (`api.responses.write`). Check the configured account or workspace, then try again.'

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

const normalizeRemoteErrorCode = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, '_')
  return normalized || undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const parseRemoteErrorRecords = (value: unknown): Record<string, unknown>[] => {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return []
    const records: Record<string, unknown>[] = [parsed]
    for (const key of ['error', 'details', 'cause']) {
      const nested = parsed[key]
      if (isRecord(nested)) records.push(nested)
      else if (typeof nested === 'string' && nested.trim()) records.push({ message: nested })
    }
    return records
  } catch {
    return []
  }
}

export const isInvalidSessionContinuationError = (
  error: unknown,
  hasSessionUrl = false
): boolean => {
  if (!hasSessionUrl) return false

  const status = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined
  if (typeof status !== 'number' || ![404, 405, 410].includes(status)) return false

  const body = error instanceof Error ? (error as Error & { body?: unknown }).body : undefined
  for (const record of parseRemoteErrorRecords(body)) {
    const code = normalizeRemoteErrorCode(record.code)
    const type = normalizeRemoteErrorCode(record.type)
    if ([code, type].some((value) => value && REMOTE_STALE_CONTINUATION_CODES.has(value))) {
      return true
    }
  }

  return false
}

type LocalChatRequestError = Error & {
  status?: number
  body?: string
  partialContent?: string
  finishReason?: LLMChatStreamResp['finishReason']
  metadata?: Record<string, unknown>
  partialResult?: RequestChatCompletionResult
}

const createLocalChatRequestError = (
  message: string,
  status?: unknown,
  body?: unknown
): LocalChatRequestError => {
  const error = new Error(message) as LocalChatRequestError
  if (typeof status === 'number') error.status = status
  if (typeof body === 'string') error.body = body
  return error
}

const mergeStreamMetadata = (
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (current === undefined) return next
  if (next === undefined) return current
  return { ...current, ...next }
}

const attachStreamPartialToError = (
  error: unknown,
  partialContent: string,
  finishReason?: LLMChatStreamResp['finishReason'],
  metadata?: Record<string, unknown>
): LocalChatRequestError => {
  const diagnostic: LocalChatRequestError =
    error instanceof Error
      ? (error as LocalChatRequestError)
      : createLocalChatRequestError(String(error))
  diagnostic.partialContent = partialContent
  if (finishReason !== undefined) diagnostic.finishReason = finishReason
  if (metadata !== undefined) diagnostic.metadata = metadata
  diagnostic.partialResult = {
    content: partialContent,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  }
  return diagnostic
}

const createIncompleteStreamError = (
  partialContent: string,
  finishReason?: LLMChatStreamResp['finishReason'],
  metadata?: Record<string, unknown>
): LocalChatRequestError =>
  attachStreamPartialToError(
    createLocalChatRequestError(
      'incomplete-stream: the IPC stream ended before a terminal done event.'
    ),
    partialContent,
    finishReason,
    metadata
  ) as LocalChatRequestError

const mapLocalChatRequestErrorMessage = (message: string): string => {
  const normalized = message.trim()
  if (/\b401\b/.test(normalized) && normalized.includes(RESPONSES_SCOPE_ERROR_FRAGMENT)) {
    return RESPONSES_SCOPE_ERROR_MESSAGE
  }

  return normalized
}

const responseToBlob = async (response: Response): Promise<Blob> => {
  if (typeof response.blob === 'function') return response.blob()
  if (typeof response.arrayBuffer === 'function') {
    const bytes = await response.arrayBuffer()
    return new Blob([bytes], {
      type: response.headers?.get?.('content-type') || 'application/octet-stream'
    })
  }
  throw new Error('Response body cannot be read as a blob')
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'))
    reader.readAsDataURL(blob)
  })

const isRequestDataImageUrl = (value: string): boolean =>
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value.trim())

const isRequestDataFileUrl = (value: string): boolean => /^data:[^;,]+;base64,/i.test(value.trim())

const isPublicHttpsUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return false
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (
      hostname !== 'localhost' &&
      hostname !== '::1' &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local') &&
      !/^127\./.test(hostname) &&
      !/^10\./.test(hostname) &&
      !/^192\.168\./.test(hostname) &&
      !/^169\.254\./.test(hostname) &&
      !/^172\.(1[6-9]|2\d|3[01])\./.test(hostname) &&
      !/^fc/i.test(hostname) &&
      !/^fd/i.test(hostname) &&
      !/^fe[89ab]/i.test(hostname)
    )
  } catch {
    return false
  }
}

const normalizeImageAttachmentForRequest = async (
  attachment: ChatAttachment,
  options: {
    allowRequestDataUrl?: boolean
    allowAccessibleUrl?: boolean
    preserveRemoteUrl?: boolean
  }
): Promise<ChatAttachment> => {
  if (
    attachment.type !== 'image' ||
    !attachment.url ||
    isRequestDataImageUrl(attachment.url) ||
    (options.allowAccessibleUrl && isPublicHttpsUrl(attachment.url)) ||
    (options.preserveRemoteUrl && isPublicHttpsUrl(attachment.url))
  ) {
    return attachment
  }

  if (!options.allowRequestDataUrl) {
    throw new Error(
      `Unable to prepare image attachment "${attachment.fileName || 'image'}" for the model: request-data-url transport is not supported`
    )
  }

  try {
    const response = await fetch(normalizeLocalMediaUrl(attachment.url))
    if (!response.ok) {
      throw new Error(`Failed to load image attachment (${response.status})`)
    }

    const blob = await responseToBlob(response)
    const dataUrl = await blobToDataUrl(blob)

    return {
      ...attachment,
      url: dataUrl,
      mimeType: attachment.mimeType || blob.type || 'image/png',
      sizeBytes:
        typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)
          ? attachment.sizeBytes
          : blob.size
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to prepare image attachment "${attachment.fileName || 'image'}" for the model: ${reason}`
    )
  }
}

const normalizeFileAttachmentForRequest = async (
  attachment: ChatAttachment,
  options: { allowRequestDataUrl?: boolean }
): Promise<ChatAttachment> => {
  if (
    attachment.type !== 'file' ||
    !attachment.url ||
    isRequestDataFileUrl(attachment.url) ||
    !normalizeLocalMediaUrl(attachment.url).startsWith('local-media://')
  ) {
    return attachment
  }

  if (!options.allowRequestDataUrl) {
    throw new Error(
      `Unable to prepare file attachment "${attachment.fileName || 'file'}" for the model: request-data-url transport is not supported`
    )
  }

  try {
    const response = await fetch(normalizeLocalMediaUrl(attachment.url))
    if (!response.ok) {
      throw new Error(`Failed to load file attachment (${response.status})`)
    }

    const blob = await responseToBlob(response)
    const dataUrl = await blobToDataUrl(blob)

    return {
      ...attachment,
      url: dataUrl,
      mimeType: attachment.mimeType || blob.type || 'application/octet-stream',
      sizeBytes:
        typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)
          ? attachment.sizeBytes
          : blob.size
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to prepare file attachment "${attachment.fileName || 'file'}" for the model: ${reason}`
    )
  }
}

export const normalizeChatAttachmentsForRequest = async (
  attachments: ChatAttachment[] | undefined,
  options: {
    managedMediaService?: ManagedMediaSvc
    allowManagedRequestDataUrl?: boolean
    allowRequestDataUrl?: boolean
    allowAccessibleUrl?: boolean
    preserveRemoteUrl?: boolean
    imageHistoryPolicy?: LLMImageHistoryPolicy
  } = {}
): Promise<ChatAttachment[] | undefined> => {
  if (!attachments?.length) {
    return undefined
  }

  return Promise.all(
    attachments.map(async (attachment) => {
      const media = normalizeMediaReference(attachment.media)
      if (media?.kind === 'managed') {
        if (
          !options.allowManagedRequestDataUrl ||
          typeof options.managedMediaService?.materializeForRequest !== 'function'
        ) {
          throw new Error(
            `Unable to prepare attachment "${attachment.fileName || 'attachment'}" for the model: no supported managed-media request transport`
          )
        }
        const materialized = await options.managedMediaService.materializeForRequest({
          reference: media,
          transport: 'request-data-url'
        })
        const requestAttachment = { ...attachment }
        delete requestAttachment.media
        return {
          ...requestAttachment,
          url: materialized.dataUrl,
          mimeType: materialized.mimeType,
          sizeBytes: materialized.sizeBytes
        }
      }
      return attachment.type === 'image'
        ? normalizeImageAttachmentForRequest(attachment, options)
        : attachment.type === 'file'
          ? normalizeFileAttachmentForRequest(attachment, options)
          : attachment
    })
  )
}

type ReportInlineCapability = {
  maxInlineChars: number
  source: 'probe' | 'fallback'
}

type AttachmentBatchCapability = {
  maxAttachments: number
  source: 'probe' | 'fallback'
}

export type ResolveAttachmentBatchCapabilityInput = Pick<
  RequestChatCompletionInput,
  'config' | 'profileId' | 'remoteProfile' | 'apiMode' | 'systemPrompt' | 'externalAgentSkill'
>

const isOfficialOpenAIBaseUrl = (baseUrl: string | undefined): boolean => {
  const normalized = String(baseUrl || '').trim()
  if (!normalized) {
    return false
  }

  try {
    const parsed = new URL(normalizeOpenAIBaseUrl(normalized))
    return parsed.protocol === 'https:' && parsed.hostname === 'api.openai.com'
  } catch {
    return false
  }
}

const resolveRequestProfile = (
  config: Config,
  profileId?: string | null
): Config['llm_config']['api_profiles'][number] | undefined => {
  const baseProfileId = getBaseProfileId(profileId)
  if (!baseProfileId) {
    return undefined
  }

  // The remote destination owns its profile IDs. A same-name local profile is
  // not routing or capability evidence for it.
  if (config.use_remote_llm) return undefined
  return [
    ...(config.llm_config.api_profiles || []),
    ...(config.plugin_config?.api_profiles || [])
  ].find((profile) => profile.id === baseProfileId)
}

const resolveSelectedRequestProfile = (
  input: Pick<RequestChatCompletionInput, 'config' | 'profileId' | 'remoteProfile'>
): RemoteRequestProfile | undefined => {
  if (input.config.use_remote_llm) {
    const profile = input.remoteProfile ?? undefined
    if (profile && input.profileId && profile.id !== input.profileId) {
      throw new Error('Remote profile metadata does not match the selected profile.')
    }
    return profile
  }
  return getBaseProfileId(input.profileId)
    ? resolveRequestProfile(input.config, input.profileId)
    : input.config.llm_config.api_profiles.find(isRunnableProfile)
}

const resolveRemoteOpenAIRequestMode = (
  profile: RemoteRequestProfile | undefined,
  apiMode?: LLMOpenAIApiMode
): OpenAIRequestMode | undefined => {
  if (
    !profile ||
    (profile.call_type && profile.call_type !== 'api') ||
    (profile.auth_mode && profile.auth_mode !== 'api_key') ||
    profile.openai_api_modes === undefined
  ) {
    return undefined
  }
  const modes = profile.openai_api_modes
  const validModes: OpenAIRequestMode[] = ['responses', 'chat-completions', 'images']
  const keys = ['default', 'auto', 'responses', 'chat-completions', 'images'] as const
  if (
    !modes ||
    typeof modes !== 'object' ||
    Array.isArray(modes) ||
    !keys.every((key) => Object.hasOwn(modes, key) && validModes.includes(modes[key]))
  ) {
    throw new Error('Remote image routing metadata is invalid. Refresh the remote profiles.')
  }
  return modes[apiMode || 'default']
}

const resolveRemoteApiModeForPayload = (
  profile: RemoteRequestProfile | undefined,
  requestedMode?: LLMOpenAIApiMode
): OpenAIRequestMode | undefined => {
  // An explicit non-auto override is part of the request contract. Keep it on
  // the wire; the remote service may use its published route map to dispatch
  // aliases (for example a Zen Responses route receiving an Images override).
  if (requestedMode && requestedMode !== 'auto') return requestedMode

  const advertisedMode = resolveRemoteOpenAIRequestMode(
    profile,
    requestedMode === 'auto' ? 'auto' : undefined
  )
  if (advertisedMode) return advertisedMode

  // Keep explicitly selected profile modes authoritative when discovery does not
  // provide a complete route map (notably legacy Images profiles).
  if (profile?.api_mode && profile.api_mode !== 'auto') return profile.api_mode

  // Older remote discovery records may omit openai_api_modes while still
  // exposing a usable base URL. Infer only the standard OpenAI route and never
  // from the colliding local profile.
  if (profile?.base_url?.trim() && resolveProfileProvider(profile) === 'openai') {
    return usesOpenAIResponsesImagePolicy(profile) ? 'responses' : 'chat-completions'
  }

  return undefined
}

const isGPTImageProfile = (
  profile: RemoteRequestProfile | undefined,
  apiMode?: LLMOpenAIApiMode
): boolean => {
  if (!profile) return false
  const effectiveApiMode = apiMode ?? profile.api_mode
  // An explicitly selected non-Images API always wins over model-name inference.
  if (effectiveApiMode === 'responses' || effectiveApiMode === 'chat-completions') return false
  const provider = resolveProfileProvider(profile)
  if (provider !== 'openai') return false
  return effectiveApiMode === 'images' || resolveProfileModelUse(profile) === 'image'
}

const supportsNativeOpenAIFileSearch = (profile: RemoteRequestProfile | undefined): boolean => {
  if (!profile) {
    return false
  }

  return (
    resolveProfileProvider(profile) === 'openai' &&
    resolveProfileDeployment(profile) === 'cloud' &&
    isOfficialOpenAIBaseUrl(profile.base_url)
  )
}

const supportsRemoteOpenAIResponsesStreaming = (
  input: Pick<
    RequestChatCompletionInput,
    'config' | 'profileId' | 'remoteProfile' | 'apiMode' | 'externalAgentSkill'
  >
): boolean => {
  if (!input.config.use_remote_llm || input.externalAgentSkill?.type === 'agent') return false
  const profile = resolveSelectedRequestProfile(input)
  if (!profile || resolveProfileProvider(profile) !== 'openai') return false
  // Prefer the published route map for stream eligibility. Legacy discovery
  // records may not include the map, so retain the standard OpenAI fallback.
  const mappedMode = resolveRemoteOpenAIRequestMode(profile, input.apiMode)
  if (mappedMode) return mappedMode === 'responses'

  // Without a route map, only standard API profiles may use the legacy
  // OpenAI inference fallback. Extension-owned routes must not inherit the
  // payload mode as evidence that their transport can stream.
  if (profile.call_type && profile.call_type !== 'api') return false
  if (profile.auth_mode && profile.auth_mode !== 'api_key') return false
  return resolveRemoteApiModeForPayload(profile, input.apiMode) === 'responses'
}

const hasExternalAgentStreamTransport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.api?.svcLLMProxy?.externalAgentStream === 'function'

export const supportsStreamingChatCompletion = (
  input: Pick<
    RequestChatCompletionInput,
    'config' | 'profileId' | 'remoteProfile' | 'apiMode' | 'externalAgentSkill'
  >
): boolean =>
  input.externalAgentSkill?.type === 'agent'
    ? hasExternalAgentStreamTransport()
    : !input.config.use_remote_llm || supportsRemoteOpenAIResponsesStreaming(input)

const shouldSkipInlineAttachmentSummary = (
  profile: RemoteRequestProfile | undefined,
  attachment: ChatAttachment
): boolean => supportsNativeOpenAIFileSearch(profile) && isOpenAIFileSearchAttachment(attachment)

const normalizeAttachmentOcrResults = (
  attachments: ChatAttachment[] | undefined,
  fallbackOcrResult?: OCRResult
): ChatAttachment[] | undefined => {
  if (!attachments?.length) {
    return undefined
  }

  const fileAttachments = attachments.filter((attachment) => attachment.type === 'file')
  const singleFileAttachment = fileAttachments.length === 1 ? fileAttachments[0] : null

  return attachments.map((attachment) => {
    if (attachment.ocrResult || !fallbackOcrResult || attachment !== singleFileAttachment) {
      return attachment
    }

    return {
      ...attachment,
      ocrResult: fallbackOcrResult
    }
  })
}

// A chat POST may already have executed tools when the connection fails.
// Without a negotiated idempotency contract it must never be replayed automatically.
const MAX_REMOTE_RETRIES = 1
const REMOTE_REQUEST_TIMEOUT_MS = 15 * 60 * 1000
const RETRY_DELAY_MS = 2000
const REMOTE_CHAT_ENDPOINTS = ['/api/chat', '/api/bot/chat', '/api/bot/message', '/api/message']
const REMOTE_CHAT_FALLBACK_STATUSES = new Set([404, 405, 410])
const REPORT_INLINE_CAPABILITY_STORAGE_PREFIX = 'chat.reportInlineCapability.'
const REPORT_INLINE_CAPABILITY_PROBE =
  'Reply with one integer only. What is the largest pure-text character count you can reliably accept in one request right now? Digits only.'
const DEFAULT_REPORT_INLINE_CHARS = 12000
const MIN_REPORT_INLINE_CHARS = 3000
const MAX_REPORT_INLINE_CHARS = 60000
const ATTACHMENT_BATCH_CAPABILITY_STORAGE_PREFIX = 'chat.attachmentBatchCapability.'
const ATTACHMENT_BATCH_CAPABILITY_PROBE =
  'Ignore any previous task instructions and reply with one integer only. What is the maximum number of attachments (images, videos, 3D models, or generic files) you can reliably analyze in one request right now? Digits only.'
const DEFAULT_ATTACHMENT_BATCH_CAPABILITY = 1
const MIN_ATTACHMENT_BATCH_CAPABILITY = 1
const MAX_ATTACHMENT_BATCH_CAPABILITY = 16

const buildIncompleteCustomSkillError = (skill: CustomSkill): string | null => {
  const missingFields: string[] = []
  const category = skill.category.trim()
  const skillName = skill.skillName.trim()
  const systemPrompt = skill.instructions?.systemPrompt?.trim() || ''
  const userPrompt = skill.instructions?.userPrompt?.trim() || ''
  const prompt = skill.prompt.trim()
  const hasInstructions = Boolean(systemPrompt || userPrompt)
  const hasPrompt = Boolean(prompt || hasInstructions)

  if (!category) missingFields.push('category')
  if (!skillName) missingFields.push('skillName')
  if (!hasPrompt) missingFields.push('prompt')
  if (skill.type === 'agent' && !skill.apiAddress?.trim()) missingFields.push('apiAddress')

  if (missingFields.length === 0) return null

  return `Custom skill "${skillName || skill.id}" is incomplete: missing ${missingFields.join(
    ', '
  )}.`
}

const validateCustomSkillForSend = (skill: CustomSkill | null | undefined): void => {
  if (!skill) return

  const errorMessage = buildIncompleteCustomSkillError(skill)
  if (errorMessage) {
    throw new Error(errorMessage)
  }
}

/**
 * External-agent endpoints currently expose only the unary remoteFetch contract.
 * They cannot consume the sessionUrl emitted by a previous response, so the
 * renderer must not optimize away historical input images on the assumption of
 * provider-side continuation. Explicit isolated/no-history execution remains
 * authoritative and is never widened back to all-history.
 */
const resolveEffectiveImageHistoryPolicy = (input: {
  imageHistoryPolicy?: LLMImageHistoryPolicy
  externalAgentSkill?: CustomSkill | null
  messages: readonly ChatMessage[]
}): LLMImageHistoryPolicy | undefined => {
  if (input.externalAgentSkill?.type !== 'agent') {
    return input.imageHistoryPolicy
  }

  const execution = input.externalAgentSkill.execution
  const explicitlyIsolated =
    execution?.mode === 'isolated' ||
    execution?.allowHistory === false ||
    execution?.contextMessageLimit === 0
  if (explicitlyIsolated || input.imageHistoryPolicy === 'all') {
    return input.imageHistoryPolicy
  }

  // Keep the historical wire shape for text-only external-agent requests that
  // did not opt into an image policy. Image-bearing requests still need an
  // explicit all-history projection because this transport has no continuation
  // contract to carry omitted historical images.
  if (
    input.imageHistoryPolicy === undefined &&
    !input.messages.some((message) =>
      message.attachments?.some((attachment) => attachment.type === 'image')
    )
  ) {
    return undefined
  }

  return 'all'
}

const projectRequestInputForTransport = <T extends RequestChatCompletionInput>(input: T): T => {
  if (input.externalAgentSkill?.type !== 'agent') {
    return input
  }

  return {
    ...input,
    imageHistoryPolicy: resolveEffectiveImageHistoryPolicy({
      ...input,
      messages: input.messages
    }),
    // External-agent transport has no continuation contract. Keep the returned
    // session metadata for display/persistence, but never send it back as if it
    // were provider-supported continuation state.
    sessionUrl: undefined
  }
}

const stableSerializeToolHistoryValue = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 'undefined' : serialized
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializeToolHistoryValue(item)).join(',')}]`
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableSerializeToolHistoryValue((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`
}

const projectToolHistoryForProvider = (
  message: ChatMessage
): {
  content: string
  toolHistory?: ChatMessage['toolHistory']
} => {
  const history = message.toolHistory
  if (history === undefined) {
    return { content: message.content }
  }

  const preservedToolHistory = history.map((entry) => ({
    ...entry,
    args: { ...entry.args },
    ...(entry.metadata ? { metadata: { ...entry.metadata } } : {})
  }))
  if (history.length === 0) {
    return { content: message.content, toolHistory: preservedToolHistory }
  }

  const projection = [
    '[assistant.toolHistory]',
    ...history.map((entry, index) => {
      const lines = [
        `entry[${index + 1}].runId=${JSON.stringify(entry.runId)}`,
        `entry[${index + 1}].toolCallId=${JSON.stringify(entry.toolCallId)}`,
        `entry[${index + 1}].toolName=${JSON.stringify(entry.toolName)}`,
        `entry[${index + 1}].status=${JSON.stringify(entry.status)}`,
        `entry[${index + 1}].args=${stableSerializeToolHistoryValue(entry.args)}`
      ]
      if (entry.content !== undefined) {
        lines.push(`entry[${index + 1}].content=${JSON.stringify(entry.content)}`)
      }
      if (entry.error !== undefined) {
        lines.push(`entry[${index + 1}].error=${JSON.stringify(entry.error)}`)
      }
      if (entry.metadata !== undefined) {
        lines.push(
          `entry[${index + 1}].metadata=${stableSerializeToolHistoryValue(entry.metadata)}`
        )
      }
      return lines.join('\n')
    }),
    '[/assistant.toolHistory]'
  ].join('\n')

  return {
    content: message.content ? `${message.content}\n\n${projection}` : projection,
    toolHistory: preservedToolHistory
  }
}
const buildChatRequestPayload = (input: RequestChatCompletionInput): ChatRequestPayload => {
  const resolvedSystemPrompt =
    input.externalAgentSkill?.type === 'agent'
      ? input.externalAgentSkill.prompt?.trim() || input.systemPrompt?.trim() || undefined
      : input.systemPrompt?.trim() || input.externalAgentSkill?.prompt?.trim() || undefined
  const requestImageGenerationOptions = resolveSkillOutputImageGenerationOptions(
    input.skillRuntime?.execution?.outputMode,
    input.imageGenerationOptions
  )

  const selectedProfile = resolveSelectedRequestProfile(input)
  const explicitApiMode = selectedProfile?.api_mode
  const remoteApiMode = input.config.use_remote_llm
    ? (resolveRemoteApiModeForPayload(selectedProfile, input.apiMode) ??
      (input.apiMode === 'auto' ? undefined : input.apiMode) ??
      (explicitApiMode === 'auto' ? undefined : explicitApiMode))
    : undefined

  return {
    messages: input.messages.map((message) => {
      const projected = projectToolHistoryForProvider(message)
      return {
        role: message.role,
        content: projected.content,
        attachments: message.attachments,
        ...(projected.toolHistory !== undefined ? { toolHistory: projected.toolHistory } : {})
      }
    }),
    ...(input.route ? { route: input.route } : {}),
    profileId: input.profileId || (input.config.use_remote_llm ? selectedProfile?.id : undefined),
    ...(input.stream ? { stream: true } : {}),
    ...(input.config.use_remote_llm
      ? remoteApiMode
        ? { apiMode: remoteApiMode }
        : {}
      : input.apiMode || explicitApiMode
        ? { apiMode: input.apiMode || explicitApiMode }
        : {}),
    systemPrompt: resolvedSystemPrompt,
    ...(input.reasoningEffort && input.externalAgentSkill?.type !== 'agent'
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(requestImageGenerationOptions
      ? { imageGenerationOptions: requestImageGenerationOptions }
      : {}),
    ...(input.imageRequest ? { imageRequest: input.imageRequest } : {}),
    ...(input.imageHistoryPolicy ? { imageHistoryPolicy: input.imageHistoryPolicy } : {}),
    ...(input.skillRuntime ? { skillRuntime: input.skillRuntime } : {}),
    sessionUrl: input.sessionUrl,
    conversationId: input.conversationId,
    isEdit: input.isEdit
  }
}

const hasPrimaryReportBundleInMessages = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      message.role === 'user' &&
      message.attachments?.some((attachment) => attachment.reportBundleRole === 'primary-report')
  )

const stableSerialize = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 'undefined' : serialized
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`
}

const hashFingerprint = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const sanitizeFingerprintPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)

const buildRemoteRouteFingerprint = (
  profileId?: string | null,
  remoteProfile?: RemoteRequestProfile | null
): string => {
  if (!remoteProfile) return sanitizeFingerprintPart(getBaseProfileId(profileId) || 'default')

  // Include every non-secret field in the renderer's remote-route contract. The
  // stable serialization keeps the cache key unchanged when discovery changes
  // object insertion order, while the hash prevents truncation collisions.
  const route = {
    id: remoteProfile.id,
    model_name: remoteProfile.model_name,
    base_url: remoteProfile.base_url,
    provider: remoteProfile.provider,
    model_use: remoteProfile.model_use,
    api_mode: remoteProfile.api_mode,
    call_type: remoteProfile.call_type,
    auth_mode: remoteProfile.auth_mode,
    deployment: remoteProfile.deployment,
    attachment_transports: remoteProfile.attachment_transports,
    preferred_attachment_transport: remoteProfile.preferred_attachment_transport,
    max_input_images: remoteProfile.max_input_images,
    maxInputImages: remoteProfile.maxInputImages,
    max_images: remoteProfile.max_images,
    maxImages: remoteProfile.maxImages,
    supports_session_continuation: remoteProfile.supports_session_continuation,
    supportsSessionContinuation: remoteProfile.supportsSessionContinuation,
    is_ocr_model: remoteProfile.is_ocr_model,
    is_vision_model: remoteProfile.is_vision_model,
    openai_api_modes: remoteProfile.openai_api_modes
  }
  const serialized = stableSerialize(route)
  const readableRoute = sanitizeFingerprintPart(
    `${remoteProfile.id || 'remote'}-${remoteProfile.model_name || 'route'}`
  )
  return `remote-${readableRoute}-${hashFingerprint(serialized)}`
}

export const resolveChatRequestRouteFingerprint = (
  config: Config,
  profileId?: string | null,
  remoteProfile?: RemoteRequestProfile | null
): string =>
  config.use_remote_llm
    ? buildRemoteRouteFingerprint(profileId, remoteProfile)
    : sanitizeFingerprintPart(getBaseProfileId(profileId) || 'default')

const getReportInlineCapabilityStorageKey = (
  profileId?: string | null,
  remoteProfile?: RemoteRequestProfile | null
): string =>
  `${REPORT_INLINE_CAPABILITY_STORAGE_PREFIX}${buildRemoteRouteFingerprint(profileId, remoteProfile)}`

const getAttachmentBatchCapabilityStorageKey = (
  input: ResolveAttachmentBatchCapabilityInput
): string => {
  const routeFingerprint = buildRemoteRouteFingerprint(input.profileId, input.remoteProfile)
  const skillKey =
    input.externalAgentSkill?.type === 'agent'
      ? `agent-${sanitizeFingerprintPart(input.externalAgentSkill.id)}`
      : null

  return `${ATTACHMENT_BATCH_CAPABILITY_STORAGE_PREFIX}${
    skillKey ? `${skillKey}-${routeFingerprint}` : routeFingerprint
  }`
}

const readCachedReportInlineCapability = (
  profileId?: string | null,
  remoteProfile?: RemoteRequestProfile | null
): ReportInlineCapability | null => {
  try {
    const raw = localStorage.getItem(getReportInlineCapabilityStorageKey(profileId, remoteProfile))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ReportInlineCapability>
    if (typeof parsed.maxInlineChars !== 'number' || !Number.isFinite(parsed.maxInlineChars)) {
      return null
    }
    return {
      maxInlineChars: Math.max(
        MIN_REPORT_INLINE_CHARS,
        Math.min(MAX_REPORT_INLINE_CHARS, Math.round(parsed.maxInlineChars))
      ),
      source: parsed.source === 'probe' ? 'probe' : 'fallback'
    }
  } catch {
    return null
  }
}

const writeCachedReportInlineCapability = (
  profileId: string | null | undefined,
  remoteProfile: RemoteRequestProfile | null | undefined,
  capability: ReportInlineCapability
): void => {
  try {
    localStorage.setItem(
      getReportInlineCapabilityStorageKey(profileId, remoteProfile),
      JSON.stringify({
        ...capability,
        updatedAt: new Date().toISOString()
      })
    )
  } catch {
    /* ignore storage failures */
  }
}

const readCachedAttachmentBatchCapability = (
  input: ResolveAttachmentBatchCapabilityInput
): AttachmentBatchCapability | null => {
  try {
    const raw = localStorage.getItem(getAttachmentBatchCapabilityStorageKey(input))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<AttachmentBatchCapability>
    if (typeof parsed.maxAttachments !== 'number' || !Number.isFinite(parsed.maxAttachments)) {
      return null
    }

    return {
      maxAttachments: Math.max(
        MIN_ATTACHMENT_BATCH_CAPABILITY,
        Math.min(MAX_ATTACHMENT_BATCH_CAPABILITY, Math.round(parsed.maxAttachments))
      ),
      source: parsed.source === 'probe' ? 'probe' : 'fallback'
    }
  } catch {
    return null
  }
}

const writeCachedAttachmentBatchCapability = (
  input: ResolveAttachmentBatchCapabilityInput,
  capability: AttachmentBatchCapability
): void => {
  try {
    localStorage.setItem(
      getAttachmentBatchCapabilityStorageKey(input),
      JSON.stringify({
        ...capability,
        updatedAt: new Date().toISOString()
      })
    )
  } catch {
    /* ignore storage failures */
  }
}

const buildFallbackReportInlineChars = (input: RequestChatCompletionInput): number => {
  const profile = resolveSelectedRequestProfile(input)

  if (profile?.is_ocr_model) return 8000
  if (profile?.is_vision_model) return 10000
  return DEFAULT_REPORT_INLINE_CHARS
}

const parseReportedInlineChars = (content: string): number | null => {
  const match = content.match(/(\d{3,6})/)
  if (!match) return null

  const parsed = Number.parseInt(match[1], 10)
  if (!Number.isFinite(parsed)) return null

  return Math.max(MIN_REPORT_INLINE_CHARS, Math.min(MAX_REPORT_INLINE_CHARS, parsed))
}

const parseReportedAttachmentBatchCapability = (content: string): number | null => {
  const match = content.match(/(\d{1,2})/)
  if (!match) return null

  const parsed = Number.parseInt(match[1], 10)
  if (!Number.isFinite(parsed)) return null

  return Math.max(
    MIN_ATTACHMENT_BATCH_CAPABILITY,
    Math.min(MAX_ATTACHMENT_BATCH_CAPABILITY, parsed)
  )
}

const mergeHiddenContextIntoMessageContent = (message: ChatMessage, content: string): string => {
  const hiddenContext = message.hiddenContext?.trim()
  if (!hiddenContext) {
    return content
  }

  const visibleContent = content.trim()
  return visibleContent ? `${hiddenContext}\n\n${visibleContent}` : hiddenContext
}

const expandMessagesForImagePreflight = async (
  messages: ChatMessage[],
  imageHistoryPolicy: LLMImageHistoryPolicy | undefined,
  maxImages: number | undefined
): Promise<ChatMessage[]> => {
  if (maxImages === undefined) return messages
  // Metadata may reveal more images. Check the aggregate again before report
  // capability probes, uploads or image materialization, and do not resurrect
  // images excluded by the history policy when expanding an older bundle.
  const expandedMessages: ChatMessage[] = []
  const messagesSelectedForExpansion = selectMessagesForImageHistoryPolicy(
    messages,
    imageHistoryPolicy
  )
  for (const message of messagesSelectedForExpansion) {
    const canExpandReportBundle = message.role === 'user'
    expandedMessages.push({
      ...message,
      attachments: canExpandReportBundle
        ? await expandReportBundleAttachments(message.attachments)
        : message.attachments
    })
  }
  const selectedMessages = selectMessagesForImageHistoryPolicy(expandedMessages, imageHistoryPolicy)
  if (maxImages !== Infinity) {
    const imageCount = countProviderBoundImages(selectedMessages)
    if (imageCount > maxImages) {
      throw new Error(`Too many images; the limit is ${maxImages}.`)
    }
  }
  return selectedMessages
}

const prepareMessagesForRequest = async (
  messages: ChatMessage[],
  options: {
    reportInlineCharLimit?: number
    skipAttachmentContentAugmentation?: boolean
    skipInlineAttachmentSummary?: (attachment: ChatAttachment) => boolean
    managedMediaService?: ManagedMediaSvc
    allowManagedRequestDataUrl?: boolean
    allowRequestDataUrl?: boolean
    allowAccessibleUrl?: boolean
    preserveRemoteUrl?: boolean
    imageHistoryPolicy?: LLMImageHistoryPolicy
    reportBundlesExpanded?: boolean
  } = {}
): Promise<ChatMessage[]> => {
  const prepared: ChatMessage[] = []
  const selectedMessages = selectMessagesForImageHistoryPolicy(messages, options.imageHistoryPolicy)
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')

  for (const [index, message] of selectedMessages.entries()) {
    const canExpandReportBundle =
      message.role === 'user' && (options.imageHistoryPolicy === 'all' || index === latestUserIndex)
    const attachments =
      canExpandReportBundle && !options.reportBundlesExpanded
        ? await expandReportBundleAttachments(message.attachments)
        : message.attachments
    const normalizedAttachments = await normalizeChatAttachmentsForRequest(attachments, options)
    if (!normalizedAttachments?.length) {
      prepared.push({
        ...message,
        content: mergeHiddenContextIntoMessageContent(message, message.content)
      })
      continue
    }

    if (options.skipAttachmentContentAugmentation) {
      prepared.push({
        ...message,
        attachments: normalizedAttachments,
        content: mergeHiddenContextIntoMessageContent(message, message.content)
      })
      continue
    }

    const nextContent = await augmentMessageContentWithFileAttachments(
      normalizedAttachments,
      message.content,
      undefined,
      {
        role: message.role,
        reportInlineCharLimit: options.reportInlineCharLimit,
        skipAttachment: options.skipInlineAttachmentSummary
      }
    )
    prepared.push({
      ...message,
      attachments: normalizedAttachments,
      content: mergeHiddenContextIntoMessageContent(message, nextContent)
    })
  }

  return prepared
}

const normalizeTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const normalizeChatTokenUsage = (
  usage?: Record<string, unknown>,
  metadata?: Record<string, unknown>
): RequestChatTokenUsage | undefined => {
  const rawUsage =
    usage ||
    (metadata?.usage && typeof metadata.usage === 'object'
      ? (metadata.usage as Record<string, unknown>)
      : metadata)
  const inputTokenDetails = (rawUsage?.input_tokens_details ??
    rawUsage?.inputTokensDetails ??
    rawUsage?.inputTokenDetails) as Record<string, unknown> | undefined
  const normalized = {
    promptTokens: normalizeTokenCount(
      rawUsage?.promptTokens ??
        rawUsage?.prompt_tokens ??
        rawUsage?.inputTokens ??
        rawUsage?.input_tokens
    ),
    inputTextTokens: normalizeTokenCount(
      rawUsage?.inputTextTokens ??
        rawUsage?.input_text_tokens ??
        inputTokenDetails?.text_tokens ??
        inputTokenDetails?.textTokens
    ),
    inputImageTokens: normalizeTokenCount(
      rawUsage?.inputImageTokens ??
        rawUsage?.input_image_tokens ??
        inputTokenDetails?.image_tokens ??
        inputTokenDetails?.imageTokens
    ),
    completionTokens: normalizeTokenCount(
      rawUsage?.completionTokens ?? rawUsage?.completion_tokens
    ),
    totalTokens: normalizeTokenCount(rawUsage?.totalTokens ?? rawUsage?.total_tokens)
  }
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined
}

const normalizeResponse = (response: {
  content?: string
  reply?: string
  message?: string
  text?: string
  imageUrl?: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  metadata?: Record<string, unknown>
  usage?: Record<string, unknown>
  finishReason?: LLMChatStreamResp['finishReason']
}): RequestChatCompletionResult => {
  const normalizedAttachments = normalizeAttachmentOcrResults(
    response.attachments,
    response.ocrResult
  )
  const imageAttachments = response.imageUrl?.trim()
    ? [
        {
          type: 'image' as const,
          url: response.imageUrl.trim()
        }
      ]
    : []
  const attachments =
    imageAttachments.length > 0 || normalizedAttachments?.length
      ? [...imageAttachments, ...(normalizedAttachments || [])]
      : undefined
  const normalizedContent =
    response.content ?? response.reply ?? response.message ?? response.text ?? ''
  const usage = normalizeChatTokenUsage(response.usage, response.metadata)
  const normalized: RequestChatCompletionResult = {
    content: normalizedContent,
    sessionUrl: response.sessionUrl,
    attachments,
    ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
    ...(response.metadata ? { metadata: response.metadata } : {}),
    ...(usage ? { usage } : {})
  }

  if (response.ocrResult) {
    normalized.ocrResult = response.ocrResult
  }

  return normalized
}

const parseExternalAgentSkillResponse = (
  body: string
): {
  content?: string
  imageUrl?: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  metadata?: Record<string, unknown>
} => {
  try {
    return JSON.parse(body) as {
      content?: string
      imageUrl?: string
      sessionUrl?: string
      attachments?: ChatAttachment[]
      ocrResult?: OCRResult
      metadata?: Record<string, unknown>
    }
  } catch {
    return { content: body }
  }
}

const cancelConversationSilently = async (conversationId?: string): Promise<void> => {
  const normalizedConversationId = String(conversationId || '').trim()
  if (!normalizedConversationId) {
    return
  }

  try {
    await window.api.svcLLMProxy.cancelConversation({
      conversationId: normalizedConversationId
    })
  } catch (error) {
    console.warn('[ChatPage] Failed to cancel conversation:', normalizedConversationId, error)
  }
}

const requestExternalAgentSkillCompletion = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  const skill = input.externalAgentSkill
  const apiAddress = skill?.apiAddress?.trim()
  if (!skill || skill.type !== 'agent' || !apiAddress) {
    throw new Error('External agent skill routing requires a configured API address.')
  }

  if (input.signal?.aborted) {
    await cancelConversationSilently(input.conversationId)
    throwIfAborted(input.signal)
  }
  throwIfAborted(input.signal)
  const handleAbort = () => {
    void cancelConversationSilently(input.conversationId)
  }
  if (input.signal) {
    input.signal.addEventListener('abort', handleAbort, { once: true })
  }

  try {
    const response = await awaitWithAbort(
      window.api.svcLLMProxy.remoteFetch({
        url: apiAddress,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(skill.apiKey?.trim()
            ? {
                Authorization: `Bearer ${skill.apiKey.trim()}`
              }
            : {})
        },
        body: JSON.stringify(
          buildChatRequestPayload({
            ...input,
            profileId: undefined,
            sessionUrl: undefined
          })
        ),
        conversationId: input.conversationId
      }),
      input.signal,
      handleAbort
    )
    throwIfAborted(input.signal)

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `External agent skill request failed (${response.status} ${response.statusText}): ${response.body}`
      )
    }

    throwIfAborted(input.signal)
    const result = normalizeResponse(parseExternalAgentSkillResponse(response.body))
    throwIfAborted(input.signal)
    return result
  } finally {
    if (input.signal) {
      input.signal.removeEventListener('abort', handleAbort)
    }
  }
}

const remoteResponseCleanup = new WeakMap<Response, () => void>()
const remoteResponseDeadline = new WeakMap<Response, Promise<never>>()

const releaseRemoteResponse = (response: Response): void => {
  remoteResponseCleanup.get(response)?.()
  remoteResponseCleanup.delete(response)
  remoteResponseDeadline.delete(response)
  void response.body?.cancel().catch(() => undefined)
}

const readRemoteResponse = async <T>(response: Response, read: () => Promise<T>): Promise<T> => {
  const deadline = remoteResponseDeadline.get(response)
  try {
    return deadline ? await Promise.race([read(), deadline]) : await read()
  } finally {
    releaseRemoteResponse(response)
  }
}

const shouldFallbackRemoteChatEndpoint = (response: Response): boolean =>
  REMOTE_CHAT_FALLBACK_STATUSES.has(response.status)

const waitForRemoteRetry = async (
  input: RequestChatCompletionInput,
  delayMs: number,
  deadlineAt: number
): Promise<void> => {
  throwIfAborted(input.signal)
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) throw createRemoteDeadlineError()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timerId)
      window.clearTimeout(deadlineId)
      input.signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      const reason = input.signal?.reason
      finish(() =>
        reject(reason instanceof Error ? reason : createAbortError('The request was aborted.'))
      )
    }
    const timerId = window.setTimeout(() => finish(resolve), Math.min(delayMs, remainingMs))
    const deadlineId = window.setTimeout(
      () => finish(() => reject(createRemoteDeadlineError())),
      remainingMs
    )
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
  })
}

const requestRemoteChatEndpoint = async (
  input: RequestChatCompletionInput,
  serverOrigin: string,
  endpoint: string,
  requestBody: string,
  deadlineAt: number
): Promise<Response> => {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_REMOTE_RETRIES; attempt += 1) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) throw createRemoteDeadlineError()

    const controller = new AbortController()
    let timeoutId: number | undefined
    let rejectDeadline: ((reason: Error) => void) | undefined
    let responseReturned = false
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject
    })
    // The deadline is only raced once fetch has returned a Response. Attach a
    // handler immediately so an abort while fetch is still pending cannot
    // become an unhandled rejection.
    void deadline.catch(() => undefined)
    const handleAbort = () => {
      const reason =
        input.signal?.reason !== undefined
          ? input.signal.reason
          : createAbortError('The request was aborted.')
      controller.abort(reason)
      rejectDeadline?.(reason)
    }
    if (input.signal?.aborted) {
      handleAbort()
    } else if (input.signal) {
      input.signal.addEventListener('abort', handleAbort, { once: true })
    }
    timeoutId = window.setTimeout(() => {
      const timeoutError = createRemoteDeadlineError()
      controller.abort(timeoutError)
      rejectDeadline?.(timeoutError)
    }, remainingMs)

    const cleanup = () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
        timeoutId = undefined
      }
      input.signal?.removeEventListener('abort', handleAbort)
    }

    try {
      throwIfAborted(input.signal)
      const request = fetch(`${serverOrigin}${endpoint}`, {
        method: 'POST',
        headers: buildRemoteLlmServerHeaders(input.config, { 'Content-Type': 'application/json' }),
        signal: controller.signal,
        body: requestBody
      })
      void request.then(
        (lateResponse) => {
          if (controller.signal.aborted) {
            void lateResponse.body?.cancel().catch(() => undefined)
          }
        },
        () => undefined
      )
      const response = await Promise.race([request, deadline])
      responseReturned = true
      remoteResponseCleanup.set(response, cleanup)
      remoteResponseDeadline.set(response, deadline)
      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (input.signal?.aborted) {
        throwIfAborted(input.signal)
        throw lastError
      }
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason
      }
      console.warn(
        `[ChatPage] remote request failed for ${endpoint} (${attempt}/${MAX_REMOTE_RETRIES}):`,
        lastError.message
      )

      if (attempt < MAX_REMOTE_RETRIES) {
        await waitForRemoteRetry(input, RETRY_DELAY_MS, deadlineAt)
      }
    } finally {
      if (!responseReturned) cleanup()
    }
  }

  throw lastError || new Error('Remote chat request failed')
}

const requestRemoteChatCompletion = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  const serverOrigin = getRemoteLlmServerOrigin(input.config).replace(/\/+$/, '')
  const requestBody = JSON.stringify(buildChatRequestPayload(input))
  const deadlineAt = Date.now() + REMOTE_REQUEST_TIMEOUT_MS
  for (let index = 0; index < REMOTE_CHAT_ENDPOINTS.length; index += 1) {
    const endpoint = REMOTE_CHAT_ENDPOINTS[index]
    const response = await requestRemoteChatEndpoint(
      input,
      serverOrigin,
      endpoint,
      requestBody,
      deadlineAt
    )
    if (response.ok) {
      return normalizeResponse(await readRemoteResponse(response, () => response.json()))
    }

    // Read once under the existing deadline and release its body/listener/timer.
    // Application continuation failures must reach ChatPage's history-replay
    // recovery, not be replaced by a later legacy endpoint's 404.
    const body = await readRemoteResponse(response, () => response.text())
    const error = Object.assign(
      new Error(buildRemoteLlmServerErrorMessage('chat', response, body)),
      { body, status: response.status }
    )
    if (
      isInvalidSessionContinuationError(error, Boolean(input.sessionUrl?.trim())) ||
      !shouldFallbackRemoteChatEndpoint(response) ||
      index === REMOTE_CHAT_ENDPOINTS.length - 1
    ) {
      throw error
    }
    console.warn(
      `[ChatPage] remote endpoint ${endpoint} returned ${response.status}; trying legacy endpoint.`
    )
  }

  throw new Error('Remote chat request failed')
}

const requestLocalChatCompletion = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  if (input.signal?.aborted) {
    await cancelConversationSilently(input.conversationId)
    throwIfAborted(input.signal)
  }
  throwIfAborted(input.signal)
  const handleAbort = () => {
    void cancelConversationSilently(input.conversationId)
  }
  if (input.signal) {
    input.signal.addEventListener('abort', handleAbort, { once: true })
  }

  try {
    return normalizeResponse(await window.api.svcLLMProxy.chat(buildChatRequestPayload(input)))
  } catch (error) {
    const message = mapLocalChatRequestErrorMessage(
      error instanceof Error ? error.message : String(error)
    )
    if (error instanceof Error && message === error.message) {
      const diagnostic = error as LocalChatRequestError
      if (diagnostic.status !== undefined || diagnostic.body !== undefined) {
        throw createLocalChatRequestError(message, diagnostic.status, diagnostic.body)
      }
      throw error
    }

    if (error instanceof Error) {
      const diagnostic = error as LocalChatRequestError
      throw createLocalChatRequestError(message, diagnostic.status, diagnostic.body)
    }

    throw new Error(message)
  } finally {
    if (input.signal) {
      input.signal.removeEventListener('abort', handleAbort)
    }
  }
}

const toRequestChatCompletionStreamResult = (
  response: Partial<LLMChatStreamResp> & {
    content?: string
    imageUrl?: string
    sessionUrl?: string
    attachments?: ChatAttachment[]
    ocrResult?: OCRResult
    metadata?: Record<string, unknown>
    usage?: Record<string, unknown>
    finishReason?: LLMChatStreamResp['finishReason']
  }
): RequestChatCompletionStreamResult => {
  const normalized = normalizeResponse({
    content: response.content ?? response.fullContent,
    imageUrl: response.imageUrl,
    sessionUrl: response.sessionUrl,
    attachments: response.attachments,
    ocrResult: response.ocrResult,
    finishReason: response.finishReason,
    metadata: response.metadata,
    usage: response.usage
  })

  return {
    result: normalized,
    response: normalized.content
  }
}

const requestLocalChatCompletionStream = async (
  input: RequestChatCompletionStreamInput,
  invoke?: RendererStreamInvoker,
  request?: unknown
): Promise<RequestChatCompletionStreamResult> => {
  if (input.signal?.aborted) {
    await cancelConversationSilently(input.conversationId)
    throwIfAborted(input.signal)
  }
  throwIfAborted(input.signal)

  const [abortSender, abortReceiver] = newAbortHandler()
  let streamActive = true
  let resolveControl: (() => void) | undefined
  let rejectControl: ((reason: unknown) => void) | undefined
  const control = new Promise<void>((resolve, reject) => {
    resolveControl = resolve
    rejectControl = reject
  })
  void control.catch(() => undefined)
  const rejectStream = (reason: unknown): void => {
    streamActive = false
    rejectControl?.(reason)
  }
  const handleAbort = () => {
    const reason = input.signal?.reason
    abortSender.abort()
    void cancelConversationSilently(input.conversationId)
    rejectStream(reason instanceof Error ? reason : createAbortError('The request was aborted.'))
  }
  if (input.signal) {
    input.signal.addEventListener('abort', handleAbort, { once: true })
  }

  let streamedResponse: RequestChatCompletionStreamResult = {
    result: { content: '' },
    response: ''
  }
  let partialContent = ''
  let partialFinishReason: LLMChatStreamResp['finishReason'] | undefined
  let partialMetadata: Record<string, unknown> | undefined
  let receivedTerminalDone = false
  let observedError: LocalChatRequestError | null = null
  let streamDeadlineTimer: number | undefined
  const streamDeadline = new Promise<never>((_resolve, reject) => {
    const timerId = window.setTimeout(() => {
      const timeoutError = createLocalTimeoutError(
        'Local IPC chat stream timed out after 15 minutes.'
      )
      abortSender.abort()
      void cancelConversationSilently(input.conversationId)
      rejectStream(timeoutError)
      reject(timeoutError)
    }, IPC_STREAM_DEADLINE_MS)
    streamDeadlineTimer = timerId
  })
  void streamDeadline.catch(() => undefined)

  try {
    const streamInvoker =
      invoke || (window.api.svcLLMProxy.chatStream as unknown as RendererStreamInvoker)
    const streamRequest = request ?? buildChatRequestPayload(input)
    const streamPromise = streamInvoker(streamRequest, {
      abortReceiver,
      onData: (chunk) => {
        if (!streamActive || input.signal?.aborted) {
          return
        }

        partialMetadata = mergeStreamMetadata(partialMetadata, chunk.metadata)
        partialFinishReason = chunk.finishReason ?? partialFinishReason
        if (chunk.type === 'text-delta' && chunk.delta) {
          partialContent += chunk.delta
          input.onEvent({
            type: 'text-delta',
            delta: chunk.delta
          })
        }

        if (chunk.type === 'attachment' && chunk.attachment) {
          input.onEvent({
            type: 'attachment',
            attachment: chunk.attachment
          })
        }

        if (chunk.type === 'session' && chunk.sessionUrl) {
          input.onEvent({
            type: 'session',
            sessionUrl: chunk.sessionUrl
          })
        }

        if (chunk.type === 'error' && chunk.error) {
          partialFinishReason = chunk.finishReason ?? partialFinishReason
          observedError = createLocalChatRequestError(
            mapLocalChatRequestErrorMessage(chunk.error),
            chunk.status,
            chunk.body
          )
          input.onEvent({
            type: 'error',
            error: chunk.error
          })
        }

        if (chunk.type === 'done') {
          receivedTerminalDone = true
          const terminalContent = chunk.fullContent ?? chunk.content
          if (terminalContent !== undefined) {
            partialContent = terminalContent
          }
          partialFinishReason = chunk.finishReason ?? partialFinishReason
          streamActive = false
          streamedResponse = toRequestChatCompletionStreamResult({
            ...chunk,
            attachments: chunk.attachments ?? streamedResponse.result.attachments,
            sessionUrl: chunk.sessionUrl ?? streamedResponse.result.sessionUrl,
            ocrResult: chunk.ocrResult ?? streamedResponse.result.ocrResult,
            metadata: partialMetadata,
            usage:
              (chunk as { usage?: Record<string, unknown> }).usage ?? streamedResponse.result.usage
          })
          resolveControl?.()
          input.onEvent({ type: 'done' })
          if (chunk.error) {
            const diagnostic = createLocalChatRequestError(
              mapLocalChatRequestErrorMessage(chunk.error),
              chunk.status,
              chunk.body
            )
            observedError = observedError
              ? Object.assign(observedError, {
                  status: diagnostic.status ?? observedError.status,
                  body: diagnostic.body ?? observedError.body
                })
              : diagnostic
          }
        }
      }
    })

    void streamPromise.catch(() => undefined)
    await Promise.race([streamPromise, control, streamDeadline])

    if (input.signal?.aborted) {
      throwIfAborted(input.signal)
    }

    if (!receivedTerminalDone) {
      throw createIncompleteStreamError(partialContent, partialFinishReason, partialMetadata)
    }

    if (observedError) {
      throw observedError
    }

    return streamedResponse
  } catch (error) {
    const diagnostic = attachStreamPartialToError(
      error,
      partialContent,
      partialFinishReason,
      partialMetadata
    )
    const message = mapLocalChatRequestErrorMessage(diagnostic.message)
    if (message !== diagnostic.message) {
      diagnostic.message = message
    }
    throw diagnostic
  } finally {
    if (streamDeadlineTimer !== undefined) {
      window.clearTimeout(streamDeadlineTimer)
      streamDeadlineTimer = undefined
    }
    streamActive = false
    if (input.signal) {
      input.signal.removeEventListener('abort', handleAbort)
    }
  }
}

const buildExternalAgentStreamRequest = (
  input: RequestChatCompletionStreamInput
): LLMExternalAgentStreamReq => {
  const skill = input.externalAgentSkill
  const apiAddress = skill?.apiAddress?.trim()
  if (!skill || skill.type !== 'agent' || !apiAddress) {
    throw new Error('External agent skill routing requires a configured API address.')
  }

  return {
    url: apiAddress,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(skill.apiKey?.trim()
        ? {
            Authorization: `Bearer ${skill.apiKey.trim()}`
          }
        : {})
    },
    body: JSON.stringify(
      buildChatRequestPayload({
        ...input,
        profileId: undefined,
        sessionUrl: undefined,
        stream: true
      })
    ),
    conversationId: input.conversationId
  }
}
const dispatchChatCompletionRequest = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  let result: RequestChatCompletionResult
  if (input.externalAgentSkill?.type === 'agent') {
    result = await requestExternalAgentSkillCompletion(input)
  } else if (input.config.use_remote_llm) {
    result = await requestRemoteChatCompletion(input)
  } else {
    result = await requestLocalChatCompletion(input)
  }

  return applySkillOutputModeContract(result, input.skillRuntime?.execution?.outputMode)
}

const dispatchChatCompletionStreamRequest = async (
  input: RequestChatCompletionStreamInput
): Promise<RequestChatCompletionStreamResult> => {
  if (input.externalAgentSkill?.type === 'agent' && hasExternalAgentStreamTransport()) {
    return requestLocalChatCompletionStream(
      input,
      window.api.svcLLMProxy.externalAgentStream as unknown as RendererStreamInvoker,
      buildExternalAgentStreamRequest(input)
    )
  }

  if (supportsStreamingChatCompletion(input)) {
    return requestLocalChatCompletionStream(input)
  }

  const result = await dispatchChatCompletionRequest({ ...input, stream: false })
  throwIfAborted(input.signal)
  if (result.content) {
    input.onEvent({
      type: 'text-delta',
      delta: result.content
    })
    throwIfAborted(input.signal)
  }
  for (const attachment of result.attachments || []) {
    throwIfAborted(input.signal)
    input.onEvent({
      type: 'attachment',
      attachment
    })
    throwIfAborted(input.signal)
  }
  if (result.sessionUrl) {
    throwIfAborted(input.signal)
    input.onEvent({
      type: 'session',
      sessionUrl: result.sessionUrl
    })
    throwIfAborted(input.signal)
  }
  throwIfAborted(input.signal)
  input.onEvent({ type: 'done' })

  return {
    result,
    response: result.content
  }
}

const ensureReportInlineCapability = async (
  input: RequestChatCompletionInput
): Promise<ReportInlineCapability | null> => {
  if (input.externalAgentSkill?.type === 'agent') {
    return null
  }

  const cachedCapability = readCachedReportInlineCapability(input.profileId, input.remoteProfile)
  if (cachedCapability) {
    return cachedCapability
  }

  const fallbackCapability: ReportInlineCapability = {
    maxInlineChars: buildFallbackReportInlineChars(input),
    source: 'fallback'
  }

  try {
    const probeResult = await dispatchChatCompletionRequest({
      ...input,
      messages: [{ role: 'user', content: REPORT_INLINE_CAPABILITY_PROBE }],
      systemPrompt: undefined,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: false
    })
    const reportedChars = parseReportedInlineChars(probeResult.content)
    if (!reportedChars) {
      writeCachedReportInlineCapability(input.profileId, input.remoteProfile, fallbackCapability)
      return fallbackCapability
    }

    const probedCapability: ReportInlineCapability = {
      maxInlineChars: reportedChars,
      source: 'probe'
    }
    writeCachedReportInlineCapability(input.profileId, input.remoteProfile, probedCapability)
    return probedCapability
  } catch (error) {
    console.warn('[ChatPage] Failed to probe report inline capability:', error)
    writeCachedReportInlineCapability(input.profileId, input.remoteProfile, fallbackCapability)
    return fallbackCapability
  }
}

export const resolveAttachmentBatchCapability = async (
  input: ResolveAttachmentBatchCapabilityInput
): Promise<number> => {
  validateCustomSkillForSend(input.externalAgentSkill)

  const cachedCapability = readCachedAttachmentBatchCapability(input)
  if (cachedCapability) {
    return cachedCapability.maxAttachments
  }

  const fallbackCapability: AttachmentBatchCapability = {
    maxAttachments: DEFAULT_ATTACHMENT_BATCH_CAPABILITY,
    source: 'fallback'
  }

  try {
    const probeResult = await dispatchChatCompletionRequest({
      config: input.config,
      messages: [{ role: 'user', content: ATTACHMENT_BATCH_CAPABILITY_PROBE }],
      profileId: input.profileId,
      remoteProfile: input.remoteProfile,
      apiMode: input.apiMode,
      systemPrompt: undefined,
      externalAgentSkill: input.externalAgentSkill,
      sessionUrl: undefined,
      conversationId: undefined,
      isEdit: false
    })
    const reportedCapability = parseReportedAttachmentBatchCapability(probeResult.content)
    if (!reportedCapability) {
      writeCachedAttachmentBatchCapability(input, fallbackCapability)
      return fallbackCapability.maxAttachments
    }

    const probedCapability: AttachmentBatchCapability = {
      maxAttachments: reportedCapability,
      source: 'probe'
    }
    writeCachedAttachmentBatchCapability(input, probedCapability)
    return probedCapability.maxAttachments
  } catch (error) {
    console.warn('[ChatPage] Failed to probe attachment batch capability:', error)
    writeCachedAttachmentBatchCapability(input, fallbackCapability)
    return fallbackCapability.maxAttachments
  }
}

export const resolveAttachmentRequestCapabilities = (
  config: Config,
  profileId?: string | null,
  apiMode?: LLMOpenAIApiMode,
  remoteProfile?: RemoteRequestProfile | null
): {
  allowManagedRequestDataUrl: boolean
  allowRequestDataUrl: boolean
  allowAccessibleUrl: boolean
  preserveRemoteUrl: boolean
} => {
  const profile = resolveSelectedRequestProfile({ config, profileId, remoteProfile })
  const effectiveApiMode =
    (config.use_remote_llm ? resolveRemoteOpenAIRequestMode(profile, apiMode) : undefined) ??
    apiMode ??
    profile?.api_mode
  const maxInputImages =
    profile?.max_input_images ??
    profile?.maxInputImages ??
    profile?.max_images ??
    profile?.maxImages
  const capabilities = resolveChatProfileCapabilities({
    ...profile,
    ...(maxInputImages !== undefined ? { max_input_images: maxInputImages } : {})
  })
  const gptImageProfile = isGPTImageProfile(profile, effectiveApiMode)
  const requestDataUrlTransport = selectProviderAttachmentTransport(capabilities, {
    available: { 'request-data-url': true },
    requested: 'request-data-url'
  })
  const accessibleUrlTransport = selectProviderAttachmentTransport(capabilities, {
    available: { 'accessible-url': true },
    requested: 'accessible-url'
  })
  return {
    allowManagedRequestDataUrl: requestDataUrlTransport === 'request-data-url' || gptImageProfile,
    allowRequestDataUrl: requestDataUrlTransport === 'request-data-url' || gptImageProfile,
    allowAccessibleUrl: accessibleUrlTransport === 'accessible-url',
    preserveRemoteUrl: gptImageProfile
  }
}

const resolveManagedMediaRequestOptions = (input: RequestChatCompletionInput) => {
  return {
    managedMediaService: (api() as unknown as { svcManagedMedia?: ManagedMediaSvc })
      .svcManagedMedia,
    ...resolveAttachmentRequestCapabilities(
      input.config,
      input.profileId,
      input.apiMode,
      input.remoteProfile
    )
  }
}

const resolveRemoteResponsesImagePolicy = (
  input: RequestChatCompletionInput,
  profile: RemoteRequestProfile | undefined
): boolean | undefined => {
  if (
    profile &&
    ((profile.call_type && profile.call_type !== 'api') ||
      (profile.auth_mode && profile.auth_mode !== 'api_key'))
  ) {
    // Extension-owned protocols must publish their own policy contract.
    return false
  }
  const resolvedRemoteMode = resolveRemoteOpenAIRequestMode(profile, input.apiMode)
  if (resolvedRemoteMode) return resolvedRemoteMode === 'responses'
  const provider = profile && resolveProfileProvider(profile)
  if (provider && provider !== 'openai') return false
  const mode = input.apiMode ?? profile?.api_mode
  if (profile?.base_url?.trim()) return usesOpenAIResponsesImagePolicy(profile, input.apiMode)
  if (mode && mode !== 'auto') return mode === 'responses'
  return undefined
}

const countProviderBoundImages = (messages: readonly ChatMessage[]): number => {
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

const preflightRequestImageCount = (
  input: RequestChatCompletionInput,
  profile: RemoteRequestProfile | undefined
): number | undefined => {
  if (input.externalAgentSkill?.type === 'agent') return undefined
  const selectedMessages = selectMessagesForImageHistoryPolicy(
    input.messages,
    input.imageHistoryPolicy
  )
  const latestUserIndex = input.messages.findLastIndex((message) => message.role === 'user')
  const selectedUserMessages = selectedMessages.filter(
    (message) =>
      message.role === 'user' &&
      (input.imageHistoryPolicy === 'all' || input.messages.indexOf(message) === latestUserIndex)
  )
  const hasSelectedImages = selectedMessages.some(
    (message) =>
      message.role !== 'system' &&
      message.attachments?.some((attachment) => attachment.type === 'image')
  )
  const knownImageCount = countProviderBoundImages(selectedMessages)
  const hasSelectedReportBundle = selectedUserMessages.some((message) =>
    message.attachments?.some((attachment) => attachment.reportBundleRole === 'primary-report')
  )
  const usesResponses = input.config.use_remote_llm
    ? resolveRemoteResponsesImagePolicy(input, profile)
    : profile && usesOpenAIResponsesImagePolicy(profile, input.apiMode)
  if (
    input.config.use_remote_llm &&
    (hasSelectedImages || hasSelectedReportBundle) &&
    usesResponses === undefined
  ) {
    throw new Error(
      'Remote image routing metadata is unavailable. Refresh the remote profiles before sending images.'
    )
  }
  const hasKnownImages = hasSelectedImages || knownImageCount > 0
  if (!hasKnownImages && !hasSelectedReportBundle) return undefined
  if (usesResponses !== true) return undefined
  const maxInputImages =
    profile?.max_input_images ??
    profile?.maxInputImages ??
    profile?.max_images ??
    profile?.maxImages
  const capabilities = resolveChatProfileCapabilities({
    ...profile,
    ...(maxInputImages !== undefined ? { max_input_images: maxInputImages } : {})
  })
  const maxImages = capabilities.maxInputImages ?? DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY.maxImages
  if (maxImages === undefined) return undefined
  if (maxImages !== undefined && knownImageCount > maxImages) {
    throw new Error(`Too many images; the limit is ${maxImages}.`)
  }
  return maxImages
}

// Pure descriptor-only guard for UI planning before blob persistence or resource reads.
// Request entrypoints still recheck their final selected/expanded attachments.
export const preflightChatRequestImages = (
  input: Pick<
    RequestChatCompletionInput,
    | 'config'
    | 'messages'
    | 'profileId'
    | 'remoteProfile'
    | 'externalAgentSkill'
    | 'imageHistoryPolicy'
    | 'apiMode'
  >
): number | undefined => {
  validateCustomSkillForSend(input.externalAgentSkill)
  return preflightRequestImageCount(input, resolveSelectedRequestProfile(input))
}

export const requestChatCompletion = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  validateCustomSkillForSend(input.externalAgentSkill)
  const requestInput = projectRequestInputForTransport(input)
  const profile = resolveSelectedRequestProfile(requestInput)
  const maxImages = preflightRequestImageCount(requestInput, profile)
  const preflightMessages = await expandMessagesForImagePreflight(
    requestInput.messages,
    requestInput.imageHistoryPolicy,
    maxImages
  )

  const useNativeOpenAIFileSearch = supportsNativeOpenAIFileSearch(profile)
  const reportInlineCapability =
    !useNativeOpenAIFileSearch && hasPrimaryReportBundleInMessages(requestInput.messages)
      ? await ensureReportInlineCapability(requestInput)
      : null
  const skipAttachmentContentAugmentation =
    getBaseProfileId(requestInput.profileId) === HUNYUAN_3D_PROFILE_ID
  const requestMessages = await prepareMessagesForRequest(preflightMessages, {
    reportBundlesExpanded: maxImages !== undefined,
    reportInlineCharLimit: reportInlineCapability?.maxInlineChars,
    skipAttachmentContentAugmentation,
    ...resolveManagedMediaRequestOptions(requestInput),
    imageHistoryPolicy: requestInput.imageHistoryPolicy,
    skipInlineAttachmentSummary: (attachment) =>
      shouldSkipInlineAttachmentSummary(profile, attachment)
  })

  return dispatchChatCompletionRequest({
    ...requestInput,
    messages: requestMessages
  })
}

export const requestChatCompletionStream = async (
  input: RequestChatCompletionStreamInput
): Promise<RequestChatCompletionStreamResult> => {
  validateCustomSkillForSend(input.externalAgentSkill)
  const requestInput = projectRequestInputForTransport(input)
  const profile = resolveSelectedRequestProfile(requestInput)
  const maxImages = preflightRequestImageCount(requestInput, profile)
  const preflightMessages = await expandMessagesForImagePreflight(
    requestInput.messages,
    requestInput.imageHistoryPolicy,
    maxImages
  )

  const useNativeOpenAIFileSearch = supportsNativeOpenAIFileSearch(profile)
  const reportInlineCapability =
    !useNativeOpenAIFileSearch && hasPrimaryReportBundleInMessages(requestInput.messages)
      ? await ensureReportInlineCapability(requestInput)
      : null
  const skipAttachmentContentAugmentation =
    getBaseProfileId(requestInput.profileId) === HUNYUAN_3D_PROFILE_ID
  const requestMessages = await prepareMessagesForRequest(preflightMessages, {
    reportBundlesExpanded: maxImages !== undefined,
    reportInlineCharLimit: reportInlineCapability?.maxInlineChars,
    skipAttachmentContentAugmentation,
    ...resolveManagedMediaRequestOptions(requestInput),
    imageHistoryPolicy: requestInput.imageHistoryPolicy,
    skipInlineAttachmentSummary: (attachment) =>
      shouldSkipInlineAttachmentSummary(profile, attachment)
  })

  const result = await dispatchChatCompletionStreamRequest({
    ...requestInput,
    messages: requestMessages
  })

  const normalizedResult = applySkillOutputModeContract(
    result.result,
    requestInput.skillRuntime?.execution?.outputMode
  )

  return {
    result: normalizedResult,
    response: normalizedResult.content
  }
}
