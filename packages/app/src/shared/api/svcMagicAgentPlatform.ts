import type { AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentGraphCancelResult,
  MagicAgentGraphChannelDefinition,
  MagicAgentGraphConditionDefinition,
  MagicAgentGraphCreateRequest,
  MagicAgentGraphDeleteRequest,
  MagicAgentGraphDefinition,
  MagicAgentGraphForkRequest,
  MagicAgentGraphListItem,
  MagicAgentGraphNodeDefinition,
  MagicAgentGraphOutputDefinition,
  MagicAgentGraphPreflightRunRequest,
  MagicAgentGraphPreflightSnapshot,
  MagicAgentGraphRunEvent,
  MagicAgentGraphRunEventListRequest,
  MagicAgentGraphRunRecord,
  MagicAgentGraphRunRequest,
  MagicAgentGraphRunResult,
  MagicAgentGraphRunStreamEvent,
  MagicAgentGraphValidationResult
} from '@shared/magicAgent'
import type {
  MagicAgentInstalledPackage,
  MagicAgentPackageInspection,
  MagicAgentPackageValidationResult
} from '@shared/magicAgentRuntime'
import type { ChatAttachment } from './svcLLMProxy'
import type { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'

export type MagicAgentPlatformEmptyReq = Record<string, never>

export type MagicAgentPlatformAgentDefinition = {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  toolNames?: string[] | null
  maxToolIterations?: number
  profileId?: string
}

export type MagicAgentPlatformToolSource = 'assistantRuntime' | 'creative' | 'magicAgentRuntime'

export type MagicAgentPlatformToolStatus = 'available' | 'unavailable'

export type MagicAgentPlatformToolPermissionLevel = 'read' | 'write' | 'destructive'

export type MagicAgentPlatformToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  source: MagicAgentPlatformToolSource
  category?: string
  status?: MagicAgentPlatformToolStatus
  permissionLevel?: MagicAgentPlatformToolPermissionLevel
  requiresConfirmation?: boolean
  disabledByDefault?: boolean
  unavailableReason?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentPlatformToolCallStatus = 'ok' | 'unavailable' | 'permission-denied' | 'failed'

export type MagicAgentPlatformToolCallReq = {
  name: string
  args?: Record<string, unknown>
  route: AgentRouteLike
  agentId?: string
  source?: MagicAgentPlatformToolSource
  metadata?: Record<string, unknown>
}

export type MagicAgentPlatformToolCallResp = {
  ok: boolean
  toolName: string
  source: MagicAgentPlatformToolSource
  status: MagicAgentPlatformToolCallStatus
  content: string
  data?: unknown
  unavailableReason?: string
  error?: string
  metadata?: Record<string, unknown>
}

export type MagicAgentPlatformRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'timeout'
  | 'permission_denied'

export type MagicAgentPlatformRunEvent = {
  eventId: string
  runId: string
  agentId: string
  type: string
  message: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type MagicAgentPlatformRunMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  attachments?: ChatAttachment[]
  metadata?: Record<string, unknown>
}

export type MagicAgentPlatformToolCallRecord = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type MagicAgentPlatformRunReq = {
  agentId?: string
  text: string
  route: AgentRouteLike
  profileId?: string
  systemPrompt?: string
  attachments?: ChatAttachment[]
  maxToolIterations?: number
  timeoutMs?: number
  allowedToolNames?: string[] | null
  metadata?: Record<string, unknown>
}

export type MagicAgentPlatformRunResp = {
  runId: string
  agentId: string
  status: MagicAgentPlatformRunStatus
  content: string
  messages: MagicAgentPlatformRunMessage[]
  toolCalls: MagicAgentPlatformToolCallRecord[]
  events: MagicAgentPlatformRunEvent[]
  startedAt: number
  finishedAt: number
  error?: string
}

export type MagicAgentPlatformStatus = {
  enabled: boolean
  featureFlag: 'MAGICPOT_MAGICAGENT_PLATFORM'
  platformVersion: 1
  assistantRuntimeCompatible: true
  agentCount: number
  toolCount: number
  assistantToolCount: number
  creativeToolCount: number
  graphCount: number
  packageCount?: number
}

export type MagicAgentPlatformStatusResp = MagicAgentPlatformStatus

export type MagicAgentPlatformListAgentsResp = {
  agents: MagicAgentPlatformAgentDefinition[]
}

export type MagicAgentPlatformRegisterAgentReq = {
  agent: MagicAgentPlatformAgentDefinition
}

export type MagicAgentPlatformRegisterAgentResp = {
  agent: MagicAgentPlatformAgentDefinition
}

export type MagicAgentPlatformListToolsReq = {
  agentId?: string
  source?: MagicAgentPlatformToolSource
}

export type MagicAgentPlatformListToolsResp = {
  tools: MagicAgentPlatformToolDefinition[]
}

export type MagicAgentPlatformGraphCatalogListReq = {
  route?: AgentRouteLike
  allowedToolNames?: string[] | null
}

export type MagicAgentPlatformGraphCreateResp = {
  graph: MagicAgentGraphDefinition
}

export type MagicAgentPlatformGraphSaveResp = MagicAgentPlatformGraphCreateResp

export type MagicAgentPlatformGraphDeleteReq = MagicAgentGraphDeleteRequest

export type MagicAgentPlatformGraphDeleteResp = {
  deleted: boolean
}

export type MagicAgentPlatformGraphForkReq = MagicAgentGraphForkRequest

export type MagicAgentPlatformGraphForkResp = {
  graph: MagicAgentGraphDefinition
}

export type MagicAgentPlatformGraphValidateReq = {
  graph: unknown
}

export type MagicAgentPlatformGraphValidateResp = {
  validation: MagicAgentGraphValidationResult
}

export type MagicAgentPlatformGraphPreflightRunReq = MagicAgentGraphPreflightRunRequest

export type MagicAgentPlatformGraphPreflightRunResp = {
  preflight: MagicAgentGraphPreflightSnapshot
}

export type MagicAgentPlatformGraphInspectReq = {
  graphId: string
}

export type MagicAgentPlatformGraphInspectResp = {
  graph?: MagicAgentGraphDefinition
}

export type MagicAgentPlatformGraphListResp = {
  graphs: MagicAgentGraphListItem[]
}

export type MagicAgentPlatformGraphRunListReq = {
  route: AgentRouteLike
  graphId?: string
  limit?: number
}

export type MagicAgentPlatformGraphRunListResp = {
  runs: MagicAgentGraphRunRecord[]
}

export type MagicAgentPlatformGraphRunGetReq = {
  runId: string
  route: AgentRouteLike
}

export type MagicAgentPlatformGraphRunGetResp = {
  run?: MagicAgentGraphRunRecord
}

export type MagicAgentPlatformGraphRunEventListReq = MagicAgentGraphRunEventListRequest

export type MagicAgentPlatformGraphRunEventListResp = {
  events: MagicAgentGraphRunEvent[]
}

export type MagicAgentPlatformGraphRunWatchReq = {
  runId: string
  route: AgentRouteLike
}

export type MagicAgentPlatformGraphCancelReq = {
  runId: string
  route: AgentRouteLike
  reason?: string
}

export type MagicAgentPlatformValidatePackageManifestReq = {
  manifest: unknown
}

export type MagicAgentPlatformValidatePackageManifestResp = {
  validation: MagicAgentPackageValidationResult
}

export type MagicAgentPlatformPackagePathReq = {
  packageDir: string
}

export type MagicAgentPlatformPackageInspectReq = {
  packageIdOrDir: string
}

export type MagicAgentPlatformPackageUninstallReq = {
  packageId: string
}

export type MagicAgentPlatformInstalledPackage = Omit<
  MagicAgentInstalledPackage,
  'sourcePath' | 'packagePath'
>

export type MagicAgentPlatformPackageInspection = Omit<
  MagicAgentPackageInspection,
  'manifestPath' | 'packagePath' | 'installed'
> & {
  installed?: MagicAgentPlatformInstalledPackage
}

export type MagicAgentPlatformPackageScanResp = MagicAgentPlatformPackageInspection
export type MagicAgentPlatformPackageInstallResp = {
  installed: MagicAgentPlatformInstalledPackage
  replaced: boolean
}
export type MagicAgentPlatformPackageInspectResp = MagicAgentPlatformPackageInspection

export type MagicAgentPlatformPackageListResp = {
  packages: MagicAgentPlatformInstalledPackage[]
}

export type MagicAgentPlatformPackageUninstallResp = {
  uninstalled: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MAGIC_AGENT_ROUTE_SCOPE_TYPES = new Set(['dm', 'group', 'channel', 'thread', 'topic'])
const MAGIC_AGENT_GRAPH_NODE_KINDS = new Set([
  'agent',
  'tool',
  'input',
  'condition',
  'merge',
  'output'
])
const MAGIC_AGENT_GRAPH_CHANNEL_KINDS = new Set(['handoff', 'artifact', 'message', 'control'])
const MAGIC_AGENT_GRAPH_RUN_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
])
const MAGIC_AGENT_GRAPH_RUN_STREAM_EVENT_TYPES = new Set(['snapshot', 'event', 'closed'])
const MAGIC_AGENT_GRAPH_CONDITION_OPERATORS = new Set([
  'always',
  'truthy',
  'falsy',
  'equals',
  'contains',
  'matches'
])

const issue = (field: string, message: string) =>
  new ServiceValidationError(`svcMagicAgentPlatform ${field}`, [
    { path: [field], message, code: 'invalid_type' }
  ])

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ServiceValidationError(`svcMagicAgentPlatform.${label} request`)
  }
  return value
}

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  throw issue(field, 'Expected a string')
}

const optionalCleanString = (value: unknown, field: string): string | undefined => {
  const text = optionalString(value, field)
  if (text === undefined) return undefined
  const normalized = text.trim()
  if (!normalized) {
    throw issue(field, 'Expected a non-empty string when provided')
  }
  return normalized
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw issue(field, 'Expected a non-empty string')
}

const optionalRecord = (value: unknown, field: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined
  if (isRecord(value)) return value
  throw issue(field, 'Expected an object')
}

const optionalStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())) {
    return value.map((item) => item.trim())
  }
  throw issue(field, 'Expected an array of non-empty strings')
}

const optionalNullableStringArray = (
  value: unknown,
  field: string
): string[] | null | undefined => {
  if (value === null) return null
  return optionalStringArray(value, field)
}

const optionalNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw issue(field, 'Expected a finite number')
}

const optionalPositiveNumber = (value: unknown, field: string): number | undefined => {
  const parsed = optionalNumber(value, field)
  if (parsed === undefined) return undefined
  if (parsed > 0) return parsed
  throw issue(field, 'Expected a positive number')
}

const optionalPositiveInteger = (value: unknown, field: string): number | undefined => {
  const parsed = optionalPositiveNumber(value, field)
  if (parsed === undefined) return undefined
  if (Number.isInteger(parsed)) return parsed
  throw issue(field, 'Expected a positive integer')
}

const requireNonNegativeInteger = (value: unknown, field: string): number => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw issue(field, 'Expected a non-negative integer')
}

const requireFiniteNumber = (value: unknown, field: string): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw issue(field, 'Expected a finite number')
}

const validateEmptyReq = (value: unknown): MagicAgentPlatformEmptyReq => {
  requireRecord(value, 'empty')
  return {}
}

const validateRoute = (value: unknown, field = 'route'): AgentRouteLike => {
  const route = requireRecord(value, field)
  const scopeType = requireString(route.scopeType, `${field}.scopeType`)
  if (!MAGIC_AGENT_ROUTE_SCOPE_TYPES.has(scopeType)) {
    throw issue(`${field}.scopeType`, 'Expected one of dm, group, channel, thread, or topic')
  }
  const threadId = optionalCleanString(route.threadId, `${field}.threadId`)
  const senderId = optionalCleanString(route.senderId, `${field}.senderId`)
  const senderName = optionalCleanString(route.senderName, `${field}.senderName`)
  return {
    channel: requireString(route.channel, `${field}.channel`),
    scopeType,
    scopeId: requireString(route.scopeId, `${field}.scopeId`),
    ...(threadId ? { threadId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {})
  }
}

const validateAgentDefinition = (value: unknown): MagicAgentPlatformAgentDefinition => {
  const agent = requireRecord(value, 'agent')
  return {
    id: requireString(agent.id, 'agent.id'),
    name: requireString(agent.name, 'agent.name'),
    ...(optionalCleanString(agent.description, 'agent.description') !== undefined
      ? { description: optionalCleanString(agent.description, 'agent.description') }
      : {}),
    ...(optionalCleanString(agent.systemPrompt, 'agent.systemPrompt') !== undefined
      ? { systemPrompt: optionalCleanString(agent.systemPrompt, 'agent.systemPrompt') }
      : {}),
    ...(agent.toolNames !== undefined
      ? { toolNames: optionalNullableStringArray(agent.toolNames, 'agent.toolNames') }
      : {}),
    ...(optionalNumber(agent.maxToolIterations, 'agent.maxToolIterations') !== undefined
      ? { maxToolIterations: optionalNumber(agent.maxToolIterations, 'agent.maxToolIterations') }
      : {}),
    ...(optionalCleanString(agent.profileId, 'agent.profileId') !== undefined
      ? { profileId: optionalCleanString(agent.profileId, 'agent.profileId') }
      : {})
  }
}

const requireArray = (value: unknown, field: string): unknown[] => {
  if (Array.isArray(value)) return value
  throw issue(field, 'Expected an array')
}

const validateGraphCondition = (
  value: unknown,
  field: string
): MagicAgentGraphConditionDefinition | undefined => {
  if (value === undefined) return undefined
  const condition = requireRecord(value, field)
  const sourceNodeId = optionalCleanString(condition.sourceNodeId, `${field}.sourceNodeId`)
  const operator = optionalCleanString(condition.operator, `${field}.operator`)
  if (operator && !MAGIC_AGENT_GRAPH_CONDITION_OPERATORS.has(operator)) {
    throw issue(`${field}.operator`, 'Expected a valid MagicAgentGraph condition operator')
  }
  return {
    ...(sourceNodeId !== undefined ? { sourceNodeId } : {}),
    ...(operator !== undefined
      ? { operator: operator as MagicAgentGraphConditionDefinition['operator'] }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(condition, 'value') ? { value: condition.value } : {})
  }
}

const validateGraphNodeDefinition = (
  value: unknown,
  index: number
): MagicAgentGraphNodeDefinition => {
  const field = `graph.nodes.${index}`
  const node = requireRecord(value, field)
  const kind = requireString(node.kind, `${field}.kind`)
  if (!MAGIC_AGENT_GRAPH_NODE_KINDS.has(kind)) {
    throw issue(`${field}.kind`, 'Expected a valid MagicAgentGraph node kind')
  }
  const capabilities = optionalStringArray(node.capabilities, `${field}.capabilities`)
  const config = optionalRecord(node.config, `${field}.config`)
  const condition = validateGraphCondition(node.condition, `${field}.condition`)
  const metadata = optionalRecord(node.metadata, `${field}.metadata`)
  return {
    ...(node as MagicAgentGraphNodeDefinition),
    nodeId: requireString(node.nodeId, `${field}.nodeId`),
    kind: kind as MagicAgentGraphNodeDefinition['kind'],
    name: requireString(node.name, `${field}.name`),
    description: requireString(node.description, `${field}.description`),
    ...(optionalCleanString(node.instruction, `${field}.instruction`) !== undefined
      ? { instruction: optionalCleanString(node.instruction, `${field}.instruction`) }
      : {}),
    ...(optionalCleanString(node.modelName, `${field}.modelName`) !== undefined
      ? { modelName: optionalCleanString(node.modelName, `${field}.modelName`) }
      : {}),
    ...(optionalCleanString(node.agentId, `${field}.agentId`) !== undefined
      ? { agentId: optionalCleanString(node.agentId, `${field}.agentId`) }
      : {}),
    ...(optionalCleanString(node.toolName, `${field}.toolName`) !== undefined
      ? { toolName: optionalCleanString(node.toolName, `${field}.toolName`) }
      : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(condition !== undefined ? { condition } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  }
}

const validateGraphChannelDefinition = (
  value: unknown,
  index: number
): MagicAgentGraphChannelDefinition => {
  const field = `graph.channels.${index}`
  const channel = requireRecord(value, field)
  const kind = requireString(channel.kind, `${field}.kind`)
  if (!MAGIC_AGENT_GRAPH_CHANNEL_KINDS.has(kind)) {
    throw issue(`${field}.kind`, 'Expected a valid MagicAgentGraph channel kind')
  }
  if (channel.required !== undefined && typeof channel.required !== 'boolean') {
    throw issue(`${field}.required`, 'Expected a boolean')
  }
  const condition = validateGraphCondition(channel.condition, `${field}.condition`)
  const metadata = optionalRecord(channel.metadata, `${field}.metadata`)
  return {
    ...(channel as MagicAgentGraphChannelDefinition),
    channelId: requireString(channel.channelId, `${field}.channelId`),
    from: requireString(channel.from, `${field}.from`),
    to: requireString(channel.to, `${field}.to`),
    kind: kind as MagicAgentGraphChannelDefinition['kind'],
    ...(optionalCleanString(channel.label, `${field}.label`) !== undefined
      ? { label: optionalCleanString(channel.label, `${field}.label`) }
      : {}),
    ...(channel.required !== undefined ? { required: channel.required } : {}),
    ...(condition !== undefined ? { condition } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  }
}

const validateGraphOutputDefinition = (
  value: unknown,
  index: number
): MagicAgentGraphOutputDefinition => {
  const field = `graph.outputs.${index}`
  const output = requireRecord(value, field)
  const metadata = optionalRecord(output.metadata, `${field}.metadata`)
  return {
    ...(output as MagicAgentGraphOutputDefinition),
    outputId: requireString(output.outputId, `${field}.outputId`),
    name: requireString(output.name, `${field}.name`),
    description: requireString(output.description, `${field}.description`),
    sourceNodeId: requireString(output.sourceNodeId, `${field}.sourceNodeId`),
    ...(optionalCleanString(output.channelId, `${field}.channelId`) !== undefined
      ? { channelId: optionalCleanString(output.channelId, `${field}.channelId`) }
      : {}),
    ...(optionalCleanString(output.mimeType, `${field}.mimeType`) !== undefined
      ? { mimeType: optionalCleanString(output.mimeType, `${field}.mimeType`) }
      : {}),
    ...(metadata !== undefined ? { metadata } : {})
  }
}

const assertUnique = (values: string[], field: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw issue(field, 'Expected unique MagicAgentGraph identifiers')
    }
    seen.add(value)
  }
}

const validateGraphDefinition = (value: unknown): MagicAgentGraphDefinition => {
  const graph = requireRecord(value, 'graph')
  const nodes = requireArray(graph.nodes, 'graph.nodes').map(validateGraphNodeDefinition)
  const channels = requireArray(graph.channels, 'graph.channels').map(
    validateGraphChannelDefinition
  )
  const outputs = requireArray(graph.outputs, 'graph.outputs').map(validateGraphOutputDefinition)
  const entryNodeIds = optionalStringArray(graph.entryNodeIds, 'graph.entryNodeIds') || []
  const tags = optionalStringArray(graph.tags, 'graph.tags') || []
  const metadata = optionalRecord(graph.metadata, 'graph.metadata')

  if (nodes.length === 0) throw issue('graph.nodes', 'Expected at least one graph node')
  if (outputs.length === 0) throw issue('graph.outputs', 'Expected at least one graph output')
  assertUnique(
    nodes.map((node) => node.nodeId),
    'graph.nodes'
  )
  assertUnique(
    channels.map((channel) => channel.channelId),
    'graph.channels'
  )
  assertUnique(
    outputs.map((output) => output.outputId),
    'graph.outputs'
  )

  const nodeIds = new Set(nodes.map((node) => node.nodeId))
  const channelIds = new Set(channels.map((channel) => channel.channelId))
  for (const channel of channels) {
    if (!nodeIds.has(channel.from))
      throw issue('graph.channels.from', 'Expected existing from node')
    if (!nodeIds.has(channel.to)) throw issue('graph.channels.to', 'Expected existing to node')
    if (channel.condition?.sourceNodeId && !nodeIds.has(channel.condition.sourceNodeId)) {
      throw issue('graph.channels.condition.sourceNodeId', 'Expected existing source node')
    }
  }
  for (const node of nodes) {
    if (node.condition?.sourceNodeId && !nodeIds.has(node.condition.sourceNodeId)) {
      throw issue('graph.nodes.condition.sourceNodeId', 'Expected existing source node')
    }
  }
  for (const output of outputs) {
    if (!nodeIds.has(output.sourceNodeId)) {
      throw issue('graph.outputs.sourceNodeId', 'Expected existing source node')
    }
    if (output.channelId && !channelIds.has(output.channelId)) {
      throw issue('graph.outputs.channelId', 'Expected existing channel')
    }
  }
  for (const entryNodeId of entryNodeIds) {
    if (!nodeIds.has(entryNodeId)) throw issue('graph.entryNodeIds', 'Expected existing entry node')
  }

  return {
    ...(graph as MagicAgentGraphDefinition),
    graphId: requireString(graph.graphId, 'graph.graphId'),
    name: requireString(graph.name, 'graph.name'),
    description: requireString(graph.description, 'graph.description'),
    version: optionalCleanString(graph.version, 'graph.version') || '0.0.0',
    tags,
    nodes,
    channels,
    outputs,
    entryNodeIds,
    ...(metadata !== undefined ? { metadata } : {})
  }
}

const validateRegisterAgentReq = (value: unknown): MagicAgentPlatformRegisterAgentReq => {
  const req = requireRecord(value, 'registerAgent')
  return { agent: validateAgentDefinition(req.agent) }
}

const validateListToolsReq = (value: unknown): MagicAgentPlatformListToolsReq => {
  const req = requireRecord(value, 'listTools')
  const source = optionalString(req.source, 'source')
  if (source && !['assistantRuntime', 'creative', 'magicAgentRuntime'].includes(source)) {
    throw issue('source', 'Expected a valid MagicAgent tool source')
  }
  return {
    ...(optionalCleanString(req.agentId, 'agentId') !== undefined
      ? { agentId: optionalCleanString(req.agentId, 'agentId') }
      : {}),
    ...(source ? { source: source as MagicAgentPlatformToolSource } : {})
  }
}

const validateToolCallReq = (value: unknown): MagicAgentPlatformToolCallReq => {
  const req = requireRecord(value, 'callTool')
  const source = optionalString(req.source, 'source')
  if (source && !['assistantRuntime', 'creative', 'magicAgentRuntime'].includes(source)) {
    throw issue('source', 'Expected a valid MagicAgent tool source')
  }
  return {
    name: requireString(req.name, 'name'),
    ...(optionalRecord(req.args, 'args') ? { args: optionalRecord(req.args, 'args') } : {}),
    route: validateRoute(req.route),
    ...(optionalCleanString(req.agentId, 'agentId') !== undefined
      ? { agentId: optionalCleanString(req.agentId, 'agentId') }
      : {}),
    ...(source ? { source: source as MagicAgentPlatformToolSource } : {}),
    ...(optionalRecord(req.metadata, 'metadata')
      ? { metadata: optionalRecord(req.metadata, 'metadata') }
      : {})
  }
}

const validateRunAgentReq = (value: unknown): MagicAgentPlatformRunReq => {
  const req = requireRecord(value, 'runAgent')
  return {
    ...(optionalCleanString(req.agentId, 'agentId') !== undefined
      ? { agentId: optionalCleanString(req.agentId, 'agentId') }
      : {}),
    text: requireString(req.text, 'text'),
    route: validateRoute(req.route),
    ...(optionalCleanString(req.profileId, 'profileId') !== undefined
      ? { profileId: optionalCleanString(req.profileId, 'profileId') }
      : {}),
    ...(optionalCleanString(req.systemPrompt, 'systemPrompt') !== undefined
      ? { systemPrompt: optionalCleanString(req.systemPrompt, 'systemPrompt') }
      : {}),
    ...(Array.isArray(req.attachments) ? { attachments: req.attachments as ChatAttachment[] } : {}),
    ...(optionalNumber(req.maxToolIterations, 'maxToolIterations') !== undefined
      ? { maxToolIterations: optionalNumber(req.maxToolIterations, 'maxToolIterations') }
      : {}),
    ...(optionalPositiveNumber(req.timeoutMs, 'timeoutMs') !== undefined
      ? { timeoutMs: optionalPositiveNumber(req.timeoutMs, 'timeoutMs') }
      : {}),
    ...(req.allowedToolNames !== undefined
      ? { allowedToolNames: optionalNullableStringArray(req.allowedToolNames, 'allowedToolNames') }
      : {}),
    ...(optionalRecord(req.metadata, 'metadata')
      ? { metadata: optionalRecord(req.metadata, 'metadata') }
      : {})
  }
}

const validateGraphCatalogListReq = (value: unknown): MagicAgentPlatformGraphCatalogListReq => {
  const req = requireRecord(value, 'listGraphCatalog')
  return {
    ...(req.route !== undefined ? { route: validateRoute(req.route) } : {}),
    ...(req.allowedToolNames !== undefined
      ? { allowedToolNames: optionalNullableStringArray(req.allowedToolNames, 'allowedToolNames') }
      : {})
  }
}

const validateGraphCreateReq = (value: unknown): MagicAgentGraphCreateRequest => {
  const req = requireRecord(value, 'createGraph')
  return {
    graph: validateGraphDefinition(req.graph),
    route: validateRoute(req.route),
    ...(req.replace === true ? { replace: true } : {})
  }
}

const validateGraphDeleteReq = (value: unknown): MagicAgentPlatformGraphDeleteReq => {
  const req = requireRecord(value, 'deleteGraph')
  return { graphId: requireString(req.graphId, 'graphId'), route: validateRoute(req.route) }
}

const validateGraphForkReq = (value: unknown): MagicAgentPlatformGraphForkReq => {
  const req = requireRecord(value, 'forkGraph')
  return {
    graphId: requireString(req.graphId, 'graphId'),
    route: validateRoute(req.route),
    ...(optionalCleanString(req.targetGraphId, 'targetGraphId') !== undefined
      ? { targetGraphId: optionalCleanString(req.targetGraphId, 'targetGraphId') }
      : {}),
    ...(optionalCleanString(req.name, 'name') !== undefined
      ? { name: optionalCleanString(req.name, 'name') }
      : {}),
    ...(req.replace === true ? { replace: true } : {})
  }
}

const validateGraphValidateReq = (value: unknown): MagicAgentPlatformGraphValidateReq => {
  const req = requireRecord(value, 'validateGraph')
  if (!Object.prototype.hasOwnProperty.call(req, 'graph')) {
    throw issue('graph', 'Expected graph to be provided')
  }
  return { graph: req.graph }
}

const validatePreflightGraphRunReq = (value: unknown): MagicAgentPlatformGraphPreflightRunReq => {
  const req = requireRecord(value, 'preflightGraphRun')
  return {
    graphId: requireString(req.graphId, 'graphId'),
    route: validateRoute(req.route),
    ...(req.allowedToolNames !== undefined
      ? { allowedToolNames: optionalNullableStringArray(req.allowedToolNames, 'allowedToolNames') }
      : {})
  }
}

const validateGraphIdReq = (value: unknown): MagicAgentPlatformGraphInspectReq => {
  const req = requireRecord(value, 'graphId')
  return { graphId: requireString(req.graphId, 'graphId') }
}

const validateRunGraphReq = (value: unknown): MagicAgentGraphRunRequest => {
  const req = requireRecord(value, 'runGraph')
  return {
    graphId: requireString(req.graphId, 'graphId'),
    input: requireString(req.input, 'input'),
    route: validateRoute(req.route),
    ...(optionalCleanString(req.runId, 'runId') !== undefined
      ? { runId: optionalCleanString(req.runId, 'runId') }
      : {}),
    ...(optionalStringArray(req.outputIds, 'outputIds')
      ? { outputIds: optionalStringArray(req.outputIds, 'outputIds') }
      : {}),
    ...(req.allowedToolNames !== undefined
      ? { allowedToolNames: optionalNullableStringArray(req.allowedToolNames, 'allowedToolNames') }
      : {}),
    ...(optionalRecord(req.metadata, 'metadata')
      ? { metadata: optionalRecord(req.metadata, 'metadata') }
      : {})
  }
}

const validateGraphRunListReq = (value: unknown): MagicAgentPlatformGraphRunListReq => {
  const req = requireRecord(value, 'listGraphRuns')
  const graphId = optionalCleanString(req.graphId, 'graphId')
  const limit = optionalPositiveInteger(req.limit, 'limit')
  return {
    route: validateRoute(req.route),
    ...(graphId !== undefined ? { graphId } : {}),
    ...(limit !== undefined ? { limit } : {})
  }
}

const validateGraphRunGetReq = (value: unknown): MagicAgentPlatformGraphRunGetReq => {
  const req = requireRecord(value, 'getGraphRun')
  return { runId: requireString(req.runId, 'runId'), route: validateRoute(req.route) }
}

const validateGraphRunEventListReq = (value: unknown): MagicAgentPlatformGraphRunEventListReq => {
  const req = requireRecord(value, 'listGraphRunEvents')
  const limit = optionalPositiveInteger(req.limit, 'limit')
  return {
    runId: requireString(req.runId, 'runId'),
    route: validateRoute(req.route),
    ...(limit !== undefined ? { limit } : {})
  }
}

const validateGraphRunWatchReq = (value: unknown): MagicAgentPlatformGraphRunWatchReq => {
  const req = requireRecord(value, 'watchGraphRun')
  return { runId: requireString(req.runId, 'runId'), route: validateRoute(req.route) }
}

const validateGraphRunStreamEvent = (value: unknown): MagicAgentGraphRunStreamEvent => {
  const event = requireRecord(value, 'watchGraphRun.stream')
  const type = requireString(event.type, 'stream.type')
  if (!MAGIC_AGENT_GRAPH_RUN_STREAM_EVENT_TYPES.has(type)) {
    throw issue('stream.type', 'Expected a valid MagicAgentGraph run stream event type')
  }
  const status = requireString(event.status, 'stream.status')
  if (!MAGIC_AGENT_GRAPH_RUN_STATUSES.has(status)) {
    throw issue('stream.status', 'Expected a valid MagicAgentGraph run status')
  }
  if (event.run !== undefined && !isRecord(event.run)) {
    throw issue('stream.run', 'Expected an object')
  }
  if (event.event !== undefined && !isRecord(event.event)) {
    throw issue('stream.event', 'Expected an object')
  }
  const error = optionalCleanString(event.error, 'stream.error')
  return {
    type: type as MagicAgentGraphRunStreamEvent['type'],
    sequence: requireNonNegativeInteger(event.sequence, 'stream.sequence'),
    runId: requireString(event.runId, 'stream.runId'),
    graphId: requireString(event.graphId, 'stream.graphId'),
    status: status as MagicAgentGraphRunStreamEvent['status'],
    createdAt: requireFiniteNumber(event.createdAt, 'stream.createdAt'),
    ...(event.run !== undefined ? { run: event.run as MagicAgentGraphRunRecord } : {}),
    ...(event.event !== undefined
      ? { event: event.event as MagicAgentGraphRunStreamEvent['event'] }
      : {}),
    ...(error !== undefined ? { error } : {})
  }
}

const validateGraphCancelReq = (value: unknown): MagicAgentPlatformGraphCancelReq => {
  const req = requireRecord(value, 'cancelGraphRun')
  return {
    runId: requireString(req.runId, 'runId'),
    route: validateRoute(req.route),
    ...(optionalCleanString(req.reason, 'reason') !== undefined
      ? { reason: optionalCleanString(req.reason, 'reason') }
      : {})
  }
}

const validatePackageManifestReq = (
  value: unknown
): MagicAgentPlatformValidatePackageManifestReq => {
  const req = requireRecord(value, 'validatePackageManifest')
  return { manifest: req.manifest }
}

const validatePackagePathReq = (value: unknown): MagicAgentPlatformPackagePathReq => {
  const req = requireRecord(value, 'packagePath')
  return { packageDir: requireString(req.packageDir, 'packageDir') }
}

const validatePackageInspectReq = (value: unknown): MagicAgentPlatformPackageInspectReq => {
  const req = requireRecord(value, 'inspectPackage')
  return { packageIdOrDir: requireString(req.packageIdOrDir, 'packageIdOrDir') }
}

const validatePackageUninstallReq = (value: unknown): MagicAgentPlatformPackageUninstallReq => {
  const req = requireRecord(value, 'uninstallPackage')
  return { packageId: requireString(req.packageId, 'packageId') }
}

export type MagicAgentPlatformSvc = {
  getStatus(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformStatusResp>
  listAgents(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformListAgentsResp>
  registerAgent(
    req: MagicAgentPlatformRegisterAgentReq
  ): Promise<MagicAgentPlatformRegisterAgentResp>
  runAgent(req: MagicAgentPlatformRunReq): Promise<MagicAgentPlatformRunResp>
  listTools(req: MagicAgentPlatformListToolsReq): Promise<MagicAgentPlatformListToolsResp>
  callTool(req: MagicAgentPlatformToolCallReq): Promise<MagicAgentPlatformToolCallResp>
  listGraphs(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformGraphListResp>
  listGraphCatalog(
    req: MagicAgentPlatformGraphCatalogListReq
  ): Promise<MagicAgentPlatformGraphListResp>
  createGraph(req: MagicAgentGraphCreateRequest): Promise<MagicAgentPlatformGraphCreateResp>
  saveGraph(req: MagicAgentGraphCreateRequest): Promise<MagicAgentPlatformGraphSaveResp>
  deleteGraph(req: MagicAgentPlatformGraphDeleteReq): Promise<MagicAgentPlatformGraphDeleteResp>
  forkGraph(req: MagicAgentPlatformGraphForkReq): Promise<MagicAgentPlatformGraphForkResp>
  validateGraph(
    req: MagicAgentPlatformGraphValidateReq
  ): Promise<MagicAgentPlatformGraphValidateResp>
  preflightGraphRun(
    req: MagicAgentPlatformGraphPreflightRunReq
  ): Promise<MagicAgentPlatformGraphPreflightRunResp>
  inspectGraph(req: MagicAgentPlatformGraphInspectReq): Promise<MagicAgentPlatformGraphInspectResp>
  runGraph(req: MagicAgentGraphRunRequest): Promise<MagicAgentGraphRunResult>
  listGraphRuns(req: MagicAgentPlatformGraphRunListReq): Promise<MagicAgentPlatformGraphRunListResp>
  getGraphRun(req: MagicAgentPlatformGraphRunGetReq): Promise<MagicAgentPlatformGraphRunGetResp>
  listGraphRunEvents(
    req: MagicAgentPlatformGraphRunEventListReq
  ): Promise<MagicAgentPlatformGraphRunEventListResp>
  watchGraphRun(
    req: MagicAgentPlatformGraphRunWatchReq,
    resp: ServerStreaming<MagicAgentGraphRunStreamEvent>
  ): Promise<void>
  cancelGraphRun(req: MagicAgentPlatformGraphCancelReq): Promise<MagicAgentGraphCancelResult>
  validatePackageManifest(
    req: MagicAgentPlatformValidatePackageManifestReq
  ): Promise<MagicAgentPlatformValidatePackageManifestResp>
  scanPackage(req: MagicAgentPlatformPackagePathReq): Promise<MagicAgentPlatformPackageScanResp>
  installPackage(
    req: MagicAgentPlatformPackagePathReq
  ): Promise<MagicAgentPlatformPackageInstallResp>
  listPackages(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformPackageListResp>
  inspectPackage(
    req: MagicAgentPlatformPackageInspectReq
  ): Promise<MagicAgentPlatformPackageInspectResp>
  uninstallPackage(
    req: MagicAgentPlatformPackageUninstallReq
  ): Promise<MagicAgentPlatformPackageUninstallResp>
}

export const magicAgentPlatformSvcDef: ServiceDefSheet<MagicAgentPlatformSvc> = {
  getStatus: { type: 'unary', request: validateEmptyReq },
  listAgents: { type: 'unary', request: validateEmptyReq },
  registerAgent: { type: 'unary', request: validateRegisterAgentReq },
  runAgent: { type: 'unary', request: validateRunAgentReq },
  listTools: { type: 'unary', request: validateListToolsReq },
  callTool: { type: 'unary', request: validateToolCallReq },
  listGraphs: { type: 'unary', request: validateEmptyReq },
  listGraphCatalog: { type: 'unary', request: validateGraphCatalogListReq },
  createGraph: { type: 'unary', request: validateGraphCreateReq },
  saveGraph: { type: 'unary', request: validateGraphCreateReq },
  deleteGraph: { type: 'unary', request: validateGraphDeleteReq },
  forkGraph: { type: 'unary', request: validateGraphForkReq },
  validateGraph: { type: 'unary', request: validateGraphValidateReq },
  preflightGraphRun: { type: 'unary', request: validatePreflightGraphRunReq },
  inspectGraph: { type: 'unary', request: validateGraphIdReq },
  runGraph: { type: 'unary', request: validateRunGraphReq },
  listGraphRuns: { type: 'unary', request: validateGraphRunListReq },
  getGraphRun: { type: 'unary', request: validateGraphRunGetReq },
  listGraphRunEvents: { type: 'unary', request: validateGraphRunEventListReq },
  watchGraphRun: {
    type: 'serverStreaming',
    request: validateGraphRunWatchReq,
    data: validateGraphRunStreamEvent
  },
  cancelGraphRun: { type: 'unary', request: validateGraphCancelReq },
  validatePackageManifest: { type: 'unary', request: validatePackageManifestReq },
  scanPackage: { type: 'unary', request: validatePackagePathReq },
  installPackage: { type: 'unary', request: validatePackagePathReq },
  listPackages: { type: 'unary', request: validateEmptyReq },
  inspectPackage: { type: 'unary', request: validatePackageInspectReq },
  uninstallPackage: { type: 'unary', request: validatePackageUninstallReq }
}
