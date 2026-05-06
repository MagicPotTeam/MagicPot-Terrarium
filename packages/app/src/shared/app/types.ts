export const MAGICPOT_CORE_APP_ID = 'magicpot.core'
export const QUICK_APP_IMAGE_INTERROGATION_APP_ID = 'qapp.image-interrogation'
export const QUICK_APP_PROMPT_TRANSLATION_APP_ID = 'qapp.prompt-translation'
export const MAGICPOT_CUSTOM_SKILL_APP_ID_PREFIX = 'custom-skill'

export type MagicPotAppTransport = 'mcp' | 'http' | 'bridge' | 'local' | 'qapp'

export type MagicPotAppSource =
  | 'builtin'
  | 'mcp-client'
  | 'bridge'
  | 'magicpot-core'
  | 'qapp'
  | 'mcp-external'
  | 'custom-skill'

export type MagicPotAppStatus = 'ready' | 'disabled' | 'connecting' | 'error'

export type MagicPotAppTransportDetails = {
  kind: MagicPotAppTransport
  mode?: 'builtin' | 'configured' | 'runtime'
  endpoint?: string
  command?: string
  toolPrefix?: string
}

export type MagicPotAppAuthKind = 'none' | 'header' | 'token' | 'api-key' | 'cookie' | 'unknown'

export type MagicPotAppAuthDescriptor = {
  kind: MagicPotAppAuthKind
  configured: boolean
  labels?: string[]
  source?: string
}

export type MagicPotAppStateDescriptor = {
  enabled: boolean
  status: MagicPotAppStatus
  lastError?: string
}

export type MagicPotAppConfigDescriptor =
  | { kind: 'core' }
  | { kind: 'qapp'; key: string; profileId?: string }
  | { kind: 'mcpClientServer'; serverId: string }
  | { kind: 'customSkill'; skillId: string }

export type MagicPotAppToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type MagicPotAppResourceDescriptor = {
  uri: string
  description?: string
  mimeType?: string
}

export type MagicPotAppCapabilitySet = {
  tools: MagicPotAppToolDescriptor[]
  resources: MagicPotAppResourceDescriptor[]
}

export type MagicPotAppDescriptor = {
  id: string
  name: string
  description: string
  enabled: boolean
  status: MagicPotAppStatus
  transport: MagicPotAppTransport
  source: MagicPotAppSource
  capabilities: MagicPotAppCapabilitySet
  configRef?: MagicPotAppConfigDescriptor
  discovery?: {
    transport: MagicPotAppTransportDetails
    auth: MagicPotAppAuthDescriptor
    state: MagicPotAppStateDescriptor
    config?: MagicPotAppConfigDescriptor
  }
  metadata?: Record<string, unknown>
}

export type MagicPotAppDefinition = MagicPotAppDescriptor

export const MAGICPOT_APP_CATALOG_SCHEMA_VERSION = 1
export const MAGICPOT_CHAT_APPS_RESOURCE_URI = 'magicpot://chat/apps'
export const MAGICPOT_CHAT_TOOLS_RESOURCE_URI = 'magicpot://chat/tools'
export const MAGICPOT_SESSION_STATUS_TOOL_NAME = 'session.status'

const cleanString = (value?: string | null): string => String(value || '').trim()

export const normalizeMagicPotToolName = (value?: string | null): string => {
  return cleanString(value)
}

export const normalizeMagicPotResourceUri = (value?: string | null): string => cleanString(value)

export type MagicPotAppCatalogSnapshot = {
  schemaVersion: number
  generatedAt: string
  apps: MagicPotAppDefinition[]
}

export const MAGICPOT_CORE_TOOL_DESCRIPTORS: ReadonlyArray<MagicPotAppToolDescriptor> = [
  {
    name: 'apps.list',
    description: 'List the unified MagicPot app catalog snapshot.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: MAGICPOT_SESSION_STATUS_TOOL_NAME,
    description: 'Describe the current chat session and task state.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'session.summary',
    description:
      'Return a concise summary of the current chat session, including runs, artifacts, and workspace state.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'session.history',
    description: 'Return recent chat history for the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      }
    }
  },
  {
    name: 'events.list',
    description: 'Return recent runtime events recorded for the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      }
    }
  },
  {
    name: 'session.cleanup',
    description:
      'Clear the current session or prune stale sessions older than a requested threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['clear', 'prune'] },
        olderThanDays: { type: 'integer', minimum: 1, maximum: 3650 }
      }
    }
  },
  {
    name: 'sessions.list',
    description: 'List recent chat sessions tracked by the local session store.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'workspaces.list',
    description: 'List recorded workspace identities aggregated from persisted chat sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'workflows.list',
    description:
      'List persisted workflow records aggregated from run lineage for the current route.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'workspace.inspect',
    description: 'Inspect a recorded workspace identity by workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        runLimit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['workspaceId']
    }
  },
  {
    name: 'workflow.inspect',
    description: 'Inspect a persisted workflow record by workflow id or root run id.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        runLimit: { type: 'integer', minimum: 1, maximum: 100 },
        eventLimit: { type: 'integer', minimum: 1, maximum: 200 },
        artifactLimit: { type: 'integer', minimum: 1, maximum: 200 }
      },
      required: ['workflowId']
    }
  },
  {
    name: 'workflow.resume',
    description:
      'Requeue the latest failed or cancelled run in a persisted workflow record using phase-1 resume semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        async: { type: 'boolean' }
      },
      required: ['workflowId']
    }
  },
  {
    name: 'workspace.attach',
    description:
      'Attach the current route to a workspace identity and optionally update shared workspace metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        accessMode: { type: 'string', enum: ['private', 'shared'] },
        sharedNote: { type: 'string' }
      },
      required: ['workspaceId']
    }
  },
  {
    name: 'workspace.detach',
    description:
      'Detach the current route from a shared workspace and restore its default workspace.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'workspace.manage',
    description:
      'Share, privatize, archive, or revive a workspace identity subject to owner-only policy checks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['share', 'privatize', 'archive', 'revive'] },
        workspaceId: { type: 'string' }
      },
      required: ['action']
    }
  },
  {
    name: 'workspace.context',
    description: 'Return the stored workspace and desktop context snapshot for this session.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'memory.recent',
    description: 'Return the recent memory preview for this session.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'context.pinned',
    description: 'List, add, remove, or clear pinned reusable context notes for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'clear'] },
        text: { type: 'string' },
        index: { type: 'integer', minimum: 1, maximum: 8 },
        noteId: { type: 'string' }
      }
    }
  },
  {
    name: 'runs.list',
    description: 'List recent run records for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 }
      }
    }
  },
  {
    name: 'runs.get',
    description: 'Return a recorded run by runId from the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.trace',
    description: 'Return a correlated trace timeline for a recorded run in the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.lineage',
    description: 'Return the related run chain for a recorded run in the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.resume',
    description: 'Requeue a failed or cancelled run from its stored request text.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        mode: { type: 'string', enum: ['stored-request'] }
      },
      required: ['runId']
    }
  },
  {
    name: 'artifacts.list',
    description: 'List recorded artifacts for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 }
      }
    }
  },
  {
    name: 'artifacts.get',
    description: 'Return a recorded artifact by artifactId from the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' }
      },
      required: ['artifactId']
    }
  },
  {
    name: 'limits.status',
    description: 'Return session store retention and current usage visibility.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'audit.timeline',
    description: 'Return a correlated audit timeline for recent runs, events, and artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        runId: { type: 'string' }
      }
    }
  },
  {
    name: 'ops.status',
    description: 'Return derived operational counters and latency summaries for chat activity.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20 }
      }
    }
  },
  {
    name: 'mcp.status',
    description: 'Describe current MCP client connections and the local MagicPot MCP server state.',
    inputSchema: { type: 'object', properties: {} }
  }
]

export const MAGICPOT_CORE_TOOL_NAMES: readonly string[] = MAGICPOT_CORE_TOOL_DESCRIPTORS.map(
  (tool) => tool.name
)
