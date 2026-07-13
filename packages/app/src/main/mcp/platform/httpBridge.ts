import type http from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { getAssistantRuntime } from '../../assistantRuntime/runtime'
import { getConfig } from '../../config/config'
import { createMagicPotMcpServer } from '../serverBridge'
import {
  appendMagicPotMcpAudit,
  getMagicPotMcpPlatformRuntime,
  refreshMagicPotMcpPlatformRuntime
} from './runtime'

const getConfiguredMcpPath = (): string =>
  String(getConfig().mcp_config?.server?.path || '/api/mcp').trim() || '/api/mcp'

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

export const getConfiguredMcpLegacySsePath = (): string =>
  `${trimTrailingSlash(getConfiguredMcpPath())}/sse`

export const getConfiguredMcpLegacySseMessagePath = (): string =>
  `${trimTrailingSlash(getConfiguredMcpPath())}/messages`

export const LEGACY_SSE_MAX_SESSIONS = 100
export const LEGACY_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000

type LegacySseSessionRecord = {
  transport: SSEServerTransport
  server: ReturnType<typeof createMagicPotMcpServer>
  lastActivityAt: number
  idleTimer: ReturnType<typeof setTimeout>
  removeLifecycleListeners: () => void
}

const legacySseSessions = new Map<string, LegacySseSessionRecord>()

const parseRequestUrl = (req: http.IncomingMessage): URL =>
  new URL(String(req.url || '/'), 'http://localhost')

const getLegacySseSessionId = (req: http.IncomingMessage): string | undefined => {
  const sessionId = String(parseRequestUrl(req).searchParams.get('sessionId') || '').trim()
  return sessionId || undefined
}

const cleanupLegacySseSession = async (sessionId: string): Promise<void> => {
  const existing = legacySseSessions.get(sessionId)
  if (!existing) {
    return
  }

  legacySseSessions.delete(sessionId)
  clearTimeout(existing.idleTimer)
  existing.removeLifecycleListeners()
  await existing.server.close().catch(() => undefined)
}

const refreshLegacySseSessionIdleTimer = (sessionId: string): void => {
  const existing = legacySseSessions.get(sessionId)
  if (!existing) {
    return
  }

  existing.lastActivityAt = Date.now()
  clearTimeout(existing.idleTimer)
  existing.idleTimer = setTimeout(() => {
    void cleanupLegacySseSession(sessionId)
  }, LEGACY_SSE_IDLE_TIMEOUT_MS)
  existing.idleTimer.unref?.()
}

export const closeMagicPotMcpLegacySseSessions = async (): Promise<void> => {
  await Promise.all([...legacySseSessions.keys()].map(cleanupLegacySseSession))
}

export const handleMagicPotMcpLegacySseOpenRequest = async (options: {
  req: http.IncomingMessage
  res: http.ServerResponse
}): Promise<void> => {
  const config = getConfig()

  options.res.setHeader('X-Accel-Buffering', 'no')
  options.res.setHeader('Cache-Control', 'no-cache, no-transform')

  refreshMagicPotMcpPlatformRuntime(config, {
    toolCatalog: getAssistantRuntime().listTools()
  })
  appendMagicPotMcpAudit({
    actor: 'http:mcp',
    action: 'transport.request',
    target: getConfiguredMcpLegacySsePath(),
    decision: 'allow',
    metadata: {
      method: options.req.method || 'GET',
      transport: 'legacy-sse'
    }
  })

  if (legacySseSessions.size >= LEGACY_SSE_MAX_SESSIONS) {
    options.res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' })
    options.res.end(JSON.stringify({ error: 'Legacy SSE session capacity reached.' }))
    return
  }

  const transport = new SSEServerTransport(getConfiguredMcpLegacySseMessagePath(), options.res)
  const server = createMagicPotMcpServer({
    configProvider: () => getConfig()
  })
  const sessionId = transport.sessionId
  const cleanup = (): void => {
    void cleanupLegacySseSession(sessionId)
  }
  const cleanupOnRequestClose = (): void => {
    if (!options.req.complete || options.res.destroyed) {
      cleanup()
    }
  }
  const lifecycleEvents = [
    [options.req, 'aborted'],
    [options.req, 'error'],
    [options.res, 'close'],
    [options.res, 'error']
  ] as const
  for (const [emitter, event] of lifecycleEvents) {
    emitter.once(event, cleanup)
  }
  options.req.once('close', cleanupOnRequestClose)

  legacySseSessions.set(sessionId, {
    transport,
    server,
    lastActivityAt: Date.now(),
    idleTimer: setTimeout(cleanup, LEGACY_SSE_IDLE_TIMEOUT_MS),
    removeLifecycleListeners: () => {
      for (const [emitter, event] of lifecycleEvents) {
        emitter.removeListener(event, cleanup)
      }
      options.req.removeListener('close', cleanupOnRequestClose)
    }
  })
  legacySseSessions.get(sessionId)?.idleTimer.unref?.()
  transport.onclose = cleanup

  try {
    await server.connect(transport)
  } catch (error) {
    await cleanupLegacySseSession(sessionId)
    throw error
  }
}

export const handleMagicPotMcpLegacySseMessageRequest = async (options: {
  req: http.IncomingMessage
  res: http.ServerResponse
  parsedBody?: unknown
}): Promise<void> => {
  const config = getConfig()

  refreshMagicPotMcpPlatformRuntime(config, {
    toolCatalog: getAssistantRuntime().listTools()
  })

  const sessionId = getLegacySseSessionId(options.req)
  appendMagicPotMcpAudit({
    actor: 'http:mcp',
    action: 'transport.request',
    target: getConfiguredMcpLegacySseMessagePath(),
    decision: sessionId && legacySseSessions.has(sessionId) ? 'allow' : 'deny',
    metadata: {
      method: options.req.method || 'POST',
      transport: 'legacy-sse',
      ...(sessionId ? { sessionId } : {})
    }
  })

  if (!sessionId) {
    options.res.writeHead(400, { 'Content-Type': 'application/json' })
    options.res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Missing legacy SSE sessionId.'
        },
        id: null
      })
    )
    return
  }

  const existing = legacySseSessions.get(sessionId)
  if (!existing) {
    options.res.writeHead(400, { 'Content-Type': 'application/json' })
    options.res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `No legacy SSE transport found for sessionId: ${sessionId}`
        },
        id: null
      })
    )
    return
  }

  refreshLegacySseSessionIdleTimer(sessionId)

  const cleanupOnAborted = (): void => {
    void cleanupLegacySseSession(sessionId)
  }
  options.req.once('aborted', cleanupOnAborted)
  options.req.once('error', cleanupOnAborted)
  options.res.once('error', cleanupOnAborted)

  try {
    await existing.transport.handlePostMessage(options.req, options.res, options.parsedBody)
    refreshLegacySseSessionIdleTimer(sessionId)
  } finally {
    options.req.removeListener('aborted', cleanupOnAborted)
    options.req.removeListener('error', cleanupOnAborted)
    options.res.removeListener('error', cleanupOnAborted)
  }
}

export const handleMagicPotMcpHttpBridgeRequest = async (options: {
  req: http.IncomingMessage
  res: http.ServerResponse
  parsedBody?: unknown
}): Promise<void> => {
  const config = getConfig()

  refreshMagicPotMcpPlatformRuntime(config, {
    toolCatalog: getAssistantRuntime().listTools()
  })
  appendMagicPotMcpAudit({
    actor: 'http:mcp',
    action: 'transport.request',
    target: getConfiguredMcpPath(),
    decision: 'allow',
    metadata: {
      method: options.req.method || 'POST'
    }
  })

  await getMagicPotMcpPlatformRuntime().handleStreamableHttpRequest({
    ...options,
    endpoint: getConfiguredMcpPath()
  })
}
