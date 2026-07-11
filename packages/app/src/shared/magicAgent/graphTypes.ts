import type { AgentRouteLike } from '@shared/agent'

export type MagicAgentGraphNodeKind = 'agent' | 'tool' | 'input' | 'condition' | 'merge' | 'output'

export type MagicAgentGraphChannelKind = 'handoff' | 'artifact' | 'message' | 'control'

export type MagicAgentGraphRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type MagicAgentGraphNodeRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export type MagicAgentGraphConditionOperator =
  | 'always'
  | 'truthy'
  | 'falsy'
  | 'equals'
  | 'contains'
  | 'matches'

export type MagicAgentGraphConditionDefinition = {
  sourceNodeId?: string
  operator?: MagicAgentGraphConditionOperator
  value?: unknown
}

export type MagicAgentGraphNodeDefinition = {
  nodeId: string
  kind: MagicAgentGraphNodeKind
  name: string
  description: string
  instruction?: string
  modelName?: string
  capabilities?: string[]
  agentId?: string
  toolName?: string
  config?: Record<string, unknown>
  condition?: MagicAgentGraphConditionDefinition
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphChannelDefinition = {
  channelId: string
  from: string
  to: string
  kind: MagicAgentGraphChannelKind
  label?: string
  required?: boolean
  condition?: MagicAgentGraphConditionDefinition
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphOutputDefinition = {
  outputId: string
  name: string
  description: string
  sourceNodeId: string
  channelId?: string
  mimeType?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphDefinition = {
  graphId: string
  name: string
  description: string
  version: string
  tags: string[]
  nodes: MagicAgentGraphNodeDefinition[]
  channels: MagicAgentGraphChannelDefinition[]
  outputs: MagicAgentGraphOutputDefinition[]
  entryNodeIds: string[]
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphSourceKind = 'builtIn' | 'user' | 'package'

export type MagicAgentGraphPreflightIssueSeverity = 'error' | 'warning'

export type MagicAgentGraphPreflightIssueCode =
  | 'tool-node-detected'
  | 'tool-denied'
  | 'tool-unavailable'
  | 'tool-missing-allowlist'
  | 'tool-unknown'

export type MagicAgentGraphPreflightIssue = {
  severity: MagicAgentGraphPreflightIssueSeverity
  code: MagicAgentGraphPreflightIssueCode
  message: string
  nodeId?: string
  toolName?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphToolPermissionSnapshot = {
  nodeId: string
  toolName?: string
  allowed: boolean
  available: boolean
  denied: boolean
  requiresAllowlist: boolean
  source?: string
  status?: string
  permissionLevel?: 'read' | 'write' | 'destructive'
  requiresConfirmation?: boolean
  unavailableReason?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphPermissionSnapshot = {
  allowedToolNames?: string[] | null
  tools: MagicAgentGraphToolPermissionSnapshot[]
  issues: MagicAgentGraphPreflightIssue[]
}

export type MagicAgentGraphPreflightSnapshot = {
  graphId: string
  checkedAt: number
  ok: boolean
  safeToRun: boolean
  requiresExplicitToolAllowlist: boolean
  hasToolNodes: boolean
  toolNodes: MagicAgentGraphToolPermissionSnapshot[]
  issues: MagicAgentGraphPreflightIssue[]
  permissions: MagicAgentGraphPermissionSnapshot
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphListItem = Pick<
  MagicAgentGraphDefinition,
  'graphId' | 'name' | 'description' | 'version' | 'tags'
> & {
  nodeCount: number
  channelCount: number
  outputCount: number
  builtIn: boolean
  /** Source/provenance metadata for Agent Studio catalog rendering. */
  sourceKind?: MagicAgentGraphSourceKind
  readOnly?: boolean
  runnable?: boolean
  forkable?: boolean
  removable?: boolean
  safeToRun?: boolean
  unavailableReason?: string
  sourcePackageId?: string
  sourcePackageName?: string
  sourcePackageVersion?: string
  packageId?: string
  packageName?: string
  packageVersion?: string
  contributionId?: string
  contributionTitle?: string
  createdAt?: number
  updatedAt?: number
  preflight?: MagicAgentGraphPreflightSnapshot
}

export type MagicAgentGraphValidationIssue = {
  path: string
  message: string
}

export type MagicAgentGraphValidationResult =
  | {
      ok: true
      graph: MagicAgentGraphDefinition
      warnings: MagicAgentGraphValidationIssue[]
    }
  | {
      ok: false
      errors: MagicAgentGraphValidationIssue[]
      warnings: MagicAgentGraphValidationIssue[]
    }

export type MagicAgentGraphCreateRequest = {
  graph: MagicAgentGraphDefinition
  route: AgentRouteLike
  replace?: boolean
}

export type MagicAgentGraphDeleteRequest = {
  graphId: string
  route: AgentRouteLike
}

export type MagicAgentGraphForkRequest = {
  graphId: string
  route: AgentRouteLike
  targetGraphId?: string
  name?: string
  replace?: boolean
}

export type MagicAgentGraphPreflightRunRequest = {
  graphId: string
  route: AgentRouteLike
  allowedToolNames?: string[] | null
}

export type MagicAgentGraphRunEventListRequest = {
  runId: string
  route: AgentRouteLike
  limit?: number
}

export type MagicAgentGraphRunRequest = {
  graphId: string
  input: string
  route: AgentRouteLike
  runId?: string
  outputIds?: string[]
  allowedToolNames?: string[] | null
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunOutput = {
  outputId: string
  name: string
  content: string
  sourceNodeId: string
  channelId?: string
  mimeType?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunNodeRecord = {
  nodeId: string
  kind: MagicAgentGraphNodeKind
  status: MagicAgentGraphNodeRunStatus
  input?: string
  output?: string
  startedAt?: number
  endedAt?: number
  error?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunChannelRecord = {
  channelId: string
  from: string
  to: string
  kind: MagicAgentGraphChannelKind
  content: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunEventType =
  | 'graph.started'
  | 'graph.completed'
  | 'graph.failed'
  | 'graph.cancelled'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.skipped'
  | 'tool.invoked'
  | 'channel.message'
  | 'output.created'

export type MagicAgentGraphRunEvent = {
  eventId: string
  runId: string
  graphId: string
  type: MagicAgentGraphRunEventType
  message: string
  createdAt: number
  sequence?: number
  nodeId?: string
  channelId?: string
  outputId?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunRecord = {
  runId: string
  graphId: string
  status: MagicAgentGraphRunStatus
  input: string
  route: AgentRouteLike
  sessionKey: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  nodes?: MagicAgentGraphRunNodeRecord[]
  channels: MagicAgentGraphRunChannelRecord[]
  outputs: MagicAgentGraphRunOutput[]
  events?: MagicAgentGraphRunEvent[]
  graphSnapshot?: MagicAgentGraphDefinition
  permissionSnapshot?: MagicAgentGraphPermissionSnapshot
  preflightSnapshot?: MagicAgentGraphPreflightSnapshot
  error?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunStreamEventType = 'snapshot' | 'event' | 'closed'

export type MagicAgentGraphRunStreamEvent = {
  type: MagicAgentGraphRunStreamEventType
  sequence: number
  runId: string
  graphId: string
  status: MagicAgentGraphRunStatus
  createdAt: number
  run?: MagicAgentGraphRunRecord
  event?: MagicAgentGraphRunEvent
  error?: string
}

export type MagicAgentGraphRunResult = MagicAgentGraphRunRecord

export type MagicAgentGraphCancelResult = {
  runId: string
  cancelled: boolean
  status?: MagicAgentGraphRunStatus
  error?: string
}
