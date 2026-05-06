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

type LegacySseSessionRecord = {
  transport: SSEServerTransport
  server: ReturnType<typeof createMagicPotMcpServer>
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
  await existing.server.close().catch(() => undefined)
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

  const transport = new SSEServerTransport(getConfiguredMcpLegacySseMessagePath(), options.res)
  const server = createMagicPotMcpServer({
    configProvider: () => getConfig()
  })

  legacySseSessions.set(transport.sessionId, {
    transport,
    server
  })
  transport.onclose = () => {
    void cleanupLegacySseSession(transport.sessionId)
  }

  try {
    await server.connect(transport)
  } catch (error) {
    legacySseSessions.delete(transport.sessionId)
    await server.close().catch(() => undefined)
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

  await existing.transport.handlePostMessage(options.req, options.res, options.parsedBody)
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
