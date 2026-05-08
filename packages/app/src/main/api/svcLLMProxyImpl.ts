// Main-process LLM proxy service used by chat, OCR, skill routing, and local model integrations.
// This file centralizes provider selection and media-aware request handling.

import { net } from 'electron'
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
  ChatMessage,
  ChatAttachment
} from '@shared/api/svcLLMProxy'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { getConfig } from '../config/config'
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
  resolveProfileDeployment,
  resolveProfileProvider,
  resolveProfileModelUse,
  resolveTaggerProviderDescriptor,
  resolveTaggerRuntimeDescriptor,
  isTaggerSkillRuntime,
  getTaggerProviderDisplayLabel,
  type LLMChatResult,
  type LLMDeltaEvent
} from '@shared/llm'
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
// Browser automation snapshots may arrive through file URLs; normalize them before downstream handling.

const decodeHy3dProfileSegment = (value?: string): string => {
  if (!value) return ''

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const isMockFetchFunction = (value: unknown): value is FetchImpl =>
  typeof value === 'function' && 'mock' in (value as unknown as { mock?: unknown })

const DEFAULT_HY3D_API_REGION = 'ap-guangzhou'

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

const createMainProcessElectronFetch = (): FetchImpl | null => {
  const electronFetch = getElectronNetFetch()
  if (!electronFetch) {
    return null
  }

  return ((input: RequestInfo | URL, init?: RequestInit) =>
    electronFetch(
      input instanceof URL ? input.toString() : (input as unknown as string | Request),
      init as Parameters<typeof electronFetch>[1]
    )) as FetchImpl
}

// ==================== Chat execution helpers ====================

type ChatExecutionOptions = LLMChatOptions & {
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

const toLLMChatResp = (value: string | LLMChatResult): LLMChatResp => {
  const normalized = normalizeLLMChatResult(value)
  const structuredContent = parseStructuredLLMChatResult(normalized.content)
  const attachments = dedupeChatAttachments([
    ...(structuredContent?.attachments || []),
    ...(normalized.attachments || [])
  ])
  const metadata = mergeChatMetadata(structuredContent?.metadata, normalized.metadata)

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
    ...(metadata ? { metadata } : {})
  }
}

// ==================== 服务实现 ====================

const parseStructuredChatResponse = (content: string): LLMChatResp | null => {
  const parsed = parseStructuredLLMChatResult(content)
  return parsed ? toLLMChatResp(parsed) : null
}

const normalizeConfiguredSecret = (value?: string): string => String(value || '').trim()

const extractTencentTraceSuffix = (message: string): string => {
  const requestIdMatch = message.match(/requestId[:=]\s*([^\s]+)/i)
  const traceIdMatch = message.match(/traceId[:=]\s*([^\s]+)/i)
  const parts = [
    requestIdMatch ? `requestId:${requestIdMatch[1]}` : '',
    traceIdMatch ? `traceId:${traceIdMatch[1]}` : ''
  ].filter(Boolean)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

type Hunyuan3DErrorContext = {
  mode?: string
  sourceFileName?: string
}

const isHunyuanGenericServiceFailure = (message: string): boolean =>
  /(?:\[Hunyuan3D\]\s*)?(?:Job failed:\s*)?(?:FailedOperation\.)?InnerError|InternalServerError|ServiceUnavailable|An internal error has occurred|Retry your request/i.test(
    message
  )

const buildHunyuanUvGlbHint = (context?: Hunyuan3DErrorContext): string => {
  if (context?.mode !== 'SubmitHunyuanTo3DUVJob') {
    return ''
  }

  const sourceFileName = String(context.sourceFileName || '')
    .trim()
    .toLowerCase()
  if (!sourceFileName.endsWith('.glb')) {
    return ''
  }

  return ' Current input is GLB; if UV unwrap keeps failing, convert it to FBX first and retry UV unwrap.'
}

const buildHunyuanGenericFailureMessage = (traceSuffix: string, uvGlbHint: string): string =>
  `[Hunyuan3D] Tencent 3D service is temporarily unavailable and the job failed. Please retry later.${uvGlbHint}${traceSuffix}`.trim()

const normalizeHunyuan3DError = (error: unknown, context?: Hunyuan3DErrorContext): Error => {
  const fallback =
    error instanceof Error
      ? error
      : new Error(typeof error === 'object' ? JSON.stringify(error) : String(error))
  const message = fallback.message || ''
  const traceSuffix = extractTencentTraceSuffix(message)
  const uvGlbHint = buildHunyuanUvGlbHint(context)

  if (message.startsWith('[Hunyuan3D]') && !isHunyuanGenericServiceFailure(message)) {
    return fallback
  }

  if (isHunyuanGenericServiceFailure(message)) {
    return new Error(buildHunyuanGenericFailureMessage(traceSuffix, uvGlbHint))
  }

  if (
    /AuthFailure\.SecretIdNotFound|The SecretId is not found|InvalidAccessKeyId|Access Key Id you provided does not exist in our records/i.test(
      message
    )
  ) {
    return new Error(
      `[Hunyuan3D] The configured Tencent Cloud SecretId is invalid or has expired. Check the current SecretId/SecretKey pair and retry.${traceSuffix}`.trim()
    )
  }

  if (
    /AuthFailure\.SignatureFailure|The SecretKey is not found|SignatureDoesNotMatch|The request signature we calculated does not match|signature/i.test(
      message
    )
  ) {
    return new Error(
      `[Hunyuan3D] The configured Tencent Cloud SecretKey is invalid or does not match the SecretId. Check the current SecretId/SecretKey pair and retry.${traceSuffix}`.trim()
    )
  }

  if (
    /TencentCloudSDKException|An internal error has occurred|InternalError|InternalServerError|ServiceUnavailable|Retry your request/i.test(
      message
    )
  ) {
    return new Error(buildHunyuanGenericFailureMessage(traceSuffix, uvGlbHint))
  }

  return fallback
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

const MAX_SKILL_RUNTIME_TOOL_CALLS = 4

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeRequestedToolArgs = (value: unknown): Record<string, unknown> => {
  if (isPlainRecord(value)) {
    return value
  }

  if (value === undefined || value === null) {
    return {}
  }

  return {
    input: value
  }
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
    'Do not wrap the JSON in Markdown fences.',
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

const parseRequestedToolInvocation = (
  content: string,
  allowedToolNames?: ReadonlySet<string>
): RequestedToolInvocation | null => {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainRecord(parsed) || typeof parsed.toolName !== 'string' || !parsed.toolName.trim()) {
      return null
    }

    const keys = Object.keys(parsed)
    if (keys.some((key) => key !== 'toolName' && key !== 'args')) {
      return null
    }

    const toolName = parsed.toolName.trim()
    if (allowedToolNames && !allowedToolNames.has(toolName)) {
      return null
    }

    return {
      toolName,
      args: normalizeRequestedToolArgs(parsed.args)
    }
  } catch {
    return null
  }
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

  private getFetchImpl(): FetchImpl {
    if (isMockFetchFunction(globalThis.fetch)) {
      return globalThis.fetch.bind(globalThis) as FetchImpl
    }

    const electronFetch = createMainProcessElectronFetch()
    if (electronFetch) {
      return electronFetch
    }

    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis) as FetchImpl
    }

    throw new Error('Fetch API is unavailable in the main process runtime.')
  }

  private createConversationAbortContext(
    conversationId?: string,
    signal?: AbortSignal
  ): {
    signal?: AbortSignal
    cleanup: () => void
  } {
    if (!conversationId) {
      return {
        signal,
        cleanup: () => undefined
      }
    }

    const controller = new AbortController()
    this.conversationAbortControllers.set(conversationId, controller)

    const handleAbort = () => {
      if (controller.signal.aborted) return

      if (signal?.reason instanceof Error) {
        controller.abort(signal.reason)
        return
      }

      controller.abort(
        createAbortError(
          typeof signal?.reason === 'string' ? signal.reason : 'The request was aborted.'
        )
      )
    }

    if (signal?.aborted) {
      handleAbort()
    } else if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true })
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        if (signal) {
          signal.removeEventListener('abort', handleAbort)
        }
        const current = this.conversationAbortControllers.get(conversationId)
        if (current === controller) {
          this.conversationAbortControllers.delete(conversationId)
        }
      }
    }
  }
  // Keep per-endpoint round-robin counters stable across requests so load-balanced profile selection stays deterministic.
  private static loadBalancingCounters: Map<string, number> = new Map()

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

  chat = async (req: LLMChatReq, options?: LLMChatOptions): Promise<LLMChatResp> => {
    const abortContext = this.createConversationAbortContext(req.conversationId, options?.signal)
    console.log('[LLMProxy] received chat request at top-level handler', {
      profileId: req.profileId,
      sessionUrl: req.sessionUrl,
      messageCount: req.messages.length,
      conversationId: req.conversationId
    })

    try {
      // Standard API chat remains the fallback path after specialized handlers decline the request.
      console.log('[LLMProxy] routing request through the standard API path')
      return await this.chatViaAPI(req, {
        ...options,
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
    const config = getConfig()
    const requestedProfileId = req.profileId

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
      sourceFileName
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
      const decodedSourceFileName = decodeHy3dProfileSegment(sourceFileName) || undefined
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
      : validProfiles[0]
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
      profile = validProfiles[0]
    }

    let selectedApiKey = profile?.api_key || ''

    if (profile) {
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

        if (siblings.length > 1) {
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

    const cli = cliFromProfile(profileWithSelectedKey, {
      fetchImpl: this.getFetchImpl()
    })
    if (!cli) {
      throw new Error('Unable to create an LLM client.')
    }

    const effectiveMessages = req.messages

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
    const toolInstructionBlock = buildSkillRuntimeToolInstructions(availableSkillTools, {
      outputMode: req.skillRuntime?.execution?.outputMode
    })
    const systemPromptWithTools = [req.systemPrompt?.trim() || '', toolInstructionBlock]
      .filter(Boolean)
      .join('\n\n')
    const toolAwareSystemPrompt = systemPromptWithTools || undefined
    const conversationMessages = [...effectiveMessages]
    let content = ''
    let chatResult: LLMChatResult = { content: '' }

    for (let step = 0; step <= MAX_SKILL_RUNTIME_TOOL_CALLS; step += 1) {
      const bufferedEvents: LLMDeltaEvent[] = []
      const shouldBufferStepEvents = availableSkillTools.length > 0
      const nextChatResult = await cli.chat({
        messages: conversationMessages,
        systemPrompt: toolAwareSystemPrompt,
        reasoningEffort: req.reasoningEffort,
        imageGenerationOptions: req.imageGenerationOptions,
        signal: options?.signal,
        sessionUrl: req.sessionUrl,
        conversationId: req.conversationId,
        onDelta: shouldBufferStepEvents ? (event) => bufferedEvents.push(event) : options?.onDelta
      })
      chatResult = normalizeLLMChatResult(nextChatResult)
      content = chatResult.content
      throwIfAborted(options?.signal)

      const requestedTool =
        availableSkillTools.length > 0
          ? parseRequestedToolInvocation(content, availableSkillToolNames)
          : null
      if (!requestedTool) {
        if (shouldBufferStepEvents) {
          bufferedEvents.forEach((event) => options?.onDelta?.(event))
        }
        break
      }

      if (step === MAX_SKILL_RUNTIME_TOOL_CALLS) {
        throw new Error('Skill runtime tool-call loop exceeded the maximum number of steps.')
      }

      const toolResult = await runtime.callTool(
        buildSkillRuntimeRoute(req),
        requestedTool.toolName,
        requestedTool.args,
        {
          allowedToolNames
        }
      )
      throwIfAborted(options?.signal)

      conversationMessages.push({
        role: 'assistant',
        content
      })
      conversationMessages.push(buildToolResultMessage(requestedTool, toolResult.content))
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
    resp: ServerStreaming<LLMChatStreamResp>
  ): Promise<void> => {
    const abortContext = this.createConversationAbortContext(req.conversationId)
    let streamedText = ''
    let lastSessionUrl = req.sessionUrl?.trim() || undefined
    const seenAttachmentKeys = new Set<string>()

    const rememberAttachment = (attachment: ChatAttachment): boolean => {
      const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
      if (seenAttachmentKeys.has(key)) {
        return false
      }
      seenAttachmentKeys.add(key)
      return true
    }

    const emitEvent = (event: LLMDeltaEvent): void => {
      if (event.type === 'text-delta' && event.delta) {
        streamedText += event.delta
      }

      if (event.type === 'attachment' && event.attachment) {
        rememberAttachment(event.attachment)
      }

      if (event.type === 'session' && event.sessionUrl) {
        lastSessionUrl = event.sessionUrl
      }

      resp.onData({
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
        ...(event.metadata ? { metadata: event.metadata } : {})
      })
    }

    try {
      const result = await this.chatViaAPI(req, {
        signal: abortContext.signal,
        onDelta: emitEvent
      })
      const fallbackContent = result.content || result.imageUrl || ''
      const finalFullContent = result.content || streamedText || result.imageUrl || undefined

      if (!streamedText && fallbackContent) {
        streamedText = fallbackContent
        resp.onData({
          type: 'text-delta',
          delta: fallbackContent,
          done: false,
          fullContent: fallbackContent,
          content: result.content,
          ...(result.imageUrl ? { imageUrl: result.imageUrl } : {})
        })
      }

      for (const attachment of result.attachments || []) {
        if (!rememberAttachment(attachment)) {
          continue
        }

        resp.onData({
          type: 'attachment',
          delta: '',
          done: false,
          fullContent: finalFullContent,
          attachment
        })
      }

      if (result.sessionUrl && result.sessionUrl !== lastSessionUrl) {
        lastSessionUrl = result.sessionUrl
        resp.onData({
          type: 'session',
          delta: '',
          done: false,
          fullContent: finalFullContent,
          sessionUrl: result.sessionUrl
        })
      }

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
        ...(result.metadata ? { metadata: result.metadata } : {})
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      resp.onData({
        type: 'error',
        delta: '',
        done: false,
        fullContent: streamedText || undefined,
        content: streamedText || '',
        error: message,
        finishReason: 'error'
      })
      resp.onData({
        type: 'done',
        delta: '',
        done: true,
        fullContent: streamedText || undefined,
        content: streamedText || '',
        error: message,
        finishReason: 'error'
      })
    } finally {
      abortContext.cleanup()
    }
  }

  listProfiles = async (req: LLMListProfilesReq): Promise<LLMListProfilesResp> => {
    const config = getConfig()
    const validProfiles = config.llm_config.api_profiles.filter(isRunnableProfile)

    return {
      profiles: validProfiles.map((p) => {
        const modelUse = resolveProfileModelUse(p)
        const isVisionModel =
          modelUse === 'agent' ||
          modelUse === 'multimodal' ||
          modelUse === 'vision' ||
          modelUse === 'ocr' ||
          Boolean(p.is_vision_model)
        const isOcrModel = modelUse === 'ocr' || Boolean(p.is_ocr_model)
        const taggerDescriptor = resolveTaggerRuntimeDescriptor(p)

        return {
          id: p.id,
          model_name: p.model_name,
          deployment: resolveProfileDeployment(p),
          model_use: modelUse,
          is_vision_model: isVisionModel,
          is_ocr_model: isOcrModel,
          ...(p.tagger_provider ? { tagger_provider: p.tagger_provider } : {}),
          ...(p.tagger_endpoint?.trim() ? { tagger_endpoint: p.tagger_endpoint.trim() } : {}),
          ...(p.tagger_runtime_cache_scope
            ? { tagger_runtime_cache_scope: p.tagger_runtime_cache_scope }
            : {}),
          ...(taggerDescriptor ? { tagger_runtime_key: taggerDescriptor.cacheKey } : {})
        }
      })
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
        return await uploadLocalHy3dModel(credentials, cosConfig, req.filePath)
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

  remoteFetch = async (req: LLMRemoteFetchReq): Promise<LLMRemoteFetchResp> => {
    const https = await import('https')
    const http = await import('http')

    const timeoutMs = req.timeoutMs || 5 * 60 * 1000
    const parsedUrl = new URL(req.url)
    const isHttps = parsedUrl.protocol === 'https:'
    const transport = isHttps ? https : http
    const maxRetries = 3
    const abortContext = this.createConversationAbortContext(req.conversationId)

    const doRequest = (attempt: number): Promise<LLMRemoteFetchResp> =>
      new Promise((resolve, reject) => {
        throwIfAborted(abortContext.signal)
        const options: import('https').RequestOptions = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: req.method,
          headers: req.headers || {},
          timeout: timeoutMs,
          rejectUnauthorized: false
        }

        const request = transport.request(options, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            abortContext.signal?.removeEventListener('abort', handleAbort)
            const body = Buffer.concat(chunks).toString('utf-8')
            resolve({
              status: res.statusCode || 500,
              statusText: res.statusMessage || '',
              body
            })
          })
        })
        const handleAbort = () => {
          request.destroy(createAbortError('Remote request aborted.'))
        }

        if (abortContext.signal?.aborted) {
          handleAbort()
        } else {
          abortContext.signal?.addEventListener('abort', handleAbort, { once: true })
        }

        request.on('error', (error) => {
          abortContext.signal?.removeEventListener('abort', handleAbort)
          if (abortContext.signal?.aborted) {
            reject(
              abortContext.signal.reason instanceof Error
                ? abortContext.signal.reason
                : createAbortError('Remote request aborted.')
            )
            return
          }
          const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].some(
            (code) => error.message.includes(code)
          )
          if (retryable && attempt < maxRetries) {
            console.warn(
              '[LLMProxy] remoteFetch retry ' + attempt + '/' + maxRetries + ': ' + error.message
            )
            setTimeout(() => doRequest(attempt + 1).then(resolve, reject), 1000 * attempt)
          } else {
            console.error('[LLMProxy] remoteFetch failed:', error.message)
            reject(new Error('Remote request failed: ' + error.message))
          }
        })

        request.on('timeout', () => {
          abortContext.signal?.removeEventListener('abort', handleAbort)
          request.destroy()
          reject(new Error('Remote request timed out'))
        })

        if (req.body) {
          request.write(req.body)
        }
        request.end()
      })

    try {
      return await doRequest(1)
    } finally {
      abortContext.cleanup()
    }
  }
}
