import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { ChatAttachment, ChatMessage, LLMChatResp } from '@shared/api/svcLLMProxy'

export type AssistantChannel =
  | 'telegram'
  | 'feishu'
  | 'discord'
  | 'qq'
  | 'wechat'
  | 'imessage'
  | 'generic'
  | string
export type AssistantScopeType = 'dm' | 'group' | 'channel' | 'thread' | 'topic'

export type AssistantRoute = {
  channel: AssistantChannel
  scopeType: AssistantScopeType
  scopeId: string
  threadId?: string
  senderId?: string
  senderName?: string
}

export type AssistantInboundMessage = {
  route: AssistantRoute
  text?: string
  attachments?: ChatAttachment[]
  profileId?: string
  systemPrompt?: string
  execution?: AssistantExecutionPolicy
  workspaceId?: string
  continueFromRunId?: string
  resumeFromRunId?: string
  resetHistory?: boolean
  taskGroup?: Partial<AssistantTaskGroupState> | null
  signal?: AbortSignal
  onEvent?: (event: AssistantRunEvent) => void | Promise<void>
}

export type AssistantRunStatus =
  | 'queued'
  | 'acknowledged'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type AssistantRunOrigin = 'new' | 'continue' | 'retry' | 'resume'
export type AssistantResumeMode = 'requeue'
export type AssistantExecutionMode = 'inherit' | 'isolated' | 'no-history'

export type AssistantExecutionPolicy = {
  mode?: AssistantExecutionMode
  allowHistory?: boolean
  contextMessageLimit?: 0 | 3 | 5 | 10 | 'all'
  allowedToolNames?: string[]
  traceLabel?: string
  captureArtifacts?: boolean
}

export type AssistantQualityGateStatus = 'unknown' | 'pending' | 'passing' | 'warning' | 'failed'

export type AssistantQualityGateCheck = {
  checkId: string
  label?: string
  status: AssistantQualityGateStatus
  detail?: string
  updatedAt: number
}

export type AssistantQualityGateState = {
  gateId: string
  status: AssistantQualityGateStatus
  updatedAt: number
  summary?: string
  checks?: AssistantQualityGateCheck[]
}

export type AssistantTaskGroupAction =
  | 'start'
  | 'progress'
  | 'cancel'
  | 'resume'
  | 'approve'
  | 'export'

export type AssistantTaskGroupStatus =
  | 'draft'
  | 'running'
  | 'waiting-approval'
  | 'approved'
  | 'exported'
  | 'cancelled'

export type AssistantTaskGroupProgress = {
  completed?: number
  total?: number
  percent?: number
  label?: string
  updatedAt?: number
}

export type AssistantTaskGroupState = {
  taskGroupId: string
  title?: string
  description?: string
  status: AssistantTaskGroupStatus
  qualityGate?: AssistantQualityGateState
  progress?: AssistantTaskGroupProgress
  approvedAt?: number
  approvedBy?: string
  exportedAt?: number
  exportTarget?: string
  exportArtifactIds?: string[]
  workspaceRunId?: string
  rootRunId?: string
  updatedAt: number
}

export type AssistantArtifactLineageRef = {
  taskGroupId?: string
  taskGroupAction?: AssistantTaskGroupAction
  workspaceRunId?: string
  workspaceId?: string
  rootRunId?: string
  parentArtifactId?: string
}

export type AssistantArtifactRef = {
  artifactId: string
  runId: string
  kind: 'image' | 'video' | 'model3d' | 'file' | 'text'
  url?: string
  mimeType?: string
  fileName?: string
  sizeBytes?: number
  createdAt: number
  source: 'reply' | 'tool' | 'workspace'
  traceId?: string
  executionMode?: AssistantExecutionMode
  originatingRunId?: string
  executionTraceLabel?: string
  lineage?: AssistantArtifactLineageRef
}

export type AssistantRunEvent = {
  eventId: string
  runId: string
  sessionKey: string
  route: AssistantRoute
  type:
    | 'queued'
    | 'acknowledged'
    | 'started'
    | 'progress'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'tool'
  level: 'info' | 'warning' | 'error'
  message: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type AssistantWorkspaceState = {
  workspaceId: string
  workspaceRootDir: string
  workspaceMetaFile: string
  rootDir: string
  memoryDir: string
  memoryFile: string
  contextFile: string
  taskContextFile: string
  pinnedContextFile: string
}

export type AssistantWorkspaceRegistryStatus = 'active' | 'archived'
export type AssistantWorkspaceAccessMode = 'private' | 'shared'
export type AssistantWorkspaceGovernanceAction = 'share' | 'privatize' | 'archive' | 'revive'

export type AssistantWorkspaceMeta = {
  workspaceId: string
  createdAt: number
  updatedAt: number
  status: AssistantWorkspaceRegistryStatus
  accessMode: AssistantWorkspaceAccessMode
  attachedSessionKeys: string[]
  attachedRoutes: AssistantRoute[]
  ownerSessionKey?: string
  ownerRoute?: AssistantRoute
  archivedAt?: number
  title?: string
  description?: string
  sharedNotes?: string[]
}

export type AssistantWorkspaceSummary = {
  workspaceId: string
  workspaceRootDir: string
  workspaceMetaFile: string
  createdAt?: number
  updatedAt?: number
  status: AssistantWorkspaceRegistryStatus
  accessMode: AssistantWorkspaceAccessMode
  attachedSessionKeys: string[]
  attachedRoutes: AssistantRoute[]
  ownerSessionKey?: string
  ownerRoute?: AssistantRoute
  archivedAt?: number
  sessionCount: number
  messageCount: number
  runCount: number
  eventCount: number
  artifactCount: number
  title?: string
  description?: string
  sharedNotes?: string[]
  latestSessionUpdatedAt?: number
  latestRunUpdatedAt?: number
}

export type AssistantContextSnapshot = {
  clientId: string
  sessionKey: string
  workspaceId: string
  route: AssistantRoute
  generatedAt: number
  workflowDir: string
  outputDir: string
  downloadDir: string
  useRemoteComfyUI: boolean
  useRemoteLLM: boolean
  localLLMServerEnabled: boolean
}

export type AssistantTaskContextRun = {
  runId: string
  workspaceId: string
  status: AssistantRunStatus
  runOrigin: AssistantRunOrigin
  updatedAt: number
  parentRunId?: string
  rootRunId: string
  resumeSourceRunId?: string
  resumeAttempt?: number
  resumeMode?: AssistantResumeMode
  profileId?: string
  requestText?: string
  responseText?: string
  errorMessage?: string
  artifactIds: string[]
  toolNames: string[]
  taskGroup?: AssistantTaskGroupState
}

export type AssistantTaskContextArtifact = {
  artifactId: string
  runId: string
  kind: AssistantArtifactRef['kind']
  url?: string
  mimeType?: string
  fileName?: string
  createdAt: number
  source: AssistantArtifactRef['source']
  lineage?: AssistantArtifactLineageRef
}

export type AssistantTaskContext = {
  sessionKey: string
  workspaceId: string
  route: AssistantRoute
  createdAt: number
  updatedAt: number
  latestStatus?: AssistantRunStatus
  latestProfileId?: string
  latestRequestText?: string
  latestResponseText?: string
  latestErrorMessage?: string
  recentArtifactIds: string[]
  recentArtifacts: AssistantTaskContextArtifact[]
  recentToolNames: string[]
  recentRuns: AssistantTaskContextRun[]
  taskGroup?: AssistantTaskGroupState
}

export type AssistantPinnedNote = {
  noteId: string
  text: string
  createdAt: number
  updatedAt: number
}

export type AssistantPinnedContext = {
  sessionKey: string
  route: AssistantRoute
  createdAt: number
  updatedAt: number
  notes: AssistantPinnedNote[]
}

export type AssistantReusableContextPack = {
  contextSnapshot?: AssistantContextSnapshot
  taskContext?: AssistantTaskContext
  pinnedContext?: AssistantPinnedContext
  memoryPreview?: string
  workspaceMeta?: AssistantWorkspaceMeta
}

export type AssistantRunRecord = {
  runId: string
  sessionKey: string
  workspaceId: string
  route: AssistantRoute
  status: AssistantRunStatus
  runOrigin: AssistantRunOrigin
  rootRunId: string
  parentRunId?: string
  resumeSourceRunId?: string
  resumeAttempt?: number
  resumeMode?: AssistantResumeMode
  executionMode?: AssistantExecutionMode
  executionHistorySize?: number
  executionTraceLabel?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  queuePosition?: number
  requestText?: string
  responseText?: string
  profileId?: string
  errorMessage?: string
  cancelRequested?: boolean
  toolCalls?: Array<{
    toolName: string
    args?: Record<string, unknown>
  }>
  artifactIds: string[]
  taskGroup?: AssistantTaskGroupState
  lineage?: AssistantArtifactLineageRef
}

export type AssistantSessionRecord = {
  sessionKey: string
  route: AssistantRoute
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  workspace: AssistantWorkspaceState
  contextSnapshot?: AssistantContextSnapshot
  runs: AssistantRunRecord[]
  artifacts: AssistantArtifactRef[]
  eventLog: AssistantRunEvent[]
}

export type AssistantSessionSummary = {
  sessionKey: string
  route: AssistantRoute
  messageCount: number
  createdAt: number
  updatedAt: number
  workspace?: AssistantWorkspaceState
  latestRun?: Pick<
    AssistantRunRecord,
    'runId' | 'status' | 'updatedAt' | 'profileId' | 'queuePosition' | 'errorMessage'
  >
  lastUserText?: string
  lastAssistantText?: string
}

export type AssistantWorkspaceInspection = AssistantWorkspaceSummary & {
  sessions: AssistantSessionSummary[]
  recentRuns: AssistantRunRecord[]
}

export type AssistantRuntimeResult = {
  runId?: string
  sessionKey: string
  historySize: number
  profileId?: string
  executionMode?: AssistantExecutionMode
  executionHistorySize?: number
  executionTraceLabel?: string
  status?: AssistantRunStatus
  taskState?: AssistantTaskState
  events?: AssistantRunEvent[]
  artifacts?: AssistantArtifactRef[]
  reply: LLMChatResp
}

export type AssistantTaskState = {
  sessionKey: string
  running: boolean
  queuedCount: number
  activeRunId?: string
  activeStatus?: AssistantRunStatus
  cancelRequested?: boolean
  taskGroup?: AssistantTaskGroupState
  updatedAt: number
}

export const normalizeAssistantRoute = (route: AssistantRoute): AssistantRoute =>
  normalizeAgentRoute(route) as AssistantRoute

export const getAssistantSessionKey = (route: AssistantRoute): string => getAgentSessionKey(route)
