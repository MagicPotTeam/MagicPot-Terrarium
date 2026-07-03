import type { AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentGraphCancelResult,
  MagicAgentGraphCreateRequest,
  MagicAgentGraphDefinition,
  MagicAgentGraphListItem,
  MagicAgentGraphRunRecord,
  MagicAgentGraphRunRequest,
  MagicAgentGraphRunResult
} from '@shared/magicAgent'
import type {
  MagicAgentInstalledPackage,
  MagicAgentPackageInspection,
  MagicAgentPackageValidationResult
} from '@shared/magicAgentRuntime'
import type { ChatAttachment } from './svcLLMProxy'
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

export type MagicAgentPlatformGraphCreateResp = {
  graph: MagicAgentGraphDefinition
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

const validateGraphCreateReq = (value: unknown): MagicAgentGraphCreateRequest => {
  const req = requireRecord(value, 'createGraph')
  const graph = requireRecord(req.graph, 'graph')
  return {
    graph: graph as unknown as MagicAgentGraphDefinition,
    route: validateRoute(req.route),
    ...(req.replace === true ? { replace: true } : {})
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
  createGraph(req: MagicAgentGraphCreateRequest): Promise<MagicAgentPlatformGraphCreateResp>
  inspectGraph(req: MagicAgentPlatformGraphInspectReq): Promise<MagicAgentPlatformGraphInspectResp>
  runGraph(req: MagicAgentGraphRunRequest): Promise<MagicAgentGraphRunResult>
  listGraphRuns(req: MagicAgentPlatformGraphRunListReq): Promise<MagicAgentPlatformGraphRunListResp>
  getGraphRun(req: MagicAgentPlatformGraphRunGetReq): Promise<MagicAgentPlatformGraphRunGetResp>
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
  createGraph: { type: 'unary', request: validateGraphCreateReq },
  inspectGraph: { type: 'unary', request: validateGraphIdReq },
  runGraph: { type: 'unary', request: validateRunGraphReq },
  listGraphRuns: { type: 'unary', request: validateGraphRunListReq },
  getGraphRun: { type: 'unary', request: validateGraphRunGetReq },
  cancelGraphRun: { type: 'unary', request: validateGraphCancelReq },
  validatePackageManifest: { type: 'unary', request: validatePackageManifestReq },
  scanPackage: { type: 'unary', request: validatePackagePathReq },
  installPackage: { type: 'unary', request: validatePackagePathReq },
  listPackages: { type: 'unary', request: validateEmptyReq },
  inspectPackage: { type: 'unary', request: validatePackageInspectReq },
  uninstallPackage: { type: 'unary', request: validatePackageUninstallReq }
}
