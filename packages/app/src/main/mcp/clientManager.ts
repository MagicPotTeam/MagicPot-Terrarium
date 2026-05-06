import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpClientConnectionSnapshot } from '@shared/api/svcState'
import { Config, McpExternalServerConfig } from '@shared/config/config'
import { createAbortError, isAbortError, throwIfAborted } from '@shared/agent'

type ExternalToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

type ExternalToolCallResult = {
  content: string
  metadata?: Record<string, unknown>
}

type ManagedServerStatus = 'connecting' | 'connected' | 'error'

type ManagedServerState = {
  id: string
  aliasPrefix: string
  configSignature: string
  config: McpExternalServerConfig
  status: ManagedServerStatus
  client?: Client
  transport?: {
    close(): Promise<void>
  }
  tools: Array<
    ExternalToolDefinition & {
      originalName: string
    }
  >
  lastError?: string
}

const DEFAULT_STARTUP_TIMEOUT_MS = 8000
const DEFAULT_REQUEST_TIMEOUT_MS = 12000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> => {
  throwIfAborted(signal)

  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
        if (signal) {
          abortHandler = () => reject(createAbortError(signal.reason))
          signal.addEventListener('abort', abortHandler, { once: true })
        }
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler)
    }
  }
}

const toConfigSignature = (config: McpExternalServerConfig): string =>
  JSON.stringify({
    id: config.id,
    enabled: config.enabled,
    transport: config.transport,
    command: config.command,
    args: config.args || [],
    cwd: config.cwd || '',
    env: config.env || {},
    url: config.url || '',
    headers: config.headers || {},
    toolPrefix: config.toolPrefix || '',
    startupTimeoutMs: config.startupTimeoutMs || 0,
    requestTimeoutMs: config.requestTimeoutMs || 0
  })

const buildAliasPrefix = (config: McpExternalServerConfig): string =>
  String(config.toolPrefix || `mcp.${config.id}`).trim()

const normalizeInputSchema = (schema: unknown): Record<string, unknown> | null => {
  if (!isRecord(schema)) return null
  if (schema.type !== 'object') return null
  if (schema.properties !== undefined && !isRecord(schema.properties)) return null
  if (schema.required !== undefined && !Array.isArray(schema.required)) return null
  return schema
}

const renderToolContent = (content: unknown): string => {
  if (!Array.isArray(content) || content.length === 0) {
    return 'The MCP tool returned no content.'
  }

  return content
    .map((item) => {
      if (!isRecord(item)) return JSON.stringify(item)
      if (item.type === 'text' && typeof item.text === 'string') {
        return item.text
      }
      return JSON.stringify(item, null, 2)
    })
    .join('\n\n')
}

export class McpClientManager {
  private readonly clients = new Map<string, ManagedServerState>()

  async sync(config: Config): Promise<void> {
    const desiredServers = (config.mcp_config?.client?.servers || []).filter(
      (server) => server.enabled && String(server.id || '').trim()
    )
    const desiredIds = new Set(desiredServers.map((server) => server.id))

    const removedIds = [...this.clients.keys()].filter((id) => !desiredIds.has(id))
    for (const id of removedIds) {
      await this.disconnectServer(id)
    }

    for (const serverConfig of desiredServers) {
      const configSignature = toConfigSignature(serverConfig)
      const existing = this.clients.get(serverConfig.id)
      if (existing?.configSignature === configSignature && existing.status === 'connected') {
        continue
      }

      await this.connectServer(serverConfig, configSignature)
    }
  }

  listToolsSnapshot(): ExternalToolDefinition[] {
    return [...this.clients.values()].flatMap((state) =>
      state.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    )
  }

  listConnections(): McpClientConnectionSnapshot[] {
    return [...this.clients.values()].map((state) => ({
      id: state.id,
      aliasPrefix: state.aliasPrefix,
      status: state.status,
      toolCount: state.tools.length,
      toolAliases: state.tools.map((tool) => tool.name),
      transport: state.config.transport,
      ...(state.lastError ? { lastError: state.lastError } : {})
    }))
  }

  async callToolByAlias(
    alias: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ExternalToolCallResult | null> {
    throwIfAborted(signal)

    for (const state of this.clients.values()) {
      const tool = state.tools.find((item) => item.name === alias)
      if (!tool) continue
      if (!state.client) {
        throw new Error(`MCP server "${state.id}" is not connected.`)
      }

      const requestTimeoutMs = Math.max(
        1000,
        Number(state.config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)
      )

      try {
        const result = await withTimeout(
          state.client.callTool({
            name: tool.originalName,
            arguments: args || {}
          }),
          requestTimeoutMs,
          `MCP tool ${alias}`,
          signal
        )

        return {
          content: renderToolContent(result.content),
          metadata: {
            serverId: state.id,
            toolName: tool.originalName,
            alias,
            isError: Boolean(result.isError),
            ...(isRecord(result.structuredContent)
              ? { structuredContent: result.structuredContent }
              : {})
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }
        state.status = 'error'
        state.lastError = error instanceof Error ? error.message : String(error)
        throw new Error(`MCP tool "${alias}" failed: ${state.lastError}`)
      }
    }

    return null
  }

  async stop(): Promise<void> {
    const ids = [...this.clients.keys()]
    for (const id of ids) {
      await this.disconnectServer(id)
    }
  }

  private async connectServer(
    config: McpExternalServerConfig,
    configSignature: string
  ): Promise<void> {
    await this.disconnectServer(config.id)

    const aliasPrefix = buildAliasPrefix(config)
    const state: ManagedServerState = {
      id: config.id,
      aliasPrefix,
      configSignature,
      config,
      status: 'connecting',
      tools: []
    }
    this.clients.set(config.id, state)

    let transport: ReturnType<McpClientManager['createTransport']> | undefined

    try {
      transport = this.createTransport(config)
      const client = this.createClient()
      const startupTimeoutMs = Math.max(
        1000,
        Number(config.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS)
      )

      await withTimeout(client.connect(transport), startupTimeoutMs, `MCP server ${config.id}`)
      const listedTools = await withTimeout(
        client.listTools(),
        startupTimeoutMs,
        `MCP tool discovery for ${config.id}`
      )

      const tools = listedTools.tools
        .map((tool) => {
          const normalizedInputSchema = normalizeInputSchema(tool.inputSchema)
          if (!normalizedInputSchema) {
            return null
          }

          return {
            originalName: tool.name,
            name: `${aliasPrefix}.${tool.name}`,
            description: String(tool.description || `MCP tool from ${config.id}`),
            inputSchema: normalizedInputSchema
          }
        })
        .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))

      state.client = client
      state.transport = transport
      state.tools = tools
      state.status = 'connected'
      state.lastError = undefined
    } catch (error) {
      state.status = 'error'
      state.lastError = error instanceof Error ? error.message : String(error)
      state.tools = []
      await transport?.close().catch(() => undefined)
      delete state.transport
      delete state.client
    }
  }

  protected createClient(): Client {
    return new Client({
      name: 'magicpot-mcp-client',
      version: '1.0.0'
    })
  }

  protected createTransport(config: McpExternalServerConfig) {
    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error(`MCP stdio server "${config.id}" is missing a command.`)
      }

      return new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.env ? { env: config.env } : {}),
        stderr: 'pipe'
      })
    }

    if (!config.url) {
      throw new Error(`MCP HTTP server "${config.id}" is missing a url.`)
    }

    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: config.headers || {}
      }
    })
  }

  private async disconnectServer(id: string): Promise<void> {
    const existing = this.clients.get(id)
    if (!existing) return

    if (existing.transport) {
      await existing.transport.close().catch(() => undefined)
    }

    this.clients.delete(id)
  }
}
