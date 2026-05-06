import path from 'node:path'
import type { Config } from '@shared/config/config'
import { MAGICPOT_SESSION_STATUS_TOOL_NAME, normalizeMagicPotToolName } from '@shared/app/types'
import { buildMagicPotAppCatalogSnapshot } from '@shared/app/catalog'
import type {
  McpAuditDecision,
  McpHealthSnapshot,
  McpPermissionContext
} from '@shared/agent/mcpPlatform'
import { normalizeAssistantRoute, type AssistantRoute } from '../../assistantRuntime/types'
import { getConfig } from '../../config/config'
import { getAgentKernel } from '../../agentKernel/agentKernel'
import { normalizeLocalFilePath } from '../../utils/localFileUrl'
import { handleManagedMagicPotMcpHttpBridgeRequest } from './managedHttpBridge'
import { MagicPotMcpPlatform } from './mcpPlatform'

type AssistantToolCatalogEntry = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

type MagicPotMcpPlatformStatus = {
  health: McpHealthSnapshot
  auditEntryCount: number
}

type NegotiatedMcpSession = {
  sessionId: string
  transport: 'stdio' | 'streamable-http'
}

export type MagicPotMcpPlatformEnv = {
  enableStdioServer: boolean
}

const PLATFORM_NAME = 'magicpot-mcp-platform'
const PLATFORM_VERSION = '1.0.0'
const PLATFORM_SOURCE_ID = 'platform:inspection'
const APP_SOURCE_PREFIX = 'app:'
const TOOL_SOURCE_ID = 'chat:tools'
const KERNEL_SOURCE_ID = 'agent-kernel'
const CHATBOT_TOOL_TARGET_PREFIX = 'chat.tool.'

const CANVAS_APPROVED_TOOL_NAMES = new Set([
  'artifacts.get',
  'artifacts.list',
  'audit.timeline',
  MAGICPOT_SESSION_STATUS_TOOL_NAME,
  'events.list',
  'memory.recent',
  'run.inspect',
  'run.lineage',
  'run.replay',
  'run.trace',
  'runs.get',
  'runs.list',
  'session.history',
  'session.summary'
])

const CANVAS_DENIED_TOOL_NAMES = new Set([
  'context.pinned',
  'limits.status',
  'mcp.status',
  'ops.status',
  'run.resume',
  'run.retry',
  'session.cleanup',
  'sessions.list',
  'task.group.approve',
  'task.group.cancel',
  'task.group.export',
  'task.group.inspect',
  'task.group.list',
  'task.group.progress',
  'task.group.resume',
  'task.group.retry',
  'task.group.start',
  'workflow.inspect',
  'workflow.resume',
  'workflows.list',
  'workspace.attach',
  'workspace.context',
  'workspace.detach',
  'workspace.inspect',
  'workspace.manage',
  'workspaces.list'
])

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

const toBooleanFlag = (value?: string | null): boolean => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeComparablePath = (value: string): string =>
  path
    .resolve(normalizeLocalFilePath(value))
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

const isPathWithinRoot = (candidatePath: string, rootPath: string): boolean => {
  const normalizedCandidatePath = normalizeComparablePath(candidatePath)
  const normalizedRootPath = normalizeComparablePath(rootPath)
  return (
    normalizedCandidatePath === normalizedRootPath ||
    normalizedCandidatePath.startsWith(`${normalizedRootPath}/`)
  )
}

const isCanvasScopedRoute = (route?: AssistantRoute): boolean =>
  route?.channel === 'canvas' &&
  route.scopeType === 'thread' &&
  Boolean(cleanString(route.scopeId)) &&
  Boolean(cleanString(route.threadId))

const isInternalAssistantActor = (actor: string): boolean =>
  actor.startsWith('assistant:') || actor.startsWith('kernel:') || actor.startsWith('bot:')

const extractToolNameFromTarget = (target: string): string | undefined => {
  if (target.startsWith(CHATBOT_TOOL_TARGET_PREFIX)) {
    return normalizeMagicPotToolName(target.slice(CHATBOT_TOOL_TARGET_PREFIX.length))
  }
  return undefined
}

const normalizeRouteFromValue = (value: unknown): AssistantRoute | undefined => {
  if (!isPlainRecord(value)) {
    return undefined
  }
  return normalizeAssistantRoute(value as AssistantRoute)
}

const resolveRouteFromPermissionContext = (
  context: McpPermissionContext
): AssistantRoute | undefined => {
  const metadataRoute = normalizeRouteFromValue(context.metadata?.['route'])
  if (metadataRoute) {
    return metadataRoute
  }
  const sessionId = cleanString(context.sessionId)
  return sessionId ? getMagicPotMcpPlatformRuntime().getRouteForSession(sessionId) : undefined
}

const collectCanvasScopedRoots = (context: McpPermissionContext): string[] => {
  const metadata = isPlainRecord(context.metadata) ? context.metadata : {}
  const collected = new Set<string>()

  const pushRootValue = (value: unknown) => {
    const normalized = cleanString(typeof value === 'string' ? value : undefined)
    if (normalized) {
      collected.add(normalized)
    }
  }

  for (const key of ['currentCanvasRoot', 'currentCanvasRootDir']) {
    pushRootValue(metadata[key])
  }

  for (const key of ['currentCanvasRoots']) {
    const value = metadata[key]
    if (!Array.isArray(value)) {
      continue
    }
    value.forEach((entry) => pushRootValue(entry))
  }

  return [...collected]
}

const resolveRequestedFilePath = (context: McpPermissionContext): string | undefined => {
  const metadata = isPlainRecord(context.metadata) ? context.metadata : {}
  const metadataFilePath =
    cleanString(typeof metadata['filePath'] === 'string' ? metadata['filePath'] : undefined) ||
    cleanString(typeof metadata['path'] === 'string' ? metadata['path'] : undefined)
  if (metadataFilePath) {
    return metadataFilePath
  }
  return cleanString(context.target)
}

const isFileScopedAction = (context: McpPermissionContext): boolean =>
  context.action.startsWith('file.') ||
  context.action.startsWith('fs.') ||
  Boolean(
    isPlainRecord(context.metadata) &&
    (typeof context.metadata['filePath'] === 'string' ||
      typeof context.metadata['path'] === 'string')
  )

const evaluateCanvasFilePermission = (context: McpPermissionContext) => {
  const route = resolveRouteFromPermissionContext(context)
  if (!isCanvasScopedRoute(route)) {
    return {
      allowed: true,
      policyId: 'magicpot-assistant-legacy-noncanvas-file'
    }
  }

  const requestedFilePath = resolveRequestedFilePath(context)
  if (!requestedFilePath) {
    return {
      allowed: false,
      reason: 'Canvas-scoped file access requires an explicit file path.',
      policyId: 'magicpot-assistant-file-path-deny'
    }
  }

  const allowedRoots = collectCanvasScopedRoots(context)
  if (!allowedRoots.length) {
    return {
      allowed: false,
      reason: 'Canvas-scoped file access requires an explicit current-canvas root.',
      policyId: 'magicpot-assistant-file-root-deny'
    }
  }

  if (!allowedRoots.some((rootPath) => isPathWithinRoot(requestedFilePath, rootPath))) {
    return {
      allowed: false,
      reason: 'Requested file path is outside the current canvas scope.',
      policyId: 'magicpot-assistant-file-scope-deny'
    }
  }

  return {
    allowed: true,
    policyId: 'magicpot-assistant-file-scope'
  }
}

const evaluateInternalToolPermission = (context: McpPermissionContext) => {
  const toolName = extractToolNameFromTarget(context.target)
  if (!toolName) {
    return undefined
  }

  const route = resolveRouteFromPermissionContext(context)
  if (isCanvasScopedRoute(route)) {
    if (CANVAS_DENIED_TOOL_NAMES.has(toolName) || isMutatingTarget(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is outside the current-canvas sandbox.`,
        policyId: 'magicpot-chat-tool-deny'
      }
    }
    if (CANVAS_APPROVED_TOOL_NAMES.has(toolName)) {
      return {
        allowed: true,
        policyId: 'magicpot-assistant-canvas-tool'
      }
    }
    return {
      allowed: false,
      reason: `Canvas-scoped access only allows approved canvas tools. "${toolName}" is not approved.`,
      policyId: 'magicpot-assistant-canvas-tool-deny'
    }
  }

  return {
    allowed: true,
    policyId: 'magicpot-assistant-legacy-noncanvas'
  }
}

export const readMagicPotMcpPlatformEnv = (
  env: NodeJS.ProcessEnv = process.env
): MagicPotMcpPlatformEnv => ({
  enableStdioServer: toBooleanFlag(env['MAGICPOT_MCP_STDIO_SERVER'])
})

const isMutatingTarget = (target: string): boolean =>
  [
    'workspace.attach',
    'workspace.detach',
    'workspace.manage',
    'workflow.resume',
    'run.resume',
    'run.retry',
    'session.cleanup',
    'task.group.start',
    'task.group.progress',
    'task.group.approve',
    'task.group.export',
    'task.group.cancel',
    'task.group.resume',
    'task.group.retry'
  ].some((prefix) => target === prefix || target.startsWith(`${prefix}.`))

const defaultPermissionPolicy = (context: McpPermissionContext) => {
  const actor = cleanString(context.actor) || 'unknown'

  if (context.target.startsWith('magicpot://mcp/platform/')) {
    return {
      allowed: true,
      policyId: 'magicpot-platform-inspection'
    }
  }

  if (isInternalAssistantActor(actor) && isFileScopedAction(context)) {
    return evaluateCanvasFilePermission(context)
  }

  if (isInternalAssistantActor(actor) && context.action === 'tool.invoke') {
    const toolDecision = evaluateInternalToolPermission(context)
    if (toolDecision) {
      return toolDecision
    }
  }

  if (context.action.startsWith('read:')) {
    return {
      allowed: true,
      policyId: 'magicpot-read-only'
    }
  }

  if (isMutatingTarget(context.target)) {
    return {
      allowed: false,
      reason: 'Mutating MCP actions require explicit higher-privilege authorization.',
      policyId: 'magicpot-external-mutation-deny'
    }
  }

  return {
    allowed: true,
    policyId: 'magicpot-external-default'
  }
}

class MagicPotMcpPlatformRuntime {
  private readonly platform = new MagicPotMcpPlatform(
    {
      name: PLATFORM_NAME,
      version: PLATFORM_VERSION
    },
    defaultPermissionPolicy
  )
  private readonly managedSourceIds = new Set<string>()
  private readonly sessionRoutes = new Map<string, AssistantRoute>()
  private stdioStartPromise: Promise<void> | null = null
  private streamableHttpEndpoint: string | null = null
  private stdioServerEnabled = false
  private initialized = false

  initialize(
    config: Config | undefined = getConfig(),
    options?: {
      toolCatalog?: AssistantToolCatalogEntry[]
    }
  ): void {
    this.refresh(config, options)
    if (!this.initialized) {
      this.platform.lifecycle.transition('ready', 'MCP platform runtime initialized')
      this.initialized = true
    }
  }

  refresh(
    config: Config | undefined = getConfig(),
    options?: {
      toolCatalog?: AssistantToolCatalogEntry[]
    }
  ): void {
    this.syncConfiguredStreamableHttpTransport(config || getConfig())
    this.replaceManagedSources([
      this.buildPlatformInspectionSource(),
      ...this.buildAppSources(config || getConfig()),
      this.buildToolCatalogSource(options?.toolCatalog),
      this.buildKernelSource()
    ])
  }

  negotiateSession(options: {
    route: AssistantRoute
    sessionKey: string
    capabilityIds?: string[]
  }): NegotiatedMcpSession {
    const sessionId = `mcp:${options.sessionKey}:${crypto.randomUUID()}`
    const route = normalizeAssistantRoute(options.route)

    this.platform.registerSession({
      sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'active',
      route: {
        channel: route.channel,
        scopeType: route.scopeType,
        scopeId: route.scopeId,
        ...(route.threadId ? { threadId: route.threadId } : {})
      },
      owner: options.sessionKey,
      metadata: {
        capabilityIds: options.capabilityIds || []
      }
    })
    this.sessionRoutes.set(sessionId, route)
    this.appendAudit({
      actor: `bot:${options.sessionKey}`,
      action: 'session.negotiate',
      target: sessionId,
      decision: 'allow',
      metadata: {
        capabilityIds: options.capabilityIds || []
      }
    })

    return {
      sessionId,
      transport: 'streamable-http'
    }
  }

  getRouteForSession(sessionId: string): AssistantRoute | undefined {
    return this.sessionRoutes.get(String(sessionId || '').trim())
  }

  listTools(capabilityIds?: string[]): Array<{
    capabilityId: string
    name: string
    description?: string
  }> {
    const filter = new Set(
      (capabilityIds || []).map((item) => String(item || '').trim()).filter(Boolean)
    )
    const tools = this.platform.registry.listCapabilities().tools.map((tool) => ({
      capabilityId: `chat.tool.${tool.name}`,
      name: normalizeMagicPotToolName(tool.name),
      description: tool.description
    }))

    if (filter.size === 0) {
      return tools
    }

    return tools.filter((tool) => filter.has(tool.capabilityId) || filter.has(tool.name))
  }

  authorizeToolInvocation(options: {
    actor: string
    action: string
    target: string
    transport?: 'stdio' | 'streamable-http'
    sessionId?: string
    metadata?: Record<string, unknown>
  }) {
    return this.platform.checkPermission({
      actor: options.actor,
      action: options.action,
      target: options.target,
      transport: options.transport || 'stdio',
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {})
    })
  }

  appendAudit(options: {
    actor: string
    action: string
    target: string
    decision: McpAuditDecision
    reason?: string
    metadata?: Record<string, unknown>
  }): void {
    this.platform.appendAudit({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor: options.actor,
      action: options.action,
      target: options.target,
      decision: options.decision,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {})
    })
  }

  getStatus(): MagicPotMcpPlatformStatus {
    return {
      health: this.platform.describeHealth(),
      auditEntryCount: this.platform.listAuditEntries().length
    }
  }

  async syncDesktopTransports(
    env: MagicPotMcpPlatformEnv = readMagicPotMcpPlatformEnv()
  ): Promise<void> {
    if (!env.enableStdioServer || this.stdioServerEnabled) {
      return
    }

    if (!this.stdioStartPromise) {
      this.stdioStartPromise = this.platform
        .startStdio()
        .then(() => {
          this.stdioServerEnabled = true
        })
        .finally(() => {
          this.stdioStartPromise = null
        })
    }

    await this.stdioStartPromise
  }

  async handleStreamableHttpRequest(options: {
    req: import('node:http').IncomingMessage
    res: import('node:http').ServerResponse
    parsedBody?: unknown
    endpoint?: string
  }): Promise<void> {
    const endpoint = cleanString(options.endpoint)
    if (endpoint && endpoint !== this.streamableHttpEndpoint) {
      this.streamableHttpEndpoint = endpoint
      this.platform.updateTransportSnapshot({
        kind: 'streamable-http',
        status: 'ready',
        endpoint
      })
    }

    await handleManagedMagicPotMcpHttpBridgeRequest({
      ...options,
      configProvider: () => getConfig()
    })
  }

  async stop(): Promise<void> {
    if (this.streamableHttpEndpoint) {
      this.platform.updateTransportSnapshot({
        kind: 'streamable-http',
        status: 'stopped',
        endpoint: this.streamableHttpEndpoint
      })
    }
    this.streamableHttpEndpoint = null
    await this.platform.stop()
    this.sessionRoutes.clear()
    this.stdioStartPromise = null
    this.stdioServerEnabled = false
    this.initialized = false
  }

  private replaceManagedSources(
    sources: Array<Parameters<MagicPotMcpPlatform['registerSource']>[0] | null>
  ): void {
    for (const sourceId of this.managedSourceIds) {
      this.platform.registry.removeSource(sourceId)
    }
    this.managedSourceIds.clear()

    for (const source of sources) {
      if (!source) continue
      this.platform.registerSource(source)
      this.managedSourceIds.add(source.id)
    }
  }

  private syncConfiguredStreamableHttpTransport(config: Config): void {
    const enabled = config.mcp_config?.server?.enabled ?? true
    const endpoint = cleanString(config.mcp_config?.server?.path) || '/api/mcp'

    this.streamableHttpEndpoint = endpoint
    this.platform.updateTransportSnapshot({
      kind: 'streamable-http',
      status: enabled ? 'ready' : 'stopped',
      endpoint
    })
  }

  private buildPlatformInspectionSource() {
    return {
      id: PLATFORM_SOURCE_ID,
      label: 'MagicPot MCP Platform',
      scope: 'global' as const,
      version: PLATFORM_VERSION,
      bundle: {
        tools: [
          {
            name: 'platform.health',
            description: 'Return the platform lifecycle, transport, and capability health snapshot.'
          },
          {
            name: 'platform.audit.list',
            description: 'List the in-memory MCP audit trail.'
          }
        ],
        resources: [
          {
            uri: 'magicpot://mcp/platform/capabilities',
            name: 'platform.capabilities',
            description: 'Canonical capability registry snapshot.',
            mimeType: 'application/json'
          },
          {
            uri: 'magicpot://mcp/platform/health',
            name: 'platform.health',
            description: 'Current MCP platform health snapshot.',
            mimeType: 'application/json'
          }
        ],
        prompts: [
          {
            name: 'platform.system',
            description: 'Summarize the MagicPot MCP platform for an operator or downstream agent.'
          }
        ]
      }
    }
  }

  private buildAppSources(config: Config) {
    return buildMagicPotAppCatalogSnapshot(config).apps.map((app) => ({
      id: `${APP_SOURCE_PREFIX}${app.id}`,
      label: app.name,
      scope: 'global' as const,
      version: PLATFORM_VERSION,
      metadata: {
        appId: app.id,
        transport: app.transport,
        source: app.source,
        status: app.status
      },
      bundle: {
        tools: app.capabilities.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        resources: app.capabilities.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.uri,
          description: resource.description,
          mimeType: resource.mimeType
        })),
        prompts: []
      }
    }))
  }

  private buildToolCatalogSource(toolCatalog?: AssistantToolCatalogEntry[]) {
    if (!toolCatalog?.length) return null

    return {
      id: TOOL_SOURCE_ID,
      label: 'MagicPot Chat Tool Catalog',
      scope: 'global' as const,
      version: PLATFORM_VERSION,
      bundle: {
        tools: toolCatalog.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        resources: [],
        prompts: []
      }
    }
  }

  private buildKernelSource() {
    const capabilities = getAgentKernel().listCapabilities()
    return {
      id: KERNEL_SOURCE_ID,
      label: 'MagicPot Agent Kernel',
      scope: 'global' as const,
      version: PLATFORM_VERSION,
      bundle: {
        tools: capabilities
          .filter((capability) => capability.kind === 'tool')
          .map((capability) => ({
            name: capability.name,
            description: capability.description,
            inputSchema: capability.inputSchema
          })),
        resources: capabilities
          .filter((capability) => capability.kind === 'resource')
          .map((capability) => ({
            uri: capability.capabilityId,
            name: capability.name,
            description: capability.description,
            mimeType: 'application/json'
          })),
        prompts: capabilities
          .filter((capability) => capability.kind === 'prompt')
          .map((capability) => ({
            name: capability.name,
            description: capability.description,
            argsSchema: capability.inputSchema
          }))
      }
    }
  }
}

let runtimeSingleton: MagicPotMcpPlatformRuntime | null = null

export const getMagicPotMcpPlatformRuntime = (): MagicPotMcpPlatformRuntime => {
  if (!runtimeSingleton) {
    runtimeSingleton = new MagicPotMcpPlatformRuntime()
  }
  return runtimeSingleton
}

export const initializeMagicPotMcpPlatformRuntime = (
  config?: Config,
  options?: {
    toolCatalog?: AssistantToolCatalogEntry[]
  }
): void => {
  getMagicPotMcpPlatformRuntime().initialize(config || getConfig(), options)
}

export const refreshMagicPotMcpPlatformRuntime = (
  config?: Config,
  options?: {
    toolCatalog?: AssistantToolCatalogEntry[]
  }
): void => {
  getMagicPotMcpPlatformRuntime().refresh(config || getConfig(), options)
}

export const negotiateMagicPotMcpSession = (options: {
  route: AssistantRoute
  sessionKey: string
  capabilityIds?: string[]
}): NegotiatedMcpSession => getMagicPotMcpPlatformRuntime().negotiateSession(options)

export const listMagicPotMcpTools = (capabilityIds?: string[]) =>
  getMagicPotMcpPlatformRuntime().listTools(capabilityIds)

export const authorizeMagicPotMcpToolInvocation = (options: {
  actor: string
  action: string
  target: string
  transport?: 'stdio' | 'streamable-http'
  sessionId?: string
  metadata?: Record<string, unknown>
}) => getMagicPotMcpPlatformRuntime().authorizeToolInvocation(options)

export const appendMagicPotMcpAudit = (options: {
  actor: string
  action: string
  target: string
  decision: McpAuditDecision
  reason?: string
  metadata?: Record<string, unknown>
}) => getMagicPotMcpPlatformRuntime().appendAudit(options)

export const getMagicPotMcpPlatformStatus = () => getMagicPotMcpPlatformRuntime().getStatus()

export const getMagicPotMcpRouteForSession = (sessionId: string) =>
  getMagicPotMcpPlatformRuntime().getRouteForSession(sessionId)

export const syncMagicPotMcpPlatformDesktopTransports = async (
  env: MagicPotMcpPlatformEnv = readMagicPotMcpPlatformEnv()
): Promise<void> => {
  await getMagicPotMcpPlatformRuntime().syncDesktopTransports(env)
}

export const stopMagicPotMcpPlatformRuntime = async (): Promise<void> => {
  if (!runtimeSingleton) return
  await runtimeSingleton.stop()
}
