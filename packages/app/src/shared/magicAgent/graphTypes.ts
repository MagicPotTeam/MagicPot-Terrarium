import type { AgentRouteLike } from '@shared/agent'

export type MagicAgentGraphNodeKind = 'agent' | 'tool' | 'input' | 'output'

export type MagicAgentGraphChannelKind = 'handoff' | 'artifact' | 'message' | 'control'

export type MagicAgentGraphRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type MagicAgentGraphNodeDefinition = {
  nodeId: string
  kind: MagicAgentGraphNodeKind
  name: string
  description: string
  instruction?: string
  modelName?: string
  capabilities?: string[]
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphChannelDefinition = {
  channelId: string
  from: string
  to: string
  kind: MagicAgentGraphChannelKind
  label?: string
  required?: boolean
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

export type MagicAgentGraphListItem = Pick<
  MagicAgentGraphDefinition,
  'graphId' | 'name' | 'description' | 'version' | 'tags'
> & {
  nodeCount: number
  channelCount: number
  outputCount: number
  builtIn: boolean
}

export type MagicAgentGraphCreateRequest = {
  graph: MagicAgentGraphDefinition
  route: AgentRouteLike
  replace?: boolean
}

export type MagicAgentGraphRunRequest = {
  graphId: string
  input: string
  route: AgentRouteLike
  runId?: string
  outputIds?: string[]
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

export type MagicAgentGraphRunChannelRecord = {
  channelId: string
  from: string
  to: string
  kind: MagicAgentGraphChannelKind
  content: string
  createdAt: number
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
  channels: MagicAgentGraphRunChannelRecord[]
  outputs: MagicAgentGraphRunOutput[]
  error?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunResult = MagicAgentGraphRunRecord

export type MagicAgentGraphCancelResult = {
  runId: string
  cancelled: boolean
  status?: MagicAgentGraphRunStatus
  error?: string
}
