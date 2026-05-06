import { ChatAttachment, ChatMessage, LLMProxySvc } from '@shared/api/svcLLMProxy'
import { MAGICPOT_SESSION_STATUS_TOOL_NAME } from '@shared/app/types'
import { Config } from '@shared/config/config'
import { LLMProxySvcImpl } from '../api/svcLLMProxyImpl'
import { getConfig } from '../config/config'
import { syncMcpClientManager } from '../mcp/runtime'
import { AssistantExecutionAdapter } from './executionAdapter'
import { buildAssistantHelpText } from './assistantOutputPresenter'
import {
  AssistantAuditTimelineEntry,
  AssistantOpsStatus,
  AssistantPruneResult,
  AssistantRetentionState,
  AssistantRunLineage,
  AssistantRunTrace,
  AssistantWorkflowInspection,
  AssistantWorkflowSummary,
  AssistantSessionStore
} from './sessionStore'
import { AssistantToolRegistry, type AssistantToolDefinition } from './toolRegistry'
import {
  AssistantArtifactRef,
  AssistantArtifactLineageRef,
  AssistantExecutionMode,
  AssistantExecutionPolicy,
  AssistantInboundMessage,
  AssistantResumeMode,
  AssistantRoute,
  AssistantRunEvent,
  AssistantRunOrigin,
  AssistantRunRecord,
  AssistantRunStatus,
  AssistantRuntimeResult,
  AssistantSessionRecord,
  AssistantSessionSummary,
  AssistantQualityGateState,
  AssistantWorkspaceAccessMode,
  AssistantWorkspaceGovernanceAction,
  AssistantTaskState,
  AssistantTaskGroupAction,
  AssistantTaskGroupState,
  AssistantWorkspaceInspection,
  AssistantWorkspaceSummary,
  getAssistantSessionKey,
  normalizeAssistantRoute
} from './types'
import {
  appendAssistantMemoryLog,
  buildAssistantContextSnapshot,
  clearAssistantReusableContext,
  detachAssistantWorkspaceBinding,
  ensureAssistantWorkspaceBinding,
  ensureAssistantWorkspaceState,
  getAssistantWorkspaceState,
  manageAssistantWorkspaceGovernance,
  persistAssistantContextSnapshot,
  readAssistantContextSnapshot,
  readAssistantMemoryPreview,
  updateAssistantWorkspaceMeta,
  updateAssistantTaskContext,
  normalizeTaskGroupState,
  normalizeArtifactLineage
} from './workspace'

type AssistantRuntimeDeps = {
  chatService?: Pick<LLMProxySvc, 'chat'>
  sessionStore?: AssistantSessionStore
  configProvider?: () => Config
  toolRegistry?: AssistantToolRegistry
}

type AssistantEventListener = (event: AssistantRunEvent) => void | Promise<void>

type QueuedAssistantMessage = {
  route: AssistantRoute
  config: Config
  workspace: Awaited<ReturnType<AssistantRuntime['prepareSession']>>['workspace']
  contextSnapshot: Awaited<ReturnType<AssistantRuntime['prepareSession']>>['contextSnapshot']
  runId: string
  sessionKey: string
  taskState: AssistantTaskState
  queuedRun: AssistantRunRecord
  queuedEvents: AssistantRunEvent[]
}

type AssistantCleanupResult = {
  mode: 'clear' | 'prune'
  sessionKey?: string
  cleared?: boolean
  prunedCount?: number
  removedSessionKeys?: string[]
  retention: AssistantRetentionState
  taskState?: AssistantTaskState
}

const DEFAULT_SYSTEM_ATTACHMENT_PROMPT = 'Please analyze the attached content.'
const DEFAULT_MAX_HISTORY_MESSAGES = 12

const cleanString = (value?: string | null, maxLength?: number): string | undefined => {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  if (!Number.isFinite(maxLength) || !maxLength || maxLength <= 0) {
    return normalized
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized
}

const clampHistoryMessages = (value?: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_HISTORY_MESSAGES
  return Math.min(100, Math.max(2, Math.trunc(Number(value))))
}

const isAbortError = (error: unknown): boolean => {
  if (!error) return false
  if (error instanceof Error) {
    return error.name === 'AbortError' || /aborted|cancelled/i.test(error.message)
  }
  return false
}

const buildUserMessage = (req: AssistantInboundMessage): ChatMessage => {
  const content =
    cleanString(req.text) || (req.attachments?.length ? DEFAULT_SYSTEM_ATTACHMENT_PROMPT : '')
  return {
    role: 'user',
    content,
    ...(req.attachments?.length ? { attachments: req.attachments } : {})
  }
}

const buildAssistantMessage = (
  content: string,
  attachments?: ChatAttachment[],
  ocrResult?: ChatMessage['ocrResult']
): ChatMessage => ({
  role: 'assistant',
  content,
  ...(attachments?.length ? { attachments } : {}),
  ...(ocrResult ? { ocrResult } : {})
})

const formatAssistantToolSchema = (inputSchema: Record<string, unknown>): string =>
  JSON.stringify(inputSchema || {}, null, 2)

const formatAssistantToolList = (tools: AssistantToolDefinition[]): string => {
  if (!tools.length) {
    return 'No tools are available.'
  }

  return [
    'Available tools:',
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
    '',
    'Use /tools <name> to inspect a tool and its input schema.'
  ].join('\n')
}

const formatAssistantToolDetail = (tool: AssistantToolDefinition): string =>
  [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    '',
    'Input schema:',
    formatAssistantToolSchema(tool.inputSchema)
  ].join('\n')

const createEvent = (
  runId: string,
  route: AssistantRoute,
  type: AssistantRunEvent['type'],
  message: string,
  options?: {
    level?: AssistantRunEvent['level']
    metadata?: Record<string, unknown>
  }
): AssistantRunEvent => ({
  eventId: crypto.randomUUID(),
  runId,
  sessionKey: getAssistantSessionKey(route),
  route,
  type,
  level: options?.level || 'info',
  message,
  createdAt: Date.now(),
  ...(options?.metadata ? { metadata: options.metadata } : {})
})

const createRunRecord = (
  runId: string,
  route: AssistantRoute,
  requestText: string | undefined,
  queuePosition: number,
  profileId?: string,
  options?: {
    workspaceId?: string
    runOrigin?: AssistantRunOrigin
    parentRunId?: string
    rootRunId?: string
    resumeSourceRunId?: string
    resumeAttempt?: number
    resumeMode?: AssistantResumeMode
    executionMode?: AssistantExecutionMode
    executionHistorySize?: number
    executionTraceLabel?: string
    taskGroup?: AssistantTaskGroupState
    lineage?: AssistantArtifactLineageRef
  }
): AssistantRunRecord => {
  const executionMode = options?.executionMode
  const executionHistorySize = options?.executionHistorySize
  const executionTraceLabel = cleanString(options?.executionTraceLabel, 120)

  return {
    runId,
    sessionKey: getAssistantSessionKey(route),
    workspaceId:
      cleanString(options?.workspaceId, 120) || `workspace-${getAssistantSessionKey(route)}`,
    route,
    status: queuePosition > 0 ? 'queued' : 'acknowledged',
    runOrigin: options?.runOrigin || 'new',
    rootRunId: cleanString(options?.rootRunId, 120) || runId,
    ...(cleanString(options?.parentRunId, 120)
      ? { parentRunId: cleanString(options?.parentRunId, 120) }
      : {}),
    ...(cleanString(options?.resumeSourceRunId, 120)
      ? { resumeSourceRunId: cleanString(options?.resumeSourceRunId, 120) }
      : {}),
    ...(Number.isFinite(options?.resumeAttempt)
      ? { resumeAttempt: Number(options?.resumeAttempt) }
      : {}),
    ...(cleanString(options?.resumeMode, 32)
      ? { resumeMode: cleanString(options?.resumeMode, 32) as AssistantResumeMode }
      : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(Number.isFinite(executionHistorySize)
      ? { executionHistorySize: Number(executionHistorySize) }
      : {}),
    ...(executionTraceLabel ? { executionTraceLabel } : {}),
    ...(options?.taskGroup ? { taskGroup: normalizeTaskGroupState(options.taskGroup) } : {}),
    ...(options?.lineage ? { lineage: normalizeArtifactLineage(options.lineage) } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    queuePosition,
    requestText,
    profileId,
    toolCalls: [],
    artifactIds: []
  }
}

const buildRunRelationshipMetadata = (
  run: Pick<
    AssistantRunRecord,
    | 'parentRunId'
    | 'rootRunId'
    | 'resumeSourceRunId'
    | 'resumeAttempt'
    | 'resumeMode'
    | 'taskGroup'
    | 'lineage'
  >
): Record<string, unknown> => ({
  ...(run.parentRunId ? { parentRunId: run.parentRunId, rootRunId: run.rootRunId } : {}),
  ...(run.resumeSourceRunId ? { resumeSourceRunId: run.resumeSourceRunId } : {}),
  ...(Number.isFinite(run.resumeAttempt) ? { resumeAttempt: run.resumeAttempt } : {}),
  ...(run.resumeMode ? { resumeMode: run.resumeMode } : {}),
  ...(run.taskGroup?.taskGroupId ? { taskGroupId: run.taskGroup.taskGroupId } : {}),
  ...(run.taskGroup ? { taskGroupStatus: run.taskGroup.status } : {}),
  ...(run.lineage ? { lineage: run.lineage } : {})
})

const buildTaskGroupLineage = (
  taskGroup?: Partial<AssistantTaskGroupState> | null,
  fallbackRunId?: string,
  workspaceId?: string
): AssistantArtifactLineageRef | undefined => {
  const normalized = normalizeTaskGroupState(taskGroup)
  if (!normalized && !fallbackRunId && !workspaceId) return undefined
  return {
    ...(normalized?.taskGroupId ? { taskGroupId: normalized.taskGroupId } : {}),
    ...(fallbackRunId
      ? { workspaceRunId: fallbackRunId, rootRunId: normalized?.rootRunId || fallbackRunId }
      : {}),
    ...(workspaceId ? { workspaceId } : {})
  }
}

const buildTaskGroupQualityGate = (
  taskGroupId: string,
  action: AssistantTaskGroupAction,
  now: number,
  previousTaskGroup?: AssistantTaskGroupState | null,
  details?: {
    title?: string
    description?: string
    approvedBy?: string
    exportTarget?: string
  }
): AssistantQualityGateState => {
  const previousGate = previousTaskGroup?.qualityGate
  const gateStatus =
    action === 'approve' || action === 'export'
      ? 'passing'
      : action === 'cancel'
        ? 'failed'
        : action === 'resume'
          ? 'pending'
          : 'pending'
  const summary =
    action === 'approve'
      ? details?.approvedBy
        ? `Approved by ${details.approvedBy}`
        : 'Task group approved'
      : action === 'export'
        ? details?.exportTarget
          ? `Exported to ${details.exportTarget}`
          : 'Task group exported'
        : action === 'cancel'
          ? 'Task group cancelled'
          : action === 'resume'
            ? 'Task group resumed'
            : 'Task group in progress'

  return {
    gateId: previousGate?.gateId || `${taskGroupId}:quality-gate`,
    status: gateStatus,
    updatedAt: now,
    summary,
    checks: [
      {
        checkId: `${taskGroupId}:${action}`,
        ...(details?.title ? { label: details.title } : {}),
        status: gateStatus,
        ...(details?.description ? { detail: details.description } : {}),
        updatedAt: now
      }
    ]
  }
}

const resolveInboundTaskGroup = (
  req: AssistantInboundMessage,
  queuedRun: AssistantRunRecord,
  fallbackStatus: AssistantTaskGroupState['status'] = 'running'
): AssistantTaskGroupState | undefined => {
  const incoming = normalizeTaskGroupState(req.taskGroup)
  const current = normalizeTaskGroupState(queuedRun.taskGroup)
  const taskGroupId = incoming?.taskGroupId || current?.taskGroupId || queuedRun.rootRunId
  if (!taskGroupId) return undefined

  const progress = incoming?.progress || current?.progress
  const status =
    incoming?.status ||
    current?.status ||
    (queuedRun.status === 'cancelled'
      ? 'cancelled'
      : queuedRun.status === 'completed'
        ? 'approved'
        : fallbackStatus)

  return normalizeTaskGroupState({
    taskGroupId,
    ...(current || {}),
    ...(incoming || {}),
    status,
    ...(progress ? { progress } : {}),
    ...(queuedRun.workspaceId ? { workspaceRunId: queuedRun.runId } : {}),
    rootRunId: queuedRun.rootRunId,
    updatedAt: Date.now()
  })
}

const buildSystemReplyResult = (
  route: AssistantRoute,
  historySize: number,
  content: string,
  options?: Partial<AssistantRuntimeResult>
): AssistantRuntimeResult => ({
  runId: options?.runId,
  sessionKey: getAssistantSessionKey(route),
  historySize,
  profileId: options?.profileId,
  executionMode: options?.executionMode,
  executionHistorySize: options?.executionHistorySize,
  executionTraceLabel: options?.executionTraceLabel,
  status: options?.status,
  taskState: options?.taskState,
  events: options?.events,
  artifacts: options?.artifacts,
  reply: {
    content
  }
})

const splitTaskCommandArgs = (value?: string): string[] => {
  const normalized = cleanString(value)
  if (!normalized) return []

  const segments = normalized.includes('|') ? normalized.split('|') : normalized.split(/\s+/)

  return segments
    .map((segment) => cleanString(segment))
    .filter((segment): segment is string => Boolean(segment))
}

const parseJsonToolResult = <T>(content: string): T | null => {
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

const formatTaskGroupSummaryLine = (summary: AssistantWorkflowSummary, index: number): string =>
  [
    `#${index + 1} ${summary.workflowId}`,
    `taskGroup=${summary.taskGroup?.taskGroupId || summary.workflowId}`,
    `status=${summary.taskGroup?.status || summary.status}`,
    `qualityGate=${summary.qualityGate?.status || summary.taskGroup?.qualityGate?.status || 'unknown'}`,
    `runs=${summary.runCount}`,
    `latestRun=${summary.latestRunId}`,
    `updated=${new Date(summary.updatedAt).toLocaleString()}`
  ].join(' | ')

const formatWorkspaceInspectionLines = (
  workspaceInspection?: AssistantWorkspaceInspection | null
): string[] => {
  if (!workspaceInspection) return []

  const lines = [
    `Workspace status: ${workspaceInspection.status}`,
    `Workspace access: ${workspaceInspection.accessMode}`,
    `Workspace sessions: ${workspaceInspection.sessionCount}`,
    `Workspace runs: ${workspaceInspection.runCount}`,
    `Workspace artifacts: ${workspaceInspection.artifactCount}`
  ]

  if (workspaceInspection.title) {
    lines.push(`Workspace title: ${workspaceInspection.title}`)
  }
  if (workspaceInspection.description) {
    lines.push(`Workspace description: ${workspaceInspection.description}`)
  }
  if (workspaceInspection.sharedNotes?.length) {
    lines.push(`Workspace notes: ${workspaceInspection.sharedNotes.join(' | ')}`)
  }

  return lines
}

type TaskGroupInspectionLike = Pick<
  AssistantWorkflowInspection,
  | 'workflowId'
  | 'workspaceId'
  | 'status'
  | 'latestRunId'
  | 'runCount'
  | 'eventCount'
  | 'artifactCount'
  | 'qualityGate'
> & {
  root: {
    runId: string
  }
  taskGroup?: AssistantTaskGroupState | null
  workspaceInspection?: AssistantWorkspaceInspection | null
}

const formatTaskGroupInspectionLikeLines = (inspection: TaskGroupInspectionLike): string[] => {
  const taskGroup = inspection.taskGroup
  const lines = [
    `Task group: ${taskGroup?.taskGroupId || inspection.workflowId}`,
    `Workflow: ${inspection.workflowId}`,
    `Status: ${taskGroup?.status || inspection.status}`,
    `Quality gate: ${
      taskGroup?.qualityGate?.gateId ||
      inspection.qualityGate?.gateId ||
      `${inspection.workflowId}:quality-gate`
    }`,
    `Quality gate status: ${taskGroup?.qualityGate?.status || inspection.qualityGate?.status || 'unknown'}`,
    `Workspace: ${inspection.workspaceId}`,
    `Root run: ${inspection.root.runId}`,
    `Latest run: ${inspection.latestRunId}`,
    `Runs: ${inspection.runCount}`,
    `Events: ${inspection.eventCount}`,
    `Artifacts: ${inspection.artifactCount}`
  ]

  if (taskGroup?.title) {
    lines.push(`Title: ${taskGroup.title}`)
  }
  if (taskGroup?.description) {
    lines.push(`Description: ${taskGroup.description}`)
  }
  if (inspection.workspaceInspection) {
    lines.push(...formatWorkspaceInspectionLines(inspection.workspaceInspection))
  }
  if (taskGroup?.progress) {
    const progress = taskGroup.progress
    lines.push(
      `Progress: ${[
        progress.label ? progress.label : null,
        progress.completed !== undefined ? `completed=${progress.completed}` : null,
        progress.total !== undefined ? `total=${progress.total}` : null,
        progress.percent !== undefined ? `percent=${progress.percent}` : null
      ]
        .filter(Boolean)
        .join(' | ')}`
    )
  }
  const qualityGate = taskGroup?.qualityGate || inspection.qualityGate
  if (qualityGate) {
    if (qualityGate.summary) {
      lines.push(`Quality gate summary: ${qualityGate.summary}`)
    }
    if (qualityGate.checks?.length) {
      lines.push(
        ...qualityGate.checks.map((check) =>
          [
            `Quality gate check: ${check.checkId}`,
            `status=${check.status}`,
            ...(check.label ? [`label=${check.label}`] : []),
            ...(check.detail ? [`detail=${check.detail}`] : []),
            `updated=${new Date(check.updatedAt).toLocaleString()}`
          ].join(' | ')
        )
      )
    }
  }
  if (taskGroup?.approvedAt) {
    lines.push(`Approved: ${new Date(taskGroup.approvedAt).toLocaleString()}`)
  }
  if (taskGroup?.approvedBy) {
    lines.push(`Approved by: ${taskGroup.approvedBy}`)
  }
  if (taskGroup?.exportedAt) {
    lines.push(`Exported: ${new Date(taskGroup.exportedAt).toLocaleString()}`)
  }
  if (taskGroup?.exportTarget) {
    lines.push(`Export target: ${taskGroup.exportTarget}`)
  }
  if (taskGroup?.exportArtifactIds?.length) {
    lines.push(`Export artifacts: ${taskGroup.exportArtifactIds.join(', ')}`)
  }
  if (taskGroup?.workspaceRunId) {
    lines.push(`Workspace run: ${taskGroup.workspaceRunId}`)
  }
  if (taskGroup?.rootRunId) {
    lines.push(`Task root: ${taskGroup.rootRunId}`)
  }

  return lines
}

const mapTaskGroupStatusToRunStatus = (
  status?: AssistantTaskGroupState['status'] | null
): AssistantRunStatus => {
  switch (status) {
    case 'cancelled':
      return 'cancelled'
    case 'approved':
    case 'exported':
      return 'completed'
    case 'draft':
    case 'waiting-approval':
      return 'acknowledged'
    case 'running':
    default:
      return 'running'
  }
}

const resolveExecutionMode = (req: AssistantInboundMessage): AssistantExecutionMode => {
  if (req.resetHistory || req.execution?.mode === 'isolated') {
    return 'isolated'
  }
  if (req.execution?.mode === 'no-history' || req.execution?.allowHistory === false) {
    return 'no-history'
  }
  return req.execution?.mode || 'inherit'
}

type AssistantContextMessageLimit = NonNullable<AssistantExecutionPolicy['contextMessageLimit']>

const resolveExecutionContextMessageLimit = (
  req: AssistantInboundMessage,
  executionMode: AssistantExecutionMode
): AssistantContextMessageLimit => {
  const contextMessageLimit = req.execution?.contextMessageLimit
  if (
    contextMessageLimit === 'all' ||
    contextMessageLimit === 0 ||
    contextMessageLimit === 3 ||
    contextMessageLimit === 5 ||
    contextMessageLimit === 10
  ) {
    return contextMessageLimit
  }

  return executionMode === 'inherit' ? 'all' : 0
}

const buildExecutionMessages = (
  existingMessages: ChatMessage[] | undefined,
  userMessage: ChatMessage,
  executionMode: AssistantExecutionMode,
  contextMessageLimit: AssistantContextMessageLimit
): ChatMessage[] =>
  executionMode === 'inherit'
    ? [
        ...(contextMessageLimit === 'all'
          ? existingMessages || []
          : contextMessageLimit === 0
            ? []
            : (existingMessages || []).slice(-contextMessageLimit)),
        userMessage
      ]
    : [userMessage]

const buildExecutionTraceMetadata = (options: {
  executionMode: AssistantExecutionMode
  executionHistorySize: number
  executionTraceLabel?: string
  requestText?: string
}): Record<string, unknown> => ({
  executionMode: options.executionMode,
  executionHistorySize: options.executionHistorySize,
  ...(options.executionTraceLabel ? { executionTraceLabel: options.executionTraceLabel } : {}),
  ...(options.requestText ? { requestText: options.requestText } : {})
})

export class AssistantRuntime {
  private readonly chatService: Pick<LLMProxySvc, 'chat'>
  private readonly sessionStore: AssistantSessionStore
  private readonly configProvider: () => Config
  private readonly toolRegistry: AssistantToolRegistry
  private readonly executionAdapter: AssistantExecutionAdapter
  private readonly routeQueues = new Map<string, Promise<unknown>>()
  private readonly taskStates = new Map<string, AssistantTaskState>()
  private readonly activeRuns = new Map<string, string>()
  private readonly queuedRuns = new Map<string, string[]>()
  private readonly cancelledRuns = new Set<string>()
  private readonly runAbortControllers = new Map<string, AbortController>()
  private readonly routeEventSubscribers = new Map<string, Set<AssistantEventListener>>()

  constructor(deps: AssistantRuntimeDeps = {}) {
    this.chatService = deps.chatService || new LLMProxySvcImpl()
    this.sessionStore = deps.sessionStore || new AssistantSessionStore()
    this.configProvider = deps.configProvider || getConfig
    this.toolRegistry = deps.toolRegistry || new AssistantToolRegistry()
    this.executionAdapter = new AssistantExecutionAdapter({
      chatService: this.chatService,
      toolRegistry: this.toolRegistry
    })
  }

  private resolveProfileId(req: AssistantInboundMessage, config: Config): string | undefined {
    return cleanString(req.profileId) || cleanString(config.chat_config?.profile_id)
  }

  private resolveSystemPrompt(req: AssistantInboundMessage, config: Config): string | undefined {
    if (typeof req.systemPrompt === 'string') {
      return cleanString(req.systemPrompt)
    }
    return cleanString(config.chat_config?.system_prompt)
  }

  private getResumeEligibility(run: AssistantRunRecord): {
    resumable: boolean
    reason?: string
  } {
    if (!['failed', 'cancelled'].includes(run.status)) {
      return {
        resumable: false,
        reason: 'Only failed or cancelled runs can be resumed.'
      }
    }

    if (!cleanString(run.requestText)) {
      return {
        resumable: false,
        reason: 'Run has no stored request text to resume.'
      }
    }

    return { resumable: true }
  }

  private async getResumeAttemptCount(sourceRunId: string): Promise<number> {
    const runs = await this.sessionStore.listRuns(1000)
    return runs.filter((run) => run.resumeSourceRunId === sourceRunId).length + 1
  }

  private async findTaskGroupRun(
    route: AssistantRoute,
    taskGroupId: string
  ): Promise<AssistantRunRecord | null> {
    const session = await this.sessionStore.getSession(route)
    if (!session) return null

    const matchingRuns = session.runs.filter(
      (run) => run.taskGroup?.taskGroupId === taskGroupId || run.rootRunId === taskGroupId
    )
    return (
      matchingRuns.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ||
      session.runs[session.runs.length - 1] ||
      null
    )
  }

  private async recordTaskGroupAction(
    route: AssistantRoute,
    action: AssistantTaskGroupAction,
    options?: {
      taskGroupId?: string
      title?: string
      description?: string
      label?: string
      total?: number
      completed?: number
      percent?: number
      approvedBy?: string
      exportTarget?: string
      exportArtifactIds?: string[]
      workspaceRunId?: string
      sourceRunId?: string
    }
  ): Promise<AssistantTaskGroupState | null> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const taskGroupId =
      cleanString(options?.taskGroupId, 120) ||
      cleanString(options?.workspaceRunId, 120) ||
      cleanString(options?.sourceRunId, 120)
    if (!taskGroupId) return null

    const targetRun =
      (options?.sourceRunId ? await this.getRun(options.sourceRunId, normalizedRoute) : null) ||
      (await this.findTaskGroupRun(normalizedRoute, taskGroupId))
    if (!targetRun) return null

    const previousTaskGroup = normalizeTaskGroupState(targetRun.taskGroup)
    const now = Date.now()
    const title = cleanString(options?.title, 160)
    const description = cleanString(options?.description, 600)
    const progressLabel = cleanString(options?.label, 160)
    const approvedBy = cleanString(options?.approvedBy, 120)
    const exportTarget = cleanString(options?.exportTarget, 400)
    const workspaceRunId = cleanString(options?.workspaceRunId, 120)
    const exportArtifactIds = Array.isArray(options?.exportArtifactIds)
      ? options.exportArtifactIds
      : undefined
    const total = Number.isFinite(options?.total) ? Number(options?.total) : undefined
    const completed = Number.isFinite(options?.completed) ? Number(options?.completed) : undefined
    const percent = Number.isFinite(options?.percent) ? Number(options?.percent) : undefined
    const nextStatus =
      action === 'start' || action === 'resume'
        ? 'running'
        : action === 'progress'
          ? previousTaskGroup?.status || 'running'
          : action === 'cancel'
            ? 'cancelled'
            : action === 'approve'
              ? 'approved'
              : action === 'export'
                ? 'exported'
                : previousTaskGroup?.status || 'draft'
    const nextTaskGroup = normalizeTaskGroupState({
      ...(previousTaskGroup || {}),
      taskGroupId,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(progressLabel || total !== undefined || completed !== undefined || percent !== undefined
        ? {
            progress: {
              ...(previousTaskGroup?.progress || {}),
              ...(progressLabel ? { label: progressLabel } : {}),
              ...(total !== undefined ? { total } : {}),
              ...(completed !== undefined ? { completed } : {}),
              ...(percent !== undefined ? { percent } : {}),
              updatedAt: now
            }
          }
        : {}),
      status: nextStatus,
      qualityGate: buildTaskGroupQualityGate(taskGroupId, action, now, previousTaskGroup, {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(approvedBy ? { approvedBy } : {}),
        ...(exportTarget ? { exportTarget } : {})
      }),
      ...(action === 'approve'
        ? {
            approvedAt: now,
            ...(approvedBy ? { approvedBy } : {})
          }
        : {}),
      ...(action === 'export'
        ? {
            exportedAt: now,
            ...(exportTarget ? { exportTarget } : {}),
            ...(exportArtifactIds?.length ? { exportArtifactIds } : {})
          }
        : {}),
      ...(workspaceRunId ? { workspaceRunId } : {}),
      rootRunId: previousTaskGroup?.rootRunId || targetRun.rootRunId || targetRun.runId,
      updatedAt: now
    })
    if (!nextTaskGroup) return null

    const updatedRun: AssistantRunRecord = {
      ...targetRun,
      updatedAt: now,
      taskGroup: nextTaskGroup
    }
    await this.sessionStore.upsertRun(normalizedRoute, updatedRun)

    const event = createEvent(
      updatedRun.runId,
      normalizedRoute,
      'progress',
      [
        `Task group ${action}${nextTaskGroup.title ? `: ${nextTaskGroup.title}` : ''}`,
        nextTaskGroup.progress?.label ? `Progress: ${nextTaskGroup.progress.label}` : null,
        nextTaskGroup.exportTarget ? `Export target: ${nextTaskGroup.exportTarget}` : null
      ]
        .filter(Boolean)
        .join(' | '),
      {
        metadata: {
          taskGroupId: nextTaskGroup.taskGroupId,
          taskGroupStatus: nextTaskGroup.status,
          ...(nextTaskGroup.qualityGate ? { qualityGate: nextTaskGroup.qualityGate } : {}),
          ...(nextTaskGroup.progress ? { taskGroupProgress: nextTaskGroup.progress } : {}),
          ...(nextTaskGroup.approvedAt ? { approvedAt: nextTaskGroup.approvedAt } : {}),
          ...(nextTaskGroup.exportedAt ? { exportedAt: nextTaskGroup.exportedAt } : {}),
          ...(nextTaskGroup.exportTarget ? { exportTarget: nextTaskGroup.exportTarget } : {}),
          ...(nextTaskGroup.exportArtifactIds?.length
            ? { exportArtifactIds: nextTaskGroup.exportArtifactIds }
            : {}),
          ...(nextTaskGroup.workspaceRunId ? { workspaceRunId: nextTaskGroup.workspaceRunId } : {})
        }
      }
    )

    const workspace = await this.resolveWorkspaceState(normalizedRoute, updatedRun.workspaceId)
    await updateAssistantTaskContext(workspace, {
      route: normalizedRoute,
      runId: updatedRun.runId,
      workspaceId: updatedRun.workspaceId,
      status: updatedRun.status,
      runOrigin: updatedRun.runOrigin,
      updatedAt: now,
      parentRunId: updatedRun.parentRunId,
      rootRunId: updatedRun.rootRunId,
      resumeSourceRunId: updatedRun.resumeSourceRunId,
      resumeAttempt: updatedRun.resumeAttempt,
      resumeMode: updatedRun.resumeMode,
      profileId: updatedRun.profileId,
      requestText: updatedRun.requestText,
      responseText: updatedRun.responseText,
      errorMessage: updatedRun.errorMessage,
      artifactIds: updatedRun.artifactIds,
      toolCalls: updatedRun.toolCalls,
      taskGroup: nextTaskGroup,
      artifacts: []
    })
    await this.sessionStore.appendEvents(normalizedRoute, [event])
    this.broadcastEvents(normalizedRoute, [event])
    this.setTaskState(getAssistantSessionKey(normalizedRoute), {
      taskGroup: nextTaskGroup
    })
    return nextTaskGroup
  }

  private getOrCreateTaskState(sessionKey: string): AssistantTaskState {
    const existing = this.taskStates.get(sessionKey)
    if (existing) return existing

    const created: AssistantTaskState = {
      sessionKey,
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    this.taskStates.set(sessionKey, created)
    return created
  }

  private setTaskState(sessionKey: string, next: Partial<AssistantTaskState>): AssistantTaskState {
    const previous = this.getOrCreateTaskState(sessionKey)
    const updated: AssistantTaskState = {
      ...previous,
      ...next,
      updatedAt: Date.now()
    }
    this.taskStates.set(sessionKey, updated)
    return updated
  }

  private enqueueRun(sessionKey: string, runId: string): AssistantTaskState {
    const queue = [...(this.queuedRuns.get(sessionKey) || []), runId]
    this.queuedRuns.set(sessionKey, queue)
    return this.setTaskState(sessionKey, {
      queuedCount: queue.length,
      ...(this.activeRuns.has(sessionKey)
        ? {
            running: true,
            activeRunId: this.activeRuns.get(sessionKey),
            activeStatus: 'running'
          }
        : {})
    })
  }

  private startRun(sessionKey: string, runId: string): AssistantTaskState {
    const queue = [...(this.queuedRuns.get(sessionKey) || [])].filter((id) => id !== runId)
    this.queuedRuns.set(sessionKey, queue)
    this.activeRuns.set(sessionKey, runId)
    return this.setTaskState(sessionKey, {
      running: true,
      queuedCount: queue.length,
      activeRunId: runId,
      activeStatus: 'running',
      cancelRequested: this.cancelledRuns.has(runId)
    })
  }

  private finishRun(
    sessionKey: string,
    runId: string,
    status: AssistantTaskState['activeStatus'] = undefined
  ): AssistantTaskState {
    const queue = this.queuedRuns.get(sessionKey) || []
    if (this.activeRuns.get(sessionKey) === runId) {
      this.activeRuns.delete(sessionKey)
    }
    this.runAbortControllers.delete(runId)
    this.cancelledRuns.delete(runId)
    return this.setTaskState(sessionKey, {
      running: false,
      queuedCount: queue.length,
      activeRunId: undefined,
      activeStatus: status,
      cancelRequested: false
    })
  }

  private async runSerialForRoute<T>(
    route: AssistantRoute,
    runId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const sessionKey = getAssistantSessionKey(route)
    const previous = this.routeQueues.get(sessionKey) || Promise.resolve()
    const next = previous.catch(() => undefined).then(task)

    this.routeQueues.set(sessionKey, next)

    try {
      return await next
    } finally {
      if (this.routeQueues.get(sessionKey) === next) {
        this.routeQueues.delete(sessionKey)
      }
      if (this.activeRuns.get(sessionKey) === runId) {
        this.finishRun(sessionKey, runId)
      }
    }
  }

  private async resolveWorkspaceState(route: AssistantRoute, preferredWorkspaceId?: string) {
    const normalizedRoute = normalizeAssistantRoute(route)
    const existingWorkspace = getAssistantWorkspaceState(normalizedRoute)
    const existingContextSnapshot = await readAssistantContextSnapshot(existingWorkspace)
    const workspaceId =
      cleanString(preferredWorkspaceId, 120) ||
      cleanString(existingContextSnapshot?.workspaceId, 120) ||
      existingWorkspace.workspaceId

    return getAssistantWorkspaceState(normalizedRoute, workspaceId)
  }

  private async prepareSession(
    route: AssistantRoute,
    config: Config,
    preferredWorkspaceId?: string
  ) {
    const workspace = await ensureAssistantWorkspaceState(
      route,
      (await this.resolveWorkspaceState(route, preferredWorkspaceId)).workspaceId
    )
    await ensureAssistantWorkspaceBinding(workspace, route)
    const contextSnapshot = buildAssistantContextSnapshot(route, config, workspace.workspaceId)
    await persistAssistantContextSnapshot(workspace, contextSnapshot)
    return {
      workspace,
      contextSnapshot
    }
  }

  private async clearPersistentSessionState(route: AssistantRoute): Promise<void> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const workspace = await ensureAssistantWorkspaceState(normalizedRoute)
    await this.sessionStore.clearSession(normalizedRoute)
    await clearAssistantReusableContext(workspace)
    this.routeQueues.delete(getAssistantSessionKey(normalizedRoute))
    this.activeRuns.delete(getAssistantSessionKey(normalizedRoute))
    this.queuedRuns.delete(getAssistantSessionKey(normalizedRoute))
    this.taskStates.delete(getAssistantSessionKey(normalizedRoute))
  }

  private async clearWorkspaceForRoute(route: AssistantRoute): Promise<void> {
    const workspace = getAssistantWorkspaceState(route)
    await clearAssistantReusableContext(workspace)
  }

  private buildWorkspaceInspectionFallback(
    route: AssistantRoute,
    workspace: Awaited<ReturnType<typeof ensureAssistantWorkspaceState>>
  ): AssistantWorkspaceInspection {
    const defaultWorkspace = getAssistantWorkspaceState(route)
    return {
      workspaceId: workspace.workspaceId,
      workspaceRootDir: workspace.workspaceRootDir,
      workspaceMetaFile: workspace.workspaceMetaFile,
      status: 'active',
      accessMode: workspace.workspaceId === defaultWorkspace.workspaceId ? 'private' : 'shared',
      attachedSessionKeys: [getAssistantSessionKey(route)],
      attachedRoutes: [route],
      ownerSessionKey: getAssistantSessionKey(route),
      ownerRoute: route,
      sessionCount: 1,
      messageCount: 0,
      runCount: 0,
      eventCount: 0,
      artifactCount: 0,
      sessions: [],
      recentRuns: []
    }
  }

  private async emitEvents(
    req: AssistantInboundMessage,
    events: AssistantRunEvent[]
  ): Promise<void> {
    if (!req.onEvent || events.length === 0) return

    for (const event of events) {
      try {
        await req.onEvent(event)
      } catch (error) {
        console.warn('[AssistantRuntime] Failed to deliver runtime event:', error)
      }
    }
  }

  private broadcastEvents(route: AssistantRoute, events: AssistantRunEvent[]): void {
    if (events.length === 0) return

    const sessionKey = getAssistantSessionKey(normalizeAssistantRoute(route))
    const subscribers = this.routeEventSubscribers.get(sessionKey)
    if (!subscribers?.size) return

    for (const event of events) {
      for (const subscriber of subscribers) {
        try {
          void Promise.resolve(subscriber(event)).catch((error) => {
            console.warn('[AssistantRuntime] Failed to deliver subscribed runtime event:', error)
          })
        } catch (error) {
          console.warn('[AssistantRuntime] Failed to deliver subscribed runtime event:', error)
        }
      }
    }
  }

  private async appendAndEmitEvent(
    req: AssistantInboundMessage,
    route: AssistantRoute,
    event: AssistantRunEvent
  ): Promise<void> {
    await this.sessionStore.appendEvents(route, [event])
    await this.emitEvents(req, [event])
    this.broadcastEvents(route, [event])
  }

  private async handleMessageUnlocked(
    req: AssistantInboundMessage,
    route: AssistantRoute,
    runId: string,
    queuedRun: AssistantRunRecord,
    preparedSession: Awaited<ReturnType<AssistantRuntime['prepareSession']>>
  ): Promise<AssistantRuntimeResult> {
    const config = this.configProvider()
    await syncMcpClientManager(config)
    if (!cleanString(req.text) && !(req.attachments && req.attachments.length > 0)) {
      throw new Error('Missing inbound chat message text or attachments.')
    }

    if (req.resetHistory) {
      await this.clearPersistentSessionState(route)
    }

    const { workspace, contextSnapshot } = preparedSession
    const sessionKey = getAssistantSessionKey(route)
    const startedState = this.startRun(sessionKey, runId)
    const profileId = this.resolveProfileId(req, config)
    const systemPrompt = this.resolveSystemPrompt(req, config)
    const executionMode = queuedRun.executionMode || resolveExecutionMode(req)
    const executionTraceLabel =
      queuedRun.executionTraceLabel || cleanString(req.execution?.traceLabel, 120)
    const taskGroup = resolveInboundTaskGroup(req, queuedRun)
    if (taskGroup) {
      this.setTaskState(sessionKey, { taskGroup })
    }

    if (this.cancelledRuns.has(runId)) {
      const cancelledAt = Date.now()
      const cancelledRun: AssistantRunRecord = {
        ...queuedRun,
        status: 'cancelled',
        cancelRequested: true,
        finishedAt: cancelledAt,
        updatedAt: cancelledAt,
        errorMessage: 'Cancelled before execution started.',
        ...(taskGroup ? { taskGroup } : {})
      }
      const cancelledEvent = createEvent(
        runId,
        route,
        'cancelled',
        'Run cancelled before execution started.'
      )
      await this.sessionStore.upsertRun(route, cancelledRun, {
        workspace,
        contextSnapshot,
        events: [cancelledEvent]
      })
      await appendAssistantMemoryLog(workspace, {
        title: cleanString(req.text) || 'Attachment-only request',
        requestText: cleanString(req.text),
        status: 'cancelled',
        profileId
      })
      await updateAssistantTaskContext(workspace, {
        route,
        runId,
        workspaceId: queuedRun.workspaceId,
        status: 'cancelled',
        runOrigin: queuedRun.runOrigin,
        updatedAt: cancelledAt,
        parentRunId: queuedRun.parentRunId,
        rootRunId: queuedRun.rootRunId,
        resumeSourceRunId: queuedRun.resumeSourceRunId,
        resumeAttempt: queuedRun.resumeAttempt,
        resumeMode: queuedRun.resumeMode,
        profileId,
        requestText: cleanString(req.text),
        errorMessage: cancelledRun.errorMessage,
        artifactIds: [],
        toolCalls: [],
        taskGroup
      })
      await this.emitEvents(req, [cancelledEvent])
      this.broadcastEvents(route, [cancelledEvent])
      const taskState = this.finishRun(sessionKey, runId, 'cancelled')
      return buildSystemReplyResult(route, 0, 'The queued task was cancelled.', {
        runId,
        profileId,
        executionMode,
        executionHistorySize: 1,
        executionTraceLabel,
        status: 'cancelled',
        taskState,
        events: [cancelledEvent]
      })
    }

    const existingSession = await this.sessionStore.getSession(route)
    const userMessage = buildUserMessage(req)
    const contextMessageLimit = resolveExecutionContextMessageLimit(req, executionMode)
    const executionMessages = buildExecutionMessages(
      existingSession?.messages || [],
      userMessage,
      executionMode,
      contextMessageLimit
    )
    const executionHistorySize = executionMessages.length
    const priorMessageCount = Math.max(0, executionHistorySize - 1)

    const startedAt = Date.now()
    const startEvent = createEvent(runId, route, 'started', 'Chat execution started.', {
      metadata: {
        workspaceId: queuedRun.workspaceId,
        ...buildExecutionTraceMetadata({
          executionMode,
          executionHistorySize,
          executionTraceLabel,
          requestText: cleanString(req.text)
        }),
        priorMessageCount,
        ...buildRunRelationshipMetadata(queuedRun)
      }
    })
    const runningRun: AssistantRunRecord = {
      ...queuedRun,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      executionMode,
      executionHistorySize,
      ...(executionTraceLabel ? { executionTraceLabel } : {}),
      ...(taskGroup ? { taskGroup } : {})
    }
    await this.sessionStore.upsertRun(route, runningRun, {
      workspace,
      contextSnapshot,
      events: [startEvent]
    })
    await this.emitEvents(req, [startEvent])
    this.broadcastEvents(route, [startEvent])

    const abortController = new AbortController()
    this.runAbortControllers.set(runId, abortController)

    const executionResult = await this.executionAdapter.run({
      runId,
      route,
      req,
      config,
      messages: executionMessages,
      profileId,
      systemPrompt,
      executionMode,
      executionHistorySize,
      executionTraceLabel,
      sessionStore: this.sessionStore,
      taskState: startedState,
      workspaceMemoryFile: workspace.memoryFile,
      workspaceTaskContextFile: workspace.taskContextFile,
      workspaceContextFile: workspace.contextFile,
      workspacePinnedContextFile: workspace.pinnedContextFile,
      workspaceMetaFile: workspace.workspaceMetaFile,
      resumeRun: this.resumeRun.bind(this),
      resumeWorkflow: this.resumeWorkflow.bind(this),
      signal: abortController.signal,
      emitEvent: async (event) =>
        this.appendAndEmitEvent(
          req,
          route,
          createEvent(runId, route, event.type, event.message, {
            level: event.level,
            metadata: event.metadata
          })
        )
    })

    const reply = executionResult.reply
    const artifactLineage = {
      ...(taskGroup?.taskGroupId ? { taskGroupId: taskGroup.taskGroupId } : {}),
      workspaceRunId: runId,
      workspaceId: queuedRun.workspaceId,
      rootRunId: queuedRun.rootRunId
    }
    const artifactsWithLineage = executionResult.artifacts.map((artifact) => ({
      ...artifact,
      lineage: {
        ...(artifact.lineage || {}),
        ...artifactLineage
      }
    }))
    const assistantMessage = buildAssistantMessage(
      reply.content || '',
      reply.attachments,
      reply.ocrResult
    )
    const completionStatus = this.cancelledRuns.has(runId) ? 'cancelled' : 'completed'
    const finishedAt = Date.now()
    const finalRun: AssistantRunRecord = {
      ...runningRun,
      status: completionStatus,
      updatedAt: finishedAt,
      finishedAt,
      responseText: cleanString(reply.content),
      toolCalls: executionResult.toolCalls,
      artifactIds: executionResult.artifacts.map((artifact) => artifact.artifactId),
      executionMode: executionResult.executionMode || executionMode,
      executionHistorySize: executionResult.executionHistorySize || executionHistorySize,
      ...(executionTraceLabel ? { executionTraceLabel } : {}),
      cancelRequested: completionStatus === 'cancelled'
    }
    const finalEvents = [
      ...executionResult.events,
      createEvent(
        runId,
        route,
        completionStatus === 'cancelled' ? 'cancelled' : 'completed',
        completionStatus === 'cancelled'
          ? 'Execution result discarded because cancellation was requested.'
          : 'Chat execution completed.',
        {
          metadata: {
            workspaceId: finalRun.workspaceId,
            ...buildExecutionTraceMetadata({
              executionMode: finalRun.executionMode || executionMode,
              executionHistorySize: finalRun.executionHistorySize || executionHistorySize,
              executionTraceLabel,
              requestText: cleanString(req.text)
            }),
            artifactCount: executionResult.artifacts.length,
            toolCallCount: executionResult.toolCalls.length,
            ...buildRunRelationshipMetadata(finalRun)
          }
        }
      )
    ]

    const stored = await this.sessionStore.appendTurn(
      route,
      [userMessage, assistantMessage],
      clampHistoryMessages(config.chat_config?.max_history_messages),
      {
        workspace,
        contextSnapshot,
        run: finalRun,
        artifacts: artifactsWithLineage,
        events: finalEvents
      }
    )
    await this.emitEvents(req, finalEvents)
    this.broadcastEvents(route, finalEvents)

    await appendAssistantMemoryLog(workspace, {
      title: cleanString(req.text) || 'Attachment-only request',
      requestText: cleanString(req.text),
      responseText: cleanString(reply.content),
      status: finalRun.status,
      profileId
    })
    await updateAssistantTaskContext(workspace, {
      route,
      runId,
      workspaceId: finalRun.workspaceId,
      status: finalRun.status,
      runOrigin: finalRun.runOrigin,
      updatedAt: finishedAt,
      parentRunId: finalRun.parentRunId,
      rootRunId: finalRun.rootRunId,
      resumeSourceRunId: finalRun.resumeSourceRunId,
      resumeAttempt: finalRun.resumeAttempt,
      resumeMode: finalRun.resumeMode,
      profileId,
      requestText: cleanString(req.text),
      responseText: cleanString(reply.content),
      artifactIds: finalRun.artifactIds,
      artifacts: artifactsWithLineage,
      toolCalls: executionResult.toolCalls,
      taskGroup
    })

    const taskState = this.finishRun(sessionKey, runId, completionStatus)
    return {
      runId,
      sessionKey: getAssistantSessionKey(route),
      historySize: stored.messages.length,
      ...(profileId ? { profileId } : {}),
      executionMode: finalRun.executionMode,
      executionHistorySize: finalRun.executionHistorySize,
      executionTraceLabel,
      status: finalRun.status,
      taskState,
      events: finalEvents,
      artifacts: artifactsWithLineage,
      reply:
        completionStatus === 'cancelled'
          ? {
              content: 'The task was cancelled before the final result was delivered.'
            }
          : reply
    }
  }

  private async queueInboundMessage(req: AssistantInboundMessage): Promise<QueuedAssistantMessage> {
    const route = normalizeAssistantRoute(req.route)
    const config = this.configProvider()
    const continueFromRunId = cleanString(req.continueFromRunId, 120)
    const resumeFromRunId = cleanString(req.resumeFromRunId, 120)
    if (continueFromRunId && resumeFromRunId) {
      throw new Error('Cannot use continueFromRunId and resumeFromRunId in the same request.')
    }

    const continuationSourceRun = continueFromRunId
      ? await this.sessionStore.getRun(continueFromRunId)
      : null
    if (continueFromRunId && !continuationSourceRun) {
      throw new Error(`Cannot continue from missing run: ${continueFromRunId}`)
    }
    const resumeSourceRun = resumeFromRunId ? await this.sessionStore.getRun(resumeFromRunId) : null
    if (resumeFromRunId && !resumeSourceRun) {
      throw new Error(`Cannot resume from missing run: ${resumeFromRunId}`)
    }
    if (resumeSourceRun) {
      const eligibility = this.getResumeEligibility(resumeSourceRun)
      if (!eligibility.resumable) {
        throw new Error(`Cannot resume run ${resumeSourceRun.runId}: ${eligibility.reason}`)
      }
    }

    const sourceRun = resumeSourceRun || continuationSourceRun
    const requestText = cleanString(req.text) || cleanString(resumeSourceRun?.requestText)
    if (resumeSourceRun && !requestText) {
      throw new Error(`Cannot resume run ${resumeSourceRun.runId}: no stored request text found.`)
    }
    const profileId = cleanString(req.profileId) || resumeSourceRun?.profileId
    const executionMode = resolveExecutionMode(req)
    const executionTraceLabel = cleanString(req.execution?.traceLabel, 120)
    const resumeAttempt = resumeSourceRun
      ? await this.getResumeAttemptCount(resumeSourceRun.runId)
      : undefined

    if (requestText && !cleanString(req.text)) {
      req.text = requestText
    }
    if (profileId && !cleanString(req.profileId)) {
      req.profileId = profileId
    }

    const { workspace, contextSnapshot } = await this.prepareSession(
      route,
      config,
      cleanString(req.workspaceId, 120) || sourceRun?.workspaceId
    )
    const runId = crypto.randomUUID()
    const sessionKey = getAssistantSessionKey(route)
    const taskState = this.enqueueRun(sessionKey, runId)
    const normalizedTaskGroup = req.taskGroup
      ? normalizeTaskGroupState({
          ...req.taskGroup,
          taskGroupId:
            cleanString(req.taskGroup.taskGroupId, 120) ||
            cleanString(req.continueFromRunId, 120) ||
            cleanString(req.resumeFromRunId, 120) ||
            runId
        })
      : undefined
    if (normalizedTaskGroup) {
      this.setTaskState(sessionKey, { taskGroup: normalizedTaskGroup })
    }
    const queuedRun = createRunRecord(
      runId,
      route,
      requestText,
      taskState.queuedCount,
      profileId || this.resolveProfileId(req, config),
      {
        workspaceId: workspace.workspaceId,
        runOrigin: resumeSourceRun ? 'resume' : continuationSourceRun ? 'continue' : 'new',
        parentRunId: sourceRun?.runId,
        rootRunId: sourceRun?.rootRunId || sourceRun?.runId,
        ...(resumeSourceRun ? { resumeSourceRunId: resumeSourceRun.runId } : {}),
        ...(resumeAttempt !== undefined ? { resumeAttempt } : {}),
        ...(resumeSourceRun ? { resumeMode: 'requeue' as const } : {}),
        executionMode,
        ...(executionTraceLabel ? { executionTraceLabel } : {}),
        ...(normalizedTaskGroup ? { taskGroup: normalizedTaskGroup } : {}),
        lineage: buildTaskGroupLineage(normalizedTaskGroup, runId, workspace.workspaceId) || {
          workspaceRunId: runId,
          workspaceId: workspace.workspaceId,
          rootRunId: sourceRun?.rootRunId || sourceRun?.runId || runId
        }
      }
    )
    const queuedEvents = [
      createEvent(runId, route, 'queued', 'Message queued for chat execution.', {
        metadata: {
          queuePosition: taskState.queuedCount,
          workspaceId: workspace.workspaceId,
          ...buildExecutionTraceMetadata({
            executionMode,
            executionHistorySize: 1,
            executionTraceLabel,
            requestText
          }),
          ...buildRunRelationshipMetadata(queuedRun)
        }
      }),
      createEvent(runId, route, 'acknowledged', 'MagicPot acknowledged the request.', {
        metadata: {
          workspaceId: workspace.workspaceId,
          ...buildExecutionTraceMetadata({
            executionMode,
            executionHistorySize: 1,
            executionTraceLabel,
            requestText
          }),
          ...buildRunRelationshipMetadata(queuedRun)
        }
      })
    ]

    await this.sessionStore.upsertRun(route, queuedRun, {
      workspace,
      contextSnapshot,
      events: queuedEvents
    })
    await this.emitEvents(req, queuedEvents)
    this.broadcastEvents(route, queuedEvents)

    return {
      route,
      config,
      workspace,
      contextSnapshot,
      runId,
      sessionKey,
      taskState,
      queuedRun,
      queuedEvents
    }
  }

  private async executeQueuedMessage(
    req: AssistantInboundMessage,
    queuedMessage: QueuedAssistantMessage
  ): Promise<AssistantRuntimeResult> {
    const { route, runId, sessionKey, queuedRun, workspace, contextSnapshot } = queuedMessage

    try {
      return await this.runSerialForRoute(route, runId, () =>
        this.handleMessageUnlocked(req, route, runId, queuedRun, {
          workspace,
          contextSnapshot
        })
      )
    } catch (error) {
      if (this.cancelledRuns.has(runId) || isAbortError(error)) {
        const cancelledAt = Date.now()
        const existingRun =
          (await this.sessionStore.getSession(route))?.runs.find((run) => run.runId === runId) ||
          queuedRun
        const cancelledRun: AssistantRunRecord = {
          ...existingRun,
          status: 'cancelled',
          updatedAt: cancelledAt,
          finishedAt: cancelledAt,
          cancelRequested: true,
          errorMessage: 'Chat execution cancelled.'
        }
        const cancelledEvent = createEvent(runId, route, 'cancelled', 'Chat execution cancelled.', {
          metadata: {
            ...buildExecutionTraceMetadata({
              executionMode: cancelledRun.executionMode || queuedRun.executionMode || 'inherit',
              executionHistorySize:
                cancelledRun.executionHistorySize || queuedRun.executionHistorySize || 1,
              executionTraceLabel:
                cancelledRun.executionTraceLabel || queuedRun.executionTraceLabel,
              requestText: queuedRun.requestText
            }),
            ...buildRunRelationshipMetadata(cancelledRun)
          }
        })
        await this.sessionStore.upsertRun(route, cancelledRun, {
          workspace,
          contextSnapshot,
          events: [cancelledEvent]
        })
        await appendAssistantMemoryLog(workspace, {
          title: queuedRun.requestText || 'Attachment-only request',
          requestText: queuedRun.requestText,
          status: 'cancelled',
          profileId: queuedRun.profileId
        })
        await updateAssistantTaskContext(workspace, {
          route,
          runId,
          workspaceId: queuedRun.workspaceId,
          status: 'cancelled',
          runOrigin: queuedRun.runOrigin,
          updatedAt: cancelledAt,
          parentRunId: queuedRun.parentRunId,
          rootRunId: queuedRun.rootRunId,
          resumeSourceRunId: queuedRun.resumeSourceRunId,
          resumeAttempt: queuedRun.resumeAttempt,
          resumeMode: queuedRun.resumeMode,
          profileId: queuedRun.profileId,
          requestText: queuedRun.requestText,
          errorMessage: cancelledRun.errorMessage,
          artifactIds: cancelledRun.artifactIds,
          toolCalls: cancelledRun.toolCalls,
          taskGroup: cancelledRun.taskGroup
        })
        await this.emitEvents(req, [cancelledEvent])
        this.broadcastEvents(route, [cancelledEvent])
        const currentTaskState = this.finishRun(sessionKey, runId, 'cancelled')
        return buildSystemReplyResult(
          route,
          await this.getSessionMessageCount(route),
          'The task was cancelled.',
          {
            runId,
            profileId: queuedRun.profileId,
            status: 'cancelled',
            taskState: currentTaskState,
            events: [cancelledEvent]
          }
        )
      }

      const failedAt = Date.now()
      const failedRun: AssistantRunRecord = {
        ...queuedRun,
        status: 'failed',
        updatedAt: failedAt,
        finishedAt: failedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(queuedRun.taskGroup ? { taskGroup: queuedRun.taskGroup } : {})
      }
      const failedEvent = createEvent(
        runId,
        route,
        'failed',
        failedRun.errorMessage || 'Chat execution failed.',
        {
          level: 'error',
          metadata: {
            ...buildExecutionTraceMetadata({
              executionMode: failedRun.executionMode || queuedRun.executionMode || 'inherit',
              executionHistorySize:
                failedRun.executionHistorySize || queuedRun.executionHistorySize || 1,
              executionTraceLabel: failedRun.executionTraceLabel || queuedRun.executionTraceLabel,
              requestText: queuedRun.requestText
            }),
            ...buildRunRelationshipMetadata(failedRun)
          }
        }
      )
      await this.sessionStore.upsertRun(route, failedRun, {
        workspace,
        contextSnapshot,
        events: [failedEvent]
      })
      await appendAssistantMemoryLog(workspace, {
        title: queuedRun.requestText || 'Attachment-only request',
        requestText: queuedRun.requestText,
        responseText: failedRun.errorMessage,
        status: 'failed',
        profileId: queuedRun.profileId
      })
      await updateAssistantTaskContext(workspace, {
        route,
        runId,
        workspaceId: queuedRun.workspaceId,
        status: 'failed',
        runOrigin: queuedRun.runOrigin,
        updatedAt: failedAt,
        parentRunId: queuedRun.parentRunId,
        rootRunId: queuedRun.rootRunId,
        resumeSourceRunId: queuedRun.resumeSourceRunId,
        resumeAttempt: queuedRun.resumeAttempt,
        resumeMode: queuedRun.resumeMode,
        profileId: queuedRun.profileId,
        requestText: queuedRun.requestText,
        responseText: failedRun.errorMessage,
        errorMessage: failedRun.errorMessage,
        artifactIds: failedRun.artifactIds,
        toolCalls: failedRun.toolCalls,
        taskGroup: failedRun.taskGroup
      })
      await this.emitEvents(req, [failedEvent])
      this.broadcastEvents(route, [failedEvent])
      const currentTaskState = this.finishRun(sessionKey, runId, 'failed')
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        runId,
        taskState: currentTaskState
      })
    }
  }

  async handleMessage(req: AssistantInboundMessage): Promise<AssistantRuntimeResult> {
    return this.executeQueuedMessage(req, await this.queueInboundMessage(req))
  }

  async submitMessage(req: AssistantInboundMessage): Promise<AssistantRuntimeResult> {
    const queuedMessage = await this.queueInboundMessage(req)

    void this.executeQueuedMessage(req, queuedMessage).catch((error) => {
      console.error('[AssistantRuntime] Async chat message failed:', error)
    })

    return buildSystemReplyResult(
      queuedMessage.route,
      await this.getSessionMessageCount(queuedMessage.route),
      'MagicPot accepted the request for asynchronous processing.',
      {
        runId: queuedMessage.runId,
        profileId: queuedMessage.queuedRun.profileId,
        executionMode: queuedMessage.queuedRun.executionMode,
        executionHistorySize: 1,
        executionTraceLabel: queuedMessage.queuedRun.executionTraceLabel,
        status: queuedMessage.queuedRun.status,
        taskState: queuedMessage.taskState,
        events: queuedMessage.queuedEvents
      }
    )
  }

  async resumeRun(
    route: AssistantRoute,
    runId: string,
    options?: {
      async?: boolean
    }
  ): Promise<AssistantRuntimeResult> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const sourceRun = await this.getRun(runId, normalizedRoute)
    if (!sourceRun) {
      throw new Error(`Cannot resume missing run: ${runId}`)
    }

    const eligibility = this.getResumeEligibility(sourceRun)
    if (!eligibility.resumable) {
      throw new Error(`Cannot resume run ${runId}: ${eligibility.reason}`)
    }

    const requestText = cleanString(sourceRun.requestText)
    if (!requestText) {
      throw new Error(`Cannot resume run ${runId}: no stored request text found.`)
    }

    const resumeRequest: AssistantInboundMessage = {
      route: normalizedRoute,
      text: requestText,
      ...(sourceRun.profileId ? { profileId: sourceRun.profileId } : {}),
      workspaceId: sourceRun.workspaceId,
      resumeFromRunId: sourceRun.runId,
      ...(sourceRun.taskGroup ? { taskGroup: sourceRun.taskGroup } : {})
    }

    return options?.async ? this.submitMessage(resumeRequest) : this.handleMessage(resumeRequest)
  }

  async resumeWorkflow(
    workflowId: string,
    route?: AssistantRoute,
    options?: {
      async?: boolean
    }
  ): Promise<AssistantRuntimeResult> {
    const normalizedWorkflowId = cleanString(workflowId, 120)
    if (!normalizedWorkflowId) {
      throw new Error('Cannot resume a workflow without a workflowId.')
    }

    const workflow = await this.getWorkflow(
      normalizedWorkflowId,
      route ? normalizeAssistantRoute(route) : undefined,
      {
        runLimit: 1000,
        eventLimit: 1,
        artifactLimit: 1
      }
    )
    if (!workflow) {
      throw new Error(`Cannot resume missing workflow: ${normalizedWorkflowId}`)
    }

    const resumeEligibleRunIds = new Set(workflow.resumeEligibleRunIds)
    const resumableRun = [...workflow.runs]
      .filter((run) => resumeEligibleRunIds.has(run.runId))
      .sort(
        (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
      )[0]

    if (!resumableRun) {
      throw new Error(
        `Workflow ${workflow.workflowId} has no failed or cancelled run with stored request text.`
      )
    }

    return this.resumeRun(workflow.route, resumableRun.runId, options)
  }

  async resetSession(route: AssistantRoute): Promise<void> {
    const normalizedRoute = normalizeAssistantRoute(route)
    await this.runSerialForRoute(normalizedRoute, crypto.randomUUID(), () =>
      this.clearPersistentSessionState(normalizedRoute)
    )
  }

  async cleanupSession(
    route: AssistantRoute,
    options?: {
      mode?: 'clear' | 'prune'
      olderThanDays?: number
    }
  ): Promise<AssistantCleanupResult> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const mode = options?.mode || 'clear'

    if (mode === 'prune') {
      const olderThanDays = Number(options?.olderThanDays)
      if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
        throw new Error('Cleanup prune requires olderThanDays.')
      }

      const cutoff = Date.now() - Math.trunc(olderThanDays) * 24 * 60 * 60 * 1000
      const pruneResult: AssistantPruneResult = await this.sessionStore.pruneSessions(cutoff)
      await Promise.all(
        pruneResult.removedSessions.map(async (session) => {
          this.taskStates.delete(session.sessionKey)
          this.routeQueues.delete(session.sessionKey)
          this.activeRuns.delete(session.sessionKey)
          this.queuedRuns.delete(session.sessionKey)
          await this.clearWorkspaceForRoute(session.route)
        })
      )

      return {
        mode: 'prune',
        prunedCount: pruneResult.removedCount,
        removedSessionKeys: pruneResult.removedSessionKeys,
        retention: await this.sessionStore.getRetentionState()
      }
    }

    const existing = await this.sessionStore.getSession(normalizedRoute)
    await this.clearPersistentSessionState(normalizedRoute)
    return {
      mode: 'clear',
      sessionKey: getAssistantSessionKey(normalizedRoute),
      cleared: Boolean(existing),
      retention: await this.sessionStore.getRetentionState(),
      taskState: this.getTaskState(normalizedRoute)
    }
  }

  async getRetentionState(): Promise<AssistantRetentionState> {
    return this.sessionStore.getRetentionState()
  }

  async cancelRoute(route: AssistantRoute): Promise<AssistantTaskState> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const sessionKey = getAssistantSessionKey(normalizedRoute)
    const current = this.getOrCreateTaskState(sessionKey)
    const queue = this.queuedRuns.get(sessionKey) || []
    const activeRunId = this.activeRuns.get(sessionKey)

    for (const runId of queue) {
      this.cancelledRuns.add(runId)
    }
    if (activeRunId) {
      this.cancelledRuns.add(activeRunId)
      this.runAbortControllers.get(activeRunId)?.abort('Chat execution cancelled.')
    }

    const updated = this.setTaskState(sessionKey, {
      cancelRequested: Boolean(activeRunId || queue.length > 0)
    })

    const session = await this.sessionStore.getSession(normalizedRoute)
    const affectedRuns = (session?.runs || []).filter(
      (run) =>
        run.status === 'queued' ||
        run.status === 'acknowledged' ||
        (activeRunId && run.runId === activeRunId)
    )

    await Promise.all(
      affectedRuns.map((run) =>
        this.sessionStore.upsertRun(normalizedRoute, {
          ...run,
          cancelRequested: true,
          updatedAt: Date.now()
        })
      )
    )

    return updated
  }

  async handleCommand(
    route: AssistantRoute,
    commandName: string,
    commandArgs?: string
  ): Promise<AssistantRuntimeResult> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const normalizedCommand = cleanString(commandName)?.toLowerCase() || ''
    const normalizedCommandArgs = cleanString(commandArgs)
    const taskState = this.getTaskState(normalizedRoute)
    const workspace = await this.resolveWorkspaceState(normalizedRoute)
    await syncMcpClientManager(this.configProvider())

    switch (normalizedCommand) {
      case 'new':
      case 'reset':
        await this.clearPersistentSessionState(normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          0,
          'Conversation history and reusable context cleared for this chat.',
          { taskState: this.getTaskState(normalizedRoute) }
        )
      case 'cleanup': {
        const parts = normalizedCommandArgs?.split(/\s+/).filter(Boolean) || []
        const mode = cleanString(parts[0])?.toLowerCase()
        if (!mode || mode === 'clear') {
          const result = await this.cleanupSession(normalizedRoute, { mode: 'clear' })
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            [
              `Cleanup mode: clear`,
              `Cleared: ${result.cleared ? 'yes' : 'no'}`,
              `Session key: ${result.sessionKey || getAssistantSessionKey(normalizedRoute)}`,
              `Remaining sessions: ${result.retention.sessionCount}`
            ].join('\n'),
            { taskState: this.getTaskState(normalizedRoute) }
          )
        }

        if (mode === 'prune') {
          const olderThanDays = Number(parts[1])
          if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
            return buildSystemReplyResult(
              normalizedRoute,
              await this.getSessionMessageCount(normalizedRoute),
              'Usage: /cleanup prune <olderThanDays>',
              { taskState }
            )
          }

          const result = await this.cleanupSession(normalizedRoute, {
            mode: 'prune',
            olderThanDays
          })
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            [
              `Cleanup mode: prune`,
              `Pruned sessions: ${result.prunedCount || 0}`,
              ...(result.removedSessionKeys?.length
                ? [`Removed: ${result.removedSessionKeys.join(', ')}`]
                : []),
              `Remaining sessions: ${result.retention.sessionCount}`
            ].join('\n'),
            { taskState }
          )
        }

        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /cleanup [clear | prune <olderThanDays>]',
          { taskState }
        )
      }
      case 'status': {
        const toolResult = await this.executionAdapter.callTool(
          MAGICPOT_SESSION_STATUS_TOOL_NAME,
          {},
          {
            config: this.configProvider(),
            route: normalizedRoute,
            sessionStore: this.sessionStore,
            taskState,
            workspaceMemoryFile: workspace.memoryFile,
            workspaceTaskContextFile: workspace.taskContextFile,
            workspaceContextFile: workspace.contextFile,
            workspacePinnedContextFile: workspace.pinnedContextFile,
            workspaceMetaFile: workspace.workspaceMetaFile,
            resumeRun: this.resumeRun.bind(this),
            resumeWorkflow: this.resumeWorkflow.bind(this)
          }
        )
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          toolResult.content,
          {
            taskState
          }
        )
      }
      case 'queue': {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          [
            `Running: ${taskState.running ? 'yes' : 'no'}`,
            `Queued: ${taskState.queuedCount}`,
            ...(taskState.activeRunId ? [`Active run: ${taskState.activeRunId}`] : []),
            ...(taskState.cancelRequested ? ['Cancel requested: yes'] : [])
          ].join('\n'),
          { taskState }
        )
      }
      case 'cancel': {
        const updatedTaskState = await this.cancelRoute(normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          updatedTaskState.running || updatedTaskState.queuedCount > 0
            ? 'Cancellation requested for the current bot task.'
            : 'There is no running or queued bot task to cancel.',
          { taskState: updatedTaskState }
        )
      }
      case 'continue': {
        const match = normalizedCommandArgs?.match(/^(\S+)\s+([\s\S]+)$/)
        if (!match) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /continue <runId> <message>',
            { taskState }
          )
        }

        return this.handleMessage({
          route: normalizedRoute,
          text: match[2],
          continueFromRunId: match[1]
        })
      }
      case 'resume': {
        const runId = cleanString(normalizedCommandArgs, 120)
        if (!runId) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /resume <runId>',
            { taskState }
          )
        }

        return this.resumeRun(normalizedRoute, runId)
      }
      case 'workflow-resume': {
        const workflowId = cleanString(normalizedCommandArgs, 120)
        if (!workflowId) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /workflow-resume <workflowId>',
            { taskState }
          )
        }

        return this.resumeWorkflow(workflowId, normalizedRoute)
      }
      case 'workspace': {
        if (normalizedCommandArgs) {
          const inspection = await this.getWorkspace(normalizedCommandArgs, { runLimit: 5 })
          if (!inspection) {
            return buildSystemReplyResult(
              normalizedRoute,
              await this.getSessionMessageCount(normalizedRoute),
              `Workspace not found: ${normalizedCommandArgs}`,
              { taskState }
            )
          }

          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            [
              `Workspace: ${inspection.workspaceId}`,
              `Status: ${inspection.status}`,
              `Access: ${inspection.accessMode}`,
              `Sessions: ${inspection.sessionCount}`,
              `Attached routes: ${inspection.attachedRoutes.length}`,
              ...(inspection.ownerSessionKey
                ? [`Owner session: ${inspection.ownerSessionKey}`]
                : []),
              ...(inspection.latestSessionUpdatedAt !== undefined
                ? [
                    `Latest session update: ${new Date(inspection.latestSessionUpdatedAt).toLocaleString()}`
                  ]
                : []),
              ...(inspection.latestRunUpdatedAt !== undefined
                ? [`Latest run update: ${new Date(inspection.latestRunUpdatedAt).toLocaleString()}`]
                : []),
              ...(inspection.sessions[0]
                ? [
                    '',
                    'Sessions:',
                    ...inspection.sessions
                      .slice(0, 3)
                      .map(
                        (session) =>
                          `${session.sessionKey} | messages=${session.messageCount} | updated=${new Date(session.updatedAt).toLocaleString()}`
                      )
                  ]
                : []),
              ...(inspection.recentRuns[0]
                ? [
                    '',
                    'Recent runs:',
                    ...inspection.recentRuns
                      .slice(0, 3)
                      .map(
                        (run) =>
                          `${run.runId} | status=${run.status} | origin=${run.runOrigin} | updated=${new Date(run.updatedAt).toLocaleString()}`
                      )
                  ]
                : [])
            ].join('\n'),
            { taskState }
          )
        }

        const toolResult = await this.executionAdapter.callTool(
          'workspace.context',
          {},
          {
            config: this.configProvider(),
            route: normalizedRoute,
            sessionStore: this.sessionStore,
            taskState,
            workspaceMemoryFile: workspace.memoryFile,
            workspaceTaskContextFile: workspace.taskContextFile,
            workspaceContextFile: workspace.contextFile,
            workspacePinnedContextFile: workspace.pinnedContextFile,
            workspaceMetaFile: workspace.workspaceMetaFile,
            resumeRun: this.resumeRun.bind(this),
            resumeWorkflow: this.resumeWorkflow.bind(this)
          }
        )
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          toolResult.content,
          { taskState }
        )
      }
      case 'attach': {
        const attachMatch = normalizedCommandArgs?.match(/^(\S+)(?:\s+(private|shared))?$/i)
        const workspaceId = cleanString(attachMatch?.[1], 120)
        const accessMode = cleanString(attachMatch?.[2], 20)?.toLowerCase() as
          | AssistantWorkspaceAccessMode
          | undefined
        if (!workspaceId) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /attach <workspaceId> [private|shared]',
            { taskState }
          )
        }

        try {
          const workspace = await this.attachWorkspace(normalizedRoute, workspaceId, {
            ...(accessMode ? { accessMode } : {})
          })
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            [
              `Attached route to workspace: ${workspace.workspaceId}`,
              `Access: ${workspace.accessMode}`,
              `Sessions: ${workspace.sessionCount}`,
              ...(workspace.title ? [`Title: ${workspace.title}`] : []),
              ...(workspace.description ? [`Description: ${workspace.description}`] : []),
              ...(workspace.sharedNotes?.length
                ? [
                    'Shared notes:',
                    ...workspace.sharedNotes.map((note, index) => `${index + 1}. ${note}`)
                  ]
                : [])
            ].join('\n'),
            { taskState }
          )
        } catch (error) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            error instanceof Error ? error.message : 'Failed to attach workspace.',
            { taskState }
          )
        }
      }
      case 'detach': {
        const result = await this.detachWorkspace(normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          result.detached
            ? [
                `Detached route from workspace: ${result.previousWorkspaceId}`,
                `Current workspace: ${result.workspace.workspaceId}`,
                ...(result.previousWorkspace?.status === 'archived'
                  ? [`Previous workspace status: ${result.previousWorkspace.status}`]
                  : []),
                `Current workspace sessions: ${result.workspace.sessionCount}`
              ].join('\n')
            : `Route already uses its default workspace identity: ${result.workspace.workspaceId}`,
          { taskState }
        )
      }
      case 'share':
      case 'privatize':
      case 'archive':
      case 'revive': {
        const workspaceId =
          cleanString(normalizedCommandArgs, 120) ||
          (await this.resolveWorkspaceState(normalizedRoute)).workspaceId
        try {
          const workspace = await this.manageWorkspace(
            normalizedRoute,
            normalizedCommand as AssistantWorkspaceGovernanceAction,
            workspaceId
          )
          const actionLabel =
            normalizedCommand === 'share'
              ? 'Shared'
              : normalizedCommand === 'privatize'
                ? 'Privatized'
                : normalizedCommand === 'archive'
                  ? 'Archived'
                  : 'Revived'
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            [
              `${actionLabel} workspace: ${workspace.workspaceId}`,
              `Status: ${workspace.status}`,
              `Access: ${workspace.accessMode}`,
              ...(workspace.ownerSessionKey ? [`Owner session: ${workspace.ownerSessionKey}`] : [])
            ].join('\n'),
            { taskState }
          )
        } catch (error) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            error instanceof Error ? error.message : 'Failed to manage workspace governance.',
            { taskState }
          )
        }
      }
      case 'workspaces': {
        const workspaces = await this.listWorkspaces(5)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          workspaces.length > 0
            ? workspaces
                .map((workspaceSummary, index) =>
                  [
                    `#${index + 1} ${workspaceSummary.workspaceId}`,
                    `status=${workspaceSummary.status}`,
                    `access=${workspaceSummary.accessMode}`,
                    `sessions=${workspaceSummary.sessionCount}`,
                    `routes=${workspaceSummary.attachedRoutes.length}`,
                    ...(workspaceSummary.latestRunUpdatedAt !== undefined
                      ? [
                          `latestRun=${new Date(workspaceSummary.latestRunUpdatedAt).toLocaleString()}`
                        ]
                      : []),
                    ...(workspaceSummary.latestSessionUpdatedAt !== undefined
                      ? [
                          `latestSession=${new Date(
                            workspaceSummary.latestSessionUpdatedAt
                          ).toLocaleString()}`
                        ]
                      : [])
                  ].join(' | ')
                )
                .join('\n')
            : 'No workspace identities have been recorded yet.',
          { taskState }
        )
      }
      case 'workflows': {
        const workflows = await this.listWorkflows(5, normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          workflows.length > 0
            ? workflows
                .map((workflowSummary, index) =>
                  [
                    `#${index + 1} ${workflowSummary.workflowId}`,
                    `status=${workflowSummary.status}`,
                    `runs=${workflowSummary.runCount}`,
                    `workspace=${workflowSummary.workspaceId}`,
                    `latestRun=${workflowSummary.latestRunId}`,
                    `updated=${new Date(workflowSummary.updatedAt).toLocaleString()}`
                  ].join(' | ')
                )
                .join('\n')
            : 'No persisted workflow records exist for this route yet.',
          { taskState }
        )
      }
      case 'pins':
      case 'notes': {
        const toolResult = await this.executionAdapter.callTool(
          'context.pinned',
          { action: 'list' },
          {
            config: this.configProvider(),
            route: normalizedRoute,
            sessionStore: this.sessionStore,
            taskState,
            workspaceMemoryFile: workspace.memoryFile,
            workspaceTaskContextFile: workspace.taskContextFile,
            workspaceContextFile: workspace.contextFile,
            workspacePinnedContextFile: workspace.pinnedContextFile,
            workspaceMetaFile: workspace.workspaceMetaFile,
            resumeRun: this.resumeRun.bind(this),
            resumeWorkflow: this.resumeWorkflow.bind(this)
          }
        )
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          toolResult.content,
          { taskState }
        )
      }
      case 'pin': {
        if (!normalizedCommandArgs) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /pin <note text>',
            { taskState }
          )
        }
        const toolResult = await this.executionAdapter.callTool(
          'context.pinned',
          {
            action: 'add',
            text: normalizedCommandArgs
          },
          {
            config: this.configProvider(),
            route: normalizedRoute,
            sessionStore: this.sessionStore,
            taskState,
            workspaceMemoryFile: workspace.memoryFile,
            workspaceTaskContextFile: workspace.taskContextFile,
            workspaceContextFile: workspace.contextFile,
            workspacePinnedContextFile: workspace.pinnedContextFile,
            workspaceMetaFile: workspace.workspaceMetaFile,
            resumeRun: this.resumeRun.bind(this),
            resumeWorkflow: this.resumeWorkflow.bind(this)
          }
        )
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          toolResult.content,
          { taskState }
        )
      }
      case 'unpin': {
        if (!normalizedCommandArgs) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /unpin <index|noteId|all>',
            { taskState }
          )
        }

        const lowerArgs = normalizedCommandArgs.toLowerCase()
        const toolArgs =
          lowerArgs === 'all' || lowerArgs === 'clear'
            ? { action: 'clear' as const }
            : Number.isFinite(Number(normalizedCommandArgs)) &&
                Number(normalizedCommandArgs) > 0 &&
                String(Math.trunc(Number(normalizedCommandArgs))) === normalizedCommandArgs
              ? {
                  action: 'remove' as const,
                  index: Math.trunc(Number(normalizedCommandArgs))
                }
              : {
                  action: 'remove' as const,
                  noteId: normalizedCommandArgs
                }

        const toolResult = await this.executionAdapter.callTool('context.pinned', toolArgs, {
          config: this.configProvider(),
          route: normalizedRoute,
          sessionStore: this.sessionStore,
          taskState,
          workspaceMemoryFile: workspace.memoryFile,
          workspaceTaskContextFile: workspace.taskContextFile,
          workspaceContextFile: workspace.contextFile,
          workspacePinnedContextFile: workspace.pinnedContextFile,
          workspaceMetaFile: workspace.workspaceMetaFile,
          resumeRun: this.resumeRun.bind(this),
          resumeWorkflow: this.resumeWorkflow.bind(this),
          startTaskGroup: this.startTaskGroup.bind(this),
          progressTaskGroup: this.progressTaskGroup.bind(this),
          approveTaskGroup: this.approveTaskGroup.bind(this),
          exportTaskGroup: this.exportTaskGroup.bind(this),
          cancelTaskGroup: this.cancelTaskGroup.bind(this),
          resumeTaskGroup: this.resumeTaskGroup.bind(this)
        })
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          toolResult.content,
          { taskState }
        )
      }
      case 'memory': {
        const memoryPreview =
          (await readAssistantMemoryPreview(workspace)) ||
          'No memory has been stored for this session yet.'
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          memoryPreview,
          { taskState }
        )
      }
      case 'session': {
        const summary = await this.getSessionSummary(normalizedRoute)
        if (!summary) {
          return buildSystemReplyResult(
            normalizedRoute,
            0,
            'No session has been stored for this route yet.',
            { taskState }
          )
        }

        const lines = [
          `Session: ${summary.sessionKey}`,
          ...(summary.workspace?.workspaceId
            ? [`Workspace: ${summary.workspace.workspaceId}`]
            : []),
          `Route: ${summary.route.channel}/${summary.route.scopeType}/${summary.route.scopeId}`,
          ...(summary.route.threadId ? [`Thread: ${summary.route.threadId}`] : []),
          `Messages: ${summary.messageCount}`,
          `Created: ${new Date(summary.createdAt).toLocaleString()}`,
          `Updated: ${new Date(summary.updatedAt).toLocaleString()}`,
          ...(summary.latestRun
            ? [
                `Latest run: ${summary.latestRun.runId}`,
                `Latest status: ${summary.latestRun.status}`,
                ...(summary.latestRun.profileId
                  ? [`Latest profile: ${summary.latestRun.profileId}`]
                  : []),
                ...(summary.latestRun.errorMessage
                  ? [`Latest error: ${summary.latestRun.errorMessage}`]
                  : [])
              ]
            : []),
          ...(summary.lastUserText ? [`Last user text: ${summary.lastUserText}`] : []),
          ...(summary.lastAssistantText
            ? [`Last assistant text: ${summary.lastAssistantText}`]
            : [])
        ]
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          lines.join('\n'),
          { taskState }
        )
      }
      case 'runs': {
        const runs = await this.listRuns(5, normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          runs.length > 0
            ? runs
                .map((run, index) =>
                  [
                    `#${index + 1} ${run.runId}`,
                    `status=${run.status}`,
                    `origin=${run.runOrigin}`,
                    `workspace=${run.workspaceId}`,
                    ...(run.parentRunId ? [`parent=${run.parentRunId}`] : []),
                    ...(run.profileId ? [`profile=${run.profileId}`] : []),
                    `updated=${new Date(run.updatedAt).toLocaleString()}`,
                    `artifacts=${run.artifactIds.length}`,
                    ...(run.errorMessage ? [`error=${run.errorMessage}`] : [])
                  ].join(' | ')
                )
                .join('\n')
            : 'No runs have been recorded for this session yet.',
          { taskState }
        )
      }
      case 'events': {
        const events = await this.listEvents(10, normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          events.length > 0
            ? events
                .map(
                  (event, index) =>
                    `#${index + 1} ${event.type} | ${new Date(event.createdAt).toLocaleString()} | ${event.message}`
                )
                .join('\n')
            : 'No runtime events have been recorded for this session yet.',
          { taskState }
        )
      }
      case 'artifacts': {
        const artifacts = await this.listArtifacts(10, normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          artifacts.length > 0
            ? artifacts
                .map((artifact, index) =>
                  [
                    `#${index + 1} ${artifact.artifactId}`,
                    `kind=${artifact.kind}`,
                    ...(artifact.fileName ? [`file=${artifact.fileName}`] : []),
                    ...(artifact.mimeType ? [`mime=${artifact.mimeType}`] : []),
                    ...(artifact.url ? [`url=${artifact.url}`] : []),
                    `source=${artifact.source}`
                  ].join(' | ')
                )
                .join('\n')
            : 'No artifacts have been recorded for this session yet.',
          { taskState }
        )
      }
      case 'ops': {
        const ops = await this.getOpsStatus(5, normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          [
            `Scope: ${ops.route ? getAssistantSessionKey(ops.route) : 'all sessions'}`,
            `Runs: ${ops.runCount}`,
            `Events: ${ops.eventCount}`,
            `Artifacts: ${ops.artifactCount}`,
            `Completed: ${ops.completedRunCount}`,
            `Failed: ${ops.failedRunCount}`,
            `Cancelled: ${ops.cancelledRunCount}`,
            `Queued: ${ops.queuedRunCount}`,
            `Running: ${ops.runningRunCount}`,
            ...(Number.isFinite(ops.averageQueueDelayMs)
              ? [`Average queue delay: ${ops.averageQueueDelayMs}ms`]
              : []),
            ...(Number.isFinite(ops.averageRunDurationMs)
              ? [`Average run duration: ${ops.averageRunDurationMs}ms`]
              : []),
            ...(ops.recentRuns[0]
              ? [
                  '',
                  'Recent runs:',
                  ...ops.recentRuns
                    .slice(0, 3)
                    .map((run) =>
                      [
                        run.runId,
                        `status=${run.status}`,
                        ...(run.durationMs !== undefined ? [`duration=${run.durationMs}ms`] : []),
                        ...(run.errorMessage ? [`error=${run.errorMessage}`] : [])
                      ].join(' | ')
                    )
                ]
              : [])
          ].join('\n'),
          { taskState }
        )
      }
      case 'trace': {
        const runId =
          normalizedCommandArgs ||
          (await this.listRuns(1, normalizedRoute)).map((run) => run.runId)[0] ||
          ''
        if (!runId) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /trace <runId>',
            { taskState }
          )
        }

        const trace = await this.getRunTrace(runId, normalizedRoute)
        if (!trace) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            `Run trace not found: ${runId}`,
            { taskState }
          )
        }

        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          [
            `Run: ${trace.runId}`,
            `Status: ${trace.status}`,
            `Events: ${trace.eventCount}`,
            `Artifacts: ${trace.artifactCount}`,
            `Tools: ${trace.toolCallCount}`,
            ...(trace.queueDelayMs !== undefined ? [`Queue delay: ${trace.queueDelayMs}ms`] : []),
            ...(trace.durationMs !== undefined ? [`Duration: ${trace.durationMs}ms`] : []),
            ...(trace.errorMessage ? [`Error: ${trace.errorMessage}`] : []),
            '',
            'Timeline:',
            ...trace.timeline.map(
              (entry, index) =>
                `#${index + 1} ${entry.type} | ${new Date(entry.createdAt).toLocaleString()} | ${entry.message}`
            )
          ].join('\n'),
          { taskState }
        )
      }
      case 'lineage': {
        const runId =
          normalizedCommandArgs ||
          (await this.listRuns(1, normalizedRoute)).map((run) => run.runId)[0] ||
          ''
        if (!runId) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /lineage <runId>',
            { taskState }
          )
        }

        const lineage = await this.getRunLineage(runId, normalizedRoute)
        if (!lineage) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            `Run lineage not found: ${runId}`,
            { taskState }
          )
        }

        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          [
            `Run: ${lineage.runId}`,
            `Status: ${lineage.status}`,
            `Origin: ${lineage.runOrigin}`,
            `Workspace: ${lineage.workspaceId}`,
            `Root: ${lineage.root.runId}`,
            ...(lineage.parentRunId ? [`Parent: ${lineage.parentRunId}`] : []),
            `Ancestors: ${lineage.ancestors.length}`,
            `Children: ${lineage.children.length}`,
            `Descendants: ${lineage.descendants.length}`,
            '',
            'Chain:',
            ...lineage.chain.map((run, index) =>
              [
                `#${index + 1} ${run.runId}`,
                `origin=${run.runOrigin}`,
                `status=${run.status}`,
                ...(run.parentRunId ? [`parent=${run.parentRunId}`] : []),
                `updated=${new Date(run.updatedAt).toLocaleString()}`
              ].join(' | ')
            )
          ].join('\n'),
          { taskState }
        )
      }
      case 'workflow': {
        const workflowId =
          normalizedCommandArgs ||
          (await this.listRuns(1, normalizedRoute)).map((run) => run.rootRunId || run.runId)[0] ||
          ''
        if (!workflowId) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            'Usage: /workflow <workflowId>',
            { taskState }
          )
        }

        const workflow = await this.getWorkflow(workflowId, normalizedRoute)
        if (!workflow) {
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            `Workflow not found: ${workflowId}`,
            { taskState }
          )
        }
        const workspaceInspection = await this.getWorkspace(workflow.workspaceId, {
          runLimit: 10
        })

        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          [
            `Workflow: ${workflow.workflowId}`,
            `Status: ${workflow.status}`,
            `Workspace: ${workflow.workspaceId}`,
            ...formatWorkspaceInspectionLines(workspaceInspection),
            `Root run: ${workflow.root.runId}`,
            `Latest run: ${workflow.latestRunId}`,
            `Runs: ${workflow.runCount}`,
            `Events: ${workflow.eventCount}`,
            `Artifacts: ${workflow.artifactCount}`,
            `Quality gate: ${workflow.qualityGate?.status || workflow.taskGroup?.qualityGate?.status || 'unknown'}`,
            ...(workflow.qualityGate?.summary
              ? [`Quality gate summary: ${workflow.qualityGate.summary}`]
              : []),
            ...(workflow.latestErrorMessage
              ? [`Latest error: ${workflow.latestErrorMessage}`]
              : []),
            ...(workflow.resumeEligibleRunIds.length > 0
              ? [`Resume eligible runs: ${workflow.resumeEligibleRunIds.join(', ')}`]
              : []),
            '',
            'Runs:',
            ...workflow.runs.map((run, index) =>
              [
                `#${index + 1} ${run.runId}`,
                `origin=${run.runOrigin}`,
                `status=${run.status}`,
                ...(run.parentRunId ? [`parent=${run.parentRunId}`] : []),
                `updated=${new Date(run.updatedAt).toLocaleString()}`
              ].join(' | ')
            )
          ].join('\n'),
          { taskState }
        )
      }
      case 'task':
      case 'task-group':
      case 'task-status':
      case 'tasks': {
        return this.handleTaskAliasCommand(
          normalizedRoute,
          normalizedCommand as 'task' | 'task-group' | 'task-status' | 'tasks',
          normalizedCommandArgs,
          taskState
        )
      }
      case 'tools': {
        const tools = this.listTools()
        if (normalizedCommandArgs) {
          const tool = tools.find((item) => item.name === normalizedCommandArgs)
          return buildSystemReplyResult(
            normalizedRoute,
            await this.getSessionMessageCount(normalizedRoute),
            tool
              ? formatAssistantToolDetail(tool)
              : `Tool not found: ${normalizedCommandArgs}\nUse /tools to list available tools.`,
            { taskState }
          )
        }

        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          formatAssistantToolList(tools),
          { taskState }
        )
      }
      case 'help':
      case 'start': {
        const count = await this.sessionStore.getMessageCount(normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          count,
          buildAssistantHelpText(normalizedRoute.channel),
          { taskState }
        )
      }
      default: {
        const count = await this.sessionStore.getMessageCount(normalizedRoute)
        return buildSystemReplyResult(
          normalizedRoute,
          count,
          `Unknown command: /${normalizedCommand}`,
          {
            taskState
          }
        )
      }
    }
  }

  getTaskState(route: AssistantRoute): AssistantTaskState {
    return this.getOrCreateTaskState(getAssistantSessionKey(normalizeAssistantRoute(route)))
  }

  subscribeEvents(route: AssistantRoute, listener: AssistantEventListener): () => void {
    const sessionKey = getAssistantSessionKey(normalizeAssistantRoute(route))
    const subscribers =
      this.routeEventSubscribers.get(sessionKey) || new Set<AssistantEventListener>()
    subscribers.add(listener)
    this.routeEventSubscribers.set(sessionKey, subscribers)

    return () => {
      const current = this.routeEventSubscribers.get(sessionKey)
      if (!current) return
      current.delete(listener)
      if (!current.size) {
        this.routeEventSubscribers.delete(sessionKey)
      }
    }
  }

  listTools(allowedToolNames?: string[] | null) {
    return this.executionAdapter.listTools(allowedToolNames)
  }

  async callTool(
    route: AssistantRoute,
    name: string,
    args: Record<string, unknown>,
    options?: {
      allowedToolNames?: string[] | null
    }
  ) {
    const normalizedRoute = normalizeAssistantRoute(route)
    const workspace = await this.resolveWorkspaceState(normalizedRoute)
    await syncMcpClientManager(this.configProvider())
    return this.executionAdapter.callTool(
      name,
      args,
      {
        config: this.configProvider(),
        route: normalizedRoute,
        sessionStore: this.sessionStore,
        taskState: this.getTaskState(normalizedRoute),
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile,
        resumeRun: this.resumeRun.bind(this),
        resumeWorkflow: this.resumeWorkflow.bind(this),
        startTaskGroup: this.startTaskGroup.bind(this),
        progressTaskGroup: this.progressTaskGroup.bind(this),
        approveTaskGroup: this.approveTaskGroup.bind(this),
        exportTaskGroup: this.exportTaskGroup.bind(this),
        cancelTaskGroup: this.cancelTaskGroup.bind(this),
        resumeTaskGroup: this.resumeTaskGroup.bind(this)
      },
      options
    )
  }

  async listEvents(limit?: number, route?: AssistantRoute): Promise<AssistantRunEvent[]> {
    return this.sessionStore.listEvents(limit, route ? normalizeAssistantRoute(route) : undefined)
  }

  async listArtifacts(limit?: number, route?: AssistantRoute): Promise<AssistantArtifactRef[]> {
    return this.sessionStore.listArtifacts(
      limit,
      route ? normalizeAssistantRoute(route) : undefined
    )
  }

  async getRun(runId: string, route?: AssistantRoute): Promise<AssistantRunRecord | null> {
    return this.sessionStore.getRun(runId, route ? normalizeAssistantRoute(route) : undefined)
  }

  async listRuns(limit?: number, route?: AssistantRoute): Promise<AssistantRunRecord[]> {
    return this.sessionStore.listRuns(limit, route ? normalizeAssistantRoute(route) : undefined)
  }

  async getRunTrace(runId: string, route?: AssistantRoute): Promise<AssistantRunTrace | null> {
    return this.sessionStore.getRunTrace(runId, route ? normalizeAssistantRoute(route) : undefined)
  }

  async getRunLineage(runId: string, route?: AssistantRoute): Promise<AssistantRunLineage | null> {
    return this.sessionStore.getRunLineage(
      runId,
      route ? normalizeAssistantRoute(route) : undefined
    )
  }

  async listWorkflows(limit?: number, route?: AssistantRoute): Promise<AssistantWorkflowSummary[]> {
    return this.sessionStore.listWorkflowSummaries({
      ...(limit !== undefined ? { limit } : {}),
      ...(route ? { route: normalizeAssistantRoute(route) } : {})
    })
  }

  async getWorkflow(
    workflowId: string,
    route?: AssistantRoute,
    options?: {
      runLimit?: number
      eventLimit?: number
      artifactLimit?: number
    }
  ): Promise<AssistantWorkflowInspection | null> {
    return this.sessionStore.getWorkflowInspection(workflowId, {
      ...(route ? { route: normalizeAssistantRoute(route) } : {}),
      ...(options?.runLimit !== undefined ? { runLimit: options.runLimit } : {}),
      ...(options?.eventLimit !== undefined ? { eventLimit: options.eventLimit } : {}),
      ...(options?.artifactLimit !== undefined ? { artifactLimit: options.artifactLimit } : {})
    })
  }

  async listTaskGroups(
    limit?: number,
    route?: AssistantRoute
  ): Promise<AssistantWorkflowSummary[]> {
    const workflows = await this.listWorkflows(limit, route)
    return workflows.filter((workflow) => Boolean(workflow.taskGroup))
  }

  async getTaskGroup(
    taskGroupId: string,
    route?: AssistantRoute
  ): Promise<AssistantWorkflowInspection | null> {
    const normalizedTaskGroupId = cleanString(taskGroupId, 120)
    if (!normalizedTaskGroupId) return null

    const workflows = await this.listWorkflows(1000, route)
    const workflow =
      workflows.find((item) => item.taskGroup?.taskGroupId === normalizedTaskGroupId) || null
    if (!workflow) return null

    return this.getWorkflow(workflow.workflowId, route, {
      runLimit: 50,
      eventLimit: 50,
      artifactLimit: 50
    })
  }

  private async findResumableTaskGroupWorkflow(
    taskGroupId: string,
    route?: AssistantRoute
  ): Promise<AssistantWorkflowInspection | null> {
    const normalizedTaskGroupId = cleanString(taskGroupId, 120)
    if (!normalizedTaskGroupId) return null

    const workflows = await this.listWorkflows(1000, route)
    const matchingWorkflows = workflows.filter(
      (workflow) =>
        workflow.taskGroup?.taskGroupId === normalizedTaskGroupId ||
        workflow.workflowId === normalizedTaskGroupId ||
        workflow.rootRunId === normalizedTaskGroupId ||
        workflow.latestRunId === normalizedTaskGroupId
    )
    if (matchingWorkflows.length === 0) return null

    const inspections = await Promise.all(
      matchingWorkflows.map(async (workflow) => ({
        workflow,
        inspection: await this.getWorkflow(workflow.workflowId, route, {
          runLimit: 50,
          eventLimit: 50,
          artifactLimit: 50
        })
      }))
    )

    const resumableInspection = inspections
      .filter(
        ({ inspection }) =>
          Boolean(inspection) && (inspection?.resumeEligibleRunIds?.length || 0) > 0
      )
      .sort((left, right) => {
        const leftInspection = left.inspection!
        const rightInspection = right.inspection!
        return (
          rightInspection.updatedAt - leftInspection.updatedAt ||
          rightInspection.createdAt - leftInspection.createdAt
        )
      })[0]?.inspection

    if (resumableInspection) {
      return resumableInspection
    }

    return (
      inspections
        .map(({ inspection }) => inspection)
        .filter((inspection): inspection is AssistantWorkflowInspection => Boolean(inspection))
        .sort(
          (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
        )[0] || null
    )
  }

  private async handleTaskAliasCommand(
    route: AssistantRoute,
    command: 'task' | 'task-group' | 'task-status' | 'tasks',
    commandArgs: string | undefined,
    taskState: AssistantTaskState
  ): Promise<AssistantRuntimeResult> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const normalizedArgs = cleanString(commandArgs)
    const explicitMatch = normalizedArgs?.match(/^([a-z0-9_-]+)(?:\s+([\s\S]+))?$/i)
    const defaultSubcommand = command === 'tasks' || command === 'task-status' ? 'list' : 'status'
    const subcommand = cleanString(explicitMatch?.[1], 32)?.toLowerCase() || defaultSubcommand
    const segments = splitTaskCommandArgs(explicitMatch?.[2])
    const taskGroupIdFallback =
      cleanString(taskState.taskGroup?.taskGroupId, 120) ||
      (await this.listWorkflows(1, normalizedRoute))[0]?.taskGroup?.taskGroupId ||
      (await this.listWorkflows(1, normalizedRoute))[0]?.workflowId ||
      ''
    const taskGroupId = cleanString(segments[0], 120) || taskGroupIdFallback

    if (subcommand === 'list' || subcommand === 'status') {
      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.list',
        {
          limit: 10
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroups?: AssistantWorkflowSummary[]
      }>(toolResult.content)
      const taskGroups = Array.isArray(payload?.taskGroups) ? payload.taskGroups : []

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task status: ${getAssistantSessionKey(normalizedRoute)}`,
          `Running: ${taskState.running ? 'yes' : 'no'}`,
          `Queued: ${taskState.queuedCount}`,
          ...(taskState.activeRunId ? [`Active run: ${taskState.activeRunId}`] : []),
          ...(taskState.taskGroup?.taskGroupId
            ? [`Active task group: ${taskState.taskGroup.taskGroupId}`]
            : []),
          ...(taskState.cancelRequested ? ['Cancel requested: yes'] : []),
          '',
          taskGroups.length > 0
            ? 'Task groups:'
            : 'No task-group workflows recorded for this route yet.',
          ...taskGroups.map((summary, index) => formatTaskGroupSummaryLine(summary, index))
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'inspect') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task inspect <taskGroupId>\nAlias: /task-group inspect <taskGroupId>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.inspect',
        {
          taskGroupId,
          runLimit: 10
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroup?: AssistantTaskGroupState | null
        workflow?: AssistantWorkflowInspection | null
      }>(toolResult.content)
      const inspection = payload?.workflow || null
      if (!inspection || !payload?.taskGroup) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          `Task group not found: ${taskGroupId}`,
          { taskState }
        )
      }
      const workspaceInspection = await this.getWorkspace(inspection.workspaceId, {
        runLimit: 10
      })

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        formatTaskGroupInspectionLikeLines({
          ...inspection,
          taskGroup: payload.taskGroup,
          workspaceInspection
        }).join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'start') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task start <taskGroupId> | <title> | <description>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.start',
        {
          taskGroupId,
          ...(segments[1] ? { title: segments[1] } : {}),
          ...(segments[2] ? { description: segments[2] } : {})
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroup?: AssistantTaskGroupState | null
        exportBundle?: Record<string, unknown> | null
      }>(toolResult.content)
      if (!payload?.taskGroup) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          `Task group not found: ${taskGroupId}`,
          { taskState }
        )
      }

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group started: ${payload.taskGroup.taskGroupId}`,
          `Status: ${payload.taskGroup.status}`,
          ...(payload.taskGroup.title ? [`Title: ${payload.taskGroup.title}`] : []),
          ...(payload.taskGroup.description
            ? [`Description: ${payload.taskGroup.description}`]
            : []),
          ...(payload.taskGroup.workspaceRunId
            ? [`Workspace run: ${payload.taskGroup.workspaceRunId}`]
            : [])
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'progress') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task progress <taskGroupId> | <label> | <completed> | <total> | <percent>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.progress',
        {
          taskGroupId,
          ...(segments[1] ? { label: segments[1] } : {}),
          ...(Number.isFinite(Number(segments[2])) ? { completed: Number(segments[2]) } : {}),
          ...(Number.isFinite(Number(segments[3])) ? { total: Number(segments[3]) } : {}),
          ...(Number.isFinite(Number(segments[4])) ? { percent: Number(segments[4]) } : {})
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroup?: AssistantTaskGroupState | null
        exportBundle?: Record<string, unknown> | null
      }>(toolResult.content)
      if (!payload?.taskGroup) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          `Task group not found: ${taskGroupId}`,
          { taskState }
        )
      }

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        formatTaskGroupInspectionLikeLines({
          workflowId: payload.taskGroup.taskGroupId,
          root: {
            runId: payload.taskGroup.rootRunId || payload.taskGroup.taskGroupId
          },
          workspaceId:
            payload.taskGroup.workspaceRunId ||
            taskState.activeRunId ||
            getAssistantSessionKey(normalizedRoute),
          status: mapTaskGroupStatusToRunStatus(payload.taskGroup.status),
          latestRunId: payload.taskGroup.workspaceRunId || payload.taskGroup.taskGroupId,
          runCount: 1,
          eventCount: 0,
          artifactCount: 0,
          taskGroup: payload.taskGroup
        }).join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'approve') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task approve <taskGroupId> | <approvedBy>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.approve',
        {
          taskGroupId,
          ...(segments[1] ? { approvedBy: segments[1] } : {})
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroup?: AssistantTaskGroupState | null
        exportBundle?: Record<string, unknown> | null
      }>(toolResult.content)
      if (!payload?.taskGroup) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          `Task group not found: ${taskGroupId}`,
          { taskState }
        )
      }

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group approved: ${payload.taskGroup.taskGroupId}`,
          `Status: ${payload.taskGroup.status}`,
          ...(payload.taskGroup.approvedBy ? [`Approved by: ${payload.taskGroup.approvedBy}`] : []),
          ...(payload.taskGroup.approvedAt
            ? [`Approved: ${new Date(payload.taskGroup.approvedAt).toLocaleString()}`]
            : [])
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'export') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task export <taskGroupId> | <exportTarget> | <artifactId,artifactId>',
          { taskState }
        )
      }

      const exportArtifactIds = segments[2]
        ? segments[2]
            .split(',')
            .map((item) => cleanString(item, 120))
            .filter((item): item is string => Boolean(item))
        : undefined
      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.export',
        {
          taskGroupId,
          ...(segments[1] ? { exportTarget: segments[1] } : {}),
          ...(exportArtifactIds ? { exportArtifactIds } : {})
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroup?: AssistantTaskGroupState | null
        exportBundle?: Record<string, unknown> | null
      }>(toolResult.content)
      if (!payload?.taskGroup) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          `Task group not found: ${taskGroupId}`,
          { taskState }
        )
      }

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group exported: ${payload.taskGroup.taskGroupId}`,
          `Status: ${payload.taskGroup.status}`,
          ...(payload.taskGroup.exportTarget
            ? [`Export target: ${payload.taskGroup.exportTarget}`]
            : []),
          ...(payload.taskGroup.exportArtifactIds?.length
            ? [`Export artifacts: ${payload.taskGroup.exportArtifactIds.join(', ')}`]
            : []),
          ...(payload.exportBundle ? ['Export bundle: ready'] : [])
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'cancel') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task cancel <taskGroupId>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.cancel',
        {
          taskGroupId
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        taskGroup?: AssistantTaskGroupState | null
      }>(toolResult.content)
      if (!payload?.taskGroup) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          `Task group not found: ${taskGroupId}`,
          { taskState }
        )
      }

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group cancelled: ${payload.taskGroup.taskGroupId}`,
          `Status: ${payload.taskGroup.status}`
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'resume') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task resume <taskGroupId>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.resume',
        {
          taskGroupId,
          async: segments[1]?.toLowerCase() === 'async' || segments[1]?.toLowerCase() === 'true'
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        result?: AssistantRuntimeResult
      }>(toolResult.content)

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group resumed: ${taskGroupId}`,
          ...(payload?.result?.runId ? [`Run: ${payload.result.runId}`] : []),
          ...(payload?.result?.status ? [`Status: ${payload.result.status}`] : []),
          ...(payload?.result?.reply?.content ? [`Reply: ${payload.result.reply.content}`] : [])
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'retry') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task retry <taskGroupId>',
          { taskState }
        )
      }

      const toolResult = await this.callTool(
        normalizedRoute,
        'task.group.retry',
        {
          taskGroupId,
          async: segments[1]?.toLowerCase() === 'async' || segments[1]?.toLowerCase() === 'true'
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        result?: AssistantRuntimeResult
      }>(toolResult.content)

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group retried: ${taskGroupId}`,
          ...(payload?.result?.runId ? [`Run: ${payload.result.runId}`] : []),
          ...(payload?.result?.status ? [`Status: ${payload.result.status}`] : []),
          ...(payload?.result?.reply?.content ? [`Reply: ${payload.result.reply.content}`] : [])
        ].join('\n'),
        { taskState }
      )
    }

    if (subcommand === 'replay') {
      if (!taskGroupId) {
        return buildSystemReplyResult(
          normalizedRoute,
          await this.getSessionMessageCount(normalizedRoute),
          'Usage: /task replay <taskGroupId>',
          { taskState }
        )
      }

      const workflow =
        (await this.findResumableTaskGroupWorkflow(taskGroupId, normalizedRoute)) ||
        (await this.getTaskGroup(taskGroupId, normalizedRoute)) ||
        (await this.getWorkflow(taskGroupId, normalizedRoute, {
          runLimit: 10,
          eventLimit: 10,
          artifactLimit: 10
        }))
      const latestResumeEligibleRunId =
        [...(workflow?.resumeEligibleRunIds || [])]
          .filter((runId): runId is string => Boolean(cleanString(runId, 120)))
          .at(-1) || undefined
      const replayRunId =
        latestResumeEligibleRunId ||
        workflow?.latestRunId ||
        workflow?.rootRunId ||
        workflow?.taskGroup?.workspaceRunId ||
        taskGroupId
      const toolResult = await this.callTool(
        normalizedRoute,
        'run.replay',
        {
          runId: replayRunId
        },
        {
          allowedToolNames: null
        }
      )
      const payload = parseJsonToolResult<{
        replay?: {
          trace?: AssistantRunTrace | null
          lineage?: AssistantRunLineage | null
          replayable?: boolean
          suggestedRetryTool?: string
        }
      }>(toolResult.content)
      const suggestedRetryTool =
        payload?.replay?.suggestedRetryTool || (latestResumeEligibleRunId ? 'run.retry' : undefined)

      return buildSystemReplyResult(
        normalizedRoute,
        await this.getSessionMessageCount(normalizedRoute),
        [
          `Task group replay: ${taskGroupId}`,
          `Replay run: ${replayRunId}`,
          ...(payload?.replay?.trace
            ? [`Trace events: ${payload.replay.trace.timeline.length}`]
            : []),
          ...(payload?.replay?.lineage
            ? [`Lineage chain: ${payload.replay.lineage.chain.length}`]
            : []),
          ...(payload?.replay?.replayable === false ? ['Replayable: no'] : ['Replayable: yes']),
          ...(suggestedRetryTool ? [`Retry tool: ${suggestedRetryTool}`] : [])
        ].join('\n'),
        { taskState }
      )
    }

    return buildSystemReplyResult(
      normalizedRoute,
      await this.getSessionMessageCount(normalizedRoute),
      [
        'Usage: /task [status | list | inspect <taskGroupId> | start <taskGroupId> | <title> | <description> | progress <taskGroupId> | <label> | <completed> | <total> | <percent> | approve <taskGroupId> | <approvedBy> | export <taskGroupId> | <exportTarget> | <artifactId,artifactId> | cancel <taskGroupId> | resume <taskGroupId> | retry <taskGroupId> | replay <taskGroupId>]',
        'Alias: /task-group ...',
        'Alias: /tasks',
        'Alias: /task-status'
      ].join('\n'),
      { taskState }
    )
  }

  async listAuditTimeline(options?: {
    limit?: number
    route?: AssistantRoute
    runId?: string
  }): Promise<AssistantAuditTimelineEntry[]> {
    return this.sessionStore.listAuditTimeline({
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.route ? { route: normalizeAssistantRoute(options.route) } : {}),
      ...(options?.runId ? { runId: options.runId } : {})
    })
  }

  async getOpsStatus(limit?: number, route?: AssistantRoute): Promise<AssistantOpsStatus> {
    return this.sessionStore.getOpsStatus({
      ...(limit !== undefined ? { limit } : {}),
      ...(route ? { route: normalizeAssistantRoute(route) } : {})
    })
  }

  async listWorkspaces(limit?: number): Promise<AssistantWorkspaceSummary[]> {
    return this.sessionStore.listWorkspaceSummaries(limit)
  }

  async getWorkspace(
    workspaceId: string,
    options?: {
      runLimit?: number
    }
  ): Promise<AssistantWorkspaceInspection | null> {
    return this.sessionStore.getWorkspaceInspection(workspaceId, options)
  }

  async attachWorkspace(
    route: AssistantRoute,
    workspaceId: string,
    options?: {
      accessMode?: AssistantWorkspaceAccessMode
      title?: string
      description?: string
      appendSharedNote?: string
      setSharedNotes?: string[]
    }
  ): Promise<AssistantWorkspaceInspection> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const config = this.configProvider()
    const { workspaceId: resolvedWorkspaceId } = await this.resolveWorkspaceState(
      normalizedRoute,
      workspaceId
    )
    const workspace = await ensureAssistantWorkspaceState(normalizedRoute, resolvedWorkspaceId)
    await ensureAssistantWorkspaceBinding(workspace, normalizedRoute, {
      ...(options?.accessMode ? { accessMode: options.accessMode } : {})
    })
    if (
      options?.accessMode ||
      options?.title ||
      options?.description ||
      options?.appendSharedNote ||
      options?.setSharedNotes
    ) {
      await updateAssistantWorkspaceMeta(workspace, {
        ...(options.accessMode ? { accessMode: options.accessMode } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.appendSharedNote ? { appendSharedNote: options.appendSharedNote } : {}),
        ...(options.setSharedNotes ? { setSharedNotes: options.setSharedNotes } : {})
      })
    }
    const contextSnapshot = buildAssistantContextSnapshot(
      normalizedRoute,
      config,
      workspace.workspaceId
    )
    await persistAssistantContextSnapshot(workspace, contextSnapshot)
    await this.sessionStore.attachWorkspace(normalizedRoute, workspace, contextSnapshot)
    return (
      (await this.getWorkspace(workspace.workspaceId, { runLimit: 20 })) ||
      this.buildWorkspaceInspectionFallback(normalizedRoute, workspace)
    )
  }

  async detachWorkspace(route: AssistantRoute): Promise<{
    detached: boolean
    previousWorkspaceId: string
    workspace: AssistantWorkspaceInspection
    previousWorkspace?: AssistantWorkspaceInspection | null
  }> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const config = this.configProvider()
    const currentWorkspace = await this.resolveWorkspaceState(normalizedRoute)
    const defaultWorkspace = getAssistantWorkspaceState(normalizedRoute)
    const detached = currentWorkspace.workspaceId !== defaultWorkspace.workspaceId

    if (detached) {
      await detachAssistantWorkspaceBinding(currentWorkspace.workspaceId, normalizedRoute)
    }

    const { workspace, contextSnapshot } = await this.prepareSession(
      normalizedRoute,
      config,
      defaultWorkspace.workspaceId
    )
    await persistAssistantContextSnapshot(workspace, contextSnapshot)
    await this.sessionStore.attachWorkspace(normalizedRoute, workspace, contextSnapshot)

    return {
      detached,
      previousWorkspaceId: currentWorkspace.workspaceId,
      workspace:
        (await this.getWorkspace(workspace.workspaceId, { runLimit: 20 })) ||
        this.buildWorkspaceInspectionFallback(normalizedRoute, workspace),
      ...(detached
        ? {
            previousWorkspace: await this.getWorkspace(currentWorkspace.workspaceId, {
              runLimit: 20
            })
          }
        : {})
    }
  }

  async manageWorkspace(
    route: AssistantRoute,
    action: AssistantWorkspaceGovernanceAction,
    workspaceId?: string
  ): Promise<AssistantWorkspaceInspection> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const targetWorkspaceId =
      cleanString(workspaceId, 120) ||
      (await this.resolveWorkspaceState(normalizedRoute)).workspaceId
    const workspace = await ensureAssistantWorkspaceState(normalizedRoute, targetWorkspaceId)
    await manageAssistantWorkspaceGovernance(workspace, normalizedRoute, action)
    return (
      (await this.getWorkspace(workspace.workspaceId, { runLimit: 20 })) ||
      this.buildWorkspaceInspectionFallback(normalizedRoute, workspace)
    )
  }

  async startTaskGroup(
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ): Promise<AssistantTaskGroupState | null> {
    return this.recordTaskGroupAction(route, 'start', options)
  }

  async progressTaskGroup(
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      label?: string
      completed?: number
      total?: number
      percent?: number
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ): Promise<AssistantTaskGroupState | null> {
    return this.recordTaskGroupAction(route, 'progress', options)
  }

  async approveTaskGroup(
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      approvedBy?: string
      workspaceRunId?: string
    }
  ): Promise<AssistantTaskGroupState | null> {
    return this.recordTaskGroupAction(route, 'approve', options)
  }

  async exportTaskGroup(
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      exportTarget?: string
      exportArtifactIds?: string[]
      workspaceRunId?: string
    }
  ): Promise<AssistantTaskGroupState | null> {
    return this.recordTaskGroupAction(route, 'export', options)
  }

  async cancelTaskGroup(
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      workspaceRunId?: string
    }
  ): Promise<AssistantTaskGroupState | null> {
    await this.cancelRoute(route)
    return this.recordTaskGroupAction(route, 'cancel', options)
  }

  async resumeTaskGroup(
    route: AssistantRoute,
    taskGroupId: string,
    options?: {
      async?: boolean
    }
  ): Promise<AssistantRuntimeResult> {
    const normalizedRoute = normalizeAssistantRoute(route)
    const workflow = await this.findResumableTaskGroupWorkflow(taskGroupId, normalizedRoute)
    return this.resumeWorkflow(workflow?.workflowId || taskGroupId, normalizedRoute, options)
  }

  async getSession(route: AssistantRoute): Promise<AssistantSessionRecord | null> {
    return this.sessionStore.getSession(route)
  }

  async getSessionSummary(route: AssistantRoute): Promise<AssistantSessionSummary | null> {
    return this.sessionStore.getSessionSummary(route)
  }

  async listSessions(limit?: number): Promise<AssistantSessionSummary[]> {
    return this.sessionStore.listSessionSummaries(limit)
  }

  async getSessionMessageCount(route: AssistantRoute): Promise<number> {
    return this.sessionStore.getMessageCount(route)
  }

  async flush(): Promise<void> {
    await this.sessionStore.flush()
  }
}

let runtimeSingleton: AssistantRuntime | null = null

export const getAssistantRuntime = (): AssistantRuntime => {
  if (!runtimeSingleton) {
    runtimeSingleton = new AssistantRuntime()
  }
  return runtimeSingleton
}
