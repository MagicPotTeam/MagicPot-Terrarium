import type http from 'node:http'
import type { Config } from '@shared/config/config'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMagicPotMcpServer } from '../serverBridge'

export const handleManagedMagicPotMcpHttpBridgeRequest = async (options: {
  req: http.IncomingMessage
  res: http.ServerResponse
  parsedBody?: unknown
  configProvider: () => Config
}): Promise<void> => {
  // SDK 1.29.0 requires a fresh stateless transport per request.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  })
  const server = createMagicPotMcpServer({
    configProvider: options.configProvider
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(options.req, options.res, options.parsedBody)
  } finally {
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}
