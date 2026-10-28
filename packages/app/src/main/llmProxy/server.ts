// LLM proxy HTTP server
// Allows AIEngine to act as a server that receives LLM requests from other clients.

import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { app } from 'electron'
import { buildMagicPotAppCatalogSnapshot } from '@shared/app/catalog'
import { type LLMOpenAIApiMode, type LLMProxyAccessTokenEntry } from '@shared/config/config'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import {
  ChatMessage,
  LLMChatReq,
  LLMChatSkillRuntime,
  type LLMChatStreamResp,
  type LLMProfileScope
} from '@shared/api/svcLLMProxy'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type {
  LLMImageHistoryPolicy,
  OpenAIImageGenerationOptions,
  VideoGenerationOptions
} from '@shared/llm/types'
import type { LLMReasoningEffort } from '@shared/llm/profileCapabilities'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import {
  AssistantScopeType,
  normalizeAssistantRoute,
  type AssistantRoute
} from '../assistantRuntime/types'
import { buildAgentRoute } from '@shared/agent'
import {
  getConfiguredMcpLegacySseMessagePath,
  getConfiguredMcpLegacySsePath,
  handleMagicPotMcpHttpBridgeRequest,
  handleMagicPotMcpLegacySseMessageRequest,
  handleMagicPotMcpLegacySseOpenRequest
} from '../mcp/platform/httpBridge'
import { getMcpRuntimeStatus } from '../mcp/status'
import { readTestUiEnv, resolveTestArtifactPath, resolveTestUiPolicy } from '../testUiPolicy'
import { isLocalFileSource, normalizeLocalFilePath } from '../utils/localFileUrl'
import { getChatMediaDir, sanitizeChatMediaScope } from './chatMediaDir'
import { recordLlmProxyAccessUsage } from './accessUsage'
import {
  PROJECT_COMPARISON_PROFILES_PATH,
  PROJECT_COMPARISON_CHAT_PATH
} from '@shared/projectComparisonProtocol'
import { handleProjectComparisonHttp } from './projectComparisonHttp'
let activeProjectComparisons = 0

let server: http.Server | null = null
let llmProxySvc: LLMProxySvcImpl | null = null
const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
const CANVAS_SYNC_REMOVED_ERROR =
  'Canvas mirroring has been removed. Remote Codex can only access content explicitly attached to the current request.'
const LEGACY_CHAT_ENDPOINTS = new Set(['/api/bot/message', '/api/bot/chat', '/api/message'])
const DEFAULT_LLM_PROXY_BIND_HOST = '127.0.0.1'

function getLlmProxyTempDir(scope?: string): string {
  const baseTempDir = resolveTestArtifactPath({
    desktopPath: app.getPath('desktop'),
    tempPath: app.getPath('temp'),
    policy: testUiPolicy,
    segments: ['llm-proxy']
  })
  const normalizedScope = sanitizeChatMediaScope(scope)
  const tempDir = normalizedScope ? path.join(baseTempDir, normalizedScope) : baseTempDir
  fs.mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/**
 * Get the local IPv4 address for LAN access.
 */
function getLocalIPAddress(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // Skip internal and non-IPv4 addresses.
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

type LlmProxyAccessIdentity = {
  tokenId: string
  label?: string
  resourceScope?: string
}

type LlmProxyConfiguredAccessToken = LlmProxyAccessIdentity & {
  token: string
}

const PROXY_MEDIA_SIGNATURE_TTL_MS = 1000 * 60 * 60 * 24

const namespaceProxyConversationId = (
  accessIdentity: LlmProxyAccessIdentity,
  conversationId?: string
): string | undefined => {
  const normalizedConversationId = cleanString(conversationId)
  if (!normalizedConversationId) {
    return undefined
  }
  if (!accessIdentity.tokenId || accessIdentity.tokenId === 'anonymous') {
    return normalizedConversationId
  }
  return `proxy:${accessIdentity.tokenId}:${normalizedConversationId}`
}

const getRequesterAddress = (req: http.IncomingMessage): string => {
  // The proxy does not have a configured trusted-hop list. Treating an
  // arbitrary X-Forwarded-For value as identity lets a LAN caller choose the
  // address bound into signed media URLs and usage records. Use the actual
  // peer address until an explicitly trusted reverse-proxy policy exists.
  const candidate = cleanString(req.socket.remoteAddress)
  if (!candidate) {
    return 'unknown'
  }
  return candidate.replace(/^::ffff:/i, '')
}

const sanitizeProxyAssetFileStem = (value?: string | null): string => {
  const normalized = String(value || '')
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return normalized || 'asset'
}

const buildProxyMediaAccessSignature = (
  filename: string,
  resourceScope: string | undefined,
  accessToken: LlmProxyConfiguredAccessToken,
  expiresAtMs: number,
  requesterAddress: string
): string =>
  createHmac('sha256', accessToken.token)
    .update(
      [
        cleanString(accessToken.tokenId) || 'anonymous',
        sanitizeChatMediaScope(resourceScope) || '',
        filename,
        String(expiresAtMs),
        requesterAddress
      ].join(':')
    )
    .digest('hex')

const buildProxyImagePath = (
  filename: string,
  resourceScope?: string,
  accessToken?: LlmProxyConfiguredAccessToken,
  requesterAddress?: string
): string => {
  const normalizedScope = sanitizeChatMediaScope(resourceScope)
  const encodedFilename = encodeURIComponent(filename)
  const pathname = normalizedScope
    ? `/api/images/${encodeURIComponent(normalizedScope)}/${encodedFilename}`
    : `/api/images/${encodedFilename}`
  if (!accessToken?.token) {
    return pathname
  }

  const expiresAtMs = Date.now() + PROXY_MEDIA_SIGNATURE_TTL_MS
  const params = new URLSearchParams({
    access_id: accessToken.tokenId,
    expires: String(expiresAtMs),
    sig: buildProxyMediaAccessSignature(
      filename,
      normalizedScope,
      accessToken,
      expiresAtMs,
      requesterAddress || 'unknown'
    )
  })
  return `${pathname}?${params.toString()}`
}

const buildScopedProxyMediaUrl = (
  sourceUrl: string,
  host: string,
  protocol: string,
  accessToken?: LlmProxyConfiguredAccessToken,
  requesterAddress?: string,
  resourceScope?: string,
  stagedUrlCache?: Map<string, string>
): string => {
  if (!sourceUrl || !isLocalFileSource(sourceUrl)) {
    return sourceUrl
  }

  const cacheKey = `${accessToken?.tokenId || 'anonymous'}::${requesterAddress || 'unknown'}::${resourceScope || 'shared'}::${sourceUrl}`
  const cached = stagedUrlCache?.get(cacheKey)
  if (cached) {
    return cached
  }

  const normalizedSourcePath = normalizeLocalFilePath(sourceUrl)
  const fallbackFilename = path.basename(normalizedSourcePath)
  let proxiedUrl = `${protocol}://${host}/${buildProxyImagePath(fallbackFilename, undefined, accessToken, requesterAddress).replace(/^\//, '')}`

  try {
    if (normalizedSourcePath && fs.existsSync(normalizedSourcePath)) {
      const extension = path.extname(normalizedSourcePath)
      const fileStem = sanitizeProxyAssetFileStem(path.basename(normalizedSourcePath, extension))
      const stagedFilename = `${fileStem}-${randomUUID()}${extension}`
      const targetDir = getChatMediaDir(resourceScope)
      const targetPath = path.join(targetDir, stagedFilename)
      const sourceStat = fs.statSync(normalizedSourcePath)

      if (path.resolve(normalizedSourcePath) !== path.resolve(targetPath)) {
        fs.copyFileSync(normalizedSourcePath, targetPath)
      }

      recordLlmProxyAccessUsage(accessToken, {
        activity: 'media-generated',
        requesterAddress,
        generatedMediaBytes: sourceStat.size
      })

      proxiedUrl = `${protocol}://${host}/${buildProxyImagePath(stagedFilename, resourceScope, accessToken, requesterAddress).replace(/^\//, '')}`
    }
  } catch (error) {
    console.warn('[LLMProxyServer] Failed to stage local media for remote access:', error)
  }

  stagedUrlCache?.set(cacheKey, proxiedUrl)
  return proxiedUrl
}

/**
 * Rewrite file:// URLs to http:// or https:// so remote clients can fetch media.
 * Supports both forward-slash and backslash Windows paths.
 */
function rewriteFileUrlsToHttp(
  content: string,
  host: string,
  protocol: string = 'http',
  accessToken?: LlmProxyConfiguredAccessToken,
  requesterAddress?: string,
  resourceScope?: string,
  stagedUrlCache?: Map<string, string>
): string {
  if (!content) return content

  return content.replace(
    /(?:file|local-media):\/\/[^)\s]+?\.(?:png|jpg|jpeg|gif|webp|mp4|webm)/gi,
    (match) =>
      buildScopedProxyMediaUrl(
        match,
        host,
        protocol,
        accessToken,
        requesterAddress,
        resourceScope,
        stagedUrlCache
      )
  )
}

/**
 * Rewrite every result field that may contain file:// or local-media:// URLs.
 */
function rewriteResultUrls(
  result: {
    content: string
    imageUrl?: string
    sessionUrl?: string
    attachments?: Array<{ url: string; ocrResult?: { sourceImageUrl?: string } }>
    ocrResult?: { sourceImageUrl?: string }
  },
  host: string,
  protocol: string = 'http',
  accessToken?: LlmProxyConfiguredAccessToken,
  requesterAddress?: string,
  resourceScope?: string
): void {
  const stagedUrlCache = new Map<string, string>()

  if (result.content) {
    result.content = rewriteFileUrlsToHttp(
      result.content,
      host,
      protocol,
      accessToken,
      requesterAddress,
      resourceScope,
      stagedUrlCache
    )
  }
  if (
    result.imageUrl &&
    (result.imageUrl.startsWith('file://') || result.imageUrl.startsWith('local-media://'))
  ) {
    result.imageUrl = buildScopedProxyMediaUrl(
      result.imageUrl,
      host,
      protocol,
      accessToken,
      requesterAddress,
      resourceScope,
      stagedUrlCache
    )
  }
  if (result.attachments?.length) {
    result.attachments = result.attachments.map((attachment) => {
      const nextAttachment = { ...attachment }

      if (
        nextAttachment.url &&
        (nextAttachment.url.startsWith('file://') ||
          nextAttachment.url.startsWith('local-media://'))
      ) {
        nextAttachment.url = buildScopedProxyMediaUrl(
          nextAttachment.url,
          host,
          protocol,
          accessToken,
          requesterAddress,
          resourceScope,
          stagedUrlCache
        )
      }

      if (
        nextAttachment.ocrResult?.sourceImageUrl &&
        (nextAttachment.ocrResult.sourceImageUrl.startsWith('file://') ||
          nextAttachment.ocrResult.sourceImageUrl.startsWith('local-media://'))
      ) {
        nextAttachment.ocrResult = {
          ...nextAttachment.ocrResult,
          sourceImageUrl: buildScopedProxyMediaUrl(
            nextAttachment.ocrResult.sourceImageUrl,
            host,
            protocol,
            accessToken,
            requesterAddress,
            resourceScope,
            stagedUrlCache
          )
        }
      }

      return nextAttachment
    })
  }
  if (
    result.ocrResult?.sourceImageUrl &&
    (result.ocrResult.sourceImageUrl.startsWith('file://') ||
      result.ocrResult.sourceImageUrl.startsWith('local-media://'))
  ) {
    result.ocrResult.sourceImageUrl = buildScopedProxyMediaUrl(
      result.ocrResult.sourceImageUrl,
      host,
      protocol,
      accessToken,
      requesterAddress,
      resourceScope,
      stagedUrlCache
    )
  }
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

const cleanUnknownString = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') {
    return cleanString(String(value))
  }
  return undefined
}

const firstHeaderValue = (value?: string | string[]): string | undefined => {
  if (Array.isArray(value)) {
    return cleanString(value[0])
  }
  return cleanString(value)
}

const getBearerToken = (header?: string | string[]): string | undefined => {
  const normalized = firstHeaderValue(header)
  if (!normalized) {
    return undefined
  }

  const match = normalized.match(/^Bearer\s+(.+)$/i)
  return cleanString(match?.[1])
}

const constantTimeTokenEquals = (left: string | undefined, right: string | undefined): boolean => {
  if (left === undefined || right === undefined) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

const getLegacyBotSecretToken = (
  headers: Record<string, string | string[] | undefined>
): string | undefined =>
  firstHeaderValue(headers['x-magicpot-bot-secret']) || firstHeaderValue(headers['x-bot-secret'])

const isLocalSecretRequestAuthorized = (
  headers: Record<string, string | string[] | undefined>,
  secret?: string | null
): boolean => {
  const normalizedSecret = cleanString(secret)
  if (!normalizedSecret) return true

  const authorizationToken = getBearerToken(headers.authorization)
  if (constantTimeTokenEquals(authorizationToken, normalizedSecret)) {
    return true
  }

  return constantTimeTokenEquals(getLegacyBotSecretToken(headers), normalizedSecret)
}

const normalizeLlmProxyAccessTokenEntry = (
  entry: Partial<LLMProxyAccessTokenEntry> | undefined,
  fallbackId: string,
  fallbackLabel: string
): LlmProxyConfiguredAccessToken | null => {
  const token = cleanString(entry?.token)
  if (!token) {
    return null
  }

  const tokenId = cleanString(entry?.id) || fallbackId
  const label = cleanString(entry?.label) || fallbackLabel
  const resourceScope =
    sanitizeChatMediaScope(entry?.resource_scope) ||
    sanitizeChatMediaScope(tokenId) ||
    sanitizeChatMediaScope(label)

  return {
    tokenId,
    label,
    token,
    resourceScope
  }
}

const getConfiguredLlmProxyAccessTokens = (): LlmProxyConfiguredAccessToken[] => {
  const serverConfig = getConfig().local_llm_server_config
  const configuredEntries = Array.isArray(serverConfig?.access_tokens)
    ? serverConfig.access_tokens
        .map((entry, index) =>
          normalizeLlmProxyAccessTokenEntry(entry, `proxy-token-${index + 1}`, `User ${index + 1}`)
        )
        .filter((entry): entry is LlmProxyConfiguredAccessToken => Boolean(entry))
    : []

  if (configuredEntries.length > 0) {
    return configuredEntries
  }

  const legacyToken = cleanString(serverConfig?.access_token)
  return legacyToken
    ? [
        {
          tokenId: 'default',
          label: 'Default',
          token: legacyToken,
          resourceScope: 'default'
        }
      ]
    : []
}

const resolveLlmProxyAccessIdentity = (
  headers: Record<string, string | string[] | undefined>
): LlmProxyConfiguredAccessToken | null => {
  const configuredTokens = getConfiguredLlmProxyAccessTokens()
  if (configuredTokens.length === 0) {
    return {
      tokenId: 'anonymous',
      label: 'Anonymous',
      token: ''
    }
  }

  const requestedToken =
    getBearerToken(headers.authorization) ||
    firstHeaderValue(headers['x-magicpot-proxy-token']) ||
    getLegacyBotSecretToken(headers)

  if (!requestedToken) {
    return null
  }

  const matched = configuredTokens.find((entry) =>
    constantTimeTokenEquals(entry.token, requestedToken)
  )
  return matched || null
}

const writeUnauthorizedLlmProxyResponse = (res: http.ServerResponse): void => {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      error:
        'Unauthorized LLM proxy request. Provide Authorization: Bearer <token>, X-MagicPot-Proxy-Token, or legacy X-MagicPot-Bot-Secret/X-Bot-Secret.'
    })
  )
}

const resolveInternalToolRequestAccess = (
  headers: Record<string, string | string[] | undefined>,
  config: ReturnType<typeof getConfig>
): { accessIdentity?: LlmProxyConfiguredAccessToken } | null => {
  const accessIdentity = resolveLlmProxyAccessIdentity(headers)
  if (accessIdentity) {
    return { accessIdentity }
  }

  const configuredLocalSecret = cleanString(config.chat_config?.webhook_secret)
  if (configuredLocalSecret && isLocalSecretRequestAuthorized(headers, configuredLocalSecret)) {
    return {}
  }

  if (getConfiguredLlmProxyAccessTokens().length === 0 && !configuredLocalSecret) {
    return {}
  }

  return null
}

const hasValidProxyMediaSignature = (
  url: URL,
  filename: string,
  requesterAddress: string,
  resourceScope?: string
): boolean => {
  const accessId = cleanString(url.searchParams.get('access_id'))
  const expiresRaw = cleanString(url.searchParams.get('expires'))
  const providedSignature = cleanString(url.searchParams.get('sig'))
  if (!accessId || !expiresRaw || !providedSignature) {
    return false
  }

  const expiresAtMs = Number.parseInt(expiresRaw, 10)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return false
  }

  const accessToken = getConfiguredLlmProxyAccessTokens().find(
    (entry) => entry.tokenId === accessId
  )
  if (!accessToken) {
    return false
  }
  if (resourceScope && accessToken.resourceScope && accessToken.resourceScope !== resourceScope) {
    return false
  }

  const expectedSignature = buildProxyMediaAccessSignature(
    filename,
    resourceScope,
    accessToken,
    expiresAtMs,
    requesterAddress
  )
  const expectedBuffer = Buffer.from(expectedSignature, 'hex')
  const providedBuffer = Buffer.from(providedSignature, 'hex')
  if (expectedBuffer.length === 0 || expectedBuffer.length !== providedBuffer.length) {
    return false
  }
  return timingSafeEqual(expectedBuffer, providedBuffer)
}

const normalizeBindHost = (value?: string | null): string =>
  cleanString(value) || DEFAULT_LLM_PROXY_BIND_HOST

const isLoopbackBindHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') {
    return true
  }
  // Do not treat arbitrary hostnames such as `127.attacker.example` as
  // loopback. A permissive prefix check could allow an unauthenticated bind
  // to a DNS-resolved public interface.
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127'
}

/**
 * CORS is an explicit browser trust policy, not a replacement for bearer auth. Keep origins
 * exact (scheme/host/port) and fail closed for malformed or wildcard entries.
 */
const normalizeCorsAllowedOrigins = (value: unknown): Set<string> => {
  const origins = new Set<string>()
  if (!Array.isArray(value)) return origins
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const raw = candidate.trim()
    if (raw === 'null') {
      origins.add(raw)
      continue
    }
    try {
      const parsed = new URL(raw)
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      ) {
        continue
      }
      origins.add(parsed.origin)
    } catch {
      // Invalid entries must not broaden the policy.
    }
  }
  return origins
}

const getCorsOrigin = (
  request: http.IncomingMessage,
  configuredOrigins: unknown
): string | undefined => {
  const requestOrigin = firstHeaderValue(request.headers.origin)
  if (!requestOrigin) return undefined
  const allowed = normalizeCorsAllowedOrigins(configuredOrigins)
  // Loopback is not a wildcard: local browser callers must still be explicitly listed.
  // Remote binds likewise require an explicit allowlist, even when bearer auth is enabled.
  if (!allowed.has(requestOrigin)) return undefined
  return requestOrigin
}

const getMcpServerPath = () => cleanString(getConfig().mcp_config?.server?.path) || '/api/mcp'

const getLocalMcpAuthToken = () =>
  cleanString(getConfig().mcp_config?.server?.auth_token) ||
  cleanString(getConfig().chat_config?.webhook_secret)

const normalizeAssistantRouteInput = (value: {
  channel?: string
  scopeType?: string
  scopeId?: string
  threadId?: string
  senderId?: string
  senderName?: string
}) =>
  normalizeAssistantRoute(
    buildAgentRoute({
      channel: cleanString(value.channel) || 'generic',
      scopeType: (cleanString(value.scopeType) as AssistantScopeType) || 'dm',
      scopeId: cleanString(value.scopeId),
      fallbackScopeId: 'default',
      threadId: cleanString(value.threadId),
      senderId: cleanString(value.senderId),
      senderName: cleanString(value.senderName)
    }) as AssistantRoute
  )

type AssistantRouteInput = Parameters<typeof normalizeAssistantRouteInput>[0]

type ProxyChatRequestData = {
  messages: ChatMessage[]
  route?: AssistantRouteInput
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  maxOutputTokens?: number
  imageGenerationOptions?: OpenAIImageGenerationOptions
  imageRequest?: LLMChatReq['imageRequest']
  imageHistoryPolicy?: LLMImageHistoryPolicy
  videoGenerationOptions?: VideoGenerationOptions
  comparisonRouting?: 'configured' | 'local'
  apiMode?: LLMOpenAIApiMode
  skillRuntime?: LLMChatSkillRuntime
  profileId?: string
  profileScope?: LLMProfileScope
  sessionUrl?: string
  conversationId?: string
  isEdit?: boolean
  isRegenerate?: boolean
  stream?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 500 | 502 | 504,
    message: string,
    options?: { body?: string }
  ) {
    super(message)
    this.name = 'HttpRequestError'
    if (options?.body !== undefined) {
      Object.defineProperty(this, 'body', {
        configurable: true,
        enumerable: true,
        value: options.body,
        writable: false
      })
    }
  }
}

const readRequestBody = async (
  req: http.IncomingMessage,
  maxBytes = 16 * 1024 * 1024
): Promise<string> => {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) {
      throw new HttpRequestError(413, 'Request body is too large.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

const normalizeLegacyMessageContent = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') {
    return cleanUnknownString(value)
  }
  if (!Array.isArray(value)) {
    return undefined
  }

  const textContent = value
    .map((part) => (isRecord(part) ? cleanUnknownString(part.text) : undefined))
    .filter((part): part is string => Boolean(part))
    .join(' ')
  return textContent || undefined
}

const normalizeLegacyChatMessages = (reqData: Record<string, unknown>): ChatMessage[] => {
  if (Array.isArray(reqData.messages)) {
    const messages = reqData.messages
      .map((message): ChatMessage | null => {
        if (typeof message === 'string' || typeof message === 'number') {
          const content = cleanUnknownString(message)
          if (content === undefined) {
            return null
          }
          return {
            role: 'user',
            content
          }
        }
        if (!isRecord(message)) {
          return null
        }

        const role =
          message.role === 'system' || message.role === 'assistant' ? message.role : 'user'
        const content = normalizeLegacyMessageContent(
          message.content ?? message.message ?? message.text
        )
        if (content === undefined) {
          return null
        }

        return {
          role,
          content,
          attachments: Array.isArray(message.attachments)
            ? (message.attachments as ChatMessage['attachments'])
            : undefined,
          ocrResult: isRecord(message.ocrResult)
            ? (message.ocrResult as ChatMessage['ocrResult'])
            : undefined,
          hiddenContext: cleanUnknownString(message.hiddenContext)
        }
      })
      .filter((message): message is ChatMessage => Boolean(message))
    if (messages.length > 0) {
      return messages
    }
  }

  const content =
    cleanUnknownString(reqData.message) ||
    cleanUnknownString(reqData.content) ||
    cleanUnknownString(reqData.text)
  return content
    ? [
        {
          role: 'user',
          content
        }
      ]
    : []
}

const normalizeLegacyRouteInput = (
  reqData: Record<string, unknown>
): AssistantRouteInput | undefined => {
  const route = isRecord(reqData.route) ? reqData.route : undefined
  const routeInput: AssistantRouteInput = {
    channel: cleanUnknownString(route?.channel) || cleanUnknownString(reqData.channel),
    scopeType: cleanUnknownString(route?.scopeType) || cleanUnknownString(reqData.scopeType),
    scopeId: cleanUnknownString(route?.scopeId) || cleanUnknownString(reqData.scopeId),
    threadId: cleanUnknownString(route?.threadId) || cleanUnknownString(reqData.threadId),
    senderId: cleanUnknownString(route?.senderId) || cleanUnknownString(reqData.senderId),
    senderName: cleanUnknownString(route?.senderName) || cleanUnknownString(reqData.senderName)
  }

  return route || Object.values(routeInput).some(Boolean) ? routeInput : undefined
}

const normalizeApiMode = (value: unknown): LLMOpenAIApiMode | undefined =>
  value === 'auto' || value === 'responses' || value === 'chat-completions' || value === 'images'
    ? value
    : undefined

const normalizeLegacyChatRequest = (reqData: Record<string, unknown>): ProxyChatRequestData => ({
  messages: normalizeLegacyChatMessages(reqData),
  route: normalizeLegacyRouteInput(reqData),
  systemPrompt: cleanUnknownString(reqData.systemPrompt),
  reasoningEffort:
    reqData.reasoningEffort === 'none' ||
    reqData.reasoningEffort === 'minimal' ||
    reqData.reasoningEffort === 'low' ||
    reqData.reasoningEffort === 'medium' ||
    reqData.reasoningEffort === 'high' ||
    reqData.reasoningEffort === 'xhigh' ||
    reqData.reasoningEffort === 'max'
      ? reqData.reasoningEffort
      : undefined,
  maxOutputTokens:
    typeof reqData.maxOutputTokens === 'number' &&
    Number.isFinite(reqData.maxOutputTokens) &&
    reqData.maxOutputTokens > 0
      ? reqData.maxOutputTokens
      : undefined,
  imageGenerationOptions: isRecord(reqData.imageGenerationOptions)
    ? (reqData.imageGenerationOptions as OpenAIImageGenerationOptions)
    : undefined,
  imageRequest: isRecord(reqData.imageRequest)
    ? (reqData.imageRequest as LLMChatReq['imageRequest'])
    : undefined,
  imageHistoryPolicy:
    reqData.imageHistoryPolicy === 'latest-user-turn' || reqData.imageHistoryPolicy === 'all'
      ? reqData.imageHistoryPolicy
      : undefined,
  videoGenerationOptions: isRecord(reqData.videoGenerationOptions)
    ? (reqData.videoGenerationOptions as VideoGenerationOptions)
    : undefined,
  comparisonRouting:
    reqData.comparisonRouting === 'configured' || reqData.comparisonRouting === 'local'
      ? reqData.comparisonRouting
      : undefined,
  apiMode: normalizeApiMode(reqData.apiMode ?? reqData.api_mode),
  skillRuntime: isRecord(reqData.skillRuntime)
    ? (reqData.skillRuntime as LLMChatSkillRuntime)
    : undefined,
  profileId: cleanUnknownString(reqData.profileId),
  profileScope:
    reqData.profileScope === 'qapp' || reqData.profileScope === 'agent'
      ? reqData.profileScope
      : undefined,
  sessionUrl: cleanUnknownString(reqData.sessionUrl),
  conversationId:
    cleanUnknownString(reqData.conversationId) || cleanUnknownString(reqData.sessionId),
  isEdit: typeof reqData.isEdit === 'boolean' ? reqData.isEdit : undefined,
  isRegenerate: typeof reqData.isRegenerate === 'boolean' ? reqData.isRegenerate : undefined,
  stream: reqData.stream === true
})

const buildMcpJsonRpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code,
    message
  }
})

const normalizeMcpAcceptHeader = (req: http.IncomingMessage): void => {
  const accept = cleanString(req.headers.accept)
  if (!accept || accept === '*/*') {
    req.headers.accept = 'application/json, text/event-stream'
  }
}

const writeProxySseFrame = (res: http.ServerResponse, payload: unknown): void => {
  if (res.destroyed || res.writableEnded) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const startProxySseResponse = (res: http.ServerResponse): void => {
  if (res.headersSent) return
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  })
}

const buildOpenAIStreamMagicPotPayload = (
  data: LLMChatStreamResp
): Record<string, unknown> | undefined => {
  const magicpot: Record<string, unknown> = {}
  if (data.imageUrl) magicpot.image_url = data.imageUrl
  if (data.sessionUrl) magicpot.session_url = data.sessionUrl
  if (data.attachments) magicpot.attachments = data.attachments
  if (data.attachment) magicpot.attachment = data.attachment
  if (data.ocrResult) magicpot.ocr_result = data.ocrResult
  if (data.fullContent !== undefined) magicpot.full_content = data.fullContent
  if (data.usage) magicpot.usage = data.usage
  if (data.metadata) magicpot.metadata = data.metadata
  if (data.error) magicpot.error = data.error
  if (data.status !== undefined) magicpot.status = data.status
  if (data.body !== undefined) magicpot.body = data.body
  return Object.keys(magicpot).length > 0 ? magicpot : undefined
}

const buildProxyChatRequest = (
  reqData: ProxyChatRequestData,
  accessIdentity: LlmProxyAccessIdentity
) => ({
  messages: reqData.messages,
  route: reqData.route ? normalizeAssistantRouteInput(reqData.route) : undefined,
  systemPrompt: reqData.systemPrompt,
  reasoningEffort: reqData.reasoningEffort,
  maxOutputTokens: reqData.maxOutputTokens,
  imageGenerationOptions: reqData.imageGenerationOptions,
  imageRequest: reqData.imageRequest,
  imageHistoryPolicy: reqData.imageHistoryPolicy,
  videoGenerationOptions: reqData.videoGenerationOptions,
  comparisonRouting: reqData.comparisonRouting,
  apiMode: reqData.apiMode,
  skillRuntime: reqData.skillRuntime,
  profileId: reqData.profileId,
  profileScope: reqData.profileScope,
  sessionUrl: reqData.sessionUrl,
  conversationId: namespaceProxyConversationId(accessIdentity, reqData.conversationId),
  isEdit: reqData.isEdit,
  isRegenerate: reqData.isRegenerate
})

const rewriteProxyStreamData = (
  data: LLMChatStreamResp,
  host: string,
  protocol: string,
  accessToken: LlmProxyConfiguredAccessToken,
  requesterAddress: string
): LLMChatStreamResp => {
  const result = {
    content: data.content || data.delta || '',
    imageUrl: data.imageUrl,
    sessionUrl: data.sessionUrl,
    attachments: data.attachments || (data.attachment ? [data.attachment] : undefined),
    ocrResult: data.ocrResult
  }
  rewriteResultUrls(
    result,
    host,
    protocol,
    accessToken,
    requesterAddress,
    accessToken.resourceScope
  )
  return {
    ...data,
    ...(data.delta
      ? {
          delta: rewriteFileUrlsToHttp(
            data.delta,
            host,
            protocol,
            accessToken,
            requesterAddress,
            accessToken.resourceScope
          )
        }
      : {}),
    ...(data.content !== undefined ? { content: result.content } : {}),
    ...(data.fullContent !== undefined
      ? {
          fullContent: rewriteFileUrlsToHttp(
            data.fullContent,
            host,
            protocol,
            accessToken,
            requesterAddress,
            accessToken.resourceScope
          )
        }
      : {}),
    ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
    ...(result.sessionUrl ? { sessionUrl: result.sessionUrl } : {}),
    ...(result.attachments ? { attachments: result.attachments } : {}),
    ...(data.attachment && result.attachments?.[0] ? { attachment: result.attachments[0] } : {}),
    ...(result.ocrResult ? { ocrResult: result.ocrResult } : {})
  }
}

const handleProxyChatRequest = async ({
  req,
  res,
  port,
  accessIdentity,
  reqData,
  includeLegacyAliases = false
}: {
  req: http.IncomingMessage
  res: http.ServerResponse
  port: number
  accessIdentity: LlmProxyConfiguredAccessToken
  reqData: ProxyChatRequestData
  includeLegacyAliases?: boolean
}): Promise<void> => {
  const abortBridge = createRequestAbortBridge(req, res)
  let streamStarted = false
  let terminalSent = false
  let streamError: string | undefined
  let preStreamError: Error | undefined
  try {
    const request = buildProxyChatRequest(reqData, accessIdentity)
    recordLlmProxyAccessUsage(accessIdentity, {
      activity: 'chat',
      requesterAddress: getRequesterAddress(req),
      profileId: reqData.profileId
    })
    if (reqData.stream === true) {
      const host = req.headers.host || `${getLocalIPAddress()}:${port}`
      const requesterAddress = getRequesterAddress(req)
      const protocol =
        (req.headers['x-forwarded-proto'] as string) ||
        (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http')
      const abortReceiver = {
        isAborted: () => abortBridge.signal.aborted || res.destroyed,
        onAbort: (handler: () => void) => {
          if (abortBridge.signal.aborted || res.destroyed) {
            handler()
            return
          }
          abortBridge.signal.addEventListener('abort', handler, { once: true })
        }
      }
      const stream: ServerStreaming<LLMChatStreamResp> = {
        abortReceiver,
        onData: (data) => {
          if (
            abortBridge.signal.aborted ||
            res.destroyed ||
            res.writableEnded ||
            terminalSent ||
            preStreamError
          )
            return
          if (data.error && !streamStarted) {
            preStreamError = new Error(data.error)
            return
          }
          if (data.type === 'error' || data.error) {
            streamError = data.error || 'Streaming request failed.'
          }
          const rewritten = rewriteProxyStreamData(
            data,
            host,
            protocol,
            accessIdentity,
            requesterAddress
          )
          const payload = includeLegacyAliases
            ? {
                ...rewritten,
                reply: rewritten.content || rewritten.delta,
                message: rewritten.content || rewritten.delta
              }
            : rewritten
          if (!streamStarted) {
            startProxySseResponse(res)
            streamStarted = true
          }
          writeProxySseFrame(res, payload)
          if (data.done) terminalSent = true
        }
      }
      await getLLMProxySvc().chatStream(request, stream)
      if (preStreamError && !streamStarted) {
        throw preStreamError
      }
      if (!abortBridge.signal.aborted && !res.destroyed && !terminalSent) {
        if (!streamStarted) {
          startProxySseResponse(res)
          streamStarted = true
        }
        terminalSent = true
        writeProxySseFrame(res, {
          type: 'done',
          delta: '',
          done: true,
          content: '',
          finishReason: streamError ? 'error' : 'stop',
          ...(streamError ? { error: streamError } : {}),
          ...(includeLegacyAliases ? { reply: '', message: '' } : {})
        })
      }
      if (!res.destroyed && !res.writableEnded) res.end()
      return
    }

    const result = await getLLMProxySvc().chat(request, {
      signal: abortBridge.signal
    })
    if (abortBridge.signal.aborted || res.destroyed) {
      return
    }
    // Rewrite file:// URLs for web and remote clients.
    const host = req.headers.host || `${getLocalIPAddress()}:${port}`
    const requesterAddress = getRequesterAddress(req)
    const protocol =
      (req.headers['x-forwarded-proto'] as string) ||
      (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http')
    rewriteResultUrls(
      result,
      host,
      protocol,
      accessIdentity,
      requesterAddress,
      accessIdentity.resourceScope
    )
    const responseBody = includeLegacyAliases
      ? {
          ...result,
          reply: result.content,
          message: result.content
        }
      : result
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(responseBody))
  } catch (error) {
    if (abortBridge.signal.aborted || isAbortError(error)) {
      return
    }
    if (reqData.stream === true) {
      if (!streamStarted) {
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
        const message = error instanceof Error ? error.message : String(error)
        const errorPayload = {
          error: message,
          ...(status !== undefined ? { status, statusCode: status } : {}),
          ...(body !== undefined ? { body } : {})
        }
        if (status !== undefined && status >= 500 && status <= 599) {
          throw Object.assign(new Error(message), errorPayload)
        }
        throw error
      }
      if (!terminalSent && !res.destroyed && !res.writableEnded) {
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
        const message = error instanceof Error ? error.message : String(error)
        writeProxySseFrame(res, {
          type: 'error',
          delta: '',
          done: false,
          error: message,
          ...(status !== undefined ? { status } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(includeLegacyAliases ? { reply: '', message: '' } : {})
        })
        terminalSent = true
        writeProxySseFrame(res, {
          type: 'done',
          delta: '',
          done: true,
          finishReason: 'error',
          error: message,
          ...(status !== undefined ? { status } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(includeLegacyAliases ? { reply: '', message: '' } : {})
        })
        res.end()
      }
      return
    }
    if (res.headersSent && !res.destroyed && !res.writableEnded) {
      writeProxySseFrame(res, {
        type: 'error',
        delta: '',
        done: false,
        error: error instanceof Error ? error.message : String(error),
        ...(includeLegacyAliases ? { reply: '', message: '' } : {})
      })
      if (!terminalSent) {
        terminalSent = true
        writeProxySseFrame(res, {
          type: 'done',
          delta: '',
          done: true,
          finishReason: 'error',
          error: error instanceof Error ? error.message : String(error),
          ...(includeLegacyAliases ? { reply: '', message: '' } : {})
        })
      }
      res.end()
      return
    }
    throw error
  } finally {
    abortBridge.cleanup()
  }
}

function getLLMProxySvc() {
  if (!llmProxySvc) {
    llmProxySvc = new LLMProxySvcImpl()
  }
  return llmProxySvc
}

const createAbortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message))

const createRequestAbortBridge = (
  req: http.IncomingMessage,
  res: http.ServerResponse
): {
  signal: AbortSignal
  cleanup: () => void
} => {
  const abortController = new AbortController()

  const abort = (message: string) => {
    if (abortController.signal.aborted) return
    abortController.abort(createAbortError(message))
  }

  const onRequestAborted = () => {
    abort('Client aborted the request before the response completed.')
  }

  const onResponseClosed = () => {
    if (res.writableEnded) return
    abort('Client closed the connection before the response completed.')
  }

  req.once('aborted', onRequestAborted)
  res.once('close', onResponseClosed)

  return {
    signal: abortController.signal,
    cleanup: () => {
      req.removeListener('aborted', onRequestAborted)
      res.removeListener('close', onResponseClosed)
    }
  }
}

/**
 * Start the LLM proxy HTTP server.
 */
export function startLLMProxyServer(): void {
  const config = getConfig()

  if (!config.local_llm_server_config?.enable_server) {
    console.log('[LLMProxyServer] Server is disabled.')
    return
  }

  const requestedPort = config.local_llm_server_config.port ?? 3721
  const port = requestedPort === 0 ? 0 : requestedPort
  const bindHost = normalizeBindHost(config.local_llm_server_config.bind_host)

  if (!isLoopbackBindHost(bindHost) && getConfiguredLlmProxyAccessTokens().length === 0) {
    console.error(
      `[LLMProxyServer] Refusing non-loopback bind on ${bindHost}: configure at least one valid proxy access token.`
    )
    return
  }

  if (server) {
    console.log('[LLMProxyServer] Server is already running.')
    return
  }

  server = http.createServer(async (req, res) => {
    // CORS is allowlist based. Never reflect arbitrary origins or use `*` on this
    // authenticated LAN endpoint; a remote web page must be explicitly trusted.
    res.setHeader('Vary', 'Origin')
    const requestOrigin = firstHeaderValue(req.headers.origin)
    const corsOrigin = getCorsOrigin(req, getConfig().local_llm_server_config?.cors_allowed_origins)
    if (requestOrigin && !corsOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: 'Origin is not allowed by the LLM proxy CORS policy.' }))
      return
    }
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-MagicPot-Bot-Secret, X-Bot-Secret, X-MagicPot-Proxy-Token'
      )
      res.setHeader('Access-Control-Expose-Headers', 'X-MagicPot-Stream-Fallback')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const pathname = url.pathname

    try {
      // This opt-in protocol never falls back to the permissive legacy chat endpoint.
      if (
        pathname === PROJECT_COMPARISON_PROFILES_PATH ||
        pathname === PROJECT_COMPARISON_CHAT_PATH
      ) {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        // Record the authenticated protocol boundary before capacity or
        // payload handling. Pass only the de-identified identity fields;
        // bearer credentials and request bodies must never enter usage data.
        recordLlmProxyAccessUsage(
          {
            tokenId: accessIdentity.tokenId,
            label: accessIdentity.label,
            resourceScope: accessIdentity.resourceScope
          },
          {
            activity: 'project-comparison',
            requesterAddress: getRequesterAddress(req)
          }
        )
        if (activeProjectComparisons >= 16) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ code: 'BUSY', message: 'Project comparison capacity reached.' }))
          return
        }
        activeProjectComparisons++
        try {
          await handleProjectComparisonHttp(req, res, getLLMProxySvc())
        } finally {
          activeProjectComparisons--
        }
        return
      }
      // Health check.
      if ((pathname === '/api/status' || pathname === '/api/bot/status') && req.method === 'GET') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        recordLlmProxyAccessUsage(accessIdentity, {
          activity: 'status',
          requesterAddress: getRequesterAddress(req)
        })
        const status = await getLLMProxySvc().serverStatus({})
        const responseBody =
          pathname === '/api/bot/status'
            ? {
                ...status,
                compatibility: {
                  endpoint: '/api/status',
                  legacyEndpoint: '/api/bot/status',
                  chatEndpoint: '/api/chat'
                }
              }
            : status
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(responseBody))
        return
      }

      // List available profiles.
      if (pathname === '/api/profiles' && req.method === 'GET') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        recordLlmProxyAccessUsage(accessIdentity, {
          activity: 'profiles',
          requesterAddress: getRequesterAddress(req)
        })
        const profiles = await getLLMProxySvc().listProfiles({})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(profiles))
        return
      }

      // ==================== Quick app API ====================

      // List server-side quick apps.
      if (pathname === '/api/qapps/list' && req.method === 'GET') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        recordLlmProxyAccessUsage(accessIdentity, {
          activity: 'qapp-list',
          requesterAddress: getRequesterAddress(req)
        })
        const { QAppFSCli } = await import('../qApp/fs')
        const qAppFSCli = new QAppFSCli()
        const qApps = await qAppFSCli.listQAppKeys()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ qApps }))
        return
      }

      // Read the config and workflow for a specific server-side quick app.
      if (pathname === '/api/qapps/get' && req.method === 'GET') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        recordLlmProxyAccessUsage(accessIdentity, {
          activity: 'qapp-get',
          requesterAddress: getRequesterAddress(req)
        })
        const key = url.searchParams.get('key')
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing key parameter' }))
          return
        }
        const { QAppFSCli } = await import('../qApp/fs')
        const qAppFSCli = new QAppFSCli()
        const { cfg, workflow, manifest } = await qAppFSCli.getQApp(key)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cfg, workflow, manifest }))
        return
      }

      if (pathname === '/api/apps/catalog' && req.method === 'GET') {
        const config = getConfig()
        let runtimeStatus: Awaited<ReturnType<typeof getMcpRuntimeStatus>> | null = null
        try {
          runtimeStatus = await getMcpRuntimeStatus(config)
        } catch (error) {
          console.warn('[LLMProxyServer] Failed to collect runtime-enriched app catalog:', error)
        }
        const snapshot = buildMagicPotAppCatalogSnapshot(config, { runtimeStatus })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(snapshot))
        return
      }

      // =======================================================

      // 410 - the legacy proxy-status endpoint has been removed.
      if (pathname === '/api/proxy-status') {
        res.writeHead(410, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'HTTP Proxy feature has been removed' }))
        return
      }

      // Media file service: /api/images/:filename
      if (pathname.startsWith('/api/images/') && req.method === 'GET') {
        const mediaPath = pathname.replace('/api/images/', '')
        const mediaSegments = mediaPath.split('/').filter(Boolean)
        const filename = mediaSegments.at(-1) || ''
        const resourceScope =
          mediaSegments.length === 2 ? decodeURIComponent(mediaSegments[0] || '') : undefined
        const requesterAddress = getRequesterAddress(req)
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        const configuredAccessTokens = getConfiguredLlmProxyAccessTokens()

        // Security check: allow simple scope and filenames with an extension only.
        if (
          mediaSegments.length === 0 ||
          mediaSegments.length > 2 ||
          !/^[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+$/.test(filename) ||
          (resourceScope && !/^[a-z0-9_.-]+$/i.test(resourceScope))
        ) {
          res.writeHead(400)
          res.end('Invalid filename')
          return
        }

        if (configuredAccessTokens.length > 0) {
          const hasMatchingHeaderAccess =
            accessIdentity &&
            (!resourceScope ||
              !accessIdentity.resourceScope ||
              accessIdentity.resourceScope === resourceScope)
          const hasMatchingSignedAccess = hasValidProxyMediaSignature(
            url,
            filename,
            requesterAddress,
            resourceScope
          )
          if (!hasMatchingHeaderAccess && !hasMatchingSignedAccess) {
            writeUnauthorizedLlmProxyResponse(res)
            return
          }
        }
        recordLlmProxyAccessUsage(accessIdentity || undefined, {
          activity: 'media-download',
          requesterAddress
        })

        // Prefer the persisted chat media directory, then fall back to temp for legacy data.
        const mediaDir = getChatMediaDir(resourceScope)
        const tempDir = getLlmProxyTempDir(resourceScope)

        let filePath = path.join(mediaDir, filename)
        if (!fs.existsSync(filePath)) {
          filePath = path.join(tempDir, filename)
        }

        if (!fs.existsSync(filePath)) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }

        const stat = fs.statSync(filePath)
        // Infer Content-Type.
        let contentType = 'application/octet-stream'
        if (filename.endsWith('.png')) contentType = 'image/png'
        else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) contentType = 'image/jpeg'
        else if (filename.endsWith('.gif')) contentType = 'image/gif'
        else if (filename.endsWith('.webp')) contentType = 'image/webp'
        else if (filename.endsWith('.mp4')) contentType = 'video/mp4'
        else if (filename.endsWith('.webm')) contentType = 'video/webm'

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size
        })
        const readStream = fs.createReadStream(filePath)
        readStream.pipe(res)
        return
      }

      // 鑱婂ぉ璇锋眰
      if (pathname === '/api/canvas/sync' && req.method === 'POST') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        req.resume()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            mirrored: false,
            error: CANVAS_SYNC_REMOVED_ERROR,
            hint: 'Canvas mirroring is no longer available. Attach required files to the chat request instead.'
          })
        )
        return
      }

      if (pathname === '/api/tools/call' && req.method === 'POST') {
        const config = getConfig()
        const toolAccess = resolveInternalToolRequestAccess(req.headers, config)
        if (!toolAccess) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error:
                'Unauthorized tool request. Provide Authorization: Bearer <token> or a configured internal tool secret.'
            })
          )
          return
        }

        let body = ''
        for await (const chunk of req) {
          body += chunk
        }

        const reqData = JSON.parse(body) as {
          channel?: string
          scopeType?: AssistantScopeType
          scopeId?: string
          threadId?: string
          toolName?: string
          args?: Record<string, unknown>
          allowedToolNames?: string[]
        }

        if (!cleanString(reqData.scopeId) || !cleanString(reqData.toolName)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing scopeId or toolName.' }))
          return
        }

        if (toolAccess.accessIdentity) {
          recordLlmProxyAccessUsage(toolAccess.accessIdentity, {
            activity: 'tool-call',
            requesterAddress: getRequesterAddress(req)
          })
        }

        const route = normalizeAssistantRouteInput(reqData)
        const result = await getAssistantRuntime().callTool(
          route,
          cleanString(reqData.toolName)!,
          reqData.args || {},
          {
            allowedToolNames: Array.isArray(reqData.allowedToolNames)
              ? reqData.allowedToolNames
              : undefined
          }
        )

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ result }))
        return
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        const body = await readRequestBody(req)
        const parsedBody = JSON.parse(body) as Record<string, unknown>
        const reqData = {
          ...parsedBody,
          apiMode: normalizeApiMode(parsedBody.apiMode ?? parsedBody.api_mode)
        } as ProxyChatRequestData
        await handleProxyChatRequest({ req, res, port, accessIdentity, reqData })
        return
      }

      if (LEGACY_CHAT_ENDPOINTS.has(pathname) && req.method === 'POST') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        const body = await readRequestBody(req)
        const parsedBody = (body ? JSON.parse(body) : {}) as unknown
        const reqData = normalizeLegacyChatRequest(isRecord(parsedBody) ? parsedBody : {})
        if (reqData.messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing message content or messages.' }))
          return
        }
        await handleProxyChatRequest({
          req,
          res,
          port,
          accessIdentity,
          reqData,
          includeLegacyAliases: true
        })
        return
      }
      // OpenAI-compatible endpoint: /v1/chat/completions
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const accessIdentity = resolveLlmProxyAccessIdentity(req.headers)
        if (!accessIdentity) {
          writeUnauthorizedLlmProxyResponse(res)
          return
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk
        }
        const reqData = JSON.parse(body) as {
          model?: string
          messages: Array<{
            role: 'system' | 'user' | 'assistant'
            content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
          }>
          stream?: boolean
          apiMode?: unknown
          api_mode?: unknown
          comparisonRouting?: unknown
          profileScope?: unknown
          reasoningEffort?: unknown
          reasoning_effort?: unknown
          maxOutputTokens?: unknown
          max_tokens?: unknown
          max_completion_tokens?: unknown
          sessionUrl?: unknown
          conversationId?: unknown
        }
        // Convert OpenAI chat-completions messages into MagicPot chat messages.
        const messages: ChatMessage[] = []
        let systemPrompt: string | undefined
        for (const msg of reqData.messages) {
          if (msg.role === 'system' && typeof msg.content === 'string') {
            systemPrompt = msg.content
            continue
          }
          if (typeof msg.content === 'string') {
            messages.push({
              role: msg.role,
              content: msg.content
            })
          } else if (Array.isArray(msg.content)) {
            // Flatten multimodal message content.
            let textContent = ''
            const attachments: { type: 'image'; url: string; mimeType: string }[] = []
            for (const part of msg.content) {
              if (part.type === 'text' && part.text) {
                textContent += part.text
              } else if (part.type === 'image_url' && part.image_url?.url) {
                attachments.push({
                  type: 'image',
                  url: part.image_url.url,
                  mimeType: 'image/jpeg'
                })
              }
            }
            messages.push({
              role: msg.role,
              content: textContent,
              attachments: attachments.length > 0 ? attachments : undefined
            })
          }
        }
        const abortBridge = createRequestAbortBridge(req, res)
        const streamId = `chatcmpl-${randomUUID()}`
        const streamCreated = Math.floor(Date.now() / 1000)
        const streamModel = reqData.model || 'unknown'
        try {
          const config = getConfig()
          const shouldUseQAppProfileScope =
            reqData.profileScope === 'qapp' ||
            (reqData.profileScope !== 'agent' &&
              Boolean(
                reqData.model &&
                (config.plugin_config?.api_profiles || []).some(
                  (profile) => profile.id === reqData.model
                )
              ))
          const reasoningEffort = normalizeLegacyChatRequest({
            reasoningEffort: reqData.reasoning_effort ?? reqData.reasoningEffort
          }).reasoningEffort
          const maxOutputTokensValue =
            reqData.max_completion_tokens ?? reqData.max_tokens ?? reqData.maxOutputTokens
          const maxOutputTokens =
            typeof maxOutputTokensValue === 'number' &&
            Number.isFinite(maxOutputTokensValue) &&
            maxOutputTokensValue > 0
              ? maxOutputTokensValue
              : undefined
          const comparisonRouting: LLMChatReq['comparisonRouting'] =
            reqData.comparisonRouting === 'configured' || reqData.comparisonRouting === 'local'
              ? reqData.comparisonRouting
              : undefined
          const apiMode: LLMOpenAIApiMode =
            normalizeApiMode(reqData.apiMode ?? reqData.api_mode) || 'chat-completions'
          const profileScope: LLMProfileScope | undefined = shouldUseQAppProfileScope
            ? 'qapp'
            : reqData.profileScope === 'agent'
              ? 'agent'
              : undefined
          const baseRequest: LLMChatReq & { stream?: boolean } = {
            messages,
            systemPrompt,
            profileId: reqData.model,
            profileScope,
            apiMode,
            comparisonRouting,
            reasoningEffort,
            maxOutputTokens,
            sessionUrl: cleanUnknownString(reqData.sessionUrl),
            conversationId: cleanUnknownString(reqData.conversationId),
            ...(reqData.stream === true ? { stream: true } : {})
          }
          recordLlmProxyAccessUsage(accessIdentity, {
            activity: 'openai',
            requesterAddress: getRequesterAddress(req),
            profileId: reqData.model
          })
          if (reqData.stream === true) {
            const host = req.headers.host || `${getLocalIPAddress()}:${port}`
            const requesterAddress = getRequesterAddress(req)
            const protocol =
              (req.headers['x-forwarded-proto'] as string) ||
              (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http')
            let streamStarted = false
            let terminalSent = false
            const writeChunk = (
              delta: string,
              finishReason: string | null,
              magicpot?: Record<string, unknown>
            ) => {
              if (terminalSent || abortBridge.signal.aborted || res.destroyed || res.writableEnded)
                return
              if (!streamStarted) {
                startProxySseResponse(res)
                streamStarted = true
              }
              writeProxySseFrame(res, {
                id: streamId,
                object: 'chat.completion.chunk',
                created: streamCreated,
                model: streamModel,
                choices: [
                  {
                    index: 0,
                    delta: delta ? { content: delta } : {},
                    finish_reason: finishReason
                  }
                ],
                ...(magicpot ? { magicpot } : {})
              })
            }
            let preStreamError: Error | undefined
            const finishStream = (finishReason: string, data?: LLMChatStreamResp) => {
              if (terminalSent || abortBridge.signal.aborted || res.destroyed || res.writableEnded)
                return
              const rewritten = data
                ? rewriteProxyStreamData(data, host, protocol, accessIdentity, requesterAddress)
                : undefined
              writeChunk(
                rewritten?.delta || '',
                finishReason,
                rewritten ? buildOpenAIStreamMagicPotPayload(rewritten) : undefined
              )
              terminalSent = true
              if (!res.destroyed && !res.writableEnded) res.write('data: [DONE]\n\n')
            }
            const abortReceiver = {
              isAborted: () => abortBridge.signal.aborted || res.destroyed,
              onAbort: (handler: () => void) => {
                if (abortBridge.signal.aborted || res.destroyed) {
                  handler()
                  return
                }
                abortBridge.signal.addEventListener('abort', handler, { once: true })
              }
            }
            const stream: ServerStreaming<LLMChatStreamResp> = {
              abortReceiver,
              onData: (data) => {
                if (
                  terminalSent ||
                  abortBridge.signal.aborted ||
                  res.destroyed ||
                  res.writableEnded ||
                  preStreamError
                )
                  return
                if (data.error && !streamStarted) {
                  preStreamError = new Error(data.error)
                  return
                }
                const rewritten = rewriteProxyStreamData(
                  data,
                  host,
                  protocol,
                  accessIdentity,
                  requesterAddress
                )
                if (data.type === 'error') {
                  finishStream('error', rewritten)
                  return
                }
                if (data.done) {
                  finishStream(data.finishReason || 'stop', rewritten)
                  return
                }
                writeChunk(rewritten.delta || '', null, buildOpenAIStreamMagicPotPayload(rewritten))
              }
            }
            try {
              await getLLMProxySvc().chatStream(baseRequest, stream)
            } catch (error) {
              if (abortBridge.signal.aborted || isAbortError(error)) return
              if (!streamStarted) throw error
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
              finishStream('error', {
                type: 'error',
                delta: '',
                done: false,
                error: error instanceof Error ? error.message : String(error),
                ...(status !== undefined ? { status } : {}),
                ...(body !== undefined ? { body } : {})
              })
              if (!res.destroyed && !res.writableEnded) res.end()
              return
            }
            if (preStreamError && !streamStarted) {
              throw preStreamError
            }
            if (!abortBridge.signal.aborted && !res.destroyed && !terminalSent) {
              finishStream('stop')
            }
            if (!res.destroyed && !res.writableEnded) res.end()
            return
          }

          const result = await getLLMProxySvc().chat(baseRequest, {
            signal: abortBridge.signal
          })
          if (abortBridge.signal.aborted || res.destroyed) {
            return
          }
          // Rewrite file:// URLs.
          const host = req.headers.host || `${getLocalIPAddress()}:${port}`
          const requesterAddress = getRequesterAddress(req)
          const protocol =
            (req.headers['x-forwarded-proto'] as string) ||
            (req.socket && 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http')
          const finalContent = rewriteFileUrlsToHttp(
            result.imageUrl || result.content,
            host,
            protocol,
            accessIdentity,
            requesterAddress,
            accessIdentity.resourceScope
          )
          // Return an OpenAI-compatible response payload.
          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: streamModel,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: finalContent
                },
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        } catch (error) {
          if (abortBridge.signal.aborted || isAbortError(error)) {
            return
          }
          throw error
        } finally {
          abortBridge.cleanup()
        }
        return
      }
      if (pathname === getConfiguredMcpLegacySsePath()) {
        const config = getConfig()
        if (!config.mcp_config?.server?.enabled) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'MCP server is disabled.' }))
          return
        }

        if (!isLocalSecretRequestAuthorized(req.headers, getLocalMcpAuthToken())) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildMcpJsonRpcError(null, -32001, 'Unauthorized MCP request.')))
          return
        }

        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify(
              buildMcpJsonRpcError(
                null,
                -32000,
                'Legacy SSE MCP transport only accepts GET on the SSE endpoint.'
              )
            )
          )
          return
        }

        await handleMagicPotMcpLegacySseOpenRequest({
          req,
          res
        })
        return
      }

      if (pathname === getConfiguredMcpLegacySseMessagePath()) {
        const config = getConfig()
        if (!config.mcp_config?.server?.enabled) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'MCP server is disabled.' }))
          return
        }

        if (!isLocalSecretRequestAuthorized(req.headers, getLocalMcpAuthToken())) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildMcpJsonRpcError(null, -32001, 'Unauthorized MCP request.')))
          return
        }

        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify(
              buildMcpJsonRpcError(
                null,
                -32000,
                'Legacy SSE MCP transport only accepts POST on the message endpoint.'
              )
            )
          )
          return
        }

        let body = ''
        for await (const chunk of req) {
          body += chunk
        }

        await handleMagicPotMcpLegacySseMessageRequest({
          req,
          res,
          parsedBody: body ? JSON.parse(body) : undefined
        })
        return
      }

      if (pathname === getMcpServerPath()) {
        const config = getConfig()
        if (!config.mcp_config?.server?.enabled) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'MCP server is disabled.' }))
          return
        }

        if (!isLocalSecretRequestAuthorized(req.headers, getLocalMcpAuthToken())) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildMcpJsonRpcError(null, -32001, 'Unauthorized MCP request.')))
          return
        }

        let body = ''
        if (req.method === 'POST') {
          for await (const chunk of req) {
            body += chunk
          }
        }

        normalizeMcpAcceptHeader(req)
        await handleMagicPotMcpHttpBridgeRequest({
          req,
          res,
          parsedBody: body ? JSON.parse(body) : undefined
        })
        return
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found', path: pathname }))
    } catch (error) {
      console.error('[LLMProxyServer] Error:', error)
      if (res.headersSent || res.destroyed) return
      const errorBody =
        error instanceof HttpRequestError &&
        typeof (error as HttpRequestError & { body?: unknown }).body === 'string'
          ? (error as HttpRequestError & { body: string }).body
          : error &&
              typeof error === 'object' &&
              typeof (error as { body?: unknown }).body === 'string'
            ? (error as { body: string }).body
            : undefined
      const rawStatus =
        error instanceof HttpRequestError
          ? error.statusCode
          : error && typeof error === 'object'
            ? ((error as { status?: unknown; statusCode?: unknown }).status ??
              (error as { statusCode?: unknown }).statusCode)
            : undefined
      const statusCode =
        typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          ...(errorBody !== undefined ? { body: errorBody } : {})
        })
      )
    }
  })

  server.on('error', (error) => {
    console.error('[LLMProxyServer] Server error:', error)
    server = null
  })

  server.listen(port, bindHost, () => {
    const address = server?.address()
    const listeningPort = address && typeof address === 'object' ? address.port : port
    const displayHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost
    console.log('[LLMProxyServer] LLM proxy server started.')
    console.log(`[LLMProxyServer] URL: http://${displayHost}:${listeningPort}`)
    console.log(
      `[LLMProxyServer] OpenAI-compatible URL: http://${displayHost}:${listeningPort}/v1/chat/completions`
    )
  })
}

/**
 * Stop the LLM proxy HTTP server.
 */
export function stopLLMProxyServer(): void {
  if (server) {
    server.close()
    server = null
    console.log('[LLMProxyServer] Server stopped.')
  }
}

/**
 * Get the current server status.
 */
export function getLLMProxyServerStatus(): { running: boolean; port?: number } {
  const config = getConfig()
  const address = server?.address()
  const listeningPort = address && typeof address === 'object' ? address.port : undefined
  return {
    running: server !== null,
    port: listeningPort ?? config.local_llm_server_config?.port
  }
}
