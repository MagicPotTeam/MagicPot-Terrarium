// LLM proxy HTTP server
// Allows AIEngine to act as a server that receives LLM requests from other clients.

import http from 'http'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { app } from 'electron'
import { buildMagicPotAppCatalogSnapshot } from '@shared/app/catalog'
import { type LLMProxyAccessTokenEntry } from '@shared/config/config'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { ChatMessage, LLMChatSkillRuntime, type LLMProfileScope } from '@shared/api/svcLLMProxy'
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

let server: http.Server | null = null
let llmProxySvc: LLMProxySvcImpl | null = null
const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
const CANVAS_SYNC_REMOVED_ERROR =
  'Canvas mirroring has been removed. Remote agents can only access content explicitly attached to the current request.'

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
  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for'])
  const candidate =
    cleanString(forwardedFor?.split(',')[0]) || cleanString(req.socket.remoteAddress)
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

const isLocalSecretRequestAuthorized = (
  headers: Record<string, string | string[] | undefined>,
  secret?: string | null
): boolean => {
  const normalizedSecret = cleanString(secret)
  if (!normalizedSecret) return true

  const authorizationToken = getBearerToken(headers.authorization)
  if (authorizationToken === normalizedSecret) {
    return true
  }

  const customToken =
    firstHeaderValue(headers['x-magicpot-bot-secret']) || firstHeaderValue(headers['x-bot-secret'])
  return customToken === normalizedSecret
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
    getBearerToken(headers.authorization) || firstHeaderValue(headers['x-magicpot-proxy-token'])

  if (!requestedToken) {
    return null
  }

  const matched = configuredTokens.find((entry) => entry.token === requestedToken)
  return matched || null
}

const writeUnauthorizedLlmProxyResponse = (res: http.ServerResponse): void => {
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      error:
        'Unauthorized LLM proxy request. Provide Authorization: Bearer <token> or X-MagicPot-Proxy-Token.'
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

  const port = config.local_llm_server_config.port ?? 3721

  if (server) {
    console.log('[LLMProxyServer] Server is already running.')
    return
  }

  server = http.createServer(async (req, res) => {
    // CORS support.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-MagicPot-Bot-Secret, X-Bot-Secret, X-MagicPot-Proxy-Token'
    )

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const pathname = url.pathname

    try {
      // Health check.
      if (pathname === '/api/status' && req.method === 'GET') {
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
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(status))
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
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*'
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
        res.writeHead(410, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: CANVAS_SYNC_REMOVED_ERROR }))
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
        let body = ''
        for await (const chunk of req) {
          body += chunk
        }
        const reqData = JSON.parse(body) as {
          messages: ChatMessage[]
          route?: {
            channel?: string
            scopeType?: AssistantScopeType
            scopeId?: string
            threadId?: string
            senderId?: string
            senderName?: string
          }
          systemPrompt?: string
          skillRuntime?: LLMChatSkillRuntime
          profileId?: string
          profileScope?: LLMProfileScope
          sessionUrl?: string
          conversationId?: string
        }
        const abortBridge = createRequestAbortBridge(req, res)
        try {
          const normalizedRoute = reqData.route
            ? normalizeAssistantRouteInput(reqData.route)
            : undefined
          recordLlmProxyAccessUsage(accessIdentity, {
            activity: 'chat',
            requesterAddress: getRequesterAddress(req),
            profileId: reqData.profileId
          })
          const result = await getLLMProxySvc().chat(
            {
              messages: reqData.messages,
              route: normalizedRoute,
              systemPrompt: reqData.systemPrompt,
              skillRuntime: reqData.skillRuntime,
              profileId: reqData.profileId,
              profileScope: reqData.profileScope,
              sessionUrl: reqData.sessionUrl,
              conversationId: namespaceProxyConversationId(accessIdentity, reqData.conversationId)
            },
            {
              signal: abortBridge.signal
            }
          )
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
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
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
        try {
          const config = getConfig()
          const shouldUseQAppProfileScope = Boolean(
            reqData.model &&
            (config.plugin_config?.api_profiles || []).some(
              (profile) => profile.id === reqData.model
            )
          )
          recordLlmProxyAccessUsage(accessIdentity, {
            activity: 'openai',
            requesterAddress: getRequesterAddress(req),
            profileId: reqData.model
          })
          const result = await getLLMProxySvc().chat(
            {
              messages,
              systemPrompt,
              profileId: reqData.model, // Map the OpenAI model field onto profileId.
              profileScope: shouldUseQAppProfileScope ? 'qapp' : undefined
            },
            {
              signal: abortBridge.signal
            }
          )
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
            model: reqData.model || 'unknown',
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
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })
      )
    }
  })

  server.on('error', (error) => {
    console.error('[LLMProxyServer] Server error:', error)
    server = null
  })

  server.listen(port, '0.0.0.0', () => {
    const address = server?.address()
    const listeningPort = address && typeof address === 'object' ? address.port : port
    const localIP = getLocalIPAddress()
    console.log('[LLMProxyServer] LLM proxy server started.')
    console.log(`[LLMProxyServer] Local URL: http://localhost:${listeningPort}`)
    console.log(`[LLMProxyServer] LAN URL: http://${localIP}:${listeningPort}`)
    console.log(
      `[LLMProxyServer] OpenAI-compatible URL: http://${localIP}:${listeningPort}/v1/chat/completions`
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
