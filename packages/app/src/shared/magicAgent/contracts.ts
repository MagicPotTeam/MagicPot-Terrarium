import type { AgentRouteLike } from '@shared/agent'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'

export type MagicAgentModuleRef =
  | string
  | {
      id: string
      options?: Record<string, unknown>
    }

export type MagicAgentPermissionLevel = 'none' | 'read' | 'write' | 'full'
export type MagicAgentNetworkPermission = 'none' | 'allowlist' | 'full'
export type MagicAgentShellPermission = 'none' | 'read-only' | 'full'

export type MagicAgentPermissions = {
  toolAllowlist?: string[]
  requireConfirm?: string[]
  fileSystem?: MagicAgentPermissionLevel
  shell?: MagicAgentShellPermission
  network?: MagicAgentNetworkPermission
}

export type MagicAgentModelConfig = {
  profileId?: string
  temperature?: number
  maxTokens?: number
}

export type MagicAgentMemoryConfig = {
  enabled?: boolean
  scope?: 'session' | 'workspace' | 'project'
  searchable?: boolean
}

export type MagicAgentSpec = {
  id: string
  name: string
  description?: string
  version?: string
  role?: string
  systemPrompt?: string
  model?: MagicAgentModelConfig
  tools?: MagicAgentModuleRef[]
  triggers?: MagicAgentModuleRef[]
  inputs?: MagicAgentModuleRef[]
  outputs?: MagicAgentModuleRef[]
  plugins?: MagicAgentModuleRef[]
  memory?: MagicAgentMemoryConfig
  permissions?: MagicAgentPermissions
  metadata?: Record<string, unknown>
}

export type MagicAgentToolCategory =
  | 'core'
  | 'comfyui'
  | 'qapp'
  | 'canvas'
  | 'image'
  | 'video'
  | 'model'
  | 'asset'
  | 'project'
  | 'mcp'
  | 'terminal'
  | 'compatibility'

export type MagicToolPermissions = {
  requireConfirm?: boolean
  filesystem?: MagicAgentPermissionLevel
  network?: boolean
  destructive?: boolean
}

export type MagicToolDefinition = {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  category: MagicAgentToolCategory
  permissions?: MagicToolPermissions
  metadata?: Record<string, unknown>
}

export type MagicTriggerDefinition = {
  id: string
  name: string
  description?: string
  kind: 'timer' | 'schedule' | 'event' | 'manual'
  config?: Record<string, unknown>
}

export type MagicInputDefinition = {
  id: string
  name: string
  description?: string
  kind: 'chat' | 'event' | 'webhook' | 'manual'
  config?: Record<string, unknown>
}

export type MagicOutputDefinition = {
  id: string
  name: string
  description?: string
  kind: 'chat' | 'event' | 'artifact' | 'manual'
  config?: Record<string, unknown>
}

export type MagicPluginDefinition = {
  id: string
  name: string
  description?: string
  hooks?: string[]
  config?: Record<string, unknown>
}

export type MagicAgentRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'

export type MagicAgentEventType =
  | 'agent.registered'
  | 'run.created'
  | 'run.started'
  | 'run.progress'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'
  | 'tool.called'
  | 'tool.result'
  | 'graph.created'
  | 'graph.started'
  | 'graph.node.started'
  | 'graph.node.completed'
  | 'graph.channel.message'
  | 'graph.completed'
  | 'package.installed'
  | 'package.uninstalled'

export type MagicAgentEvent = {
  eventId: string
  runId?: string
  graphRunId?: string
  agentId?: string
  graphId?: string
  nodeId?: string
  type: MagicAgentEventType
  level: 'info' | 'warning' | 'error'
  message: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type MagicAgentArtifact = {
  artifactId: string
  runId: string
  kind: 'image' | 'video' | 'model3d' | 'file' | 'text'
  url?: string
  mimeType?: string
  fileName?: string
  createdAt: number
  source: 'agent' | 'tool' | 'graph' | 'assistant'
  lineage?: Record<string, unknown>
}

export type MagicAgentRunRequest = {
  agentId: string
  text: string
  route?: AgentRouteLike
  profileId?: string
  systemPrompt?: string
  attachments?: ChatAttachment[]
  execution?: {
    mode?: 'inherit' | 'isolated' | 'no-history'
    allowedToolNames?: string[]
    traceLabel?: string
    maxToolSteps?: number
  }
  metadata?: Record<string, unknown>
}

export type MagicAgentRunSnapshot = {
  runId: string
  agentId: string
  status: MagicAgentRunStatus
  route?: AgentRouteLike
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  requestText?: string
  responseText?: string
  errorMessage?: string
  assistantRunId?: string
  toolCalls: Array<{ toolName: string; args?: Record<string, unknown> }>
  artifactIds: string[]
  metadata?: Record<string, unknown>
}

export type MagicAgentRunResult = {
  run: MagicAgentRunSnapshot
  content: string
  events: MagicAgentEvent[]
  artifacts: MagicAgentArtifact[]
}

export type MagicToolResult = {
  ok: boolean
  content: string
  status?: 'ok' | 'unavailable' | 'permission-denied' | 'failed'
  data?: Record<string, unknown>
  artifacts?: MagicAgentArtifact[]
  metadata?: Record<string, unknown>
}

export type MagicAgentNodeStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'failed'
  | 'stopped'
  | 'completed'

export type MagicAgentNode = {
  nodeId: string
  agentId: string
  name?: string
  role?: string
  status?: MagicAgentNodeStatus
  permissions?: {
    privileged?: boolean
    toolAllowlist?: string[]
  }
  metadata?: Record<string, unknown>
}

export type MagicAgentChannel = {
  channelId: string
  name: string
  description?: string
  listeners: string[]
}

export type MagicAgentOutputWire = {
  fromNodeId: string
  toNodeId: string
  mode: 'turn-end' | 'event' | 'artifact' | 'manual'
  filter?: Record<string, unknown>
}

export type MagicAgentGraph = {
  graphId: string
  name: string
  description?: string
  nodes: MagicAgentNode[]
  channels: MagicAgentChannel[]
  outputWires: MagicAgentOutputWire[]
  workspaceId?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentGraphRunSnapshot = {
  graphRunId: string
  graphId: string
  status: MagicAgentRunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  input?: string
  nodeRuns: Array<{
    nodeId: string
    agentId: string
    runId?: string
    status: MagicAgentRunStatus
    output?: string
    errorMessage?: string
  }>
  events: MagicAgentEvent[]
  artifactIds: string[]
}

export type MagicPotPackageManifest = {
  name: string
  version: string
  displayName?: string
  description?: string
  magicpot?: {
    minVersion?: string
  }
  agents?: string[]
  teams?: string[]
  tools?: string[]
  qapps?: string[]
  skills?: string[]
  workflows?: string[]
  targetSchemes?: string[]
  presets?: string[]
}

export type MagicPotPackageRecord = {
  packageId: string
  rootDir: string
  manifest: MagicPotPackageManifest
  installedAt: number
  updatedAt: number
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

const uniqueCleanStrings = (values?: string[]): string[] => [
  ...new Set(
    (values || [])
      .map((value) => cleanString(value))
      .filter((value): value is string => Boolean(value))
  )
]

const normalizeRefs = (refs?: MagicAgentModuleRef[]): MagicAgentModuleRef[] =>
  (refs || [])
    .map((ref) => {
      if (typeof ref === 'string') return cleanString(ref)
      const id = cleanString(ref?.id)
      return id ? { ...ref, id } : undefined
    })
    .filter((ref): ref is MagicAgentModuleRef => Boolean(ref))

export const createMagicAgentEvent = (
  type: MagicAgentEventType,
  message: string,
  options: Partial<
    Omit<MagicAgentEvent, 'eventId' | 'type' | 'message' | 'createdAt' | 'level'>
  > & {
    level?: MagicAgentEvent['level']
  } = {}
): MagicAgentEvent => ({
  eventId:
    globalThis.crypto?.randomUUID?.() || `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  type,
  message,
  level: options.level || 'info',
  createdAt: Date.now(),
  ...(options.runId ? { runId: options.runId } : {}),
  ...(options.graphRunId ? { graphRunId: options.graphRunId } : {}),
  ...(options.agentId ? { agentId: options.agentId } : {}),
  ...(options.graphId ? { graphId: options.graphId } : {}),
  ...(options.nodeId ? { nodeId: options.nodeId } : {}),
  ...(options.metadata ? { metadata: options.metadata } : {})
})

export const normalizeMagicAgentSpec = (spec: MagicAgentSpec): MagicAgentSpec => ({
  ...spec,
  id: cleanString(spec.id) || 'magicpot.agent.unknown',
  name: cleanString(spec.name) || cleanString(spec.id) || 'Unknown Agent',
  ...(cleanString(spec.description) ? { description: cleanString(spec.description) } : {}),
  version: cleanString(spec.version) || '0.0.0',
  ...(cleanString(spec.role) ? { role: cleanString(spec.role) } : {}),
  ...(cleanString(spec.systemPrompt) ? { systemPrompt: cleanString(spec.systemPrompt) } : {}),
  tools: normalizeRefs(spec.tools),
  triggers: normalizeRefs(spec.triggers),
  inputs: normalizeRefs(spec.inputs),
  outputs: normalizeRefs(spec.outputs),
  plugins: normalizeRefs(spec.plugins),
  ...(spec.model ? { model: spec.model } : {}),
  ...(spec.memory ? { memory: spec.memory } : {}),
  ...(spec.permissions
    ? {
        permissions: {
          ...spec.permissions,
          toolAllowlist: uniqueCleanStrings(spec.permissions.toolAllowlist),
          requireConfirm: uniqueCleanStrings(spec.permissions.requireConfirm)
        }
      }
    : {}),
  ...(spec.metadata ? { metadata: spec.metadata } : {})
})

export const validateMagicAgentSpec = (value: unknown): MagicAgentSpec => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MagicAgentSpec must be an object.')
  }
  const spec = normalizeMagicAgentSpec(value as MagicAgentSpec)
  if (!spec.id || spec.id === 'magicpot.agent.unknown') {
    throw new Error('MagicAgentSpec requires id.')
  }
  if (!spec.name) {
    throw new Error('MagicAgentSpec requires name.')
  }
  return spec
}

export const normalizeMagicToolDefinition = (tool: MagicToolDefinition): MagicToolDefinition => ({
  ...tool,
  name: cleanString(tool.name) || 'unknown.tool',
  ...(cleanString(tool.title) ? { title: cleanString(tool.title) } : {}),
  description: cleanString(tool.description) || '',
  category: tool.category || 'core',
  inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  ...(tool.permissions ? { permissions: tool.permissions } : {}),
  ...(tool.metadata ? { metadata: tool.metadata } : {})
})

export const validateMagicToolDefinition = (value: unknown): MagicToolDefinition => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MagicToolDefinition must be an object.')
  }
  const tool = normalizeMagicToolDefinition(value as MagicToolDefinition)
  if (!tool.name || tool.name === 'unknown.tool') {
    throw new Error('MagicToolDefinition requires name.')
  }
  return tool
}

export const normalizeMagicAgentGraph = (graph: MagicAgentGraph): MagicAgentGraph => ({
  ...graph,
  graphId: cleanString(graph.graphId) || 'magicpot.graph.unknown',
  name: cleanString(graph.name) || cleanString(graph.graphId) || 'Unknown Graph',
  ...(cleanString(graph.description) ? { description: cleanString(graph.description) } : {}),
  nodes: (graph.nodes || []).map((node) => ({
    ...node,
    nodeId: cleanString(node.nodeId) || cleanString(node.agentId) || 'node.unknown',
    agentId: cleanString(node.agentId) || 'magicpot.default.chat',
    status: node.status || 'idle'
  })),
  channels: (graph.channels || []).map((channel) => ({
    ...channel,
    channelId: cleanString(channel.channelId) || cleanString(channel.name) || 'channel.unknown',
    name: cleanString(channel.name) || cleanString(channel.channelId) || 'channel',
    listeners: uniqueCleanStrings(channel.listeners)
  })),
  outputWires: (graph.outputWires || []).map((wire) => ({
    ...wire,
    fromNodeId: cleanString(wire.fromNodeId) || '',
    toNodeId: cleanString(wire.toNodeId) || '',
    mode: wire.mode || 'turn-end'
  })),
  ...(cleanString(graph.workspaceId) ? { workspaceId: cleanString(graph.workspaceId) } : {}),
  ...(graph.metadata ? { metadata: graph.metadata } : {})
})

export const validateMagicAgentGraph = (value: unknown): MagicAgentGraph => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MagicAgentGraph must be an object.')
  }
  const graph = normalizeMagicAgentGraph(value as MagicAgentGraph)
  if (!graph.graphId || graph.graphId === 'magicpot.graph.unknown') {
    throw new Error('MagicAgentGraph requires graphId.')
  }
  if (!graph.nodes.length) {
    throw new Error('MagicAgentGraph requires at least one node.')
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId))
  for (const wire of graph.outputWires) {
    if (!nodeIds.has(wire.fromNodeId) || !nodeIds.has(wire.toNodeId)) {
      throw new Error(
        `MagicAgentGraph wire references missing node: ${wire.fromNodeId}->${wire.toNodeId}`
      )
    }
  }
  return graph
}

export const normalizeMagicPotPackageManifest = (
  manifest: MagicPotPackageManifest
): MagicPotPackageManifest => ({
  ...manifest,
  name: cleanString(manifest.name) || 'unknown-package',
  version: cleanString(manifest.version) || '0.0.0',
  ...(cleanString(manifest.displayName) ? { displayName: cleanString(manifest.displayName) } : {}),
  ...(cleanString(manifest.description) ? { description: cleanString(manifest.description) } : {}),
  agents: uniqueCleanStrings(manifest.agents),
  teams: uniqueCleanStrings(manifest.teams),
  tools: uniqueCleanStrings(manifest.tools),
  qapps: uniqueCleanStrings(manifest.qapps),
  skills: uniqueCleanStrings(manifest.skills),
  workflows: uniqueCleanStrings(manifest.workflows),
  targetSchemes: uniqueCleanStrings(manifest.targetSchemes),
  presets: uniqueCleanStrings(manifest.presets),
  ...(manifest.magicpot ? { magicpot: manifest.magicpot } : {})
})

export const validateMagicPotPackageManifest = (value: unknown): MagicPotPackageManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MagicPot package manifest must be an object.')
  }
  const manifest = normalizeMagicPotPackageManifest(value as MagicPotPackageManifest)
  if (!manifest.name || manifest.name === 'unknown-package') {
    throw new Error('MagicPot package manifest requires name.')
  }
  if (!manifest.version) {
    throw new Error('MagicPot package manifest requires version.')
  }
  return manifest
}

export const chatMessagesFromMagicAgentRequest = (req: MagicAgentRunRequest): ChatMessage[] => [
  {
    role: 'user',
    content: req.text,
    ...(req.attachments?.length ? { attachments: req.attachments } : {})
  }
]
