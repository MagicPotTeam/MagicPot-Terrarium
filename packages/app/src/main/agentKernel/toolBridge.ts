import type { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import type {
  AssistantToolCallResult,
  AssistantToolRegistry
} from '../assistantRuntime/toolRegistry'
import type {
  AssistantRoute,
  AssistantRuntimeResult,
  AssistantTaskGroupState,
  AssistantTaskState
} from '../assistantRuntime/types'
import type { Config } from '@shared/config/config'
import { throwIfAborted } from '@shared/agent'
import { normalizeMagicPotToolName } from '@shared/app/types'
import { getAgentKernel } from './agentKernel'
import {
  appendMagicPotMcpAudit,
  authorizeMagicPotMcpToolInvocation,
  refreshMagicPotMcpPlatformRuntime
} from '../mcp/platform/runtime'
import { isMagicAgentPlatformDeniedToolName } from '../magicAgentRuntime/toolPolicy'

type KernelBackedToolContext = {
  config: Config
  route: AssistantRoute
  sessionStore: AssistantSessionStore
  taskState: AssistantTaskState
  workspaceMemoryFile?: string
  workspaceTaskContextFile?: string
  workspaceContextFile?: string
  workspacePinnedContextFile?: string
  workspaceMetaFile?: string
  resumeRun?: (
    route: AssistantRoute,
    runId: string,
    options?: { async?: boolean }
  ) => Promise<AssistantRuntimeResult>
  resumeWorkflow?: (
    workflowId: string,
    route?: AssistantRoute,
    options?: { async?: boolean }
  ) => Promise<AssistantRuntimeResult>
  startTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  progressTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      label?: string
      completed?: number
      total?: number
      percent?: number
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  approveTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      approvedBy?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  exportTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      exportTarget?: string
      exportArtifactIds?: string[]
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  cancelTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  resumeTaskGroup?: (
    route: AssistantRoute,
    taskGroupId: string,
    options?: { async?: boolean }
  ) => Promise<AssistantRuntimeResult>
}

const TOOL_CAPABILITY_PREFIX = 'chat.tool.'

const toToolCapabilityId = (toolName: string): string =>
  `${TOOL_CAPABILITY_PREFIX}${normalizeMagicPotToolName(toolName)}`

const cloneToolMetadata = (context: KernelBackedToolContext) => ({
  toolContext: context
})

export const syncAssistantToolsWithAgentKernel = (toolRegistry: AssistantToolRegistry): void => {
  const kernel = getAgentKernel()
  const toolCatalog = toolRegistry
    .listTools()
    .filter(
      (tool) =>
        !isMagicAgentPlatformDeniedToolName(tool.name) &&
        !isMagicAgentPlatformDeniedToolName(toToolCapabilityId(tool.name))
    )
  const activeCapabilityIds = new Set(toolCatalog.map((tool) => toToolCapabilityId(tool.name)))

  try {
    refreshMagicPotMcpPlatformRuntime(undefined, {
      toolCatalog
    })
  } catch {
    // Unit tests often instantiate the chat runtime without bootstrapping config first.
  }

  for (const capability of kernel.listCapabilities()) {
    if (
      capability.capabilityId.startsWith(TOOL_CAPABILITY_PREFIX) &&
      !activeCapabilityIds.has(capability.capabilityId)
    ) {
      kernel.removeCapability(capability.capabilityId)
    }
  }

  for (const tool of toolCatalog) {
    kernel.registerTool({
      tool: {
        capabilityId: toToolCapabilityId(tool.name),
        name: tool.name,
        toolName: normalizeMagicPotToolName(tool.name),
        kind: 'tool',
        description: tool.description,
        version: '1.0.0',
        scope: 'session',
        transport: ['internal', 'mcp'],
        inputSchema: tool.inputSchema,
        metadata: {
          source: 'assistant'
        }
      },
      invoker: async (request) => {
        const toolContext = request.metadata?.toolContext as KernelBackedToolContext | undefined
        if (!toolContext) {
          throw new Error(`Missing kernel tool context for "${request.toolName}".`)
        }

        throwIfAborted(request.signal)
        const result = await toolRegistry.callTool(request.toolName, request.args, {
          ...toolContext,
          signal: request.signal
        })
        return {
          ok: true,
          content: result.content,
          metadata: result.metadata
        }
      }
    })
  }
}

export const invokeAssistantToolViaKernel = async (options: {
  toolRegistry: AssistantToolRegistry
  toolName: string
  args: Record<string, unknown>
  context: KernelBackedToolContext
  signal?: AbortSignal
}): Promise<AssistantToolCallResult> => {
  throwIfAborted(options.signal)
  syncAssistantToolsWithAgentKernel(options.toolRegistry)

  const kernel = getAgentKernel()
  const normalizedToolName = normalizeMagicPotToolName(options.toolName)
  const session = kernel.registerSession(options.context.route, {
    source: 'assistant'
  })
  const actor = `assistant:${session.sessionKey}`
  const target = toToolCapabilityId(normalizedToolName)

  if (
    isMagicAgentPlatformDeniedToolName(normalizedToolName) ||
    isMagicAgentPlatformDeniedToolName(target)
  ) {
    const reason = `Tool "${normalizedToolName}" is not allowed through the MagicAgent platform boundary.`
    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: 'deny',
      reason,
      metadata: {
        route: session.route
      }
    })
    throw new Error(reason)
  }

  const permission = authorizeMagicPotMcpToolInvocation({
    actor,
    action: 'tool.invoke',
    target,
    transport: 'stdio',
    metadata: {
      route: session.route
    }
  })

  if (!permission.allowed) {
    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: 'deny',
      reason: permission.reason,
      metadata: {
        route: session.route,
        policyId: permission.policyId
      }
    })
    throw new Error(permission.reason || `Tool "${options.toolName}" is not allowed.`)
  }

  try {
    throwIfAborted(options.signal)
    const result = await kernel.invokeTool({
      toolName: normalizedToolName,
      args: options.args,
      session,
      signal: options.signal,
      source: 'assistant',
      capabilityId: target,
      metadata: cloneToolMetadata(options.context)
    })

    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: result.ok ? 'allow' : 'observe',
      metadata: {
        ok: result.ok,
        durationMs: result.durationMs,
        route: session.route,
        policyId: permission.policyId
      }
    })

    if (!result.ok) {
      throw new Error(result.error?.message || `Tool "${options.toolName}" failed.`)
    }

    return {
      content: result.content || '',
      metadata: result.metadata
    }
  } catch (error) {
    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: 'observe',
      reason: error instanceof Error ? error.message : String(error),
      metadata: {
        route: session.route,
        policyId: permission.policyId
      }
    })
    throw error
  }
}
