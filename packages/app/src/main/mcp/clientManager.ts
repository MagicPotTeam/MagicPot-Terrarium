import { assertMcpArguments, cloneBoundedMcpJson, prepareMcpSchema } from '@shared/api/agentThreadMcp'
import type { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ClientRequest } from '@modelcontextprotocol/sdk/types.js'
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpClientConnectionSnapshot, type McpClientConnectionStatus } from '@shared/api/svcState'
import { normalizeMagicPotToolName } from '@shared/app/types'
import { Config, McpExternalServerConfig } from '@shared/config/config'
import { createAbortError, isAbortError, throwIfAborted } from '@shared/agent'

export type McpClientToolPolicy = Readonly<{
  authorize(input: { alias: string; serverId: string }): { allowed: boolean; reason?: string }
  audit(input: {
    alias: string
    serverId: string
    decision: 'allow' | 'deny'
    reason?: string
  }): void
}>

const ALLOW_ALL_POLICY: McpClientToolPolicy = {
  authorize: () => ({ allowed: true }),
  audit: () => undefined
}

type ExternalToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

type ExternalToolCallResult = {
  content: string
  metadata?: Record<string, unknown>
}

export type McpPinnedTool = Readonly<{
  serverId: string
  connectionId: string
  configDigest: string
  toolDigest: string
  name: string
  alias: string
  description: string
  inputSchema: Record<string, unknown>
}>
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const mcpServerConfigDigest = (config: McpExternalServerConfig): string => digest(mcpServerConfigSignature(config))
const toolDigest = (tool: Pick<ManagedServerState['tools'][number], 'originalName' | 'name' | 'description' | 'inputSchema'>): string => digest(JSON.stringify([tool.originalName, tool.name, tool.description, tool.inputSchema]))

type ManagedServerStatus = McpClientConnectionStatus
export type McpConnectionIdentity = { serverId: string; revision: string; connectionId: string | null; configDigest: string | null; status: ManagedServerStatus | 'absent'; suppressed: boolean }
export type McpConnectionControl = {
  serverId: string; configDigest: string; expected: McpConnectionIdentity; action: 'connect' | 'disconnect'
  config(): Config; signal: AbortSignal; beforeDispatch(): void; assertLive(): void
}

type ManagedServerState = {
  id: string
  aliasPrefix: string
  configSignature: string
  connectionId: string
  config: McpExternalServerConfig
  status: ManagedServerStatus
  client?: Client
  transport?: {
    close(): Promise<void>
  }
  tools: Array<
    ExternalToolDefinition & {
      originalName: string
      digest: string
    }
  >
  closeOperation?: Promise<void>
  closeConfirmed?: Promise<void>
  requireCloseEvent?: boolean
  transportClosed?: boolean
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
  let settled = false

  // Keep the settlement gate explicit. MCP transports may reject after a
  // timeout or cancellation; the late rejection remains observed while the
  // caller receives exactly one deterministic outcome.
  try {
    return await new Promise<T>((resolve, reject) => {
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        callback()
      }

      // Promise.resolve observes both normal and late rejection paths. Once a
      // timeout/abort has settled the outer promise, the rejection handler is
      // still attached and simply returns.
      Promise.resolve(promise).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )

      timer = setTimeout(
        () => finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`))),
        timeoutMs
      )
      if (signal) {
        abortHandler = () => finish(() => reject(createAbortError(signal.reason)))
        signal.addEventListener('abort', abortHandler, { once: true })
        // The signal can transition between the initial check and listener
        // registration. Re-check after subscribing so that race is covered.
        if (signal.aborted) abortHandler()
      }
    })
  } finally {
    settled = true
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler)
    }
  }
}

export const mcpServerConfigSignature = (config: McpExternalServerConfig): string =>
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
    requestTimeoutMs: config.requestTimeoutMs || 0,
    autoConnect: config.autoConnect !== false
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

export const MCP_CATALOG_LIMITS = { pages: 32, cursorBytes: 1024, tools: 256, bytes: 512 * 1024 } as const
// Only locally chosen, cursor-free messages may reach connection discovery state.
class McpCatalogError extends Error {}
export function assertBoundedMcpCatalog(result: unknown): void {
  if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.length > MCP_CATALOG_LIMITS.tools) throw new McpCatalogError('MCP catalog exceeds the 256-tool limit.')
  let bytes = 0
  const names = new Set<string>()
  for (const tool of result.tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 128) throw new McpCatalogError('Invalid bounded MCP tool identity.')
    const identity = normalizeMagicPotToolName(tool.name)
    if (!identity || names.has(identity)) throw new McpCatalogError('MCP catalog contains ambiguous tool identities.')
    names.add(identity)
    bytes += Buffer.byteLength(tool.name, 'utf8')
    if (typeof tool.description === 'string') {
      if (tool.description.length > 16000) throw new McpCatalogError('MCP tool description exceeds limit.')
      bytes += Buffer.byteLength(tool.description, 'utf8')
    }
    for (const key of ['inputSchema', 'outputSchema']) {
      if (tool[key] === undefined) continue
      let schema: unknown
      try { schema = cloneBoundedMcpJson(tool[key], 65536) } catch { throw new McpCatalogError('MCP catalog schema is invalid or exceeds bounded limits.') }
      bytes += Buffer.byteLength(JSON.stringify(schema), 'utf8')
      if (bytes > MCP_CATALOG_LIMITS.bytes) throw new McpCatalogError('MCP catalog schemas exceed the 512 KiB aggregate limit.')
    }
  }
  if (bytes > MCP_CATALOG_LIMITS.bytes) throw new McpCatalogError('MCP catalog exceeds the 512 KiB aggregate limit.')
}

/** Aggregate inside request(), so SDK listTools caches metadata once for the complete catalog. */
export class BoundedMcpClient extends Client {
  constructor(info: ConstructorParameters<typeof Client>[0], options?: ConstructorParameters<typeof Client>[1], private readonly assertCatalogCurrent: () => void = () => undefined) { super(info, options) }
  override async request<T extends AnySchema>(request: ClientRequest, schema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
    if (request.method !== 'tools/list') return super.request(request, schema, options)
    // This is connection-time full discovery, never arbitrary cursor navigation.
    if (request.params?.cursor !== undefined) throw new McpCatalogError('MCP catalog discovery must start at the first page.')
    const timeout = Math.min(options?.timeout ?? DEFAULT_STARTUP_TIMEOUT_MS, options?.maxTotalTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS)
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) throw new McpCatalogError('Invalid bounded MCP catalog timeout.')
    const deadline = performance.now() + timeout
    const current = () => {
      options?.signal?.throwIfAborted(); this.assertCatalogCurrent()
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) throw new McpCatalogError('MCP catalog discovery timed out before completion.')
      return remaining
    }
    const tools: unknown[] = [], seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MCP_CATALOG_LIMITS.pages; page++) {
      const remaining = current()
      let result: SchemaOutput<T>
      // SDK request keeps an abort listener on its supplied signal. A per-page
      // signal avoids retaining all completed request handlers on startupSignal.
      const pageController = new AbortController()
      const abortPage = () => pageController.abort(new Error('MCP catalog discovery cancelled.'))
      options?.signal?.addEventListener('abort', abortPage, { once: true })
      if (options?.signal?.aborted) abortPage()
      try {
        result = await super.request({ ...request, params: { ...request.params, ...(cursor === undefined ? {} : { cursor }) } }, schema, {
          ...options, signal: pageController.signal, timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false
        })
      } catch { throw new McpCatalogError('MCP catalog discovery failed or returned an invalid page.') }
      finally { options?.signal?.removeEventListener('abort', abortPage) }
      current()
      assertBoundedMcpCatalog(result)
      const listed = result as { tools: unknown[]; nextCursor?: unknown }
      if (tools.length + listed.tools.length > MCP_CATALOG_LIMITS.tools) throw new McpCatalogError('MCP catalog exceeds the 256-tool limit.')
      tools.push(...listed.tools)
      assertBoundedMcpCatalog({ tools })
      current()
      const next = listed.nextCursor
      if (next === undefined) return { tools } as SchemaOutput<T>
      if (typeof next !== 'string' || !next.length || Buffer.byteLength(next, 'utf8') > MCP_CATALOG_LIMITS.cursorBytes || seen.has(next)) throw new McpCatalogError('MCP catalog has an invalid, repeated or oversized continuation cursor.')
      seen.add(next); cursor = next // Opaque: do not trim, normalize, log or return it.
    }
    throw new McpCatalogError('MCP catalog exceeds the 32-page limit.')
  }
}

export class ObservedStdioClientTransport extends StdioClientTransport {
  startOutcome: 'not-started' | 'starting' | 'started' | 'failed-without-child' | 'failed-with-child' = 'not-started'
  private hadPid = false
  override async start(): Promise<void> {
    this.startOutcome = 'starting'
    try {
      const started = super.start()
      this.hadPid ||= this.pid !== null
      await started
      this.hadPid ||= this.pid !== null
      this.startOutcome = 'started'
    } catch (error) {
      this.hadPid ||= this.pid !== null
      this.startOutcome = this.hadPid ? 'failed-with-child' : 'failed-without-child'
      throw error
    }
  }
}

export class McpClientManager {
  private readonly clients = new Map<string, ManagedServerState>()
  private lifecycle: Promise<unknown> = Promise.resolve()
  private suppressed = new Set<string>()
  private pendingControls = 0
  private syncSignature = ''
  private syncController = new AbortController()
  private revisions = new Map<string, string>()
  private bump(id: string): void {
    if (!this.revisions.has(id) && this.revisions.size >= 128) throw new Error('MCP service lifecycle capacity reached; restart to clear retired identities.')
    this.revisions.set(id, randomUUID())
  }
  /** Passive read: discovery must not allocate a lifecycle revision. */
  isConnectionSuppressed(serverId: string): boolean { return this.suppressed.has(serverId) }
  connectionIdentity(serverId: string): McpConnectionIdentity {
    if (!this.revisions.has(serverId)) this.bump(serverId)
    const state = this.clients.get(serverId)
    return { serverId, revision: this.revisions.get(serverId)!, connectionId: state?.connectionId ?? null, configDigest: state ? digest(state.configSignature) : null, status: state?.status ?? 'absent', suppressed: this.suppressed.has(serverId) }
  }
  /** Main-only service control: config resolver and dispatch permit are not model inputs. */
  async controlConnection(input: McpConnectionControl): Promise<McpConnectionIdentity> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120000)])
    signal.throwIfAborted()
    const expected = structuredClone(input.expected)
    if (this.pendingControls >= 4) throw new Error('MCP connection management queue capacity reached.')
    this.pendingControls++
    const operation = this.serializeLifecycle(async () => {
      const currentConfig = () => {
        signal.throwIfAborted(); input.assertLive()
        const config = input.config(), matches = (config.mcp_config?.client?.servers ?? []).filter((server) => server.id === input.serverId)
        const server = matches[0]
        if (config.use_remote_llm || matches.length !== 1 || server.enabled !== true || server.agentThreadManage !== true || !['discover', 'call'].includes(server.agentThreadAccess ?? '') || mcpServerConfigDigest(server) !== input.configDigest) throw new Error('MCP connection management configuration changed or is not authorized.')
        return structuredClone(server)
      }
      const server = currentConfig()
      if (JSON.stringify(this.connectionIdentity(input.serverId)) !== JSON.stringify(expected)) throw new Error('MCP service identity changed while awaiting connection permission.')
      const existing = this.clients.get(input.serverId)
      if (existing && ['closing', 'close-unconfirmed', 'connecting'].includes(existing.status)) throw new Error('MCP service lifecycle is unresolved; no new connection operation is allowed.')
      if (input.action === 'connect' && existing?.status === 'connected' && existing.configSignature === mcpServerConfigSignature(server)) return this.connectionIdentity(input.serverId)
      input.beforeDispatch(); currentConfig()
      this.bump(input.serverId)
      if (input.action === 'disconnect') {
        // Sticky for this manager lifetime: stale global sync/config/status calls cannot undo it.
        this.suppressed.add(input.serverId)
        if (existing) await this.disconnectServer(input.serverId, true)
        return this.connectionIdentity(input.serverId)
      }
      try {
        // Closing an older error transport may await: recheck immediately before launch.
        this.suppressed.delete(input.serverId)
        await this.connectServer(server, mcpServerConfigSignature(server), signal, () => { currentConfig() })
        currentConfig()
        const state = this.clients.get(input.serverId)
        if (!state || state.status !== 'connected') throw new Error('MCP connection failed; no tools are available.')
        return this.connectionIdentity(input.serverId)
      } catch (error) {
        this.suppressed.add(input.serverId)
        const state = this.clients.get(input.serverId)
        if (state && state.status !== 'close-unconfirmed') await this.disconnectServer(input.serverId, true).catch(() => undefined)
        throw error
      }
    }).finally(() => { this.pendingControls-- })
    // Caller cancellation is prompt; serialized cleanup retains ownership until settled.
    return withTimeout(operation, 125000, 'MCP connection management', signal)
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation)
    this.lifecycle = next.catch(() => undefined)
    return next
  }

  constructor(private readonly toolPolicy: McpClientToolPolicy = ALLOW_ALL_POLICY, private readonly liveConfig?: () => Config) {}

  async sync(config: Config): Promise<void> {
    const snapshot = structuredClone((this.liveConfig?.() ?? config).mcp_config?.client?.servers || [])
    const signature = JSON.stringify(snapshot)
    if (signature !== this.syncSignature) {
      this.syncController.abort(new Error('MCP automatic sync configuration superseded.'))
      this.syncController = new AbortController(); this.syncSignature = signature
    }
    const signal = this.syncController.signal
    if (snapshot.length > 128) throw new Error('MCP configured service limit exceeded.')
    if (new Set(snapshot.map((server) => server.id)).size !== snapshot.length) throw new Error('Duplicate MCP server IDs are not allowed.')
    return this.serializeLifecycle(() => signal.aborted ? Promise.resolve() : this.syncServers(snapshot, signal))
  }

  private async syncServers(servers: McpExternalServerConfig[], signal: AbortSignal): Promise<void> {
    const desiredServers = servers.filter(
      (server) => server.enabled && String(server.id || '').trim()
    )
    const desiredIds = new Set(desiredServers.map((server) => server.id))

    const stillCurrent = (server: McpExternalServerConfig) => {
      if (signal.aborted) return false
      if (!this.liveConfig) return true
      const current = (this.liveConfig().mcp_config?.client?.servers ?? []).filter((item) => item.id === server.id)
      return current.length === 1 && current[0].enabled === true && mcpServerConfigSignature(current[0]) === mcpServerConfigSignature(server)
    }
    const removedIds = [...this.clients.keys()].filter((id) => !desiredIds.has(id))
    for (const id of removedIds) {
      if (signal.aborted) return
      // A stale removal must not close a newly approved current service either.
      if (this.liveConfig && this.liveConfig().mcp_config?.client?.servers.some((item) => item.id === id && item.enabled)) continue
      if (this.clients.get(id)?.status === 'close-unconfirmed') continue
      await this.disconnectServer(id).catch(() => undefined)
    }

    for (const serverConfig of desiredServers) {
      if (!stillCurrent(serverConfig)) continue
      const configSignature = mcpServerConfigSignature(serverConfig)
      const existing = this.clients.get(serverConfig.id)
      if (existing && ['closing', 'close-unconfirmed'].includes(existing.status)) continue
      if (this.suppressed.has(serverConfig.id)) continue
      if (existing?.configSignature === configSignature && existing.status === 'connected') {
        continue
      }
      if (serverConfig.autoConnect === false) {
        if (existing && existing.configSignature !== configSignature) await this.disconnectServer(serverConfig.id).catch(() => undefined)
        continue
      }
      try {
        await this.connectServer(serverConfig, configSignature, signal, () => {
          if (!stillCurrent(serverConfig) || this.suppressed.has(serverConfig.id)) throw new Error('MCP automatic launch configuration was revoked or superseded.')
        })
      } catch {
        // Failed close remains quarantined; an unrelated healthy service can proceed.
      }
    }
  }

  listToolsSnapshot(): ExternalToolDefinition[] {
    return [...this.clients.values()].filter((state) => state.status === 'connected').flatMap((state) =>
      state.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchema)
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
      ...(this.suppressed.has(state.id) ? { suppressed: true } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {})
    }))
  }

  /** No sync/network side effects; callers apply their own server disclosure policy. */
  listPinnedTools(serverId: string, query: { toolName?: string; offset?: number; limit?: number; includeSchema?: boolean } = {}): McpPinnedTool[] {
    const state = this.clients.get(serverId)
    if (!state || !state.client || state.status !== 'connected') return []
    const offset = query.offset ?? 0, limit = query.limit ?? 256
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Invalid MCP snapshot page.')
    const selected = query.toolName === undefined ? state.tools.slice(offset, offset + limit) : state.tools.filter((tool) => tool.originalName === query.toolName)
    return selected.map((tool) => ({
      serverId: state.id, connectionId: state.connectionId, configDigest: digest(state.configSignature), toolDigest: tool.digest,
      name: tool.originalName, alias: tool.name, description: tool.description, inputSchema: query.includeSchema === false ? {} : structuredClone(tool.inputSchema)
    }))
  }

  /** Main-owned exact-server dispatch. Does not connect, reconnect, or change config.
   * beforeDispatch is synchronous so final permission revalidation/consumption and dispatch cannot interleave.
   * Cancellation tells the remote peer to cancel; it does not prove that remote effects were rolled back.
   */
  async callPinnedTool(input: {
    serverId: string; toolName: string; connectionId: string; configDigest: string; toolDigest: string
    args: Record<string, unknown>; signal: AbortSignal; timeoutMs: number; beforeDispatch(): void
  }): Promise<ExternalToolCallResult> {
    input.signal.throwIfAborted()
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120000) throw new Error('Invalid bounded MCP timeout.')
    const state = this.clients.get(input.serverId)
    if (!state?.client || state.status !== 'connected' || state.connectionId !== input.connectionId || digest(state.configSignature) !== input.configDigest) throw new Error('MCP connection identity changed; discover again before calling.')
    const matches = state.tools.filter((tool) => tool.originalName === input.toolName)
    if (matches.length !== 1 || matches[0].digest !== input.toolDigest) throw new Error('MCP tool identity is missing, ambiguous or changed.')
    return this.invokeTool(state, matches[0], structuredClone(input.args), input.signal, input)
  }

  async callToolByAlias(
    alias: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ExternalToolCallResult | null> {
    throwIfAborted(signal)
    const normalizedAlias = normalizeMagicPotToolName(alias)
    const matches = [...this.clients.values()].filter((state) => state.status === 'connected').flatMap((state) => state.tools.filter((tool) => normalizeMagicPotToolName(tool.name) === normalizedAlias).map((tool) => ({ state, tool })))
    if (matches.length > 1) throw new Error('Ambiguous MCP tool alias; use an exact server/tool identity.')
    if (!matches.length) return null
    return this.invokeTool(matches[0].state, matches[0].tool, args, signal)
  }

  private async invokeTool(
    state: ManagedServerState, tool: ManagedServerState['tools'][number], args: Record<string, unknown>, signal?: AbortSignal,
    checked?: { timeoutMs: number; beforeDispatch(): void }
  ): Promise<ExternalToolCallResult> {
    throwIfAborted(signal)
    if (!state.client) throw new Error(`MCP server "${state.id}" is not connected.`)
    const alias = tool.name
    const authorization = this.toolPolicy.authorize({ alias, serverId: state.id })
    this.toolPolicy.audit({ alias, serverId: state.id, decision: authorization.allowed ? 'allow' : 'deny', ...(authorization.reason ? { reason: authorization.reason } : {}) })
    if (!authorization.allowed) throw new Error(`MCP tool invocation denied by policy: ${authorization.reason || alias}`)
    const configuredTimeout = Number(state.config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)
    if (checked && (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0)) throw new Error('Invalid MCP server request timeout.')
    const requestTimeoutMs = checked ? Math.min(checked.timeoutMs, Math.max(1000, configuredTimeout)) : Math.max(1000, configuredTimeout)
    const timeoutController = new AbortController()
    const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    signal?.throwIfAborted()
    checked?.beforeDispatch()
    signal?.throwIfAborted()
    if (this.clients.get(state.id) !== state) throw new Error('MCP connection was replaced before dispatch.')
    try {
      const result = await withTimeout(
        state.client.callTool({ name: tool.originalName, arguments: args || {} }, undefined, { signal: combined, timeout: requestTimeoutMs, maxTotalTimeout: requestTimeoutMs, resetTimeoutOnProgress: false }),
        requestTimeoutMs, `MCP tool ${alias}`, signal
      )
      if (checked) {
        // Server results remain untrusted DATA. Never forward binary resources or
        // follow links; keep structured objects only as bounded passive JSON.
        let structuredContent: unknown
        if (result.isError !== true && isRecord(result.structuredContent)) {
          try { structuredContent = cloneBoundedMcpJson(result.structuredContent, 16384) } catch { /* Omit the whole object, never incomplete JSON. */ }
        }
        let remaining = 32000, truncated = false, omitted = 0
        const parts: string[] = []
        for (const item of (Array.isArray(result.content) ? result.content : []).slice(0, 64)) {
          if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') { omitted++; continue }
          const part = item.text.slice(0, remaining)
          remaining -= part.length
          truncated ||= part.length !== item.text.length
          if (part) parts.push(part)
        }
        truncated ||= Array.isArray(result.content) && result.content.length > 64
        return { content: parts.join('\n'), metadata: { serverId: state.id, toolName: tool.originalName, alias, isError: Boolean(result.isError), truncated, omittedResources: omitted, structuredContentOmitted: result.structuredContent !== undefined && structuredContent === undefined, ...(structuredContent !== undefined ? { structuredContent } : {}) } }
      }
      return { content: renderToolContent(result.content), metadata: { serverId: state.id, toolName: tool.originalName, alias, isError: Boolean(result.isError), ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}) } }
    } catch (error) {
      timeoutController.abort(error)
      if (isAbortError(error)) throw error
      if (this.clients.get(state.id) === state && state.status === 'connected') {
        state.status = 'error'
        state.lastError = error instanceof Error ? error.message : String(error)
      }
      throw new Error(`MCP tool "${alias}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop(): Promise<void> {
    return this.serializeLifecycle(async () => {
      const results = await Promise.allSettled([...this.clients.keys()].map((id) => this.disconnectServer(id)))
      if (results.some((result) => result.status === 'rejected')) throw new Error('Some MCP transports could not be confirmed closed; quarantined state is retained.')
    })
  }

  private async connectServer(
    config: McpExternalServerConfig,
    configSignature: string,
    signal?: AbortSignal,
    beforeLaunch?: () => void
  ): Promise<void> {
    await this.disconnectServer(config.id)
    signal?.throwIfAborted(); beforeLaunch?.()
    this.bump(config.id)

    const aliasPrefix = buildAliasPrefix(config)
    const state: ManagedServerState = {
      id: config.id,
      aliasPrefix,
      configSignature,
      connectionId: randomUUID(),
      config,
      status: 'connecting',
      tools: []
    }
    this.clients.set(config.id, state)

    let transport: ReturnType<McpClientManager['createTransport']> | undefined
    let discovering = false
    const startup = new AbortController()
    const startupSignal = signal ? AbortSignal.any([signal, startup.signal]) : startup.signal

    try {
      const rawTimeout = Number(config.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS)
      if (!Number.isFinite(rawTimeout) || rawTimeout < 1 || rawTimeout > 120000) throw new Error('Invalid bounded MCP startup timeout.')
      const startupTimeoutMs = Math.max(1000, rawTimeout)
      const deadline = performance.now() + startupTimeoutMs
      const assertCurrent = () => {
        startupSignal.throwIfAborted(); beforeLaunch?.()
        if (this.clients.get(config.id) !== state || state.transportClosed) throw new McpCatalogError('MCP connection changed or closed before discovery completed.')
        if (performance.now() >= deadline) throw new McpCatalogError('MCP startup and catalog discovery timed out before completion.')
      }
      const requestOptions = (): RequestOptions => {
        assertCurrent()
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
        return { signal: startupSignal, timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false }
      }
      transport = this.createTransport(config)
      state.transport = transport
      const client = this.createClient(assertCurrent)
      const previousClose = transport.onclose
      state.closeConfirmed = new Promise<void>((resolve) => { transport!.onclose = () => {
        state.transportClosed = true; resolve(); previousClose?.()
        if (this.clients.get(state.id) === state && state.status === 'connected') { state.status = 'disconnected'; state.tools = []; this.bump(state.id) }
      } })
      if (transport instanceof StdioClientTransport) {
        // Drain but never persist stderr, avoiding an unread pipe blocking the child.
        ;(transport.stderr as Readable | null)?.resume()
        state.requireCloseEvent = true
      }

      const connectOptions = requestOptions()
      await withTimeout(client.connect(transport, connectOptions), connectOptions.timeout!, `MCP server ${config.id}`, startupSignal)
      discovering = true
      const listOptions = requestOptions()
      const listedTools = await withTimeout(client.listTools(undefined, listOptions), listOptions.timeout!, `MCP tool discovery for ${config.id}`, startupSignal)
      assertCurrent()
      assertBoundedMcpCatalog(listedTools)
      let catalogBytes = 0
      const tools = listedTools.tools
        .map((tool) => {
          if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 128 || aliasPrefix.length > 256) throw new Error('Invalid bounded MCP tool identity.')
          const schema = cloneBoundedMcpJson(tool.inputSchema, 65536)
          const normalizedInputSchema = normalizeInputSchema(schema)
          if (!normalizedInputSchema) {
            return null
          }

          const entry = {
            originalName: tool.name,
            name: `${aliasPrefix}.${tool.name}`,
            description: String(tool.description || `MCP tool from ${config.id}`).slice(0, 2000),
            inputSchema: normalizedInputSchema
          }
          catalogBytes += Buffer.byteLength(JSON.stringify(entry), 'utf8')
          if (catalogBytes > 512 * 1024) throw new Error('MCP catalog exceeds the 512 KiB limit.')
          return { ...entry, digest: toolDigest(entry) }
        })
        .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))

      assertCurrent()
      state.client = client
      state.transport = transport
      state.tools = tools
      state.status = 'connected'
      state.lastError = undefined
    } catch (error) {
      startup.abort(new Error('MCP startup failed or was cancelled.'))
      state.status = 'error'
      state.lastError = discovering ? error instanceof McpCatalogError ? error.message : 'MCP catalog discovery failed, was cancelled or admission changed; no tools are available.' : error instanceof Error ? error.message : String(error)
      state.tools = []
      try { await this.closeState(state) } catch {
        state.status = 'close-unconfirmed'
        state.lastError = 'MCP transport closure is unconfirmed; reconnect is blocked.'
      }
      if (state.status !== 'close-unconfirmed') { delete state.transport; delete state.client }
    }
  }

  protected createClient(assertCurrent?: () => void): Client {
    return new BoundedMcpClient({
      name: 'magicpot-mcp-client',
      version: '1.0.0'
    }, {
      // SDK listTools otherwise compiles untrusted outputSchema with unrestricted
      // AJV before our catalog admission code runs. Keep that path passive too.
      jsonSchemaValidator: {
        getValidator<T>(schema) {
          const prepared = prepareMcpSchema(schema)
          return (value: unknown) => {
            try {
              const bounded = cloneBoundedMcpJson(value, 65536)
              assertMcpArguments(prepared, bounded)
              return { valid: true as const, data: bounded as T, errorMessage: undefined }
            } catch { return { valid: false as const, data: undefined, errorMessage: 'MCP structured output is invalid or exceeds the supported bounded schema subset.' } }
          }
        }
      }
    }, assertCurrent)
  }

  protected createTransport(config: McpExternalServerConfig) {
    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error(`MCP stdio server "${config.id}" is missing a command.`)
      }

      return new ObservedStdioClientTransport({
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

  private async closeState(state: ManagedServerState): Promise<void> {
    state.closeOperation ??= (async () => {
      if (!state.transport) return
      await state.transport.close()
      const provenNoChild = state.transport instanceof ObservedStdioClientTransport && ['not-started', 'failed-without-child'].includes(state.transport.startOutcome)
      if (state.requireCloseEvent && !provenNoChild) await state.closeConfirmed
    })()
    await withTimeout(state.closeOperation, 6000, 'MCP transport close confirmation')
  }

  private async disconnectServer(id: string, retain = false): Promise<void> {
    const existing = this.clients.get(id)
    if (!existing) return
    if (existing.status === 'close-unconfirmed') throw new Error('MCP closure is unconfirmed; lifecycle remains quarantined.')
    existing.status = 'closing'; existing.tools = []
    this.bump(id)
    try {
      await this.closeState(existing)
      delete existing.transport; delete existing.client
      existing.status = 'disconnected'
      if (!retain) this.clients.delete(id)
    } catch {
      existing.status = 'close-unconfirmed'
      existing.lastError = 'MCP transport closure is unconfirmed; reconnect is blocked.'
      throw new Error(existing.lastError)
    }
  }
}
