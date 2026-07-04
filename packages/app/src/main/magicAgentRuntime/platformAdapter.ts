import type { AgentRouteLike, AgentRunStatus } from '@shared/agent'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp,
  MagicAgentPlatformToolCallReq,
  MagicAgentPlatformToolCallResp,
  MagicAgentPlatformToolDefinition,
  MagicAgentPlatformToolSource
} from '@shared/api/svcMagicAgentPlatform'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import { normalizeMagicPotToolName } from '@shared/app/types'
import { normalizeAgentRoute } from '@shared/agent'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import type { AssistantRuntime } from '../assistantRuntime/runtime'
import type { AssistantRoute } from '../assistantRuntime/types'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { getConfig } from '../config/config'
import { getAgentKernel, type AgentKernel } from '../agentKernel'
import { MagicAgentRegistry } from './agentRegistry'
import { MagicAgentRuntime } from './runtime'
import { MagicAgentToolRegistry } from './toolRegistry'
import type { MagicAgentToolRegistration, MagicAgentToolResult } from './types'
import {
  MagicAgentCreativeToolRegistry,
  createMagicAgentCreativeToolRegistry,
  type MagicAgentCreativeToolContext,
  type MagicAgentCreativeToolDependencies,
  type MagicAgentCreativeToolDefinition,
  type MagicAgentCreativeToolResult
} from './tools'
import { isMagicAgentPlatformDeniedToolName } from './toolPolicy'

export type MagicAgentPlatformAdapterDeps = {
  chatService?: Pick<LLMProxySvc, 'chat'>
  assistantRuntime?: Pick<AssistantRuntime, 'listTools' | 'callTool' | 'handleMessage'>
  agentRegistry?: MagicAgentRegistry
  toolRegistry?: MagicAgentToolRegistry
  creativeToolRegistry?: MagicAgentCreativeToolRegistry
  creativeToolDependencies?: Partial<MagicAgentCreativeToolDependencies>
  agentKernel?: AgentKernel
}

const MAGIC_AGENT_KERNEL_PREFIX = 'magicagent.platform'

const cleanString = (value: unknown): string => String(value || '').trim()

const cloneRecord = (value?: Record<string, unknown>): Record<string, unknown> | undefined =>
  value ? { ...value } : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const toKernelSafeSegment = (value: unknown): string =>
  cleanString(value).replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'unknown'

const toKernelAgentCapabilityId = (agentId: string): string =>
  `${MAGIC_AGENT_KERNEL_PREFIX}.agent.${toKernelSafeSegment(agentId)}`

const toKernelCreativeCapabilityId = (toolName: string): string =>
  `${MAGIC_AGENT_KERNEL_PREFIX}.tool.creative.${toKernelSafeSegment(toolName)}`

const toKernelCreativeToolName = (toolName: string): string =>
  `magicagent.creative.${toKernelSafeSegment(toolName)}`

const requirePlatformRoute = (
  route: AgentRouteLike | undefined,
  operation: string
): AssistantRoute => {
  if (!route) {
    throw new Error(`MagicAgent platform ${operation} requires an explicit trusted route.`)
  }
  return normalizeAgentRoute(route) as AssistantRoute
}

const resolveRunAllowedToolNames = (
  requested: string[] | null | undefined,
  agentToolNames: string[] | null | undefined
): string[] => {
  // Platform v1 is no-tools by default. A renderer-facing run must opt into a
  // concrete allowlist; agent.toolNames can only further narrow that list.
  const requestedNames = Array.isArray(requested)
    ? [
        ...new Set(
          requested
            .map((name) => normalizeMagicPotToolName(name))
            .filter((name) => Boolean(name) && !isMagicAgentPlatformDeniedToolName(name))
        )
      ]
    : []
  if (!requestedNames.length) {
    return []
  }

  if (!Array.isArray(agentToolNames)) {
    return requestedNames
  }

  const agentSet = new Set(
    agentToolNames.map((name) => normalizeMagicPotToolName(name)).filter(Boolean)
  )
  return requestedNames.filter((name) => agentSet.has(name))
}

const mapMagicAgentStatusToKernelStatus = (status: string): AgentRunStatus => {
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'aborted') {
    return 'cancelled'
  }
  if (status === 'running' || status === 'pending') {
    return status
  }
  return 'failed'
}

const formatJsonContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return ''
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const normalizeAgentDefinition = (
  agent: MagicAgentPlatformAgentDefinition
): MagicAgentPlatformAgentDefinition => ({
  id: normalizeMagicPotToolName(agent.id),
  name: cleanString(agent.name) || cleanString(agent.id),
  ...(cleanString(agent.description) ? { description: cleanString(agent.description) } : {}),
  ...(cleanString(agent.systemPrompt) ? { systemPrompt: cleanString(agent.systemPrompt) } : {}),
  ...(agent.toolNames !== undefined
    ? {
        toolNames: Array.isArray(agent.toolNames)
          ? agent.toolNames.map(cleanString).filter(Boolean)
          : null
      }
    : {}),
  ...(Number.isFinite(agent.maxToolIterations)
    ? { maxToolIterations: Math.max(0, Math.trunc(Number(agent.maxToolIterations))) }
    : {}),
  ...(cleanString(agent.profileId) ? { profileId: cleanString(agent.profileId) } : {})
})

const assistantToolToPlatformDefinition = (tool: {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}): MagicAgentPlatformToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  source: 'assistantRuntime',
  status: 'available',
  metadata: {
    source: 'assistantRuntime'
  }
})

const creativeToolToPlatformDefinition = (
  tool: MagicAgentCreativeToolDefinition
): MagicAgentPlatformToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  source: 'creative',
  category: tool.category,
  status: tool.status,
  permissionLevel: tool.permissionLevel,
  requiresConfirmation: tool.requiresConfirmation,
  disabledByDefault: tool.disabledByDefault,
  ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {}),
  metadata: {
    source: 'magicAgentCreativeToolRegistry',
    category: tool.category,
    permissionLevel: tool.permissionLevel,
    requiresConfirmation: tool.requiresConfirmation,
    disabledByDefault: tool.disabledByDefault
  }
})

const platformToolToRuntimeRegistration = (
  definition: MagicAgentPlatformToolDefinition,
  handler: MagicAgentToolRegistration['handler']
): MagicAgentToolRegistration => ({
  name: definition.name,
  description: definition.description,
  inputSchema: definition.inputSchema,
  metadata: {
    ...(definition.metadata || {}),
    source: definition.source,
    ...(definition.category ? { category: definition.category } : {}),
    ...(definition.status ? { status: definition.status } : {}),
    ...(definition.permissionLevel ? { permissionLevel: definition.permissionLevel } : {}),
    ...(definition.requiresConfirmation !== undefined
      ? { requiresConfirmation: definition.requiresConfirmation }
      : {}),
    ...(definition.disabledByDefault !== undefined
      ? { disabledByDefault: definition.disabledByDefault }
      : {}),
    ...(definition.unavailableReason ? { unavailableReason: definition.unavailableReason } : {})
  },
  handler
})

const creativeResultToRuntimeToolResult = (
  result: MagicAgentCreativeToolResult
): MagicAgentToolResult => ({
  content:
    result.error ||
    result.unavailableReason ||
    formatJsonContent(result.data) ||
    (result.ok ? 'Creative tool completed.' : 'Creative tool unavailable.'),
  metadata: {
    ok: result.ok,
    toolName: result.toolName,
    category: result.category,
    status: result.status,
    ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
    ...(result.permissionDenied ? { permissionDenied: result.permissionDenied } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.data !== undefined ? { data: result.data } : {})
  }
})

const creativeResultToPlatformToolResult = (
  result: MagicAgentCreativeToolResult
): MagicAgentPlatformToolCallResp => ({
  ok: result.ok,
  toolName: result.toolName,
  source: 'creative',
  status: result.ok
    ? 'ok'
    : result.permissionDenied
      ? 'permission-denied'
      : result.status === 'unavailable'
        ? 'unavailable'
        : 'failed',
  content:
    result.error ||
    result.unavailableReason ||
    formatJsonContent(result.data) ||
    (result.ok ? 'Creative tool completed.' : 'Creative tool unavailable.'),
  ...(result.data !== undefined ? { data: result.data } : {}),
  ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
  ...(result.error ? { error: result.error } : {}),
  metadata: {
    category: result.category,
    creativeStatus: result.status
  }
})

const isMagicAgentCreativeToolResult = (value: unknown): value is MagicAgentCreativeToolResult =>
  isRecord(value) &&
  typeof value.ok === 'boolean' &&
  typeof value.toolName === 'string' &&
  typeof value.category === 'string' &&
  typeof value.status === 'string'

const isPermissionError = (error: unknown): boolean =>
  error instanceof Error && /permission|not allowed|denied/i.test(error.message)

export class MagicAgentPlatformAdapter {
  private readonly assistantRuntime: Pick<
    AssistantRuntime,
    'listTools' | 'callTool' | 'handleMessage'
  >
  private readonly creativeToolRegistry: MagicAgentCreativeToolRegistry
  private readonly creativeToolDependencies?: Partial<MagicAgentCreativeToolDependencies>
  private readonly agentKernel: AgentKernel
  private readonly runtimeToolRegistry: MagicAgentToolRegistry
  private readonly runtime: MagicAgentRuntime
  private readonly managedKernelCapabilityIds = new Set<string>()
  private kernelSurfaceSignature = ''

  constructor(deps: MagicAgentPlatformAdapterDeps = {}) {
    this.assistantRuntime = deps.assistantRuntime || getAssistantRuntime()
    this.creativeToolRegistry = deps.creativeToolRegistry || createMagicAgentCreativeToolRegistry()
    this.creativeToolDependencies = deps.creativeToolDependencies
    this.agentKernel = deps.agentKernel || getAgentKernel()

    this.runtimeToolRegistry = deps.toolRegistry || new MagicAgentToolRegistry()
    this.runtime = new MagicAgentRuntime({
      chatService: deps.chatService || new LLMProxySvcImpl(),
      ...(deps.agentRegistry ? { agentRegistry: deps.agentRegistry } : {}),
      toolRegistry: this.runtimeToolRegistry
    })
    this.refreshRuntimeTools()
  }

  refreshRuntimeTools(): void {
    const registrations: MagicAgentToolRegistration[] = [
      ...this.assistantRuntime
        .listTools()
        .filter((tool) => !isMagicAgentPlatformDeniedToolName(tool.name))
        .map((tool) =>
          platformToolToRuntimeRegistration(
            assistantToolToPlatformDefinition(tool),
            async (args, context) => {
              const result = await this.assistantRuntime.callTool(
                requirePlatformRoute(
                  context.metadata?.route as AgentRouteLike | undefined,
                  'runtime tool dispatch'
                ),
                normalizeMagicPotToolName(tool.name),
                args,
                {
                  allowedToolNames: context.metadata?.allowedToolNames as
                    | string[]
                    | null
                    | undefined
                }
              )
              return {
                content: String(result?.content || ''),
                ...(result?.metadata ? { metadata: result.metadata } : {})
              }
            }
          )
        ),
      ...this.listPlatformCreativeTools().map((tool) =>
        platformToolToRuntimeRegistration(
          creativeToolToPlatformDefinition(tool),
          async (args, context) =>
            creativeResultToRuntimeToolResult(
              await this.invokeCreativeToolViaKernel(
                tool.name,
                args,
                context.signal,
                context.metadata?.route as AgentRouteLike | undefined,
                {
                  runId: context.runId,
                  agentId: context.agentId,
                  allowedToolNames: context.metadata?.allowedToolNames
                }
              )
            )
        )
      )
    ]

    this.runtimeToolRegistry.clear()
    this.runtime.registerTools(registrations)
    this.syncKernelPlatformSurface()
  }

  listAgents(): MagicAgentPlatformAgentDefinition[] {
    return this.runtime.listAgents().map(normalizeAgentDefinition)
  }

  registerAgent(agent: MagicAgentPlatformAgentDefinition): MagicAgentPlatformAgentDefinition {
    const normalized = normalizeAgentDefinition(agent)
    if (!normalized.id) {
      throw new Error('MagicAgent platform agent id is required.')
    }
    const registered = normalizeAgentDefinition(this.runtime.registerAgent(normalized))
    this.syncKernelPlatformSurface(true)
    return registered
  }

  listTools(
    options: { agentId?: string; source?: MagicAgentPlatformToolSource } = {}
  ): MagicAgentPlatformToolDefinition[] {
    const source = options.source
    const tools: MagicAgentPlatformToolDefinition[] = []

    if (!source || source === 'assistantRuntime') {
      tools.push(
        ...this.assistantRuntime
          .listTools()
          .filter((tool) => !isMagicAgentPlatformDeniedToolName(tool.name))
          .map(assistantToolToPlatformDefinition)
      )
    }

    if (!source || source === 'creative') {
      tools.push(...this.listPlatformCreativeTools().map(creativeToolToPlatformDefinition))
    }

    // v1 deliberately does not expose MagicAgentRuntime's internal registry as a
    // callable/listable platform source. Tool execution must stay behind the
    // route-aware AssistantRuntime or the fail-closed creative Kernel path.
    return tools
  }

  async callTool(req: MagicAgentPlatformToolCallReq): Promise<MagicAgentPlatformToolCallResp> {
    const name = normalizeMagicPotToolName(req.name)
    if (!name) {
      return {
        ok: false,
        toolName: '',
        source: req.source || 'magicAgentRuntime',
        status: 'unavailable',
        content: 'Tool name is required.',
        unavailableReason: 'Tool name is required.'
      }
    }

    const source = req.source || this.resolveToolSource(name)
    const args = req.args || {}

    if (isMagicAgentPlatformDeniedToolName(name)) {
      return {
        ok: false,
        toolName: name,
        source,
        status: 'permission-denied',
        content: `Tool "${name}" is not allowed through the MagicAgent platform boundary.`,
        error: `Tool "${name}" is not allowed through the MagicAgent platform boundary.`
      }
    }

    try {
      if (source === 'assistantRuntime') {
        return {
          ok: false,
          toolName: name,
          source,
          status: 'permission-denied',
          content:
            'AssistantRuntime tools are not directly callable through the MagicAgent platform service. Use route-scoped runAgent with an explicit allowedToolNames list.',
          error: 'Direct AssistantRuntime tool IPC is disabled at the platform boundary.'
        }
      }

      if (source === 'creative') {
        const route = requirePlatformRoute(req.route, 'creative tool call')
        return creativeResultToPlatformToolResult(
          await this.invokeCreativeToolViaKernel(name, args, undefined, route, req.metadata)
        )
      }

      return {
        ok: false,
        toolName: name,
        source,
        status: 'permission-denied',
        content:
          'MagicAgentRuntime tools are not directly callable through the platform service. Use AssistantRuntime-routed execution.',
        error: 'MagicAgentRuntime direct tool execution is disabled at the platform boundary.'
      }
    } catch (error) {
      return this.errorToolResult(name, source, error)
    }
  }

  async runAgent(req: MagicAgentPlatformRunReq): Promise<MagicAgentPlatformRunResp> {
    this.refreshRuntimeTools()
    const route = requirePlatformRoute(req.route, 'agent run')
    const agentId = normalizeMagicPotToolName(req.agentId) || 'magicpot.default.chat'
    const agentDefinition = this.listAgents().find((agent) => agent.id === agentId)
    const effectiveAllowedToolNames = resolveRunAllowedToolNames(
      req.allowedToolNames,
      agentDefinition?.toolNames
    )
    const startedAt = Date.now()
    const session = this.agentKernel.registerSession(route, { source: 'kernel' })
    const kernelRun = this.agentKernel.createMasterRun({
      session,
      goal: cleanString(req.text) || `Run MagicAgent ${agentId}`,
      label: `MagicAgent ${agentId}`,
      parallelism: 1,
      requestedBy: cleanString(req.metadata?.requestedBy) || 'svcMagicAgentPlatform',
      metadata: {
        ...(req.metadata || {}),
        source: 'magicAgentPlatform',
        executionBoundary: 'assistantRuntime',
        agentId
      }
    })
    this.agentKernel.updateRun(kernelRun.runId, {
      status: 'running',
      startedAt
    })

    try {
      const assistantResult = await this.assistantRuntime.handleMessage({
        route,
        text: req.text,
        ...(req.attachments?.length ? { attachments: req.attachments } : {}),
        ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
        ...(req.profileId ? { profileId: req.profileId } : {}),
        execution: {
          mode: 'inherit',
          allowedToolNames: effectiveAllowedToolNames,
          traceLabel:
            cleanString(req.metadata?.traceLabel) ||
            cleanString(req.metadata?.requestedBy) ||
            `magicagent:${agentId}`
        }
      })
      const finishedAt = Date.now()
      const status =
        assistantResult.status === 'failed'
          ? 'failed'
          : assistantResult.status === 'cancelled'
            ? 'aborted'
            : 'completed'
      const kernelStatus = mapMagicAgentStatusToKernelStatus(status)
      this.agentKernel.updateRun(kernelRun.runId, {
        status: kernelStatus,
        endedAt: finishedAt,
        metadata: {
          ...(kernelRun.metadata || {}),
          assistantRunId: assistantResult.runId,
          assistantSessionKey: assistantResult.sessionKey,
          magicAgentStatus: status,
          executionBoundary: 'assistantRuntime'
        }
      })
      this.agentKernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: kernelStatus === 'completed' ? 'run.completed' : 'run.failed',
        message:
          kernelStatus === 'completed'
            ? `MagicAgent run completed through AssistantRuntime: ${agentId}`
            : `MagicAgent run ended through AssistantRuntime: ${status}`,
        metadata: {
          assistantRunId: assistantResult.runId,
          assistantSessionKey: assistantResult.sessionKey,
          magicAgentStatus: status,
          executionBoundary: 'assistantRuntime'
        }
      })

      return {
        runId: assistantResult.runId || kernelRun.runId,
        agentId,
        status,
        content: String(assistantResult.reply?.content || ''),
        messages: [
          {
            role: 'user',
            content: req.text,
            ...(req.attachments?.length ? { attachments: req.attachments } : {})
          },
          {
            role: 'assistant',
            content: String(assistantResult.reply?.content || ''),
            ...(assistantResult.reply?.attachments?.length
              ? { attachments: assistantResult.reply.attachments }
              : {}),
            metadata: {
              source: 'assistantRuntime',
              sessionKey: assistantResult.sessionKey,
              ...(assistantResult.runId ? { assistantRunId: assistantResult.runId } : {})
            }
          }
        ],
        toolCalls: [],
        events: (assistantResult.events || []).map((event) => ({
          eventId: event.eventId,
          runId: event.runId,
          agentId,
          type: `assistantRuntime.${event.type}`,
          message: event.message,
          createdAt: event.createdAt,
          metadata: {
            ...(event.metadata || {}),
            sessionKey: event.sessionKey
          }
        })),
        startedAt,
        finishedAt
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.agentKernel.updateRun(kernelRun.runId, {
        status: 'failed',
        endedAt: Date.now(),
        metadata: {
          ...(kernelRun.metadata || {}),
          error: message,
          executionBoundary: 'assistantRuntime'
        }
      })
      this.agentKernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: 'run.failed',
        message,
        metadata: {
          source: 'magicAgentPlatform',
          executionBoundary: 'assistantRuntime',
          agentId
        }
      })
      throw error
    }
  }

  private resolveToolSource(name: string): MagicAgentPlatformToolSource {
    if (
      this.assistantRuntime
        .listTools()
        .some((tool) => normalizeMagicPotToolName(tool.name) === name)
    ) {
      return 'assistantRuntime'
    }
    if (
      this.listPlatformCreativeTools().some((tool) => normalizeMagicPotToolName(tool.name) === name)
    ) {
      return 'creative'
    }
    return 'magicAgentRuntime'
  }

  private syncKernelPlatformSurface(force = false): void {
    const agents = this.runtime.listAgents().map(normalizeAgentDefinition)
    const creativeTools = this.listPlatformCreativeTools()
    const activeCapabilityIds = new Set([
      ...agents.map((agent) => toKernelAgentCapabilityId(agent.id)),
      ...creativeTools.map((tool) => toKernelCreativeCapabilityId(tool.name))
    ])
    const signature = JSON.stringify({
      agents: agents
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          toolNames: agent.toolNames,
          maxToolIterations: agent.maxToolIterations,
          profileId: agent.profileId
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      creativeTools: creativeTools
        .map((tool) => ({
          name: tool.name,
          category: tool.category,
          status: tool.status,
          permissionLevel: tool.permissionLevel,
          requiresConfirmation: tool.requiresConfirmation,
          disabledByDefault: tool.disabledByDefault,
          unavailableReason: tool.unavailableReason
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    })
    const existingCapabilityIds = new Set(
      this.agentKernel.listCapabilities().map((capability) => capability.capabilityId)
    )
    const missingManagedCapability = [...this.managedKernelCapabilityIds].some(
      (capabilityId) => !existingCapabilityIds.has(capabilityId)
    )
    if (!force && signature === this.kernelSurfaceSignature && !missingManagedCapability) {
      return
    }

    for (const capabilityId of [...this.managedKernelCapabilityIds]) {
      if (!activeCapabilityIds.has(capabilityId)) {
        this.agentKernel.removeCapability(capabilityId)
        this.managedKernelCapabilityIds.delete(capabilityId)
      }
    }

    for (const agent of agents) {
      const capabilityId = toKernelAgentCapabilityId(agent.id)
      this.agentKernel.registerCapability({
        capabilityId,
        name: agent.name,
        kind: 'orchestrator',
        description: agent.description || 'MagicAgent platform agent.',
        version: '1.0.0',
        scope: 'global',
        transport: ['internal'],
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            attachments: { type: 'array' }
          },
          required: ['text']
        },
        metadata: {
          source: 'magicAgentPlatform',
          agentId: agent.id,
          toolNames: agent.toolNames,
          maxToolIterations: agent.maxToolIterations,
          profileId: agent.profileId
        }
      })
      this.managedKernelCapabilityIds.add(capabilityId)
    }

    for (const tool of creativeTools) {
      const capabilityId = toKernelCreativeCapabilityId(tool.name)
      this.agentKernel.registerTool({
        tool: {
          capabilityId,
          name: tool.name,
          toolName: toKernelCreativeToolName(tool.name),
          kind: 'tool',
          description: tool.description,
          version: '1.0.0',
          scope: 'session',
          transport: ['internal'],
          inputSchema: tool.inputSchema,
          metadata: {
            source: 'magicAgentPlatform',
            platformSource: 'creative',
            originalToolName: tool.name,
            category: tool.category,
            status: tool.status,
            permissionLevel: tool.permissionLevel,
            requiresConfirmation: tool.requiresConfirmation,
            disabledByDefault: tool.disabledByDefault,
            ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {})
          }
        },
        invoker: async (request) => {
          const result = await this.creativeToolRegistry.dispatch(
            tool.name,
            request.args,
            this.createCreativeContext(request.signal)
          )
          return {
            ok: result.ok,
            content: creativeResultToRuntimeToolResult(result).content,
            metadata: {
              creativeResult: result,
              source: 'magicAgentPlatform',
              platformSource: 'creative',
              originalToolName: tool.name
            },
            ...(result.ok
              ? {}
              : {
                  error: {
                    message:
                      result.error ||
                      result.unavailableReason ||
                      `MagicAgent creative tool failed: ${tool.name}`
                  }
                })
          }
        }
      })
      this.managedKernelCapabilityIds.add(capabilityId)
    }

    this.kernelSurfaceSignature = signature
  }

  private listPlatformCreativeTools(): MagicAgentCreativeToolDefinition[] {
    return this.creativeToolRegistry
      .listTools()
      .filter(
        (tool) =>
          !isMagicAgentPlatformDeniedToolName(tool.name) &&
          !isMagicAgentPlatformDeniedToolName(toKernelCreativeToolName(tool.name)) &&
          !isMagicAgentPlatformDeniedToolName(toKernelCreativeCapabilityId(tool.name))
      )
  }

  private async invokeCreativeToolViaKernel(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    route?: AgentRouteLike,
    metadata?: Record<string, unknown>
  ): Promise<MagicAgentCreativeToolResult> {
    this.syncKernelPlatformSurface()
    if (isMagicAgentPlatformDeniedToolName(name)) {
      return {
        ok: false,
        toolName: name,
        category: 'terminal',
        status: 'unavailable',
        permissionDenied: true,
        error: `Tool "${name}" is not allowed through the MagicAgent platform boundary.`
      }
    }
    const definition = this.listPlatformCreativeTools().find(
      (tool) => normalizeMagicPotToolName(tool.name) === name
    )
    if (!definition) {
      return {
        ok: false,
        toolName: name,
        category: 'asset',
        status: 'unavailable',
        unavailableReason: `Unknown MagicAgent creative tool: ${name}`
      }
    }
    const session = this.agentKernel.registerSession(
      requirePlatformRoute(route, 'creative tool invocation'),
      { source: 'kernel' }
    )
    const result = await this.agentKernel.invokeTool({
      toolName: toKernelCreativeToolName(name),
      args,
      session,
      signal,
      source: 'kernel',
      capabilityId: toKernelCreativeCapabilityId(name),
      traceLabel:
        cleanString(metadata?.runId) || cleanString(metadata?.traceLabel) || `magicagent:${name}`,
      metadata: {
        ...(metadata || {}),
        source: 'magicAgentPlatform',
        platformSource: 'creative',
        originalToolName: name
      }
    })
    const creativeResult = result.metadata?.creativeResult
    if (isMagicAgentCreativeToolResult(creativeResult)) {
      return creativeResult
    }

    return {
      ok: result.ok,
      toolName: name,
      category: definition?.category || 'asset',
      status: definition?.status || (result.ok ? 'available' : 'unavailable'),
      ...(result.content ? { data: { content: result.content } } : {}),
      ...(result.error?.message ? { error: result.error.message } : {})
    }
  }

  private createCreativeContext(signal?: AbortSignal): MagicAgentCreativeToolContext {
    let config: ReturnType<typeof getConfig> | undefined
    try {
      config = getConfig()
    } catch {
      // Creative v1 adapters treat config as optional. Keep discovery and structured
      // unavailable responses working even when config has not been initialized yet.
    }

    return {
      ...(config ? { config } : {}),
      ...(signal ? { signal } : {}),
      ...(this.creativeToolDependencies ? { dependencies: this.creativeToolDependencies } : {})
    }
  }

  private errorToolResult(
    name: string,
    source: MagicAgentPlatformToolSource,
    error: unknown
  ): MagicAgentPlatformToolCallResp {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      toolName: name,
      source,
      status: isPermissionError(error)
        ? 'permission-denied'
        : /unknown tool|not registered/i.test(message)
          ? 'unavailable'
          : 'failed',
      content: message,
      ...(/unknown tool|not registered/i.test(message) ? { unavailableReason: message } : {}),
      error: message
    }
  }
}

let platformAdapterSingleton: MagicAgentPlatformAdapter | null = null

export const getMagicAgentPlatformAdapter = (): MagicAgentPlatformAdapter => {
  if (!platformAdapterSingleton) {
    platformAdapterSingleton = new MagicAgentPlatformAdapter()
  }
  return platformAdapterSingleton
}
