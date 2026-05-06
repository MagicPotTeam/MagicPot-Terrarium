import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import { Config } from '@shared/config/config'
import { buildMagicPotAppCatalogSnapshot } from '@shared/app/catalog'
import {
  MAGICPOT_CHAT_APPS_RESOURCE_URI,
  MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
  MAGICPOT_SESSION_STATUS_TOOL_NAME
} from '@shared/app/types'
import { buildAgentRoute } from '@shared/agent'
import { getAssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantRoute } from '../assistantRuntime/types'
import { getMcpRuntimeStatus } from './status'

type MagicPotMcpServerOptions = {
  config?: Config
  configProvider?: () => Config
}

const SAFE_TOOL_NAMES = new Set([
  MAGICPOT_SESSION_STATUS_TOOL_NAME,
  'workspace.context',
  'memory.recent',
  'runs.list',
  'run.trace',
  'run.lineage',
  'artifacts.list',
  'session.summary',
  'session.inspect',
  'run.inspect',
  'events.list',
  'audit.timeline',
  'ops.status',
  'session.cleanup',
  'limits.status',
  'workspaces.list',
  'workflows.list',
  'workspace.inspect',
  'workflow.inspect',
  'workflow.resume',
  'task.group.list',
  'task.group.inspect',
  'workspace.detach',
  'apps.list',
  'tools.list',
  'mcp.status'
])

const routeSchema = {
  channel: z.string().default('generic').describe('Chat channel id.'),
  scopeType: z.enum(['dm', 'group']).default('dm').describe('Chat scope type.'),
  scopeId: z.string().describe('Chat scope id.'),
  threadId: z.string().optional().describe('Optional thread id.')
}

const optionalRouteInputSchema = {
  channel: z.string().optional().describe('Optional chat channel id.'),
  scopeType: z.enum(['dm', 'group']).optional().describe('Optional chat scope type.'),
  scopeId: z.string().optional().describe('Optional chat scope id.'),
  threadId: z.string().optional().describe('Optional thread id.')
}

const toolOutputSchema = {
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
}

const toRoute = (args: {
  channel: string
  scopeType: 'dm' | 'group'
  scopeId: string
  threadId?: string
}): AssistantRoute =>
  buildAgentRoute({
    channel: args.channel,
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    threadId: args.threadId
  }) as AssistantRoute

const toOptionalRoute = (args: {
  channel?: string
  scopeType?: 'dm' | 'group'
  scopeId?: string
  threadId?: string
}): AssistantRoute | undefined => {
  if (!args.scopeId) return undefined
  return buildAgentRoute({
    channel: args.channel || 'generic',
    scopeType: args.scopeType || 'dm',
    scopeId: args.scopeId,
    threadId: args.threadId
  }) as AssistantRoute
}

const listSafeRuntimeTools = () =>
  getAssistantRuntime()
    .listTools()
    .filter((tool) => SAFE_TOOL_NAMES.has(tool.name))

const getBridgeToolCatalog = () => [
  {
    name: 'session.summary',
    description: 'Return the latest session summary for a route.'
  },
  {
    name: 'session.inspect',
    description: 'Return the full persisted session record for a route.'
  },
  {
    name: 'run.inspect',
    description: 'Return a specific run record by run id for a route.'
  },
  {
    name: 'run.trace',
    description: 'Return a correlated trace timeline for a specific run.'
  },
  {
    name: 'run.lineage',
    description: 'Return the related run chain, ancestors, and descendants for a specific run.'
  },
  {
    name: 'run.resume',
    description: 'Requeue a failed or cancelled run from its stored request text.'
  },
  {
    name: 'events.list',
    description: 'List recent run events for a route.'
  },
  {
    name: 'audit.timeline',
    description: 'List a correlated audit timeline for runs, events, and artifacts.'
  },
  {
    name: 'ops.status',
    description: 'Return derived operational counters and latency summaries.'
  },
  {
    name: 'session.cleanup',
    description: 'Clear the current session or prune stale sessions older than a threshold.'
  },
  {
    name: 'limits.status',
    description: 'Return retention limits and current store usage for a route.'
  },
  {
    name: 'workspaces.list',
    description: 'List workspace aggregates derived from persisted chat sessions.'
  },
  {
    name: 'workflows.list',
    description: 'List persisted workflow records aggregated from run lineage.'
  },
  {
    name: 'workspace.inspect',
    description: 'Inspect a workspace aggregate by workspace id.'
  },
  {
    name: 'workflow.inspect',
    description: 'Inspect a persisted workflow record by workflow id.'
  },
  {
    name: 'workflow.resume',
    description: 'Requeue the latest failed or cancelled run in a persisted workflow record.'
  },
  {
    name: 'task.group.list',
    description: 'List task-group workflow summaries derived from persisted run lineage.'
  },
  {
    name: 'task.group.inspect',
    description: 'Inspect a task-group workflow record by task-group id.'
  },
  {
    name: 'workspace.attach',
    description: 'Attach a route to a workspace identity and optionally update shared metadata.'
  },
  {
    name: 'workspace.detach',
    description: 'Detach a route from a shared workspace and restore its default workspace.'
  },
  {
    name: 'workspace.manage',
    description: 'Apply workspace governance actions such as share, privatize, archive, or revive.'
  },
  {
    name: 'apps.list',
    description: 'List the unified MagicPot app catalog snapshot.'
  },
  {
    name: 'tools.list',
    description: 'List the read-only tool catalog exposed by the MCP bridge.'
  },
  {
    name: 'mcp.status',
    description: 'Describe current MCP client connections and the local MagicPot MCP server state.'
  }
]

const toJsonToolResponse = (result: unknown) => {
  const content = JSON.stringify(result, null, 2)
  return {
    content: [{ type: 'text' as const, text: content }],
    structuredContent: {
      content,
      ...(result && typeof result === 'object' && !Array.isArray(result)
        ? { metadata: result as Record<string, unknown> }
        : {})
    }
  }
}

const toTextToolResponse = (result: { content: string; metadata?: Record<string, unknown> }) => ({
  content: [{ type: 'text' as const, text: result.content }],
  structuredContent: {
    content: result.content,
    metadata: result.metadata
  }
})

export const createMagicPotMcpServer = ({
  config,
  configProvider
}: MagicPotMcpServerOptions): McpServer => {
  const server = new McpServer({
    name: 'magicpot-chat',
    version: '1.0.0'
  })
  const resolveConfig = (): Config => {
    const resolved = configProvider?.() || config
    if (!resolved) {
      throw new Error('MagicPot MCP server requires a config or configProvider.')
    }
    return resolved
  }

  const getAppCatalogSnapshot = async () => {
    let runtimeStatus: Awaited<ReturnType<typeof getMcpRuntimeStatus>> | null = null
    try {
      runtimeStatus = await getMcpRuntimeStatus(resolveConfig())
    } catch (error) {
      console.warn('[magicpot.mcp] Failed to collect runtime-enriched app catalog snapshot:', error)
    }
    return buildMagicPotAppCatalogSnapshot(resolveConfig(), { runtimeStatus })
  }

  server.registerTool(
    MAGICPOT_SESSION_STATUS_TOOL_NAME,
    {
      description: 'Describe the current chat session and task state for a route.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().callTool(
        toRoute(args),
        MAGICPOT_SESSION_STATUS_TOOL_NAME,
        {}
      )
      return toTextToolResponse(result)
    }
  )

  server.registerTool(
    'session.summary',
    {
      description: 'Return the latest persisted session summary for a route.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => toJsonToolResponse(await getAssistantRuntime().getSessionSummary(toRoute(args)))
  )

  server.registerTool(
    'session.inspect',
    {
      description: 'Return the full persisted session record for a route.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => toJsonToolResponse(await getAssistantRuntime().getSession(toRoute(args)))
  )

  server.registerTool(
    'run.inspect',
    {
      description: 'Return a specific run record by run id for a route.',
      inputSchema: {
        ...routeSchema,
        runId: z.string().describe('Chat run id.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse(await getAssistantRuntime().getRun(args.runId, toRoute(args)))
  )

  server.registerTool(
    'run.trace',
    {
      description: 'Return a correlated trace timeline for a specific run by run id for a route.',
      inputSchema: {
        ...routeSchema,
        runId: z.string().describe('Chat run id.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse(await getAssistantRuntime().getRunTrace(args.runId, toRoute(args)))
  )

  server.registerTool(
    'run.lineage',
    {
      description:
        'Return the related run chain, ancestors, and descendants for a specific run by run id for a route.',
      inputSchema: {
        ...routeSchema,
        runId: z.string().describe('Chat run id.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse(await getAssistantRuntime().getRunLineage(args.runId, toRoute(args)))
  )

  server.registerTool(
    'run.resume',
    {
      description: 'Requeue a failed or cancelled run from its stored request text.',
      inputSchema: {
        ...routeSchema,
        runId: z.string().describe('Chat run id to resume.'),
        async: z
          .boolean()
          .optional()
          .describe('When true, queue the resumed run and return immediately.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) =>
      toJsonToolResponse(
        await getAssistantRuntime().resumeRun(toRoute(args), args.runId, {
          async: Boolean(args.async)
        })
      )
  )

  server.registerTool(
    'events.list',
    {
      description: 'List recent run events for a route.',
      inputSchema: {
        ...routeSchema,
        limit: z.number().int().min(1).max(100).optional().describe('Max number of events.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse({
        events: await getAssistantRuntime().listEvents(args.limit, toRoute(args))
      })
  )

  server.registerTool(
    'audit.timeline',
    {
      description: 'List a correlated audit timeline for recent runs, events, and artifacts.',
      inputSchema: {
        ...optionalRouteInputSchema,
        runId: z.string().optional().describe('Optional run id filter.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max number of entries.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse({
        timeline: await getAssistantRuntime().listAuditTimeline({
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(toOptionalRoute(args) ? { route: toOptionalRoute(args) } : {}),
          ...(args.runId ? { runId: args.runId } : {})
        })
      })
  )

  server.registerTool(
    'ops.status',
    {
      description: 'Return derived operational counters and latency summaries.',
      inputSchema: {
        ...optionalRouteInputSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max number of recent runs to include.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse(
        await getAssistantRuntime().getOpsStatus(args.limit, toOptionalRoute(args))
      )
  )

  server.registerTool(
    'session.cleanup',
    {
      description: 'Clear the current session or prune stale sessions older than a threshold.',
      inputSchema: {
        ...routeSchema,
        mode: z.enum(['clear', 'prune']).default('clear').describe('Cleanup mode.'),
        olderThanDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Required for prune mode.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().cleanupSession(toRoute(args), {
        mode: args.mode,
        ...(args.olderThanDays !== undefined ? { olderThanDays: args.olderThanDays } : {})
      })
      return toJsonToolResponse(result)
    }
  )

  server.registerTool(
    'limits.status',
    {
      description: 'Return retention limits and current store usage for a route.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().callTool(toRoute(args), 'limits.status', {})
      return toTextToolResponse(result)
    }
  )

  server.registerTool(
    'workspaces.list',
    {
      description: 'List workspace aggregates derived from persisted chat sessions.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max number of workspace aggregates to return.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse({
        workspaces: await getAssistantRuntime().listWorkspaces(Math.max(1, args.limit || 20))
      })
  )

  server.registerTool(
    'workflows.list',
    {
      description: 'List persisted workflow records aggregated from run lineage.',
      inputSchema: {
        ...optionalRouteInputSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max number of workflow records to return.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse({
        workflows: await getAssistantRuntime().listWorkflows(
          Math.max(1, args.limit || 20),
          toOptionalRoute(args)
        )
      })
  )

  server.registerTool(
    'workspace.inspect',
    {
      description: 'Inspect a workspace aggregate by workspace id.',
      inputSchema: {
        workspaceId: z.string().min(1).describe('Workspace id to inspect.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const workspace = await getAssistantRuntime().getWorkspace(args.workspaceId, { runLimit: 20 })
      return toJsonToolResponse(
        workspace || {
          workspaceId: args.workspaceId,
          found: false,
          sessions: []
        }
      )
    }
  )

  server.registerTool(
    'workflow.inspect',
    {
      description: 'Inspect a persisted workflow record by workflow id.',
      inputSchema: {
        ...optionalRouteInputSchema,
        workflowId: z.string().min(1).describe('Workflow id or root run id to inspect.'),
        runLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max number of runs to include.'),
        eventLimit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max number of events to include.'),
        artifactLimit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max number of artifacts to include.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const workflow = await getAssistantRuntime().getWorkflow(
        args.workflowId,
        toOptionalRoute(args),
        {
          ...(args.runLimit !== undefined ? { runLimit: args.runLimit } : {}),
          ...(args.eventLimit !== undefined ? { eventLimit: args.eventLimit } : {}),
          ...(args.artifactLimit !== undefined ? { artifactLimit: args.artifactLimit } : {})
        }
      )
      return toJsonToolResponse(
        workflow || {
          workflowId: args.workflowId,
          found: false,
          runs: []
        }
      )
    }
  )

  server.registerTool(
    'workflow.resume',
    {
      description: 'Requeue the latest failed or cancelled run in a persisted workflow record.',
      inputSchema: {
        ...routeSchema,
        workflowId: z.string().min(1).describe('Workflow id or root run id to resume.'),
        async: z
          .boolean()
          .optional()
          .describe('When true, queue the resumed run and return immediately.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) =>
      toJsonToolResponse(
        await getAssistantRuntime().resumeWorkflow(args.workflowId, toRoute(args), {
          async: Boolean(args.async)
        })
      )
  )

  server.registerTool(
    'task.group.list',
    {
      description: 'List task-group workflow summaries derived from persisted run lineage.',
      inputSchema: {
        ...optionalRouteInputSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max number of task-group records to return.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) =>
      toJsonToolResponse({
        taskGroups: await getAssistantRuntime().listTaskGroups(
          Math.max(1, args.limit || 20),
          toOptionalRoute(args)
        )
      })
  )

  server.registerTool(
    'task.group.inspect',
    {
      description: 'Inspect a task-group workflow record by task-group id.',
      inputSchema: {
        ...optionalRouteInputSchema,
        taskGroupId: z.string().min(1).describe('Task-group id to inspect.'),
        runLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max number of runs to include.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const workflow = await getAssistantRuntime().getTaskGroup(
        args.taskGroupId,
        toOptionalRoute(args)
      )
      return toJsonToolResponse(
        workflow || {
          taskGroupId: args.taskGroupId,
          found: false,
          runs: []
        }
      )
    }
  )

  server.registerTool(
    'workspace.attach',
    {
      description: 'Attach a route to a workspace identity and optionally update shared metadata.',
      inputSchema: {
        ...routeSchema,
        workspaceId: z.string().min(1).describe('Workspace id to attach this route to.'),
        accessMode: z
          .enum(['private', 'shared'])
          .optional()
          .describe('Optional workspace access mode for this identity.'),
        title: z.string().optional().describe('Optional shared workspace title.'),
        description: z.string().optional().describe('Optional shared workspace description.'),
        sharedNote: z
          .string()
          .optional()
          .describe('Optional shared note to append to the workspace.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async (args) =>
      toJsonToolResponse(
        await getAssistantRuntime().attachWorkspace(toRoute(args), args.workspaceId, {
          ...(args.accessMode ? { accessMode: args.accessMode } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.sharedNote ? { appendSharedNote: args.sharedNote } : {})
        })
      )
  )

  server.registerTool(
    'workspace.context',
    {
      description: 'Return the stored workspace and desktop context snapshot for a route.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().callTool(toRoute(args), 'workspace.context', {})
      return toTextToolResponse(result)
    }
  )

  server.registerTool(
    'workspace.detach',
    {
      description: 'Detach a route from a shared workspace and restore its default workspace.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      }
    },
    async (args) => toJsonToolResponse(await getAssistantRuntime().detachWorkspace(toRoute(args)))
  )

  server.registerTool(
    'workspace.manage',
    {
      description:
        'Apply workspace governance actions such as share, privatize, archive, or revive.',
      inputSchema: {
        ...routeSchema,
        action: z
          .enum(['share', 'privatize', 'archive', 'revive'])
          .describe('Workspace governance action to apply.'),
        workspaceId: z.string().optional().describe('Optional workspace id to manage.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      }
    },
    async (args) =>
      toJsonToolResponse(
        await getAssistantRuntime().manageWorkspace(toRoute(args), args.action, args.workspaceId)
      )
  )

  server.registerTool(
    'memory.recent',
    {
      description: 'Return recent stored memory for a route.',
      inputSchema: routeSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().callTool(toRoute(args), 'memory.recent', {})
      return toTextToolResponse(result)
    }
  )

  server.registerTool(
    'runs.list',
    {
      description: 'List recent run records for a route.',
      inputSchema: {
        ...routeSchema,
        limit: z.number().int().min(1).max(20).optional().describe('Max number of runs to return.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().callTool(toRoute(args), 'runs.list', {
        ...(args.limit !== undefined ? { limit: args.limit } : {})
      })
      return toTextToolResponse(result)
    }
  )

  server.registerTool(
    'artifacts.list',
    {
      description: 'List recorded artifacts for a route.',
      inputSchema: {
        ...routeSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max number of artifacts to return.')
      },
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async (args) => {
      const result = await getAssistantRuntime().callTool(toRoute(args), 'artifacts.list', {
        ...(args.limit !== undefined ? { limit: args.limit } : {})
      })
      return toTextToolResponse(result)
    }
  )

  server.registerTool(
    'mcp.status',
    {
      description:
        'Describe current MCP client connections and the local MagicPot MCP server state.',
      inputSchema: {},
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async () => {
      const status = await getMcpRuntimeStatus(resolveConfig())
      return toTextToolResponse({
        content: JSON.stringify(status, null, 2),
        metadata: status as unknown as Record<string, unknown>
      })
    }
  )

  server.registerTool(
    'apps.list',
    {
      description: 'List the unified MagicPot app catalog snapshot.',
      inputSchema: {},
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async () => toJsonToolResponse(await getAppCatalogSnapshot())
  )

  server.registerTool(
    'tools.list',
    {
      description: 'List the read-only tool catalog exposed by the MCP bridge.',
      inputSchema: {},
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async () =>
      toJsonToolResponse({
        runtimeTools: listSafeRuntimeTools(),
        bridgeTools: getBridgeToolCatalog()
      })
  )

  if (resolveConfig().mcp_config?.server?.expose_resources !== false) {
    server.registerResource(
      'chat.apps',
      MAGICPOT_CHAT_APPS_RESOURCE_URI,
      {
        description: 'Unified MagicPot app catalog snapshot.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: MAGICPOT_CHAT_APPS_RESOURCE_URI,
            mimeType: 'application/json',
            text: JSON.stringify(await getAppCatalogSnapshot(), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.tools',
      MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
      {
        description: 'List of MagicPot chat tools exposed through MCP.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                runtimeTools: listSafeRuntimeTools(),
                bridgeTools: getBridgeToolCatalog()
              },
              null,
              2
            )
          }
        ]
      })
    )

    server.registerResource(
      'chat.sessions',
      'magicpot://chat/sessions',
      {
        description: 'Recent MagicPot chat session summaries.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/sessions',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().listSessions(20), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.workspaces',
      'magicpot://chat/workspaces',
      {
        description: 'Workspace aggregates derived from persisted MagicPot chat sessions.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/workspaces',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().listWorkspaces(50), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.workflows',
      'magicpot://chat/workflows',
      {
        description: 'Persisted workflow records aggregated from MagicPot chat run lineage.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/workflows',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().listWorkflows(50), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.events',
      'magicpot://chat/events',
      {
        description: 'Recent MagicPot chat run events.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/events',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().listEvents(50), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.runs',
      'magicpot://chat/runs',
      {
        description: 'Recent MagicPot chat runs.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/runs',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().listRuns(50), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.audit',
      'magicpot://chat/audit',
      {
        description: 'Recent correlated audit timeline entries for MagicPot chat activity.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/audit',
            mimeType: 'application/json',
            text: JSON.stringify(
              await getAssistantRuntime().listAuditTimeline({ limit: 50 }),
              null,
              2
            )
          }
        ]
      })
    )

    server.registerResource(
      'chat.ops',
      'magicpot://chat/ops',
      {
        description: 'Derived operational counters and recent metrics for MagicPot chat runtime.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/ops',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().getOpsStatus(10), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.artifacts',
      'magicpot://chat/artifacts',
      {
        description: 'Recent MagicPot chat artifacts.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/artifacts',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().listArtifacts(50), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'chat.limits',
      'magicpot://chat/limits',
      {
        description: 'Current chat retention limits and usage.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://chat/limits',
            mimeType: 'application/json',
            text: JSON.stringify(await getAssistantRuntime().getRetentionState(), null, 2)
          }
        ]
      })
    )

    server.registerResource(
      'mcp.status',
      'magicpot://mcp/status',
      {
        description: 'Current MagicPot MCP client and server status.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://mcp/status',
            mimeType: 'application/json',
            text: JSON.stringify(await getMcpRuntimeStatus(resolveConfig()), null, 2)
          }
        ]
      })
    )
  }

  return server
}
