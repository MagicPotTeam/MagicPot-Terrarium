import type { MagicAgentConfigContent } from '../magicAgentPlatform2/agentConfig'
import type { PolicyJsonValue } from '../magicAgentPlatform2/policy'
import type {
  SemanticMemoryAdminResult,
  SemanticMemoryAgentSessionLink,
  SemanticMemoryAgentSessionLinkPublicReq,
  SemanticMemoryClearScopePublicReq,
  SemanticMemoryDeletePublicReq,
  SemanticMemoryIngestResult,
  SemanticMemoryIngestScopePublicReq,
  SemanticMemoryIngestSessionPublicReq,
  SemanticMemoryInspectPublicReq,
  SemanticMemoryPublicInspectResult,
  SemanticMemoryPublicSearchResult,
  SemanticMemoryRebuildJob,
  SemanticMemoryRebuildPublicReq,
  SemanticMemorySearchPublicReq,
  SemanticMemorySetDisabledPublicReq,
  SemanticMemorySetVisibilityPublicReq
} from '../magicAgentPlatform2/memory'
import type { AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentGraphCancelResult,
  MagicAgentGraphPauseResult,
  MagicAgentGraphResumeResult,
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
  MagicAgentGraphRunPublicEvent,
  MagicAgentGraphRunRequest,
  MagicAgentGraphRunResult,
  MagicAgentGraphRuntimeTopologySnapshot,
  MagicAgentGraphRunStreamEvent,
  MagicAgentGraphValidationResult
} from '@shared/magicAgent'
import type {
  MagicAgentInstalledPackage,
  MagicAgentPackageInspection,
  MagicAgentPackageValidationResult
} from '@shared/magicAgentRuntime'
import type { ChatAttachment } from './svcLLMProxy'
import {
  validateGraphDefinitionV2Draft,
  type GraphDefinitionV2Draft,
  type GraphContractValidationResult,
  type GraphV2NodeDescriptor,
  type MagicAgentInstanceLimits,
  type MagicAgentInstanceState,
  type PolicyActorRef,
  type RuntimeChannelMemberRole,
  type RuntimeChannelMode,
  type RuntimeTopologyAttribution
} from '@shared/magicAgentPlatform2'
import type { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'

export type MagicAgentPlatformPendingApproval = {
  approvalId: string
  revision: number
  createdAt: number
  expiresAt: number
  request: unknown
  graphContext?: {
    runId: string
    nodeId: string
    toolName: string
    requestDigest: string
  }
}

export type MagicAgentPlatformListPendingApprovalsResp = {
  approvals: MagicAgentPlatformPendingApproval[]
}

export type MagicAgentPlatformPendingApprovalStreamEvent = {
  type: 'snapshot'
  approvals: MagicAgentPlatformPendingApproval[]
}

export type MagicAgentPlatformResolvePendingApprovalReq = {
  approvalId: string
  expectedRevision: number
  approved: boolean
}

export type MagicAgentPlatformResolvePendingApprovalResp = {
  approval: MagicAgentPlatformPendingApproval
}

export type MagicAgentPlatformAgentInstanceResource = Readonly<{
  id: string
  revision: number
  state: MagicAgentInstanceState
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformListAgentInstancesResp = Readonly<{
  instances: readonly MagicAgentPlatformAgentInstanceResource[]
}>
export type MagicAgentPlatformGetAgentInstanceReq = Readonly<{ instanceId: string }>
export type MagicAgentPlatformGetAgentInstanceResp = Readonly<{
  instance?: MagicAgentPlatformAgentInstanceResource
}>
export type MagicAgentPlatformRuntimeChannelMember = Readonly<{
  memberId: string
  agentInstanceId?: string
  graphTargetId?: string
  graphWakeRequest?: Readonly<{
    graphId: string
    route: Readonly<{ channel: string; scopeType: string; scopeId: string }>
  }>
  role: RuntimeChannelMemberRole
  joinedAt: number
}>
export type MagicAgentPlatformRuntimeChannelState = Readonly<{
  id: string
  name: string
  mode: RuntimeChannelMode
  capacity: number
  members: readonly MagicAgentPlatformRuntimeChannelMember[]
  runtimeTopologyAttribution?: RuntimeTopologyAttribution
}>
export type MagicAgentPlatformRuntimeChannelResource = Readonly<{
  id: string
  revision: number
  state: MagicAgentPlatformRuntimeChannelState
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformListRuntimeChannelsResp = Readonly<{
  channels: readonly MagicAgentPlatformRuntimeChannelResource[]
}>
export type MagicAgentPlatformGetRuntimeChannelReq = Readonly<{ channelId: string }>
export type MagicAgentPlatformGetRuntimeChannelResp = Readonly<{
  channel?: MagicAgentPlatformRuntimeChannelResource
}>
export type MagicAgentPlatformCreateRuntimeChannelReq = Readonly<{
  channel: Readonly<{ id: string; name: string; mode: RuntimeChannelMode; capacity: number }>
  createdAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformJoinRuntimeChannelReq = Readonly<{
  channelId: string
  expectedRevision: number
  member: Readonly<{
    memberId: string
    agentInstanceId: string
    role: RuntimeChannelMemberRole
    joinedAt: number
  }>
  joinedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformLeaveRuntimeChannelReq = Readonly<{
  channelId: string
  expectedRevision: number
  memberId: string
  leftAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRuntimeChannelMutationResp = Readonly<{
  channel: MagicAgentPlatformRuntimeChannelResource
}>
export type MagicAgentPlatformRuntimeChannelWireResource = Readonly<{
  id: string
  revision: number
  state: Readonly<{
    id: string
    sourceChannelId: string
    targetChannelId: string
    targetPublisherMemberId: string
    enabled: boolean
    createdAt: number
    maxHops: number
    runtimeTopologyAttribution?: RuntimeTopologyAttribution
  }>
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformListRuntimeChannelWiresResp = Readonly<{
  wires: MagicAgentPlatformRuntimeChannelWireResource[]
}>
export type MagicAgentPlatformGetRuntimeChannelWireReq = Readonly<{ wireId: string }>
export type MagicAgentPlatformGetRuntimeChannelWireResp = Readonly<{
  wire?: MagicAgentPlatformRuntimeChannelWireResource
}>
export type MagicAgentPlatformWireRuntimeChannelReq = Readonly<{
  wire: Readonly<{
    id: string
    sourceChannelId: string
    targetChannelId: string
    targetPublisherMemberId: string
    enabled: boolean
    createdAt: number
    maxHops: number
    runtimeTopologyAttribution?: RuntimeTopologyAttribution
  }>
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformUnwireRuntimeChannelReq = Readonly<{
  wireId: string
  expectedRevision: number
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRuntimeChannelWireMutationResp = Readonly<{
  wire: MagicAgentPlatformRuntimeChannelWireResource
}>
export type MagicAgentPlatformPublishRuntimeChannelMessageReq = Readonly<{
  message: Readonly<{
    id: string
    channelId: string
    publisherMemberId: string
    payload: PolicyJsonValue
    priority: number
    publishedAt: number
    expiresAt?: number
  }>
  expectedChannelRevision: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformPublishRuntimeChannelMessageResp = Readonly<{
  messageId: string
  revision: number
  channelId: string
  status: string
}>
export type MagicAgentPlatformClaimRuntimeChannelMessageReq = Readonly<{
  messageId: string
  expectedRevision: number
  consumerMemberId: string
  claimedAt: number
  leaseMs: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformAcknowledgeRuntimeChannelMessageReq = Readonly<{
  messageId: string
  expectedRevision: number
  consumerMemberId: string
  acknowledgedAt: number
  token: string
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRuntimeChannelDeliveryResp = Readonly<{
  messageId: string
  revision: number
  channelId: string
  consumerMemberId: string
  claimToken?: string
  leaseExpiresAt?: number
  acknowledgedAt?: number
}>
export type MagicAgentPlatformAgentInstanceMutationResp = Readonly<{
  instance: MagicAgentPlatformAgentInstanceResource
}>
export type MagicAgentPlatformTeamResource = Readonly<{
  id: string
  revision: number
  state: import('../magicAgentPlatform2/team').MagicAgentTeamState
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformCreateTeamReq = Readonly<{
  team: Readonly<{ id: string; name: string; createdAt: number }>
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformAddTeamMemberReq = Readonly<{
  teamId: string
  expectedRevision: number
  member: Readonly<{
    memberId: string
    agentInstanceId: string
    role: 'leader' | 'member'
    joinedAt: number
  }>
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRemoveTeamReq = Readonly<{
  teamId: string
  expectedRevision: number
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRemoveTeamMemberReq = Readonly<{
  teamId: string
  expectedRevision: number
  memberId: string
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformReplaceTeamReq = Readonly<{
  teamId: string
  expectedRevision: number
  replacements: readonly Readonly<{
    memberId: string
    definitionId: string
    name: string
    configVersion: string
    replacedAt: number
  }>[]
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformTeamLifecycleReq = Readonly<{
  teamId: string
  expectedRevision: number
  idempotencyKey: string
}>
export type MagicAgentPlatformStartTeamReq = MagicAgentPlatformTeamLifecycleReq &
  Readonly<{ request: MagicAgentPlatformRunReq }>
export type MagicAgentPlatformTeamLifecycleResp = Readonly<{
  id: string
  revision: number
  teamId: string
  teamRevision: number
  action: 'start' | 'pause' | 'resume' | 'stop' | 'replace'
  status: 'completed' | 'partial' | 'failed'
  outcomes: readonly Readonly<{
    memberId: string
    agentInstanceId: string
    status: 'completed' | 'failed'
    error?: string
  }>[]
  startedAt: number
  completedAt?: number
}>

export type MagicAgentPlatformCreateRootAgentInstanceReq = Readonly<{
  instance: MagicAgentInstanceState
  createdAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformCreateChildAgentInstanceReq = Readonly<{
  parentInstanceId: string
  parentExpectedRevision: number
  instance: Omit<MagicAgentInstanceState, 'parentInstanceId' | 'depth' | 'status'>
  createdAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformCreateAgentConfigVersionReq = Readonly<{
  config: Omit<MagicAgentConfigContent, 'createdBy' | 'contentDigest'>
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformAgentConfigVersionResp = Readonly<{
  version: string
  definitionId: string
  contentDigest: string
  createdAt: number
}>
export type MagicAgentPlatformStageAgentConfigReq = Readonly<{
  instanceId: string
  expectedRevision: number
  configVersion: string
  stagedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformActivateAgentConfigReq = Readonly<{
  instanceId: string
  expectedRevision: number
  activatedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRollbackAgentConfigReq = Readonly<{
  instanceId: string
  expectedRevision: number
  rolledBackAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>

export type MagicAgentPlatformStartAgentInstanceReq = Readonly<{
  instanceId: string
  expectedRevision: number
  request: MagicAgentPlatformRunReq
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformPauseAgentInstanceReq = Readonly<{
  instanceId: string
  expectedRevision: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformResumeAgentInstanceReq = MagicAgentPlatformPauseAgentInstanceReq
export type MagicAgentPlatformStopAgentInstanceReq = Readonly<{
  instanceId: string
  expectedRevision: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformReplaceAgentInstanceReq = Readonly<{
  instanceId: string
  expectedRevision: number
  definitionId: string
  name: string
  configVersion: string
  replacedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>
export type MagicAgentPlatformRemoveAgentInstanceReq = Readonly<{
  instanceId: string
  expectedRevision: number
  removedAt: number
  idempotencyKey: string
  grantId?: string
  expectedGrantUseCount?: number
}>

export type MagicAgentPlatformDriveResource = Readonly<{
  id: string
  revision: number
  state: unknown
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformListDrivesResp = Readonly<{
  drives: readonly MagicAgentPlatformDriveResource[]
}>
export type MagicAgentPlatformGetDriveReq = Readonly<{ driveId: string }>
export type MagicAgentPlatformGetDriveResp = Readonly<{ drive?: MagicAgentPlatformDriveResource }>
export type MagicAgentPlatformCreateDriveReq = Readonly<{
  drive: unknown
  createdAt: number
  idempotencyKey: string
}>
export type MagicAgentPlatformDriveMutationResp = Readonly<{
  drive: MagicAgentPlatformDriveResource
}>
export type MagicAgentPlatformTransitionDriveReq = Readonly<{
  driveId: string
  expectedRevision: number
  status: string
  transitionedAt: number
  idempotencyKey: string
  reason?: string
}>
export type MagicAgentPlatformReportDriveProgressReq = Readonly<{
  driveId: string
  expectedRevision: number
  summary: string
  evidence: readonly unknown[]
  reportedAt: number
  idempotencyKey: string
}>

export type MagicAgentPlatformRetryDriveDeliveryReq = Readonly<{
  driveId: string
  expectedRevision: number
  retryAt: number
  idempotencyKey: string
}>

export type MagicAgentPlatformTransferDriveReq = Readonly<{
  driveId: string
  expectedRevision: number
  ownerId?: string
  assigneeId?: string
  transferredAt: number
  idempotencyKey: string
}>
export type MagicAgentPlatformSetDriveLinksReq = Readonly<{
  driveId: string
  expectedRevision: number
  links: readonly unknown[]
  updatedAt: number
  idempotencyKey: string
}>

export type MagicAgentPlatformTriggerResource = Readonly<{
  id: string
  revision: number
  state: unknown
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformListTriggersResp = Readonly<{
  triggers: readonly MagicAgentPlatformTriggerResource[]
}>
export type MagicAgentPlatformTriggerControlReq = Readonly<{
  triggerId: string
  expectedTriggerRevision: number
  idempotencyKey: string
  requestedAt: number
}>
export type MagicAgentPlatformManualFireTriggerReq = MagicAgentPlatformTriggerControlReq &
  Readonly<{
    occurrenceId: string
    scheduledAt?: number
    payloadDigest?: string
  }>
export type MagicAgentPlatformTriggerOccurrenceResource = Readonly<{
  id: string
  revision: number
  state: unknown
  createdAt: number
  updatedAt: number
}>
export type MagicAgentPlatformManualFireTriggerResp = Readonly<{
  occurrence: MagicAgentPlatformTriggerOccurrenceResource
}>
export type MagicAgentPlatformTriggerMutationResp = Readonly<{
  trigger: MagicAgentPlatformTriggerResource
}>
export type MagicAgentPlatformUpdateTriggerReq = MagicAgentPlatformTriggerControlReq &
  Readonly<{
    patch: Readonly<{
      title?: string
      enabled?: boolean
      config?: Record<string, unknown>
    }>
  }>
export type MagicAgentPlatformCreateTriggerReq = Readonly<{
  trigger: unknown
  schedule?: unknown
  nextFireAt?: number
  createdAt: number
  idempotencyKey: string
}>
export type MagicAgentPlatformCreateTriggerResp = Readonly<{
  trigger: MagicAgentPlatformTriggerResource
}>
export type MagicAgentPlatformGetTriggerReq = Readonly<{ triggerId: string }>
export type MagicAgentPlatformGetTriggerResp = Readonly<{
  trigger?: MagicAgentPlatformTriggerResource
}>

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
  'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'timeout' | 'permission_denied'

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
  sessionId?: string
  systemPrompt?: string
  attachments?: ChatAttachment[]
  maxToolIterations?: number
  maxOutputTokens?: number
  temperature?: number
  memory?: Readonly<{ allowHistory: boolean; contextMessageLimit: number; scope: 'session' }>
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

export type MagicAgentPlatformGraphV2SaveReq = {
  graph: GraphDefinitionV2Draft
  route: AgentRouteLike
  replace?: boolean
}

export type MagicAgentPlatformGraphV2SaveResp = {
  graph: MagicAgentGraphDefinition
  definitionV2: GraphDefinitionV2Draft
}

export type MagicAgentPlatformGraphV2GetReq = {
  graphId: string
  route: AgentRouteLike
}

export type MagicAgentPlatformGraphV2GetResp = {
  definitionV2?: GraphDefinitionV2Draft
}

export type MagicAgentPlatformGraphV2PublishReq = MagicAgentPlatformGraphV2GetReq
export type MagicAgentPlatformGraphV2PublishResp = { definitionV2: GraphDefinitionV2Draft }
export type MagicAgentPlatformGraphV2GetPublishedReq = MagicAgentPlatformGraphV2GetReq & {
  version: string
}
export type MagicAgentPlatformGraphV2GetPublishedResp = MagicAgentPlatformGraphV2GetResp
export type MagicAgentPlatformGraphV2ListPublishedResp = {
  definitionsV2: GraphDefinitionV2Draft[]
}
export type MagicAgentPlatformGraphV2NodeRegistryResp = {
  descriptors: GraphV2NodeDescriptor[]
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

export type MagicAgentPlatformSessionForkReq = Readonly<{
  sourceRoute: AgentRouteLike
  sourceEventId: string
  targetRoute: AgentRouteLike
  idempotencyKey: string
}>

export type MagicAgentPlatformSessionForkResp = Readonly<{
  targetSessionKey: string
  lineage: Readonly<{
    sourceSessionKey: string
    sourceEventId: string
    sourceRunId: string
    forkedAt: number
  }>
  warning: string
  counts: Readonly<{
    messages: number
    runs: number
    events: number
    artifacts: number
  }>
}>

export type MagicAgentPlatformSessionExportFormat = 'markdown' | 'html' | 'jsonl'
export type MagicAgentPlatformSessionAvailability = Readonly<
  Record<string, Readonly<{ status: 'available' | 'unavailable'; reason?: string }>>
>
export type MagicAgentPlatformSessionExportReq = Readonly<{
  sourceRoute: AgentRouteLike
  format: MagicAgentPlatformSessionExportFormat
}>
export type MagicAgentPlatformSessionExportResp = Readonly<{
  format: MagicAgentPlatformSessionExportFormat
  mimeType: string
  filename: string
  body: string
  availability: MagicAgentPlatformSessionAvailability
}>
export type MagicAgentPlatformSessionDiffReq = Readonly<{
  leftRoute: AgentRouteLike
  rightRoute: AgentRouteLike
}>
export type MagicAgentPlatformSessionDiffResp = Readonly<{
  schemaVersion: 1
  leftSessionKey: string
  rightSessionKey: string
  relationship: Readonly<{
    relationship:
      'same' | 'left-forked-from-right' | 'right-forked-from-left' | 'related-forks' | 'unrelated'
    commonSourceSessionKey?: string
  }>
  dimensions: Readonly<
    Record<
      string,
      Readonly<{
        classification: 'equal' | 'changed' | 'left-only' | 'right-only' | 'unavailable'
        leftAvailable: boolean
        rightAvailable: boolean
        leftCount?: number
        rightCount?: number
      }>
    >
  >
  timeline: readonly Readonly<{
    side: 'left' | 'right' | 'both'
    at: number
    kind: string
    left?: unknown
    right?: unknown
  }>[]
  sideBySide: readonly Readonly<{
    index: number
    left?: unknown
    right?: unknown
    classification: 'equal' | 'changed' | 'left-only' | 'right-only'
  }>[]
}>

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

export type MagicAgentPlatformGraphRunReq = MagicAgentGraphRunRequest & {
  definitionV2?: GraphDefinitionV2Draft
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

export type MagicAgentPlatformRuntimeGraphTopologyReq = MagicAgentPlatformGraphRunGetReq
export type MagicAgentPlatformRuntimeGraphTopologyResp = {
  runId: string
  graphId: string
  status: MagicAgentGraphRunRecord['status']
  revision: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  resources: MagicAgentGraphRuntimeTopologySnapshot['resources']
}

export type MagicAgentPlatformGraphRunEventListReq = MagicAgentGraphRunEventListRequest

export type MagicAgentPlatformGraphRunEventListResp = {
  events: MagicAgentGraphRunEvent[]
}

export type MagicAgentPlatformGraphRunWatchReq = {
  runId: string
  route: AgentRouteLike
}

export type MagicAgentPlatformGraphRunAttachReq = MagicAgentPlatformGraphRunWatchReq & {
  afterEventId?: string
}

export type MagicAgentPlatformGraphCancelReq = {
  runId: string
  route: AgentRouteLike
  reason?: string
}

export type MagicAgentPlatformGraphPauseReq = { runId: string; route: AgentRouteLike }
export type MagicAgentPlatformGraphResumeReq = MagicAgentPlatformGraphPauseReq
export type MagicAgentPlatformPendingInputMutationReq = {
  runId: string
  route: AgentRouteLike
  pendingInputId: string
  expectedRevision: number
  idempotencyKey: string
}
export type MagicAgentPlatformInjectPendingInputReq = MagicAgentPlatformPendingInputMutationReq & {
  value: string
}
export type MagicAgentPlatformEditPendingInputReq = MagicAgentPlatformInjectPendingInputReq
export type MagicAgentPlatformPendingInputMutationResp = {
  runId: string
  pendingInputId: string
  revision: number
  status: 'awaiting' | 'submitted' | 'consumed' | 'cancelled'
  replayed?: boolean
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
  'pausing',
  'paused',
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

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value === 'boolean') return value
  throw issue(field, 'Expected a boolean')
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

const validateGetDriveReq = (value: unknown): MagicAgentPlatformGetDriveReq => {
  const req = requireRecord(value, 'getDrive request')
  for (const field of Object.keys(req))
    if (field !== 'driveId') throw issue(field, 'Unexpected field')
  return { driveId: requireString(req.driveId, 'getDrive driveId') }
}

const validateCreateDriveReq = (value: unknown): MagicAgentPlatformCreateDriveReq => {
  const req = requireRecord(value, 'createDrive request')
  const fields = new Set(['drive', 'createdAt', 'idempotencyKey'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  requireRecord(req.drive, 'createDrive drive')
  return {
    drive: req.drive,
    createdAt: requireFiniteNumber(req.createdAt, 'createDrive createdAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'createDrive idempotencyKey')
  }
}

const validateTransitionDriveReq = (value: unknown): MagicAgentPlatformTransitionDriveReq => {
  const req = requireRecord(value, 'transitionDrive request')
  const fields = new Set([
    'driveId',
    'expectedRevision',
    'status',
    'transitionedAt',
    'idempotencyKey',
    'reason'
  ])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  return {
    driveId: requireString(req.driveId, 'transitionDrive driveId'),
    expectedRevision: requireNonNegativeInteger(
      req.expectedRevision,
      'transitionDrive expectedRevision'
    ),
    status: requireString(req.status, 'transitionDrive status'),
    transitionedAt: requireFiniteNumber(req.transitionedAt, 'transitionDrive transitionedAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'transitionDrive idempotencyKey'),
    ...(req.reason === undefined
      ? {}
      : { reason: requireString(req.reason, 'transitionDrive reason') })
  }
}

const validateReportDriveProgressReq = (
  value: unknown
): MagicAgentPlatformReportDriveProgressReq => {
  const req = requireRecord(value, 'reportDriveProgress request')
  const fields = new Set([
    'driveId',
    'expectedRevision',
    'summary',
    'evidence',
    'reportedAt',
    'idempotencyKey'
  ])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  if (!Array.isArray(req.evidence)) throw issue('reportDriveProgress evidence', 'Expected an array')
  return {
    driveId: requireString(req.driveId, 'reportDriveProgress driveId'),
    expectedRevision: requireNonNegativeInteger(
      req.expectedRevision,
      'reportDriveProgress expectedRevision'
    ),
    summary: requireString(req.summary, 'reportDriveProgress summary'),
    evidence: req.evidence,
    reportedAt: requireFiniteNumber(req.reportedAt, 'reportDriveProgress reportedAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'reportDriveProgress idempotencyKey')
  }
}

const validateTransferDriveReq = (value: unknown): MagicAgentPlatformTransferDriveReq => {
  const req = requireRecord(value, 'transferDrive request')
  const fields = new Set([
    'driveId',
    'expectedRevision',
    'ownerId',
    'assigneeId',
    'transferredAt',
    'idempotencyKey'
  ])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  return {
    driveId: requireString(req.driveId, 'transferDrive driveId'),
    expectedRevision: requireNonNegativeInteger(
      req.expectedRevision,
      'transferDrive expectedRevision'
    ),
    ...(req.ownerId === undefined
      ? {}
      : { ownerId: requireString(req.ownerId, 'transferDrive ownerId') }),
    ...(req.assigneeId === undefined
      ? {}
      : { assigneeId: requireString(req.assigneeId, 'transferDrive assigneeId') }),
    transferredAt: requireFiniteNumber(req.transferredAt, 'transferDrive transferredAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'transferDrive idempotencyKey')
  }
}
const validateSetDriveLinksReq = (value: unknown): MagicAgentPlatformSetDriveLinksReq => {
  const req = requireRecord(value, 'setDriveLinks request')
  const fields = new Set(['driveId', 'expectedRevision', 'links', 'updatedAt', 'idempotencyKey'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  if (!Array.isArray(req.links)) throw issue('setDriveLinks links', 'Expected an array')
  return {
    driveId: requireString(req.driveId, 'setDriveLinks driveId'),
    expectedRevision: requireNonNegativeInteger(
      req.expectedRevision,
      'setDriveLinks expectedRevision'
    ),
    links: req.links,
    updatedAt: requireFiniteNumber(req.updatedAt, 'setDriveLinks updatedAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'setDriveLinks idempotencyKey')
  }
}

const validateTriggerControlReq = (
  value: unknown,
  operation: string
): MagicAgentPlatformTriggerControlReq => {
  const req = requireRecord(value, `${operation} request`)
  const fields = new Set(['triggerId', 'expectedTriggerRevision', 'idempotencyKey', 'requestedAt'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  return {
    triggerId: requireString(req.triggerId, `${operation} triggerId`),
    expectedTriggerRevision: requireNonNegativeInteger(
      req.expectedTriggerRevision,
      `${operation} expectedTriggerRevision`
    ),
    idempotencyKey: requireString(req.idempotencyKey, `${operation} idempotencyKey`),
    requestedAt: requireFiniteNumber(req.requestedAt, `${operation} requestedAt`)
  }
}

const validateManualFireTriggerReq = (value: unknown): MagicAgentPlatformManualFireTriggerReq => {
  const req = requireRecord(value, 'manualFireTrigger request')
  const fields = new Set([
    'triggerId',
    'expectedTriggerRevision',
    'idempotencyKey',
    'requestedAt',
    'occurrenceId',
    'scheduledAt',
    'payloadDigest'
  ])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  const base = validateTriggerControlReq(
    {
      triggerId: req.triggerId,
      expectedTriggerRevision: req.expectedTriggerRevision,
      idempotencyKey: req.idempotencyKey,
      requestedAt: req.requestedAt
    },
    'manualFireTrigger'
  )
  return {
    ...base,
    occurrenceId: requireString(req.occurrenceId, 'manualFireTrigger occurrenceId'),
    ...(req.scheduledAt === undefined
      ? {}
      : { scheduledAt: requireFiniteNumber(req.scheduledAt, 'manualFireTrigger scheduledAt') }),
    ...(req.payloadDigest === undefined
      ? {}
      : { payloadDigest: requireString(req.payloadDigest, 'manualFireTrigger payloadDigest') })
  }
}

const validateUpdateTriggerReq = (value: unknown): MagicAgentPlatformUpdateTriggerReq => {
  const req = requireRecord(value, 'updateTrigger request')
  const fields = new Set([
    'triggerId',
    'expectedTriggerRevision',
    'idempotencyKey',
    'requestedAt',
    'patch'
  ])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  const base = validateTriggerControlReq(
    {
      triggerId: req.triggerId,
      expectedTriggerRevision: req.expectedTriggerRevision,
      idempotencyKey: req.idempotencyKey,
      requestedAt: req.requestedAt
    },
    'updateTrigger'
  )
  const patch = requireRecord(req.patch, 'updateTrigger patch')
  const patchFields = new Set(['title', 'enabled', 'config'])
  for (const field of Object.keys(patch))
    if (!patchFields.has(field)) throw issue(field, 'Unexpected field')
  if (Object.keys(patch).length === 0) throw issue('patch', 'Expected a non-empty object')
  if (patch.title !== undefined) requireString(patch.title, 'updateTrigger patch.title')
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
    throw issue('updateTrigger patch.enabled', 'Expected a boolean')
  if (patch.config !== undefined) requireRecord(patch.config, 'updateTrigger patch.config')
  return { ...base, patch: patch as MagicAgentPlatformUpdateTriggerReq['patch'] }
}

const validateCreateTriggerReq = (value: unknown): MagicAgentPlatformCreateTriggerReq => {
  const req = requireRecord(value, 'createTrigger request')
  const fields = new Set(['trigger', 'schedule', 'nextFireAt', 'createdAt', 'idempotencyKey'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  requireRecord(req.trigger, 'createTrigger trigger')
  if (req.schedule !== undefined) requireRecord(req.schedule, 'createTrigger schedule')
  return {
    trigger: req.trigger,
    ...(req.schedule === undefined ? {} : { schedule: req.schedule }),
    ...(req.nextFireAt === undefined
      ? {}
      : { nextFireAt: requireFiniteNumber(req.nextFireAt, 'createTrigger nextFireAt') }),
    createdAt: requireFiniteNumber(req.createdAt, 'createTrigger createdAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'createTrigger idempotencyKey')
  }
}

const validateGetTriggerReq = (value: unknown): MagicAgentPlatformGetTriggerReq => {
  const req = requireRecord(value, 'getTrigger request')
  for (const field of Object.keys(req))
    if (field !== 'triggerId') throw issue(field, 'Unexpected field')
  return { triggerId: requireString(req.triggerId, 'getTrigger triggerId') }
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

const validateSessionForkReq = (value: unknown): MagicAgentPlatformSessionForkReq => {
  const req = requireRecord(value, 'forkSessionAtEvent request')
  const fields = new Set(['sourceRoute', 'sourceEventId', 'targetRoute', 'idempotencyKey'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  return {
    sourceRoute: validateRoute(req.sourceRoute, 'sourceRoute'),
    sourceEventId: requireString(req.sourceEventId, 'sourceEventId'),
    targetRoute: validateRoute(req.targetRoute, 'targetRoute'),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey')
  }
}

const validateSessionExportReq = (value: unknown): MagicAgentPlatformSessionExportReq => {
  const req = requireRecord(value, 'exportSession request')
  const fields = new Set(['sourceRoute', 'format'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  const format = requireString(req.format, 'format')
  if (!['markdown', 'html', 'jsonl'].includes(format))
    throw issue('format', 'Expected markdown, html, or jsonl')
  return {
    sourceRoute: validateRoute(req.sourceRoute, 'sourceRoute'),
    format: format as MagicAgentPlatformSessionExportFormat
  }
}

const validateSessionDiffReq = (value: unknown): MagicAgentPlatformSessionDiffReq => {
  const req = requireRecord(value, 'diffSessions request')
  const fields = new Set(['leftRoute', 'rightRoute'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  return {
    leftRoute: validateRoute(req.leftRoute, 'leftRoute'),
    rightRoute: validateRoute(req.rightRoute, 'rightRoute')
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
    ...(optionalCleanString(req.sessionId, 'sessionId') !== undefined
      ? { sessionId: optionalCleanString(req.sessionId, 'sessionId') }
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

const validateGraphV2GetReq = (value: unknown): MagicAgentPlatformGraphV2GetReq => {
  const req = requireRecord(value, 'graphV2')
  return { graphId: requireString(req.graphId, 'graphId'), route: validateRoute(req.route) }
}

const validateGraphV2GetPublishedReq = (
  value: unknown
): MagicAgentPlatformGraphV2GetPublishedReq => {
  const req = requireRecord(value, 'getPublishedGraphV2')
  return {
    graphId: requireString(req.graphId, 'graphId'),
    route: validateRoute(req.route),
    version: requireString(req.version, 'version')
  }
}

const validateGraphV2SaveReq = (value: unknown): MagicAgentPlatformGraphV2SaveReq => {
  const req = requireRecord(value, 'saveGraphV2')
  const validation = validateGraphDefinitionV2Draft(req.graph)
  if (!validation.valid) {
    throw issue(
      'graph',
      validation.issues.map((validationIssue) => validationIssue.message).join('; ')
    )
  }
  if (req.replace !== undefined && typeof req.replace !== 'boolean') {
    throw issue('replace', 'Expected a boolean')
  }
  return {
    graph: req.graph as GraphDefinitionV2Draft,
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

const validateRunGraphReq = (value: unknown): MagicAgentPlatformGraphRunReq => {
  const req = requireRecord(value, 'runGraph')
  const rawNodeExecution = optionalRecord(req.nodeExecution, 'nodeExecution')
  const nodeExecution: MagicAgentGraphRunRequest['nodeExecution'] = rawNodeExecution
    ? (() => {
        const mode = requireString(rawNodeExecution.mode, 'nodeExecution.mode')
        if (mode !== 'single-node' && mode !== 'run-from-node')
          throw new Error('nodeExecution.mode must be "single-node" or "run-from-node".')
        const inputs = optionalRecord(rawNodeExecution.inputs, 'nodeExecution.inputs')
        if (mode === 'single-node' && !inputs)
          throw new Error('nodeExecution.inputs is required for single-node execution.')
        const nodeId = requireString(rawNodeExecution.nodeId, 'nodeExecution.nodeId')
        if (mode === 'single-node') return { mode, nodeId, inputs: inputs! }
        const priorRunId = optionalCleanString(
          rawNodeExecution.priorRunId,
          'nodeExecution.priorRunId'
        )
        return {
          mode,
          nodeId,
          ...(inputs ? { inputs } : {}),
          ...(priorRunId ? { priorRunId } : {})
        }
      })()
    : undefined
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
    ...(nodeExecution ? { nodeExecution } : {}),
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

const validateRuntimeGraphTopologyReq = (
  value: unknown
): MagicAgentPlatformRuntimeGraphTopologyReq => {
  const req = exact(value, 'getRuntimeGraphTopology', ['runId', 'route'])
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

const validateGraphRunAttachReq = (value: unknown): MagicAgentPlatformGraphRunAttachReq => {
  const req = requireRecord(value, 'attachGraphRun')
  return {
    runId: requireString(req.runId, 'runId'),
    route: validateRoute(req.route),
    ...(req.afterEventId !== undefined
      ? { afterEventId: requireString(req.afterEventId, 'afterEventId') }
      : {})
  }
}

const validateGraphRunPublicEvent = (value: unknown): MagicAgentGraphRunPublicEvent => {
  const event = requireRecord(value, 'attachGraphRun.stream')
  return {
    eventId: requireString(event.eventId, 'eventId'),
    runId: requireString(event.runId, 'runId'),
    sequence: optionalPositiveInteger(event.sequence, 'sequence')!,
    kind: requireString(event.kind, 'kind') as MagicAgentGraphRunPublicEvent['kind'],
    timestamp: optionalPositiveInteger(event.timestamp, 'timestamp')!,
    payload: requireRecord(event.payload, 'payload')
  }
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

const validateGraphPauseReq = (value: unknown): MagicAgentPlatformGraphPauseReq => {
  const req = requireRecord(value, 'pauseGraphRun')
  return { runId: requireString(req.runId, 'runId'), route: validateRoute(req.route) }
}

const validateGraphResumeReq = (value: unknown): MagicAgentPlatformGraphResumeReq => {
  const req = requireRecord(value, 'resumeGraphRun')
  return { runId: requireString(req.runId, 'runId'), route: validateRoute(req.route) }
}

const validatePendingInputMutationReq = (
  value: unknown,
  operation: 'injectPendingInput' | 'editPendingInput' | 'cancelPendingInput'
): MagicAgentPlatformPendingInputMutationReq => {
  const req = requireRecord(value, operation)
  return {
    runId: requireString(req.runId, 'runId'),
    route: validateRoute(req.route),
    pendingInputId: requireString(req.pendingInputId, 'pendingInputId'),
    expectedRevision: requireNonNegativeInteger(req.expectedRevision, 'expectedRevision'),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey')
  }
}

const validateInjectPendingInputReq = (value: unknown): MagicAgentPlatformInjectPendingInputReq => {
  const req = requireRecord(value, 'injectPendingInput')
  return {
    ...validatePendingInputMutationReq(req, 'injectPendingInput'),
    value: requireString(req.value, 'value')
  }
}

const validateEditPendingInputReq = (value: unknown): MagicAgentPlatformEditPendingInputReq => {
  const req = requireRecord(value, 'editPendingInput')
  return {
    ...validatePendingInputMutationReq(req, 'editPendingInput'),
    value: requireString(req.value, 'value')
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

const validateRetryDriveDeliveryReq = (value: unknown): MagicAgentPlatformRetryDriveDeliveryReq => {
  const req = requireRecord(value, 'retryDelivery request')
  const fields = new Set(['driveId', 'expectedRevision', 'retryAt', 'idempotencyKey'])
  for (const field of Object.keys(req))
    if (!fields.has(field)) throw issue(field, 'Unexpected field')
  return {
    driveId: requireString(req.driveId, 'retryDelivery driveId'),
    expectedRevision: requireNonNegativeInteger(
      req.expectedRevision,
      'retryDelivery expectedRevision'
    ),
    retryAt: requireFiniteNumber(req.retryAt, 'retryDelivery retryAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'retryDelivery idempotencyKey')
  }
}

const validateAgentInstanceLimits = (value: unknown): MagicAgentInstanceLimits => {
  const limits = requireRecord(value, 'agentInstance.limits')
  const fields = new Set([
    'maxChildren',
    'maxDepth',
    'maxConcurrency',
    'maxRuntimeMs',
    'allowedToolNames',
    'workspaceRoots'
  ])
  for (const field of Object.keys(limits))
    if (!fields.has(field)) throw issue(`limits.${field}`, 'Unexpected field')
  return {
    maxChildren: requireNonNegativeInteger(limits.maxChildren, 'limits.maxChildren'),
    maxDepth: requireNonNegativeInteger(limits.maxDepth, 'limits.maxDepth'),
    maxConcurrency: requireNonNegativeInteger(limits.maxConcurrency, 'limits.maxConcurrency'),
    maxRuntimeMs: requireNonNegativeInteger(limits.maxRuntimeMs, 'limits.maxRuntimeMs'),
    allowedToolNames: requireArray(limits.allowedToolNames, 'limits.allowedToolNames').map(
      (item, index) => requireString(item, `limits.allowedToolNames[${index}]`)
    ),
    workspaceRoots: requireArray(limits.workspaceRoots, 'limits.workspaceRoots').map(
      (item, index) => requireString(item, `limits.workspaceRoots[${index}]`)
    )
  }
}
const validateAgentInstanceState = (value: unknown): MagicAgentInstanceState => {
  const state = requireRecord(value, 'agentInstance')
  const fields = new Set([
    'id',
    'name',
    'definitionId',
    'ownerId',
    'parentInstanceId',
    'depth',
    'configVersion',
    'status',
    'limits'
  ])
  for (const field of Object.keys(state))
    if (!fields.has(field)) throw issue(`instance.${field}`, 'Unexpected field')
  const status = requireString(state.status, 'instance.status')
  if (!['created', 'running', 'paused', 'stopped', 'removed'].includes(status))
    throw issue('instance.status', 'Invalid status')
  return {
    id: requireString(state.id, 'instance.id'),
    name: requireString(state.name, 'instance.name'),
    definitionId: requireString(state.definitionId, 'instance.definitionId'),
    ...(state.ownerId === undefined
      ? {}
      : { ownerId: requireString(state.ownerId, 'instance.ownerId') }),
    ...(state.parentInstanceId === undefined
      ? {}
      : { parentInstanceId: requireString(state.parentInstanceId, 'instance.parentInstanceId') }),
    depth: requireNonNegativeInteger(state.depth, 'instance.depth'),
    configVersion: requireString(state.configVersion, 'instance.configVersion'),
    status: status as MagicAgentInstanceState['status'],
    limits: validateAgentInstanceLimits(state.limits)
  }
}
const validateActor = (value: unknown): PolicyActorRef => {
  const actor = requireRecord(value, 'actor')
  const fields = new Set(['kind', 'id', 'parentId', 'sessionId', 'scopes'])
  for (const field of Object.keys(actor))
    if (!fields.has(field)) throw issue(`actor.${field}`, 'Unexpected field')
  return {
    kind: requireString(actor.kind, 'actor.kind'),
    id: requireString(actor.id, 'actor.id'),
    ...(actor.parentId === undefined
      ? {}
      : { parentId: requireString(actor.parentId, 'actor.parentId') }),
    ...(actor.sessionId === undefined
      ? {}
      : { sessionId: requireString(actor.sessionId, 'actor.sessionId') }),
    ...(actor.scopes === undefined
      ? {}
      : {
          scopes: requireArray(actor.scopes, 'actor.scopes').map((item, index) =>
            requireString(item, `actor.scopes[${index}]`)
          )
        })
  }
}
const exact = (value: unknown, label: string, fields: readonly string[]) => {
  const req = requireRecord(value, label)
  for (const field of Object.keys(req))
    if (!fields.includes(field)) throw issue(field, 'Unexpected field')
  return req
}

const validateGrantOptions = (data: Record<string, unknown>) => ({
  ...(data.grantId === undefined ? {} : { grantId: requireString(data.grantId, 'grantId') }),
  ...(data.expectedGrantUseCount === undefined
    ? {}
    : {
        expectedGrantUseCount: requireNonNegativeInteger(
          data.expectedGrantUseCount,
          'expectedGrantUseCount'
        )
      })
})

const validateGetAgentInstanceReq = (value: unknown): MagicAgentPlatformGetAgentInstanceReq => ({
  instanceId: requireString(
    exact(value, 'getAgentInstance', ['instanceId']).instanceId,
    'instanceId'
  )
})
const validateCreateRuntimeChannelReq = (
  value: unknown
): MagicAgentPlatformCreateRuntimeChannelReq => {
  const data = exact(value, 'createRuntimeChannel', [
    'channel',
    'createdAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const channel = exact(data.channel, 'createRuntimeChannel.channel', [
    'id',
    'name',
    'mode',
    'capacity'
  ])
  const mode = requireString(channel.mode, 'channel.mode')
  if (mode !== 'point-to-point' && mode !== 'queue' && mode !== 'broadcast')
    throw new Error('channel.mode is invalid.')
  return {
    channel: {
      id: requireString(channel.id, 'channel.id'),
      name: requireString(channel.name, 'channel.name'),
      mode,
      capacity: requireNonNegativeInteger(channel.capacity, 'channel.capacity')
    },
    createdAt: requireFiniteNumber(data.createdAt, 'createdAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateJoinRuntimeChannelReq = (value: unknown): MagicAgentPlatformJoinRuntimeChannelReq => {
  const data = exact(value, 'joinRuntimeChannel', [
    'channelId',
    'expectedRevision',
    'member',
    'joinedAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const member = exact(data.member, 'member', ['memberId', 'agentInstanceId', 'role', 'joinedAt'])
  const role = requireString(member.role, 'member.role')
  if (!['consumer', 'producer', 'producer-consumer'].includes(role))
    throw issue('member.role', 'Expected a Runtime Channel member role')
  return {
    channelId: requireString(data.channelId, 'channelId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    member: {
      memberId: requireString(member.memberId, 'member.memberId'),
      agentInstanceId: requireString(member.agentInstanceId, 'member.agentInstanceId'),
      role: role as RuntimeChannelMemberRole,
      joinedAt: requireFiniteNumber(member.joinedAt, 'member.joinedAt')
    },
    joinedAt: requireFiniteNumber(data.joinedAt, 'joinedAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateLeaveRuntimeChannelReq = (
  value: unknown
): MagicAgentPlatformLeaveRuntimeChannelReq => {
  const data = exact(value, 'leaveRuntimeChannel', [
    'channelId',
    'expectedRevision',
    'memberId',
    'leftAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    channelId: requireString(data.channelId, 'channelId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    memberId: requireString(data.memberId, 'memberId'),
    leftAt: requireFiniteNumber(data.leftAt, 'leftAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateWireRuntimeChannelReq = (value: unknown): MagicAgentPlatformWireRuntimeChannelReq => {
  const data = exact(value, 'wireRuntimeChannel', [
    'wire',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const wire = exact(data.wire, 'wire', [
    'id',
    'sourceChannelId',
    'targetChannelId',
    'targetPublisherMemberId',
    'enabled',
    'createdAt',
    'maxHops'
  ])
  return {
    wire: {
      id: requireString(wire.id, 'wire.id'),
      sourceChannelId: requireString(wire.sourceChannelId, 'wire.sourceChannelId'),
      targetChannelId: requireString(wire.targetChannelId, 'wire.targetChannelId'),
      targetPublisherMemberId: requireString(
        wire.targetPublisherMemberId,
        'wire.targetPublisherMemberId'
      ),
      enabled: requireBoolean(wire.enabled, 'wire.enabled'),
      createdAt: requireFiniteNumber(wire.createdAt, 'wire.createdAt'),
      maxHops: requireNonNegativeInteger(wire.maxHops, 'wire.maxHops')
    },
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateUnwireRuntimeChannelReq = (
  value: unknown
): MagicAgentPlatformUnwireRuntimeChannelReq => {
  const data = exact(value, 'unwireRuntimeChannel', [
    'wireId',
    'expectedRevision',
    'removedAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    wireId: requireString(data.wireId, 'wireId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    removedAt: requireFiniteNumber(data.removedAt, 'removedAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateGetRuntimeChannelWireReq = (
  value: unknown
): MagicAgentPlatformGetRuntimeChannelWireReq => {
  const data = exact(value, 'getRuntimeChannelWire', ['wireId'])
  return { wireId: requireString(data.wireId, 'wireId') }
}

const validatePublishRuntimeChannelMessageReq = (
  value: unknown
): MagicAgentPlatformPublishRuntimeChannelMessageReq => {
  const data = exact(value, 'publishRuntimeChannelMessage', [
    'message',
    'expectedChannelRevision',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const message = exact(data.message, 'publishRuntimeChannelMessage.message', [
    'id',
    'channelId',
    'publisherMemberId',
    'payload',
    'priority',
    'publishedAt',
    'expiresAt'
  ])
  return {
    message: {
      id: requireString(message.id, 'message.id'),
      channelId: requireString(message.channelId, 'message.channelId'),
      publisherMemberId: requireString(message.publisherMemberId, 'message.publisherMemberId'),
      payload: message.payload as PolicyJsonValue,
      priority: requireFiniteNumber(message.priority, 'message.priority'),
      publishedAt: requireFiniteNumber(message.publishedAt, 'message.publishedAt'),
      ...(message.expiresAt === undefined
        ? {}
        : { expiresAt: requireFiniteNumber(message.expiresAt, 'message.expiresAt') })
    },
    expectedChannelRevision: requireNonNegativeInteger(
      data.expectedChannelRevision,
      'expectedChannelRevision'
    ),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateClaimRuntimeChannelMessageReq = (
  value: unknown
): MagicAgentPlatformClaimRuntimeChannelMessageReq => {
  const data = exact(value, 'claimRuntimeChannelMessage', [
    'messageId',
    'expectedRevision',
    'consumerMemberId',
    'claimedAt',
    'leaseMs',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    messageId: requireString(data.messageId, 'messageId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    consumerMemberId: requireString(data.consumerMemberId, 'consumerMemberId'),
    claimedAt: requireFiniteNumber(data.claimedAt, 'claimedAt'),
    leaseMs: requireFiniteNumber(data.leaseMs, 'leaseMs'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateAcknowledgeRuntimeChannelMessageReq = (
  value: unknown
): MagicAgentPlatformAcknowledgeRuntimeChannelMessageReq => {
  const data = exact(value, 'acknowledgeRuntimeChannelMessage', [
    'messageId',
    'expectedRevision',
    'consumerMemberId',
    'acknowledgedAt',
    'token',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    messageId: requireString(data.messageId, 'messageId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    consumerMemberId: requireString(data.consumerMemberId, 'consumerMemberId'),
    acknowledgedAt: requireFiniteNumber(data.acknowledgedAt, 'acknowledgedAt'),
    token: requireString(data.token, 'token'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateGetRuntimeChannelReq = (value: unknown): MagicAgentPlatformGetRuntimeChannelReq => ({
  channelId: requireString(exact(value, 'getRuntimeChannel', ['channelId']).channelId, 'channelId')
})
const validateCreateTeamReq = (value: unknown): MagicAgentPlatformCreateTeamReq => {
  const data = exact(value, 'createTeam', [
    'team',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const team = exact(data.team, 'team', ['id', 'name', 'createdAt'])
  return {
    team: {
      id: requireString(team.id, 'team.id'),
      name: requireString(team.name, 'team.name'),
      createdAt: requireFiniteNumber(team.createdAt, 'team.createdAt')
    },
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateAddTeamMemberReq = (value: unknown): MagicAgentPlatformAddTeamMemberReq => {
  const data = exact(value, 'addTeamMember', [
    'teamId',
    'expectedRevision',
    'member',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const member = exact(data.member, 'member', ['memberId', 'agentInstanceId', 'role', 'joinedAt'])
  const role = requireString(member.role, 'member.role')
  if (role !== 'leader' && role !== 'member') throw new Error('member.role is invalid.')
  return {
    teamId: requireString(data.teamId, 'teamId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    member: {
      memberId: requireString(member.memberId, 'member.memberId'),
      agentInstanceId: requireString(member.agentInstanceId, 'member.agentInstanceId'),
      role,
      joinedAt: requireFiniteNumber(member.joinedAt, 'member.joinedAt')
    },
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateReplaceTeamReq = (value: unknown): MagicAgentPlatformReplaceTeamReq => {
  const data = exact(value, 'replaceTeam', [
    'teamId',
    'expectedRevision',
    'replacements',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  if (!Array.isArray(data.replacements)) throw new Error('replacements must be an array.')
  return {
    teamId: requireString(data.teamId, 'teamId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    replacements: data.replacements.map((value, index) => {
      const item = exact(value, `replacements[${index}]`, [
        'memberId',
        'definitionId',
        'name',
        'configVersion',
        'replacedAt'
      ])
      return {
        memberId: requireString(item.memberId, `replacements[${index}].memberId`),
        definitionId: requireString(item.definitionId, `replacements[${index}].definitionId`),
        name: requireString(item.name, `replacements[${index}].name`),
        configVersion: requireString(item.configVersion, `replacements[${index}].configVersion`),
        replacedAt: requireFiniteNumber(item.replacedAt, `replacements[${index}].replacedAt`)
      }
    }),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateTeamLifecycleReq = (value: unknown): MagicAgentPlatformTeamLifecycleReq => {
  const data = exact(value, 'teamLifecycle', ['teamId', 'expectedRevision', 'idempotencyKey'])
  return {
    teamId: requireString(data.teamId, 'teamId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey')
  }
}
const validateStartTeamReq = (value: unknown): MagicAgentPlatformStartTeamReq => {
  const data = exact(value, 'startTeam', [
    'teamId',
    'expectedRevision',
    'request',
    'idempotencyKey'
  ])
  return {
    teamId: requireString(data.teamId, 'teamId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    request: validateRunAgentReq(data.request),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey')
  }
}
const validateRemoveTeamReq = (value: unknown): MagicAgentPlatformRemoveTeamReq => {
  const data = exact(value, 'removeTeam', [
    'teamId',
    'expectedRevision',
    'removedAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    teamId: requireString(data.teamId, 'teamId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    removedAt: requireFiniteNumber(data.removedAt, 'removedAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateRemoveTeamMemberReq = (value: unknown): MagicAgentPlatformRemoveTeamMemberReq => {
  const data = exact(value, 'removeTeamMember', [
    'teamId',
    'expectedRevision',
    'memberId',
    'removedAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    teamId: requireString(data.teamId, 'teamId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    memberId: requireString(data.memberId, 'memberId'),
    removedAt: requireFiniteNumber(data.removedAt, 'removedAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateCreateRootAgentInstanceReq = (
  value: unknown
): MagicAgentPlatformCreateRootAgentInstanceReq => {
  const req = exact(value, 'createRootAgentInstance', [
    'instance',
    'createdAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    instance: validateAgentInstanceState(req.instance),
    createdAt: requireFiniteNumber(req.createdAt, 'createdAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(req)
  }
}
const validateCreateChildAgentInstanceReq = (
  value: unknown
): MagicAgentPlatformCreateChildAgentInstanceReq => {
  const req = exact(value, 'createChildAgentInstance', [
    'parentInstanceId',
    'parentExpectedRevision',
    'instance',
    'createdAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const instance = validateAgentInstanceState({
    ...requireRecord(req.instance, 'instance'),
    depth: 0,
    status: 'created'
  })
  const { parentInstanceId: _parent, depth: _depth, status: _status, ...child } = instance
  return {
    parentInstanceId: requireString(req.parentInstanceId, 'parentInstanceId'),
    parentExpectedRevision: requireNonNegativeInteger(
      req.parentExpectedRevision,
      'parentExpectedRevision'
    ),
    instance: child,
    createdAt: requireFiniteNumber(req.createdAt, 'createdAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(req)
  }
}
const validateStartAgentInstanceReq = (value: unknown): MagicAgentPlatformStartAgentInstanceReq => {
  const req = exact(value, 'startAgentInstance', [
    'instanceId',
    'expectedRevision',
    'request',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    instanceId: requireString(req.instanceId, 'instanceId'),
    expectedRevision: requireNonNegativeInteger(req.expectedRevision, 'expectedRevision'),
    request: validateRunAgentReq(req.request),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(req)
  }
}
const configReq = (
  value: unknown,
  name: string,
  timeField: 'stagedAt' | 'activatedAt' | 'rolledBackAt',
  includeVersion: boolean
) => {
  const fields = [
    'instanceId',
    'expectedRevision',
    timeField,
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount',
    ...(includeVersion ? ['configVersion'] : [])
  ]
  const data = exact(value, name, fields)
  return {
    instanceId: requireString(data.instanceId, 'instanceId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    [timeField]: requireFiniteNumber(data[timeField], timeField),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...(includeVersion
      ? { configVersion: requireString(data.configVersion, 'configVersion') }
      : {}),
    ...validateGrantOptions(data)
  }
}
const validateCreateAgentConfigVersionReq = (
  value: unknown
): MagicAgentPlatformCreateAgentConfigVersionReq => {
  const data = exact(value, 'createAgentConfigVersion', [
    'config',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  const config = exact(data.config, 'config', [
    'version',
    'definitionId',
    'model',
    'systemPrompt',
    'inference',
    'tools',
    'memory',
    'policy',
    'channels',
    'budgets',
    'createdAt'
  ])
  const model = exact(config.model, 'config.model', ['profileId'])
  const inference = exact(config.inference, 'config.inference', [
    'temperature',
    'maxTokens',
    'maxToolIterations'
  ])
  const tools = exact(config.tools, 'config.tools', ['allowedToolNames'])
  const memory = exact(config.memory, 'config.memory', [
    'allowHistory',
    'contextMessageLimit',
    'scope'
  ])
  const policy = exact(config.policy, 'config.policy', ['policyIds', 'workspaceRoots'])
  const channels = exact(config.channels, 'config.channels', ['channelIds'])
  const budgets = exact(config.budgets, 'config.budgets', [
    'maxRuntimeMs',
    'maxTurns',
    'maxTokens',
    'maxToolCalls'
  ])
  const strings = (items: unknown, field: string) => {
    if (!Array.isArray(items)) throw new Error(`${field} must be an array.`)
    return items.map((item, index) => requireString(item, `${field}[${index}]`))
  }
  const optionalInteger = (item: unknown, field: string) =>
    item === undefined ? undefined : requireNonNegativeInteger(item, field)
  const scope = requireString(memory.scope, 'config.memory.scope')
  if (!['instance', 'session', 'workspace'].includes(scope))
    throw new Error('config.memory.scope is invalid.')
  return {
    config: {
      version: requireString(config.version, 'config.version'),
      definitionId: requireString(config.definitionId, 'config.definitionId'),
      model: { profileId: requireString(model.profileId, 'config.model.profileId') },
      systemPrompt: requireString(config.systemPrompt, 'config.systemPrompt'),
      inference: {
        ...(inference.temperature === undefined
          ? {}
          : {
              temperature: requireFiniteNumber(
                inference.temperature,
                'config.inference.temperature'
              )
            }),
        ...(inference.maxTokens === undefined
          ? {}
          : { maxTokens: optionalInteger(inference.maxTokens, 'config.inference.maxTokens')! }),
        ...(inference.maxToolIterations === undefined
          ? {}
          : {
              maxToolIterations: optionalInteger(
                inference.maxToolIterations,
                'config.inference.maxToolIterations'
              )!
            })
      },
      tools: { allowedToolNames: strings(tools.allowedToolNames, 'config.tools.allowedToolNames') },
      memory: {
        allowHistory: requireBoolean(memory.allowHistory, 'config.memory.allowHistory'),
        contextMessageLimit: requireNonNegativeInteger(
          memory.contextMessageLimit,
          'config.memory.contextMessageLimit'
        ),
        scope: scope as 'instance' | 'session' | 'workspace'
      },
      policy: {
        policyIds: strings(policy.policyIds, 'config.policy.policyIds'),
        workspaceRoots: strings(policy.workspaceRoots, 'config.policy.workspaceRoots')
      },
      channels: { channelIds: strings(channels.channelIds, 'config.channels.channelIds') },
      budgets: {
        maxRuntimeMs: requireNonNegativeInteger(
          budgets.maxRuntimeMs,
          'config.budgets.maxRuntimeMs'
        ),
        ...(budgets.maxTurns === undefined
          ? {}
          : { maxTurns: optionalInteger(budgets.maxTurns, 'config.budgets.maxTurns')! }),
        ...(budgets.maxTokens === undefined
          ? {}
          : { maxTokens: optionalInteger(budgets.maxTokens, 'config.budgets.maxTokens')! }),
        ...(budgets.maxToolCalls === undefined
          ? {}
          : { maxToolCalls: optionalInteger(budgets.maxToolCalls, 'config.budgets.maxToolCalls')! })
      },
      createdAt: requireFiniteNumber(config.createdAt, 'config.createdAt')
    },
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}

const validateStageAgentConfigReq = (value: unknown) =>
  configReq(value, 'stageAgentConfig', 'stagedAt', true) as MagicAgentPlatformStageAgentConfigReq
const validateActivateAgentConfigReq = (value: unknown) =>
  configReq(
    value,
    'activateAgentConfig',
    'activatedAt',
    false
  ) as MagicAgentPlatformActivateAgentConfigReq
const validateRollbackAgentConfigReq = (value: unknown) =>
  configReq(
    value,
    'rollbackAgentConfig',
    'rolledBackAt',
    false
  ) as MagicAgentPlatformRollbackAgentConfigReq

const validatePauseAgentInstanceReq = (value: unknown): MagicAgentPlatformPauseAgentInstanceReq => {
  const data = exact(value, 'pauseAgentInstance', [
    'instanceId',
    'expectedRevision',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    instanceId: requireString(data.instanceId, 'instanceId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateResumeAgentInstanceReq = (value: unknown): MagicAgentPlatformResumeAgentInstanceReq =>
  validatePauseAgentInstanceReq(value)

const validateStopAgentInstanceReq = (value: unknown): MagicAgentPlatformStopAgentInstanceReq => {
  const req = exact(value, 'stopAgentInstance', [
    'instanceId',
    'expectedRevision',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    instanceId: requireString(req.instanceId, 'instanceId'),
    expectedRevision: requireNonNegativeInteger(req.expectedRevision, 'expectedRevision'),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
    ...(req.grantId === undefined ? {} : { grantId: requireString(req.grantId, 'grantId') }),
    ...(req.expectedGrantUseCount === undefined
      ? {}
      : {
          expectedGrantUseCount: requireNonNegativeInteger(
            req.expectedGrantUseCount,
            'expectedGrantUseCount'
          )
        })
  }
}
const validateReplaceAgentInstanceReq = (
  value: unknown
): MagicAgentPlatformReplaceAgentInstanceReq => {
  const data = exact(value, 'replaceAgentInstance', [
    'instanceId',
    'expectedRevision',
    'definitionId',
    'name',
    'configVersion',
    'replacedAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    instanceId: requireString(data.instanceId, 'instanceId'),
    expectedRevision: requireNonNegativeInteger(data.expectedRevision, 'expectedRevision'),
    definitionId: requireString(data.definitionId, 'definitionId'),
    name: requireString(data.name, 'name'),
    configVersion: requireString(data.configVersion, 'configVersion'),
    replacedAt: requireFiniteNumber(data.replacedAt, 'replacedAt'),
    idempotencyKey: requireString(data.idempotencyKey, 'idempotencyKey'),
    ...validateGrantOptions(data)
  }
}
const validateRemoveAgentInstanceReq = (
  value: unknown
): MagicAgentPlatformRemoveAgentInstanceReq => {
  const req = exact(value, 'removeAgentInstance', [
    'instanceId',
    'expectedRevision',
    'removedAt',
    'idempotencyKey',
    'grantId',
    'expectedGrantUseCount'
  ])
  return {
    instanceId: requireString(req.instanceId, 'instanceId'),
    expectedRevision: requireNonNegativeInteger(req.expectedRevision, 'expectedRevision'),
    removedAt: requireFiniteNumber(req.removedAt, 'removedAt'),
    idempotencyKey: requireString(req.idempotencyKey, 'idempotencyKey'),
    ...(req.grantId === undefined ? {} : { grantId: requireString(req.grantId, 'grantId') }),
    ...(req.expectedGrantUseCount === undefined
      ? {}
      : {
          expectedGrantUseCount: requireNonNegativeInteger(
            req.expectedGrantUseCount,
            'expectedGrantUseCount'
          )
        })
  }
}

export interface MagicAgentPlatformSvc {
  searchMemory(req: SemanticMemorySearchPublicReq): Promise<SemanticMemoryPublicSearchResult>
  inspectMemory(req: SemanticMemoryInspectPublicReq): Promise<SemanticMemoryPublicInspectResult>
  deleteMemory(req: SemanticMemoryDeletePublicReq): Promise<SemanticMemoryAdminResult>
  setMemoryDisabled(req: SemanticMemorySetDisabledPublicReq): Promise<SemanticMemoryAdminResult>
  setMemoryVisibility(req: SemanticMemorySetVisibilityPublicReq): Promise<SemanticMemoryAdminResult>
  clearMemoryScope(req: SemanticMemoryClearScopePublicReq): Promise<SemanticMemoryAdminResult>
  rebuildMemory(req: SemanticMemoryRebuildPublicReq): Promise<SemanticMemoryRebuildJob>
  ingestSessionMemory(
    req: SemanticMemoryIngestSessionPublicReq
  ): Promise<SemanticMemoryIngestResult>
  ingestMemoryScope(req: SemanticMemoryIngestScopePublicReq): Promise<SemanticMemoryIngestResult>
  linkMemoryAgentSession(
    req: SemanticMemoryAgentSessionLinkPublicReq
  ): Promise<SemanticMemoryAgentSessionLink[]>
  unlinkMemoryAgentSession(
    req: SemanticMemoryAgentSessionLinkPublicReq
  ): Promise<SemanticMemoryAgentSessionLink[]>
  listMemoryAgentSessions(req: { agentId: string }): Promise<SemanticMemoryAgentSessionLink[]>
  getStatus(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformStatusResp>
  forkSessionAtEvent(
    req: MagicAgentPlatformSessionForkReq
  ): Promise<MagicAgentPlatformSessionForkResp>
  exportSession(
    req: MagicAgentPlatformSessionExportReq
  ): Promise<MagicAgentPlatformSessionExportResp>
  diffSessions(req: MagicAgentPlatformSessionDiffReq): Promise<MagicAgentPlatformSessionDiffResp>
  listPendingApprovals(
    req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListPendingApprovalsResp>
  watchPendingApprovals(
    req: MagicAgentPlatformEmptyReq,
    stream: ServerStreaming<MagicAgentPlatformPendingApprovalStreamEvent>
  ): Promise<void>
  resolvePendingApproval(
    req: MagicAgentPlatformResolvePendingApprovalReq
  ): Promise<MagicAgentPlatformResolvePendingApprovalResp>
  listAgents(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformListAgentsResp>
  registerAgent(
    req: MagicAgentPlatformRegisterAgentReq
  ): Promise<MagicAgentPlatformRegisterAgentResp>
  runAgent(req: MagicAgentPlatformRunReq): Promise<MagicAgentPlatformRunResp>
  listTools(req: MagicAgentPlatformListToolsReq): Promise<MagicAgentPlatformListToolsResp>
  callTool(req: MagicAgentPlatformToolCallReq): Promise<MagicAgentPlatformToolCallResp>
  listTeams(): Promise<readonly MagicAgentPlatformTeamResource[]>
  listAgentInstances(
    req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListAgentInstancesResp>
  getAgentInstance(
    req: MagicAgentPlatformGetAgentInstanceReq
  ): Promise<MagicAgentPlatformGetAgentInstanceResp>
  listRuntimeChannels(
    req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListRuntimeChannelsResp>
  getRuntimeChannel(
    req: MagicAgentPlatformGetRuntimeChannelReq
  ): Promise<MagicAgentPlatformGetRuntimeChannelResp>
  createRuntimeChannel(
    req: MagicAgentPlatformCreateRuntimeChannelReq
  ): Promise<MagicAgentPlatformRuntimeChannelMutationResp>
  joinRuntimeChannel(
    req: MagicAgentPlatformJoinRuntimeChannelReq
  ): Promise<MagicAgentPlatformRuntimeChannelMutationResp>
  leaveRuntimeChannel(
    req: MagicAgentPlatformLeaveRuntimeChannelReq
  ): Promise<MagicAgentPlatformRuntimeChannelMutationResp>
  listRuntimeChannelWires(
    req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListRuntimeChannelWiresResp>
  getRuntimeChannelWire(
    req: MagicAgentPlatformGetRuntimeChannelWireReq
  ): Promise<MagicAgentPlatformGetRuntimeChannelWireResp>
  wireRuntimeChannel(
    req: MagicAgentPlatformWireRuntimeChannelReq
  ): Promise<MagicAgentPlatformRuntimeChannelWireMutationResp>
  unwireRuntimeChannel(
    req: MagicAgentPlatformUnwireRuntimeChannelReq
  ): Promise<MagicAgentPlatformRuntimeChannelWireMutationResp>
  publishRuntimeChannelMessage(
    req: MagicAgentPlatformPublishRuntimeChannelMessageReq
  ): Promise<MagicAgentPlatformPublishRuntimeChannelMessageResp>
  claimRuntimeChannelMessage(
    req: MagicAgentPlatformClaimRuntimeChannelMessageReq
  ): Promise<MagicAgentPlatformRuntimeChannelDeliveryResp>
  acknowledgeRuntimeChannelMessage(
    req: MagicAgentPlatformAcknowledgeRuntimeChannelMessageReq
  ): Promise<MagicAgentPlatformRuntimeChannelDeliveryResp>
  createTeam(req: MagicAgentPlatformCreateTeamReq): Promise<MagicAgentPlatformTeamResource>
  addTeamMember(req: MagicAgentPlatformAddTeamMemberReq): Promise<MagicAgentPlatformTeamResource>
  removeTeam(req: MagicAgentPlatformRemoveTeamReq): Promise<MagicAgentPlatformTeamResource>
  removeTeamMember(
    req: MagicAgentPlatformRemoveTeamMemberReq
  ): Promise<MagicAgentPlatformTeamResource>
  replaceTeam(req: MagicAgentPlatformReplaceTeamReq): Promise<MagicAgentPlatformTeamLifecycleResp>
  startTeam(req: MagicAgentPlatformStartTeamReq): Promise<MagicAgentPlatformTeamLifecycleResp>
  pauseTeam(req: MagicAgentPlatformTeamLifecycleReq): Promise<MagicAgentPlatformTeamLifecycleResp>
  resumeTeam(req: MagicAgentPlatformTeamLifecycleReq): Promise<MagicAgentPlatformTeamLifecycleResp>
  stopTeam(req: MagicAgentPlatformTeamLifecycleReq): Promise<MagicAgentPlatformTeamLifecycleResp>
  createRootAgentInstance(
    req: MagicAgentPlatformCreateRootAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  createChildAgentInstance(
    req: MagicAgentPlatformCreateChildAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  createAgentConfigVersion(
    req: MagicAgentPlatformCreateAgentConfigVersionReq
  ): Promise<MagicAgentPlatformAgentConfigVersionResp>
  stageAgentConfig(
    req: MagicAgentPlatformStageAgentConfigReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  activateAgentConfig(
    req: MagicAgentPlatformActivateAgentConfigReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  rollbackAgentConfig(
    req: MagicAgentPlatformRollbackAgentConfigReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  startAgentInstance(
    req: MagicAgentPlatformStartAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  pauseAgentInstance(
    req: MagicAgentPlatformPauseAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  resumeAgentInstance(
    req: MagicAgentPlatformResumeAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  stopAgentInstance(
    req: MagicAgentPlatformStopAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  replaceAgentInstance(
    req: MagicAgentPlatformReplaceAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceResource>
  removeAgentInstance(
    req: MagicAgentPlatformRemoveAgentInstanceReq
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp>
  listDrives(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformListDrivesResp>
  getDrive(req: MagicAgentPlatformGetDriveReq): Promise<MagicAgentPlatformGetDriveResp>
  createDrive(req: MagicAgentPlatformCreateDriveReq): Promise<MagicAgentPlatformDriveMutationResp>
  transitionDrive(
    req: MagicAgentPlatformTransitionDriveReq
  ): Promise<MagicAgentPlatformDriveMutationResp>
  reportDriveProgress(
    req: MagicAgentPlatformReportDriveProgressReq
  ): Promise<MagicAgentPlatformDriveMutationResp>
  retryDelivery(
    req: MagicAgentPlatformRetryDriveDeliveryReq
  ): Promise<MagicAgentPlatformDriveMutationResp>
  transferDrive(
    req: MagicAgentPlatformTransferDriveReq
  ): Promise<MagicAgentPlatformDriveMutationResp>
  setDriveLinks(
    req: MagicAgentPlatformSetDriveLinksReq
  ): Promise<MagicAgentPlatformDriveMutationResp>
  listTriggers(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformListTriggersResp>
  createTrigger(
    req: MagicAgentPlatformCreateTriggerReq
  ): Promise<MagicAgentPlatformCreateTriggerResp>
  updateTrigger(
    req: MagicAgentPlatformUpdateTriggerReq
  ): Promise<MagicAgentPlatformTriggerMutationResp>
  enableTrigger(
    req: MagicAgentPlatformTriggerControlReq
  ): Promise<MagicAgentPlatformTriggerMutationResp>
  disableTrigger(
    req: MagicAgentPlatformTriggerControlReq
  ): Promise<MagicAgentPlatformTriggerMutationResp>
  pauseTrigger(
    req: MagicAgentPlatformTriggerControlReq
  ): Promise<MagicAgentPlatformTriggerMutationResp>
  resumeTrigger(
    req: MagicAgentPlatformTriggerControlReq
  ): Promise<MagicAgentPlatformTriggerMutationResp>
  retryTrigger(
    req: MagicAgentPlatformTriggerControlReq
  ): Promise<MagicAgentPlatformTriggerMutationResp>
  manualFireTrigger(
    req: MagicAgentPlatformManualFireTriggerReq
  ): Promise<MagicAgentPlatformManualFireTriggerResp>
  getTrigger(req: MagicAgentPlatformGetTriggerReq): Promise<MagicAgentPlatformGetTriggerResp>
  listGraphs(req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformGraphListResp>
  listGraphCatalog(
    req: MagicAgentPlatformGraphCatalogListReq
  ): Promise<MagicAgentPlatformGraphListResp>
  createGraph(req: MagicAgentGraphCreateRequest): Promise<MagicAgentPlatformGraphCreateResp>
  saveGraphV2(req: MagicAgentPlatformGraphV2SaveReq): Promise<MagicAgentPlatformGraphV2SaveResp>
  getGraphV2(req: MagicAgentPlatformGraphV2GetReq): Promise<MagicAgentPlatformGraphV2GetResp>
  publishGraphV2(
    req: MagicAgentPlatformGraphV2PublishReq
  ): Promise<MagicAgentPlatformGraphV2PublishResp>
  getPublishedGraphV2(
    req: MagicAgentPlatformGraphV2GetPublishedReq
  ): Promise<MagicAgentPlatformGraphV2GetPublishedResp>
  listPublishedGraphsV2(
    req: MagicAgentPlatformGraphV2GetReq
  ): Promise<MagicAgentPlatformGraphV2ListPublishedResp>
  listGraphV2NodeRegistry(
    req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformGraphV2NodeRegistryResp>
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
  runGraph(req: MagicAgentPlatformGraphRunReq): Promise<MagicAgentGraphRunResult>
  listGraphRuns(req: MagicAgentPlatformGraphRunListReq): Promise<MagicAgentPlatformGraphRunListResp>
  getGraphRun(req: MagicAgentPlatformGraphRunGetReq): Promise<MagicAgentPlatformGraphRunGetResp>
  getRuntimeGraphTopology(
    req: MagicAgentPlatformRuntimeGraphTopologyReq
  ): Promise<MagicAgentPlatformRuntimeGraphTopologyResp>
  listGraphRunEvents(
    req: MagicAgentPlatformGraphRunEventListReq
  ): Promise<MagicAgentPlatformGraphRunEventListResp>
  attachGraphRun(
    req: MagicAgentPlatformGraphRunAttachReq,
    resp: ServerStreaming<MagicAgentGraphRunPublicEvent>
  ): Promise<void>
  watchGraphRun(
    req: MagicAgentPlatformGraphRunWatchReq,
    resp: ServerStreaming<MagicAgentGraphRunStreamEvent>
  ): Promise<void>
  cancelGraphRun(req: MagicAgentPlatformGraphCancelReq): Promise<MagicAgentGraphCancelResult>
  pauseGraphRun(req: MagicAgentPlatformGraphPauseReq): Promise<MagicAgentGraphPauseResult>
  resumeGraphRun(req: MagicAgentPlatformGraphResumeReq): Promise<MagicAgentGraphResumeResult>
  injectPendingInput(
    req: MagicAgentPlatformInjectPendingInputReq
  ): Promise<MagicAgentPlatformPendingInputMutationResp>
  editPendingInput(
    req: MagicAgentPlatformEditPendingInputReq
  ): Promise<MagicAgentPlatformPendingInputMutationResp>
  cancelPendingInput(
    req: MagicAgentPlatformPendingInputMutationReq
  ): Promise<MagicAgentPlatformPendingInputMutationResp>
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

const validateResolvePendingApprovalReq = (
  value: unknown
): MagicAgentPlatformResolvePendingApprovalReq => {
  const req = requireRecord(value, 'resolvePendingApproval')
  const approvalId = requireString(req.approvalId, 'resolvePendingApproval.approvalId')
  const expectedRevision = req.expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
    throw new ServiceValidationError(
      'resolvePendingApproval.expectedRevision must be a non-negative integer.'
    )
  if (typeof req.approved !== 'boolean')
    throw new ServiceValidationError('resolvePendingApproval.approved must be a boolean.')
  return { approvalId, expectedRevision: Number(expectedRevision), approved: req.approved }
}

const validateMemoryReq = (value: unknown): any => {
  const req = requireRecord(value, 'memory request')
  if ('actor' in req) throw issue('actor', 'Actor is derived from authenticated credentials')
  return req
}

export const magicAgentPlatformSvcDef: ServiceDefSheet<MagicAgentPlatformSvc> = {
  searchMemory: { type: 'unary', request: validateMemoryReq },
  inspectMemory: { type: 'unary', request: validateMemoryReq },
  deleteMemory: { type: 'unary', request: validateMemoryReq },
  setMemoryDisabled: { type: 'unary', request: validateMemoryReq },
  setMemoryVisibility: { type: 'unary', request: validateMemoryReq },
  clearMemoryScope: { type: 'unary', request: validateMemoryReq },
  rebuildMemory: { type: 'unary', request: validateMemoryReq },
  ingestSessionMemory: { type: 'unary', request: validateMemoryReq },
  ingestMemoryScope: { type: 'unary', request: validateMemoryReq },
  linkMemoryAgentSession: { type: 'unary', request: validateMemoryReq },
  unlinkMemoryAgentSession: { type: 'unary', request: validateMemoryReq },
  listMemoryAgentSessions: { type: 'unary', request: validateMemoryReq },
  listPendingApprovals: { type: 'unary', request: validateEmptyReq },
  watchPendingApprovals: { type: 'serverStreaming', request: validateEmptyReq },
  resolvePendingApproval: { type: 'unary', request: validateResolvePendingApprovalReq },
  getStatus: { type: 'unary', request: validateEmptyReq },
  listAgents: { type: 'unary', request: validateEmptyReq },
  registerAgent: { type: 'unary', request: validateRegisterAgentReq },
  runAgent: { type: 'unary', request: validateRunAgentReq },
  listTools: { type: 'unary', request: validateListToolsReq },
  callTool: { type: 'unary', request: validateToolCallReq },
  listTeams: { type: 'unary', request: () => ({}) },
  listAgentInstances: { type: 'unary', request: validateEmptyReq },
  getAgentInstance: { type: 'unary', request: validateGetAgentInstanceReq },
  listRuntimeChannels: { type: 'unary', request: validateEmptyReq },
  getRuntimeChannel: { type: 'unary', request: validateGetRuntimeChannelReq },
  createRuntimeChannel: { type: 'unary', request: validateCreateRuntimeChannelReq },
  joinRuntimeChannel: { type: 'unary', request: validateJoinRuntimeChannelReq },
  leaveRuntimeChannel: { type: 'unary', request: validateLeaveRuntimeChannelReq },
  getRuntimeChannelWire: { type: 'unary', request: validateGetRuntimeChannelWireReq },
  listRuntimeChannelWires: { type: 'unary', request: validateEmptyReq },
  wireRuntimeChannel: { type: 'unary', request: validateWireRuntimeChannelReq },
  unwireRuntimeChannel: { type: 'unary', request: validateUnwireRuntimeChannelReq },
  publishRuntimeChannelMessage: { type: 'unary', request: validatePublishRuntimeChannelMessageReq },
  claimRuntimeChannelMessage: { type: 'unary', request: validateClaimRuntimeChannelMessageReq },
  acknowledgeRuntimeChannelMessage: {
    type: 'unary',
    request: validateAcknowledgeRuntimeChannelMessageReq
  },
  createTeam: { type: 'unary', request: validateCreateTeamReq },
  addTeamMember: { type: 'unary', request: validateAddTeamMemberReq },
  removeTeam: { type: 'unary', request: validateRemoveTeamReq },
  removeTeamMember: { type: 'unary', request: validateRemoveTeamMemberReq },
  replaceTeam: { type: 'unary', request: validateReplaceTeamReq },
  startTeam: { type: 'unary', request: validateStartTeamReq },
  pauseTeam: { type: 'unary', request: validateTeamLifecycleReq },
  resumeTeam: { type: 'unary', request: validateTeamLifecycleReq },
  stopTeam: { type: 'unary', request: validateTeamLifecycleReq },
  createRootAgentInstance: { type: 'unary', request: validateCreateRootAgentInstanceReq },
  createChildAgentInstance: { type: 'unary', request: validateCreateChildAgentInstanceReq },
  createAgentConfigVersion: { type: 'unary', request: validateCreateAgentConfigVersionReq },
  stageAgentConfig: { type: 'unary', request: validateStageAgentConfigReq },
  activateAgentConfig: { type: 'unary', request: validateActivateAgentConfigReq },
  rollbackAgentConfig: { type: 'unary', request: validateRollbackAgentConfigReq },
  startAgentInstance: { type: 'unary', request: validateStartAgentInstanceReq },
  pauseAgentInstance: { type: 'unary', request: validatePauseAgentInstanceReq },
  resumeAgentInstance: { type: 'unary', request: validateResumeAgentInstanceReq },
  stopAgentInstance: { type: 'unary', request: validateStopAgentInstanceReq },
  replaceAgentInstance: { type: 'unary', request: validateReplaceAgentInstanceReq },
  removeAgentInstance: { type: 'unary', request: validateRemoveAgentInstanceReq },
  listDrives: { type: 'unary', request: validateEmptyReq },
  getDrive: { type: 'unary', request: validateGetDriveReq },
  createDrive: { type: 'unary', request: validateCreateDriveReq },
  transitionDrive: { type: 'unary', request: validateTransitionDriveReq },
  reportDriveProgress: { type: 'unary', request: validateReportDriveProgressReq },
  retryDelivery: { type: 'unary', request: validateRetryDriveDeliveryReq },
  transferDrive: { type: 'unary', request: validateTransferDriveReq },
  setDriveLinks: { type: 'unary', request: validateSetDriveLinksReq },
  listTriggers: { type: 'unary', request: validateEmptyReq },
  createTrigger: { type: 'unary', request: validateCreateTriggerReq },
  updateTrigger: { type: 'unary', request: validateUpdateTriggerReq },
  enableTrigger: {
    type: 'unary',
    request: (value) => validateTriggerControlReq(value, 'enableTrigger')
  },
  disableTrigger: {
    type: 'unary',
    request: (value) => validateTriggerControlReq(value, 'disableTrigger')
  },
  pauseTrigger: {
    type: 'unary',
    request: (value) => validateTriggerControlReq(value, 'pauseTrigger')
  },
  resumeTrigger: {
    type: 'unary',
    request: (value) => validateTriggerControlReq(value, 'resumeTrigger')
  },
  retryTrigger: {
    type: 'unary',
    request: (value) => validateTriggerControlReq(value, 'retryTrigger')
  },
  manualFireTrigger: { type: 'unary', request: validateManualFireTriggerReq },
  getTrigger: { type: 'unary', request: validateGetTriggerReq },
  listGraphs: { type: 'unary', request: validateEmptyReq },
  listGraphCatalog: { type: 'unary', request: validateGraphCatalogListReq },
  createGraph: { type: 'unary', request: validateGraphCreateReq },
  saveGraphV2: { type: 'unary', request: validateGraphV2SaveReq },
  getGraphV2: { type: 'unary', request: validateGraphV2GetReq },
  publishGraphV2: { type: 'unary', request: validateGraphV2GetReq },
  getPublishedGraphV2: { type: 'unary', request: validateGraphV2GetPublishedReq },
  listPublishedGraphsV2: { type: 'unary', request: validateGraphV2GetReq },
  listGraphV2NodeRegistry: { type: 'unary', request: validateEmptyReq },
  saveGraph: { type: 'unary', request: validateGraphCreateReq },
  deleteGraph: { type: 'unary', request: validateGraphDeleteReq },
  forkGraph: { type: 'unary', request: validateGraphForkReq },
  forkSessionAtEvent: { type: 'unary', request: validateSessionForkReq },
  exportSession: { type: 'unary', request: validateSessionExportReq },
  diffSessions: { type: 'unary', request: validateSessionDiffReq },
  validateGraph: { type: 'unary', request: validateGraphValidateReq },
  preflightGraphRun: { type: 'unary', request: validatePreflightGraphRunReq },
  inspectGraph: { type: 'unary', request: validateGraphIdReq },
  runGraph: { type: 'unary', request: validateRunGraphReq },
  listGraphRuns: { type: 'unary', request: validateGraphRunListReq },
  getGraphRun: { type: 'unary', request: validateGraphRunGetReq },
  getRuntimeGraphTopology: { type: 'unary', request: validateRuntimeGraphTopologyReq },
  listGraphRunEvents: { type: 'unary', request: validateGraphRunEventListReq },
  attachGraphRun: {
    type: 'serverStreaming',
    request: validateGraphRunAttachReq,
    data: validateGraphRunPublicEvent
  },
  watchGraphRun: {
    type: 'serverStreaming',
    request: validateGraphRunWatchReq,
    data: validateGraphRunStreamEvent
  },
  cancelGraphRun: { type: 'unary', request: validateGraphCancelReq },
  pauseGraphRun: { type: 'unary', request: validateGraphPauseReq },
  resumeGraphRun: { type: 'unary', request: validateGraphResumeReq },
  injectPendingInput: { type: 'unary', request: validateInjectPendingInputReq },
  editPendingInput: { type: 'unary', request: validateEditPendingInputReq },
  cancelPendingInput: {
    type: 'unary',
    request: (value) => validatePendingInputMutationReq(value, 'cancelPendingInput')
  },
  validatePackageManifest: { type: 'unary', request: validatePackageManifestReq },
  scanPackage: { type: 'unary', request: validatePackagePathReq },
  installPackage: { type: 'unary', request: validatePackagePathReq },
  listPackages: { type: 'unary', request: validateEmptyReq },
  inspectPackage: { type: 'unary', request: validatePackageInspectReq },
  uninstallPackage: { type: 'unary', request: validatePackageUninstallReq }
}
