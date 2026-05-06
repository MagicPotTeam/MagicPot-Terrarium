import { getAssistantRuntime } from '../assistantRuntime/runtime'
import {
  appendMagicPotMcpAudit,
  authorizeMagicPotMcpToolInvocation,
  getMagicPotMcpRouteForSession
} from './platform/runtime'

export const invokeMagicPotMcpToolForSession = async (options: {
  sessionId: string
  toolName: string
  input: Record<string, unknown>
}): Promise<{
  toolName: string
  output?: unknown
  error?: string
}> => {
  const target = `chat.tool.${options.toolName}`
  const actor = `bot:${options.sessionId}`
  const route = getMagicPotMcpRouteForSession(options.sessionId)

  if (!route) {
    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: 'deny',
      reason: `Unknown MCP session: ${options.sessionId}`
    })
    return {
      toolName: options.toolName,
      error: `Unknown MCP session: ${options.sessionId}`
    }
  }

  const permission = authorizeMagicPotMcpToolInvocation({
    actor,
    action: 'tool.invoke',
    target,
    transport: 'streamable-http',
    sessionId: options.sessionId,
    metadata: {
      route
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
        route,
        policyId: permission.policyId
      }
    })
    return {
      toolName: options.toolName,
      error: permission.reason || `Tool "${options.toolName}" is not allowed.`
    }
  }

  try {
    const result = await getAssistantRuntime().callTool(route, options.toolName, options.input, {
      allowedToolNames: null
    })
    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: 'allow',
      metadata: {
        route,
        policyId: permission.policyId
      }
    })
    return {
      toolName: options.toolName,
      output: result
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendMagicPotMcpAudit({
      actor,
      action: 'tool.invoke',
      target,
      decision: 'observe',
      reason: message,
      metadata: {
        route,
        policyId: permission.policyId
      }
    })
    return {
      toolName: options.toolName,
      error: message
    }
  }
}
