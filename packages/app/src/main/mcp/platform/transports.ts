import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpTransportSnapshot } from '@shared/agent/mcpPlatform'

export type MagicPotMcpServerBundle = {
  server: McpServer
  connectStdio(): Promise<{
    transport: StdioServerTransport
    snapshot: McpTransportSnapshot
    close(): Promise<void>
  }>
  connectStreamableHttp(options: {
    host?: string
    port: number
    path: string
    sessionIdGenerator?: () => string
    transportOptions?: StreamableHTTPServerTransportOptions
  }): Promise<{
    server: HttpServer
    transport: StreamableHTTPServerTransport
    snapshot: McpTransportSnapshot
    stop(): Promise<void>
  }>
}

export const createMagicPotMcpServerBundle = (
  name: string,
  version: string
): MagicPotMcpServerBundle => {
  const server = new McpServer({
    name,
    version
  })

  return {
    server,
    async connectStdio() {
      const transport = new StdioServerTransport()
      await server.connect(transport)
      return {
        transport,
        snapshot: {
          kind: 'stdio',
          status: 'ready'
        },
        async close() {
          await transport.close()
        }
      }
    },
    async connectStreamableHttp(options) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: options.sessionIdGenerator ?? randomUUID,
        ...(options.transportOptions || {})
      })
      const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        void transport.handleRequest(req, res)
      })

      await new Promise<void>((resolve) => {
        httpServer.listen(options.port, options.host, resolve)
      })
      await server.connect(transport)

      const address = httpServer.address()
      const endpoint =
        typeof address === 'object' && address
          ? `http://${options.host || '127.0.0.1'}:${address.port}${options.path}`
          : undefined

      return {
        server: httpServer,
        transport,
        snapshot: {
          kind: 'streamable-http',
          status: 'ready',
          ...(endpoint ? { endpoint } : {})
        },
        async stop() {
          await transport.close().catch(() => undefined)
          await new Promise<void>((resolve) => httpServer.close(() => resolve()))
        }
      }
    }
  }
}
