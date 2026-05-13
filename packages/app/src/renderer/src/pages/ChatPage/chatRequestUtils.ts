import type { Config, CustomSkill } from '@shared/config/config'
import type { LLMChatSkillRuntime, LLMChatStreamResp, OCRResult } from '@shared/api/svcLLMProxy'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { AgentRouteLike } from '@shared/agent'
import {
  isOpenAIFileSearchAttachment,
  normalizeOpenAIBaseUrl,
  resolveProfileDeployment,
  resolveProfileProvider,
  type LLMReasoningEffort,
  type OpenAIImageGenerationOptions
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
import {
  applySkillOutputModeContract,
  resolveSkillOutputImageGenerationOptions
} from './chatSkillOutputMode'

type ChatRequestPayload = {
  messages: Array<{
    role: ChatMessage['role']
    content: string
    attachments?: ChatAttachment[]
  }>
  route?: AgentRouteLike
  profileId?: string
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  imageGenerationOptions?: OpenAIImageGenerationOptions
  skillRuntime?: LLMChatSkillRuntime
  sessionUrl?: string
  conversationId?: string
  isEdit?: boolean
}

type RequestChatCompletionInput = {
  config: Config
  messages: ChatMessage[]
  route?: AgentRouteLike
  storageScope?: string
  profileId?: string | null
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  imageGenerationOptions?: OpenAIImageGenerationOptions
  skillRuntime?: LLMChatSkillRuntime
  externalAgentSkill?: CustomSkill | null
  sessionUrl?: string
  conversationId?: string
  isEdit?: boolean
  signal?: AbortSignal
}

type RequestChatCompletionResult = {
  content: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
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

export type RequestChatCompletionStreamResult = {
  result: RequestChatCompletionResult
  response: string
}

const createAbortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return

  const reason = signal.reason
  if (reason instanceof Error) {
    throw reason
  }

  throw createAbortError(typeof reason === 'string' ? reason : 'The request was aborted.')
}

const RESPONSES_SCOPE_ERROR_FRAGMENT = 'Missing scopes: api.responses.write'
const RESPONSES_SCOPE_ERROR_MESSAGE =
  'The current OpenAI account is missing the required Responses permission (`api.responses.write`). Check the configured account or workspace, then try again.'

const mapLocalChatRequestErrorMessage = (message: string): string => {
  const normalized = message.trim()
  if (/\b401\b/.test(normalized) && normalized.includes(RESPONSES_SCOPE_ERROR_FRAGMENT)) {
    return RESPONSES_SCOPE_ERROR_MESSAGE
  }

  return normalized
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'))
    reader.readAsDataURL(blob)
  })

const normalizeImageAttachmentForRequest = async (
  attachment: ChatAttachment
): Promise<ChatAttachment> => {
  if (attachment.type !== 'image' || !attachment.url || attachment.url.startsWith('data:')) {
    return attachment
  }

  try {
    const response = await fetch(normalizeLocalMediaUrl(attachment.url))
    if (!response.ok) {
      throw new Error(`Failed to load image attachment (${response.status})`)
    }

    const blob = await response.blob()
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
    console.warn(
      '[ChatPage] Failed to normalize image attachment for request:',
      attachment.fileName || attachment.url,
      error
    )
    return attachment
  }
}

const normalizeFileAttachmentForRequest = async (
  attachment: ChatAttachment
): Promise<ChatAttachment> => {
  if (
    attachment.type !== 'file' ||
    !attachment.url ||
    attachment.url.startsWith('data:') ||
    !normalizeLocalMediaUrl(attachment.url).startsWith('local-media://')
  ) {
    return attachment
  }

  try {
    const response = await fetch(normalizeLocalMediaUrl(attachment.url))
    if (!response.ok) {
      throw new Error(`Failed to load file attachment (${response.status})`)
    }

    const blob = await response.blob()
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
    console.warn(
      '[ChatPage] Failed to normalize file attachment for request:',
      attachment.fileName || attachment.url,
      error
    )
    return attachment
  }
}

export const normalizeChatAttachmentsForRequest = async (
  attachments: ChatAttachment[] | undefined
): Promise<ChatAttachment[] | undefined> => {
  if (!attachments?.length) {
    return undefined
  }

  return Promise.all(
    attachments.map((attachment) =>
      attachment.type === 'image'
        ? normalizeImageAttachmentForRequest(attachment)
        : attachment.type === 'file'
          ? normalizeFileAttachmentForRequest(attachment)
          : Promise.resolve(attachment)
    )
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
  'config' | 'profileId' | 'systemPrompt' | 'externalAgentSkill'
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

  return config.llm_config.api_profiles.find((profile) => profile.id === baseProfileId)
}

const supportsNativeOpenAIFileSearch = (config: Config, profileId?: string | null): boolean => {
  const profile = resolveRequestProfile(config, profileId)
  if (!profile) {
    return false
  }

  return (
    resolveProfileProvider(profile) === 'openai' &&
    resolveProfileDeployment(profile) === 'cloud' &&
    isOfficialOpenAIBaseUrl(profile.base_url)
  )
}

export const supportsStreamingChatCompletion = (
  input: Pick<RequestChatCompletionInput, 'config' | 'profileId' | 'externalAgentSkill'>
): boolean => {
  if (input.config.use_remote_llm || input.externalAgentSkill?.type === 'agent') {
    return false
  }

  return false
}

const shouldSkipInlineAttachmentSummary = (
  config: Config,
  profileId: string | null | undefined,
  attachment: ChatAttachment
): boolean =>
  supportsNativeOpenAIFileSearch(config, profileId) && isOpenAIFileSearchAttachment(attachment)

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

const MAX_REMOTE_RETRIES = 3
const REMOTE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const RETRY_DELAY_MS = 2000
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

const buildChatRequestPayload = (input: RequestChatCompletionInput): ChatRequestPayload => {
  const resolvedSystemPrompt =
    input.externalAgentSkill?.type === 'agent'
      ? input.externalAgentSkill.prompt?.trim() || input.systemPrompt?.trim() || undefined
      : input.systemPrompt?.trim() || input.externalAgentSkill?.prompt?.trim() || undefined
  const requestImageGenerationOptions = resolveSkillOutputImageGenerationOptions(
    input.skillRuntime?.execution?.outputMode,
    input.imageGenerationOptions
  )

  return {
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      attachments: message.attachments
    })),
    ...(input.route ? { route: input.route } : {}),
    profileId: input.profileId || undefined,
    systemPrompt: resolvedSystemPrompt,
    ...(input.reasoningEffort && input.externalAgentSkill?.type !== 'agent'
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    ...(requestImageGenerationOptions && input.externalAgentSkill?.type !== 'agent'
      ? { imageGenerationOptions: requestImageGenerationOptions }
      : {}),
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

const getReportInlineCapabilityStorageKey = (profileId?: string | null): string =>
  `${REPORT_INLINE_CAPABILITY_STORAGE_PREFIX}${getBaseProfileId(profileId) || 'default'}`

const getAttachmentBatchCapabilityStorageKey = (
  input: ResolveAttachmentBatchCapabilityInput
): string => {
  const skillKey =
    input.externalAgentSkill?.type === 'agent' ? `agent:${input.externalAgentSkill.id}` : null

  return `${ATTACHMENT_BATCH_CAPABILITY_STORAGE_PREFIX}${
    skillKey || getBaseProfileId(input.profileId) || 'default'
  }`
}

const readCachedReportInlineCapability = (
  profileId?: string | null
): ReportInlineCapability | null => {
  try {
    const raw = localStorage.getItem(getReportInlineCapabilityStorageKey(profileId))
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
  capability: ReportInlineCapability
): void => {
  try {
    localStorage.setItem(
      getReportInlineCapabilityStorageKey(profileId),
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
  const baseProfileId = getBaseProfileId(input.profileId)
  const profile = baseProfileId
    ? input.config.llm_config.api_profiles.find((candidate) => candidate.id === baseProfileId)
    : undefined

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

const prepareMessagesForRequest = async (
  messages: ChatMessage[],
  options: {
    reportInlineCharLimit?: number
    skipAttachmentContentAugmentation?: boolean
    skipInlineAttachmentSummary?: (attachment: ChatAttachment) => boolean
  } = {}
): Promise<ChatMessage[]> => {
  const prepared: ChatMessage[] = []

  for (const message of messages) {
    const attachments =
      message.role === 'user'
        ? await expandReportBundleAttachments(message.attachments)
        : message.attachments
    const normalizedAttachments = await normalizeChatAttachmentsForRequest(attachments)
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

const normalizeResponse = (response: {
  content?: string
  imageUrl?: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
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
  const normalized: RequestChatCompletionResult = {
    content: response.content || '',
    sessionUrl: response.sessionUrl,
    attachments
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
} => {
  try {
    return JSON.parse(body) as {
      content?: string
      imageUrl?: string
      sessionUrl?: string
      attachments?: ChatAttachment[]
      ocrResult?: OCRResult
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
    const response = await window.api.svcLLMProxy.remoteFetch({
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
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `External agent skill request failed (${response.status} ${response.statusText}): ${response.body}`
      )
    }

    return normalizeResponse(parseExternalAgentSkillResponse(response.body))
  } finally {
    if (input.signal) {
      input.signal.removeEventListener('abort', handleAbort)
    }
  }
}

const requestRemoteChatCompletion = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  const serverOrigin = getRemoteLlmServerOrigin(input.config).replace(/\/+$/, '')
  const requestBody = JSON.stringify(buildChatRequestPayload(input))
  let lastError: Error | null = null
  let response: Response | null = null

  for (let attempt = 1; attempt <= MAX_REMOTE_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const handleAbort = () => {
      controller.abort(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : createAbortError('The request was aborted.')
      )
    }
    if (input.signal?.aborted) {
      handleAbort()
    } else if (input.signal) {
      input.signal.addEventListener('abort', handleAbort, { once: true })
    }
    const timeoutId = window.setTimeout(
      () => controller.abort(createAbortError('Remote chat request timed out.')),
      REMOTE_REQUEST_TIMEOUT_MS
    )

    try {
      throwIfAborted(input.signal)
      response = await fetch(`${serverOrigin}/api/chat`, {
        method: 'POST',
        headers: buildRemoteLlmServerHeaders(input.config, { 'Content-Type': 'application/json' }),
        signal: controller.signal,
        body: requestBody
      })
      lastError = null
      break
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (input.signal?.aborted) {
        throwIfAborted(input.signal)
        throw lastError
      }
      console.warn(
        `[ChatPage] remote request failed (${attempt}/${MAX_REMOTE_RETRIES}):`,
        lastError.message
      )

      if (attempt < MAX_REMOTE_RETRIES) {
        await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS))
      }
    } finally {
      if (input.signal) {
        input.signal.removeEventListener('abort', handleAbort)
      }
      window.clearTimeout(timeoutId)
    }
  }

  if (lastError || !response) {
    throw lastError || new Error('Remote chat request failed')
  }

  if (!response.ok) {
    throw new Error(buildRemoteLlmServerErrorMessage('chat', response, await response.text()))
  }

  return normalizeResponse(await response.json())
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
      throw error
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
  }
): RequestChatCompletionStreamResult => {
  const normalized = normalizeResponse({
    content: response.content ?? response.fullContent,
    imageUrl: response.imageUrl,
    sessionUrl: response.sessionUrl,
    attachments: response.attachments,
    ocrResult: response.ocrResult
  })

  return {
    result: normalized,
    response: normalized.content
  }
}

const requestLocalChatCompletionStream = async (
  input: RequestChatCompletionStreamInput
): Promise<RequestChatCompletionStreamResult> => {
  if (input.signal?.aborted) {
    await cancelConversationSilently(input.conversationId)
    throwIfAborted(input.signal)
  }
  throwIfAborted(input.signal)

  const [abortSender, abortReceiver] = newAbortHandler()
  const handleAbort = () => {
    abortSender.abort()
    void cancelConversationSilently(input.conversationId)
  }
  if (input.signal) {
    input.signal.addEventListener('abort', handleAbort, { once: true })
  }

  let streamedResponse: RequestChatCompletionStreamResult = {
    result: { content: '' },
    response: ''
  }
  let observedError: string | null = null

  try {
    await window.api.svcLLMProxy.chatStream(buildChatRequestPayload(input), {
      abortReceiver,
      onData: (chunk) => {
        if (input.signal?.aborted) {
          return
        }

        if (chunk.type === 'text-delta' && chunk.delta) {
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
          observedError = chunk.error
          input.onEvent({
            type: 'error',
            error: chunk.error
          })
        }

        if (chunk.type === 'done') {
          streamedResponse = toRequestChatCompletionStreamResult({
            ...chunk,
            attachments: chunk.attachments ?? streamedResponse.result.attachments,
            sessionUrl: chunk.sessionUrl ?? streamedResponse.result.sessionUrl,
            ocrResult: chunk.ocrResult ?? streamedResponse.result.ocrResult
          })
          input.onEvent({ type: 'done' })
          if (chunk.error) {
            observedError = chunk.error
          }
        }
      }
    })

    if (input.signal?.aborted) {
      throwIfAborted(input.signal)
    }

    if (observedError) {
      throw new Error(mapLocalChatRequestErrorMessage(observedError))
    }

    return streamedResponse
  } catch (error) {
    const message = mapLocalChatRequestErrorMessage(
      error instanceof Error ? error.message : String(error)
    )
    if (error instanceof Error && message === error.message) {
      throw error
    }

    throw new Error(message)
  } finally {
    if (input.signal) {
      input.signal.removeEventListener('abort', handleAbort)
    }
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
  if (supportsStreamingChatCompletion(input)) {
    return requestLocalChatCompletionStream(input)
  }

  const result = await dispatchChatCompletionRequest(input)
  if (result.content) {
    input.onEvent({
      type: 'text-delta',
      delta: result.content
    })
  }
  for (const attachment of result.attachments || []) {
    input.onEvent({
      type: 'attachment',
      attachment
    })
  }
  if (result.sessionUrl) {
    input.onEvent({
      type: 'session',
      sessionUrl: result.sessionUrl
    })
  }
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

  const cachedCapability = readCachedReportInlineCapability(input.profileId)
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
      writeCachedReportInlineCapability(input.profileId, fallbackCapability)
      return fallbackCapability
    }

    const probedCapability: ReportInlineCapability = {
      maxInlineChars: reportedChars,
      source: 'probe'
    }
    writeCachedReportInlineCapability(input.profileId, probedCapability)
    return probedCapability
  } catch (error) {
    console.warn('[ChatPage] Failed to probe report inline capability:', error)
    writeCachedReportInlineCapability(input.profileId, fallbackCapability)
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

export const requestChatCompletion = async (
  input: RequestChatCompletionInput
): Promise<RequestChatCompletionResult> => {
  validateCustomSkillForSend(input.externalAgentSkill)

  const useNativeOpenAIFileSearch = supportsNativeOpenAIFileSearch(input.config, input.profileId)
  const reportInlineCapability =
    !useNativeOpenAIFileSearch && hasPrimaryReportBundleInMessages(input.messages)
      ? await ensureReportInlineCapability(input)
      : null
  const skipAttachmentContentAugmentation =
    getBaseProfileId(input.profileId) === HUNYUAN_3D_PROFILE_ID
  const requestMessages = await prepareMessagesForRequest(input.messages, {
    reportInlineCharLimit: reportInlineCapability?.maxInlineChars,
    skipAttachmentContentAugmentation,
    skipInlineAttachmentSummary: (attachment) =>
      shouldSkipInlineAttachmentSummary(input.config, input.profileId, attachment)
  })

  return dispatchChatCompletionRequest({
    ...input,
    messages: requestMessages
  })
}

export const requestChatCompletionStream = async (
  input: RequestChatCompletionStreamInput
): Promise<RequestChatCompletionStreamResult> => {
  validateCustomSkillForSend(input.externalAgentSkill)

  const useNativeOpenAIFileSearch = supportsNativeOpenAIFileSearch(input.config, input.profileId)
  const reportInlineCapability =
    !useNativeOpenAIFileSearch && hasPrimaryReportBundleInMessages(input.messages)
      ? await ensureReportInlineCapability(input)
      : null
  const skipAttachmentContentAugmentation =
    getBaseProfileId(input.profileId) === HUNYUAN_3D_PROFILE_ID
  const requestMessages = await prepareMessagesForRequest(input.messages, {
    reportInlineCharLimit: reportInlineCapability?.maxInlineChars,
    skipAttachmentContentAugmentation,
    skipInlineAttachmentSummary: (attachment) =>
      shouldSkipInlineAttachmentSummary(input.config, input.profileId, attachment)
  })

  const result = await dispatchChatCompletionStreamRequest({
    ...input,
    messages: requestMessages
  })

  const normalizedResult = applySkillOutputModeContract(
    result.result,
    input.skillRuntime?.execution?.outputMode
  )

  return {
    result: normalizedResult,
    response: normalizedResult.content
  }
}
