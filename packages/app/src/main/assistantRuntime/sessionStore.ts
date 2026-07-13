import fs from 'fs/promises'
import path from 'path'
import { ChatMessage } from '@shared/api/svcLLMProxy'
import { getBuildEnv } from '../config/buildEnv'
import { writeJsonFileAtomic } from '../magicAgentRuntime/graph/jsonPersistence'
import {
  AssistantArtifactRef,
  AssistantContextSnapshot,
  AssistantResumeMode,
  AssistantRunEvent,
  AssistantRunRecord,
  AssistantRunOrigin,
  AssistantRoute,
  AssistantSessionRecord,
  AssistantSessionSummary,
  AssistantQualityGateState,
  AssistantTaskGroupState,
  AssistantWorkspaceInspection,
  AssistantWorkspaceMeta,
  AssistantWorkspaceSummary,
  AssistantWorkspaceState,
  getAssistantSessionKey,
  normalizeAssistantRoute
} from './types'
import {
  getAssistantWorkspaceIdentityState,
  isDefaultAssistantWorkspaceId,
  getAssistantWorkspaceState,
  listAssistantWorkspaceMetas
} from './workspace'

type PersistedSessionFile = {
  version: 1 | 2 | 3
  sessions: AssistantSessionRecord[]
  workflows?: AssistantWorkflowRecord[]
}

const STORE_FILENAME = 'chat-sessions.json'
export const ASSISTANT_SESSION_STORE_LIMITS = {
  minHistoryMessages: 2,
  maxHistoryMessages: 100,
  maxRunRecords: 100,
  maxEventLogEntries: 400,
  maxArtifactRecords: 200
} as const

export type AssistantRetentionState = {
  sessionCount: number
  totalMessageCount: number
  totalRunCount: number
  totalEventCount: number
  totalArtifactCount: number
  oldestUpdatedAt?: number
  newestUpdatedAt?: number
  limits: typeof ASSISTANT_SESSION_STORE_LIMITS
}

export type AssistantPruneResult = {
  removedCount: number
  removedSessionKeys: string[]
  removedSessions: Array<Pick<AssistantSessionRecord, 'sessionKey' | 'route' | 'updatedAt'>>
  retention: AssistantRetentionState
}

export type AssistantRunTraceEntry = {
  traceId: string
  runId: string
  sessionKey: string
  route: AssistantRoute
  category: 'event' | 'artifact'
  type: AssistantRunEvent['type'] | 'artifact'
  level: AssistantRunEvent['level']
  message: string
  createdAt: number
  metadata?: Record<string, unknown>
  artifact?: Pick<
    AssistantArtifactRef,
    'artifactId' | 'kind' | 'url' | 'mimeType' | 'fileName' | 'source'
  >
}

export type AssistantRunTrace = {
  runId: string
  sessionKey: string
  workspaceId: string
  route: AssistantRoute
  status: AssistantRunRecord['status']
  runOrigin: AssistantRunRecord['runOrigin']
  rootRunId: string
  parentRunId?: string
  resumeSourceRunId?: string
  resumeAttempt?: number
  resumeMode?: AssistantResumeMode
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  queueDelayMs?: number
  durationMs?: number
  toolCallCount: number
  artifactCount: number
  eventCount: number
  requestText?: string
  responseText?: string
  errorMessage?: string
  timeline: AssistantRunTraceEntry[]
}

export type AssistantRunLineage = {
  runId: string
  sessionKey: string
  workspaceId: string
  route: AssistantRoute
  status: AssistantRunRecord['status']
  runOrigin: AssistantRunRecord['runOrigin']
  rootRunId: string
  parentRunId?: string
  resumeSourceRunId?: string
  resumeAttempt?: number
  resumeMode?: AssistantResumeMode
  createdAt: number
  updatedAt: number
  resumeEligible: boolean
  resumeBlockedReason?: string
  root: AssistantRunRecord
  ancestors: AssistantRunRecord[]
  children: AssistantRunRecord[]
  descendants: AssistantRunRecord[]
  chain: AssistantRunRecord[]
}

export type AssistantWorkflowSummary = {
  workflowId: string
  rootRunId: string
  workspaceId: string
  route: AssistantRoute
  sessionKeys: string[]
  status: AssistantRunRecord['status']
  createdAt: number
  updatedAt: number
  latestRunId: string
  latestErrorMessage?: string
  runCount: number
  eventCount: number
  artifactCount: number
  runOrigins: AssistantRunOrigin[]
  taskGroup?: AssistantTaskGroupState
  qualityGate?: AssistantQualityGateState
}

export type AssistantWorkflowRecord = AssistantWorkflowSummary & {
  recordVersion: 1
  runIds: string[]
  resumeEligibleRunIds: string[]
}

export type AssistantWorkflowInspection = AssistantWorkflowRecord & {
  root: AssistantRunRecord
  runs: AssistantRunRecord[]
  recentEvents: AssistantRunEvent[]
  recentArtifacts: AssistantArtifactRef[]
}

export type AssistantAuditTimelineEntry = {
  entryId: string
  sessionKey: string
  route: AssistantRoute
  runId: string
  workspaceId?: string
  category: 'event' | 'artifact'
  type: AssistantRunEvent['type'] | 'artifact'
  level: AssistantRunEvent['level']
  message: string
  createdAt: number
  status?: AssistantRunRecord['status']
  runOrigin?: AssistantRunRecord['runOrigin']
  rootRunId?: string
  parentRunId?: string
  resumeSourceRunId?: string
  resumeAttempt?: number
  resumeMode?: AssistantResumeMode
  artifactId?: string
  artifactKind?: AssistantArtifactRef['kind']
  metadata?: Record<string, unknown>
}

export type AssistantOpsRunSummary = {
  runId: string
  sessionKey: string
  workspaceId: string
  route: AssistantRoute
  status: AssistantRunRecord['status']
  runOrigin: AssistantRunRecord['runOrigin']
  rootRunId: string
  parentRunId?: string
  resumeSourceRunId?: string
  resumeAttempt?: number
  resumeMode?: AssistantResumeMode
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  queueDelayMs?: number
  durationMs?: number
  toolCallCount: number
  artifactCount: number
  eventCount: number
  errorMessage?: string
}

export type AssistantOpsChannelSummary = {
  channel: string
  sessionCount: number
  runCount: number
  eventCount: number
  artifactCount: number
  completedRunCount: number
  failedRunCount: number
  cancelledRunCount: number
  queuedRunCount: number
  runningRunCount: number
  acknowledgedRunCount: number
  newestUpdatedAt?: number
}

export type AssistantOpsStatus = {
  generatedAt: number
  route?: AssistantRoute
  sessionCount: number
  runCount: number
  eventCount: number
  artifactCount: number
  completedRunCount: number
  failedRunCount: number
  cancelledRunCount: number
  queuedRunCount: number
  runningRunCount: number
  acknowledgedRunCount: number
  averageQueueDelayMs?: number
  averageRunDurationMs?: number
  failureRate: number
  cancellationRate: number
  retention: AssistantRetentionState
  recentRuns: AssistantOpsRunSummary[]
  channels: AssistantOpsChannelSummary[]
}

const clampHistorySize = (value: number): number =>
  Math.min(
    ASSISTANT_SESSION_STORE_LIMITS.maxHistoryMessages,
    Math.max(ASSISTANT_SESSION_STORE_LIMITS.minHistoryMessages, value)
  )

const toPreviewText = (value?: string | null): string | undefined => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

const getRunResumeEligibility = (
  run: Pick<AssistantRunRecord, 'status' | 'requestText'>
): { resumeEligible: boolean; resumeBlockedReason?: string } => {
  if (!['failed', 'cancelled'].includes(run.status)) {
    return {
      resumeEligible: false,
      resumeBlockedReason: 'Only failed or cancelled runs can be resumed.'
    }
  }

  if (!cleanString(run.requestText)) {
    return {
      resumeEligible: false,
      resumeBlockedReason: 'Run has no stored request text to resume.'
    }
  }

  return { resumeEligible: true }
}

const cleanString = (value?: string | null, maxLength = 400): string | undefined => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized
}

const RUN_REQUEST_TEXT_MAX_LENGTH = 120_000
const RUN_RESPONSE_TEXT_MAX_LENGTH = 120_000
const RUN_ERROR_TEXT_MAX_LENGTH = 8_000

const QUALITY_GATE_STATUSES = new Set<AssistantQualityGateState['status']>([
  'unknown',
  'pending',
  'passing',
  'warning',
  'failed'
])

const normalizeQualityGateState = (
  qualityGate?: Partial<AssistantQualityGateState> | null
): AssistantQualityGateState | undefined => {
  const gateId = cleanString(qualityGate?.gateId, 120)
  if (!gateId) return undefined

  const status = cleanString(qualityGate?.status, 32)
  const checks = Array.isArray(qualityGate?.checks)
    ? qualityGate.checks
        .map((check) => {
          const checkId = cleanString(check?.checkId, 120)
          const checkStatus = cleanString(check?.status, 32)
          if (
            !checkId ||
            !checkStatus ||
            !QUALITY_GATE_STATUSES.has(checkStatus as AssistantQualityGateState['status'])
          ) {
            return undefined
          }

          return {
            checkId,
            ...(cleanString(check?.label, 120) ? { label: cleanString(check?.label, 120) } : {}),
            status: checkStatus as AssistantQualityGateState['status'],
            ...(cleanString(check?.detail, 400) ? { detail: cleanString(check?.detail, 400) } : {}),
            updatedAt: Number.isFinite(check?.updatedAt) ? Number(check?.updatedAt) : Date.now()
          }
        })
        .filter((check): check is NonNullable<typeof check> => Boolean(check))
    : []

  return {
    gateId,
    status:
      status && QUALITY_GATE_STATUSES.has(status as AssistantQualityGateState['status'])
        ? (status as AssistantQualityGateState['status'])
        : 'unknown',
    updatedAt: Number.isFinite(qualityGate?.updatedAt)
      ? Number(qualityGate?.updatedAt)
      : Date.now(),
    ...(cleanString(qualityGate?.summary, 400)
      ? { summary: cleanString(qualityGate?.summary, 400) }
      : {}),
    ...(checks.length ? { checks } : {})
  }
}

const normalizeTaskGroupState = (
  taskGroup?: Partial<AssistantTaskGroupState> | null
): AssistantTaskGroupState | undefined => {
  const taskGroupId = cleanString(taskGroup?.taskGroupId, 120)
  if (!taskGroupId) return undefined

  const status = cleanString(taskGroup?.status, 32)
  const approvedBy = cleanString(taskGroup?.approvedBy, 120)
  const exportTarget = cleanString(taskGroup?.exportTarget, 400)
  const workspaceRunId = cleanString(taskGroup?.workspaceRunId, 120)
  const rootRunId = cleanString(taskGroup?.rootRunId, 120)
  const approvedAt = Number.isFinite(taskGroup?.approvedAt)
    ? Number(taskGroup?.approvedAt)
    : undefined
  const exportedAt = Number.isFinite(taskGroup?.exportedAt)
    ? Number(taskGroup?.exportedAt)
    : undefined
  const exportArtifactIds = Array.isArray(taskGroup?.exportArtifactIds)
    ? taskGroup.exportArtifactIds
        .map((artifactId) => cleanString(artifactId, 120))
        .filter((artifactId): artifactId is string => Boolean(artifactId))
    : []
  const updatedAt = Number.isFinite(taskGroup?.updatedAt)
    ? Number(taskGroup?.updatedAt)
    : Date.now()
  const statusValue =
    status &&
    ['draft', 'running', 'waiting-approval', 'approved', 'exported', 'cancelled'].includes(status)
      ? (status as AssistantTaskGroupState['status'])
      : 'draft'
  const qualityGate =
    normalizeQualityGateState(taskGroup?.qualityGate) ||
    normalizeQualityGateState({
      gateId: `${taskGroupId}:quality-gate`,
      status:
        statusValue === 'approved' || statusValue === 'exported'
          ? 'passing'
          : statusValue === 'cancelled'
            ? 'failed'
            : statusValue === 'running'
              ? 'pending'
              : 'unknown',
      updatedAt,
      ...(cleanString(taskGroup?.title, 160)
        ? { summary: `${cleanString(taskGroup?.title, 160)} quality gate` }
        : {}),
      checks: [
        {
          checkId: `${taskGroupId}:status`,
          ...(cleanString(taskGroup?.title, 160)
            ? { label: cleanString(taskGroup?.title, 160) }
            : {}),
          status:
            statusValue === 'approved' || statusValue === 'exported'
              ? 'passing'
              : statusValue === 'cancelled'
                ? 'failed'
                : statusValue === 'running'
                  ? 'pending'
                  : 'unknown',
          ...(cleanString(taskGroup?.description, 600)
            ? { detail: cleanString(taskGroup?.description, 600) }
            : {}),
          updatedAt
        }
      ]
    })
  return {
    taskGroupId,
    ...(cleanString(taskGroup?.title, 160) ? { title: cleanString(taskGroup?.title, 160) } : {}),
    ...(cleanString(taskGroup?.description, 600)
      ? { description: cleanString(taskGroup?.description, 600) }
      : {}),
    status: statusValue,
    ...(taskGroup?.progress
      ? {
          progress: {
            ...(Number.isFinite(taskGroup.progress.completed)
              ? { completed: Number(taskGroup.progress.completed) }
              : {}),
            ...(Number.isFinite(taskGroup.progress.total)
              ? { total: Number(taskGroup.progress.total) }
              : {}),
            ...(Number.isFinite(taskGroup.progress.percent)
              ? { percent: Number(taskGroup.progress.percent) }
              : {}),
            ...(cleanString(taskGroup.progress.label, 160)
              ? { label: cleanString(taskGroup.progress.label, 160) }
              : {}),
            updatedAt: Number.isFinite(taskGroup.progress.updatedAt)
              ? Number(taskGroup.progress.updatedAt)
              : Date.now()
          }
        }
      : {}),
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(approvedBy ? { approvedBy } : {}),
    ...(exportedAt !== undefined ? { exportedAt } : {}),
    ...(exportTarget ? { exportTarget } : {}),
    ...(exportArtifactIds.length ? { exportArtifactIds } : {}),
    ...(workspaceRunId ? { workspaceRunId } : {}),
    ...(rootRunId ? { rootRunId } : {}),
    qualityGate,
    updatedAt
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const computeQueueDelayMs = (
  run: Pick<AssistantRunRecord, 'createdAt' | 'startedAt'>
): number | undefined =>
  isFiniteNumber(run.startedAt) ? Math.max(0, run.startedAt - run.createdAt) : undefined

const computeDurationMs = (
  run: Pick<AssistantRunRecord, 'startedAt' | 'finishedAt'>
): number | undefined =>
  isFiniteNumber(run.startedAt) && isFiniteNumber(run.finishedAt)
    ? Math.max(0, run.finishedAt - run.startedAt)
    : undefined

const roundRate = (value: number): number => Math.round(value * 1000) / 1000

const normalizeContextSnapshot = (
  route: AssistantRoute,
  sessionKey: string,
  workspaceId: string,
  snapshot?: Partial<AssistantContextSnapshot>
): AssistantContextSnapshot | undefined => {
  if (!snapshot) return undefined

  return {
    clientId: cleanString(snapshot.clientId, 160) || 'unknown-client',
    sessionKey,
    workspaceId: cleanString(snapshot.workspaceId, 120) || workspaceId,
    route: normalizeAssistantRoute(snapshot.route || route),
    generatedAt: isFiniteNumber(snapshot.generatedAt) ? Number(snapshot.generatedAt) : Date.now(),
    workflowDir: cleanString(snapshot.workflowDir, 400) || '',
    outputDir: cleanString(snapshot.outputDir, 400) || '',
    downloadDir: cleanString(snapshot.downloadDir, 400) || '',
    useRemoteComfyUI: Boolean(snapshot.useRemoteComfyUI),
    useRemoteLLM: Boolean(snapshot.useRemoteLLM),
    localLLMServerEnabled: Boolean(snapshot.localLLMServerEnabled)
  }
}

const normalizeRunRecord = (
  fallbackRoute: AssistantRoute,
  fallbackWorkspaceId: string,
  run?: Partial<AssistantRunRecord> | null
): AssistantRunRecord | null => {
  const runId = cleanString(run?.runId, 120)
  if (!runId) return null

  const route = normalizeAssistantRoute(run?.route || fallbackRoute)
  const sessionKey = getAssistantSessionKey(route)
  const workspaceId = cleanString(run?.workspaceId, 120) || fallbackWorkspaceId
  const parentRunId = cleanString(run?.parentRunId, 120)
  const rootRunId = cleanString(run?.rootRunId, 120) || parentRunId || runId
  const resumeSourceRunId = cleanString(run?.resumeSourceRunId, 120)

  return {
    runId,
    sessionKey,
    workspaceId,
    route,
    status: run?.status || 'queued',
    runOrigin: run?.runOrigin || 'new',
    rootRunId,
    ...(parentRunId ? { parentRunId } : {}),
    ...(resumeSourceRunId ? { resumeSourceRunId } : {}),
    ...(isFiniteNumber(run?.resumeAttempt) ? { resumeAttempt: Number(run?.resumeAttempt) } : {}),
    ...(cleanString(run?.resumeMode, 32)
      ? { resumeMode: cleanString(run?.resumeMode, 32) as AssistantResumeMode }
      : {}),
    createdAt: isFiniteNumber(run?.createdAt) ? Number(run?.createdAt) : Date.now(),
    updatedAt: isFiniteNumber(run?.updatedAt) ? Number(run?.updatedAt) : Date.now(),
    ...(isFiniteNumber(run?.startedAt) ? { startedAt: Number(run?.startedAt) } : {}),
    ...(isFiniteNumber(run?.finishedAt) ? { finishedAt: Number(run?.finishedAt) } : {}),
    ...(isFiniteNumber(run?.queuePosition) ? { queuePosition: Number(run?.queuePosition) } : {}),
    ...(cleanString(run?.requestText, RUN_REQUEST_TEXT_MAX_LENGTH)
      ? { requestText: cleanString(run?.requestText, RUN_REQUEST_TEXT_MAX_LENGTH) }
      : {}),
    ...(cleanString(run?.responseText, RUN_RESPONSE_TEXT_MAX_LENGTH)
      ? { responseText: cleanString(run?.responseText, RUN_RESPONSE_TEXT_MAX_LENGTH) }
      : {}),
    ...(cleanString(run?.profileId, 160) ? { profileId: cleanString(run?.profileId, 160) } : {}),
    ...(cleanString(run?.errorMessage, RUN_ERROR_TEXT_MAX_LENGTH)
      ? { errorMessage: cleanString(run?.errorMessage, RUN_ERROR_TEXT_MAX_LENGTH) }
      : {}),
    ...(typeof run?.cancelRequested === 'boolean' ? { cancelRequested: run.cancelRequested } : {}),
    toolCalls: Array.isArray(run?.toolCalls) ? run.toolCalls : [],
    artifactIds: Array.isArray(run?.artifactIds)
      ? run.artifactIds
          .map((artifactId) => cleanString(artifactId, 120))
          .filter((artifactId): artifactId is string => Boolean(artifactId))
      : [],
    ...(run?.taskGroup ? { taskGroup: normalizeTaskGroupState(run.taskGroup) } : {}),
    ...(run?.lineage ? { lineage: run.lineage } : {})
  }
}

const toSessionSummary = (record: AssistantSessionRecord): AssistantSessionSummary => {
  const userMessages = record.messages.filter((message) => message.role === 'user')
  const assistantMessages = record.messages.filter((message) => message.role === 'assistant')

  return {
    sessionKey: record.sessionKey,
    route: record.route,
    messageCount: record.messages.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    workspace: record.workspace,
    ...(record.runs.length > 0
      ? {
          latestRun: ((latestRun) => ({
            runId: latestRun.runId,
            status: latestRun.status,
            updatedAt: latestRun.updatedAt,
            profileId: latestRun.profileId,
            queuePosition: latestRun.queuePosition,
            errorMessage: latestRun.errorMessage
          }))(record.runs[record.runs.length - 1])
        }
      : {}),
    ...(toPreviewText(userMessages[userMessages.length - 1]?.content)
      ? { lastUserText: toPreviewText(userMessages[userMessages.length - 1]?.content) }
      : {}),
    ...(toPreviewText(assistantMessages[assistantMessages.length - 1]?.content)
      ? {
          lastAssistantText: toPreviewText(assistantMessages[assistantMessages.length - 1]?.content)
        }
      : {})
  }
}

const dedupeWorkspaceRoutes = (routes: AssistantRoute[]): AssistantRoute[] => {
  const unique = new Map<string, AssistantRoute>()
  for (const route of routes) {
    unique.set(getAssistantSessionKey(route), route)
  }
  return [...unique.values()]
}

const buildWorkspaceSummary = (
  workspaceId: string,
  sessions: AssistantSessionRecord[],
  metadata?: AssistantWorkspaceMeta
): AssistantWorkspaceSummary => {
  const workspaceState = getAssistantWorkspaceIdentityState(workspaceId)
  const ownerRoute = metadata?.ownerRoute || (sessions.length === 1 ? sessions[0].route : undefined)
  const ownerSessionKey =
    metadata?.ownerSessionKey || (ownerRoute ? getAssistantSessionKey(ownerRoute) : undefined)
  const accessMode =
    metadata?.accessMode ||
    (ownerRoute && isDefaultAssistantWorkspaceId(ownerRoute, workspaceId) ? 'private' : 'shared')
  const latestSessionUpdatedAt =
    sessions.length > 0 ? Math.max(...sessions.map((session) => session.updatedAt)) : undefined
  const latestRunUpdatedAt = sessions
    .flatMap((session) => session.runs.map((run) => run.updatedAt))
    .reduce<number | undefined>((latest, updatedAt) => Math.max(latest || 0, updatedAt), undefined)
  const createdAtCandidates = [
    metadata?.createdAt,
    ...sessions.map((session) => session.createdAt).filter((value) => Number.isFinite(value))
  ].filter((value): value is number => value !== undefined)
  const updatedAtCandidates = [
    metadata?.updatedAt,
    latestSessionUpdatedAt,
    latestRunUpdatedAt
  ].filter((value): value is number => value !== undefined)
  const attachedSessionKeys = Array.from(
    new Set([
      ...(metadata?.attachedSessionKeys || []),
      ...sessions.map((session) => session.sessionKey)
    ])
  )
  const attachedRoutes = dedupeWorkspaceRoutes([
    ...(metadata?.attachedRoutes || []),
    ...sessions.map((session) => session.route)
  ])
  const status =
    attachedSessionKeys.length === 0 && sessions.length === 0 && metadata?.status === 'archived'
      ? 'archived'
      : 'active'

  return {
    workspaceId,
    workspaceRootDir: workspaceState.workspaceRootDir,
    workspaceMetaFile: workspaceState.workspaceMetaFile,
    ...(createdAtCandidates.length ? { createdAt: Math.min(...createdAtCandidates) } : {}),
    ...(updatedAtCandidates.length ? { updatedAt: Math.max(...updatedAtCandidates) } : {}),
    status,
    accessMode,
    attachedSessionKeys,
    attachedRoutes,
    ...(ownerSessionKey ? { ownerSessionKey } : {}),
    ...(ownerRoute ? { ownerRoute } : {}),
    ...(status === 'archived' && metadata?.archivedAt !== undefined
      ? { archivedAt: metadata.archivedAt }
      : {}),
    sessionCount: sessions.length,
    messageCount: sessions.reduce((count, session) => count + session.messages.length, 0),
    runCount: sessions.reduce((count, session) => count + session.runs.length, 0),
    eventCount: sessions.reduce((count, session) => count + session.eventLog.length, 0),
    artifactCount: sessions.reduce((count, session) => count + session.artifacts.length, 0),
    ...(cleanString(metadata?.title, 160) ? { title: cleanString(metadata?.title, 160) } : {}),
    ...(cleanString(metadata?.description, 600)
      ? { description: cleanString(metadata?.description, 600) }
      : {}),
    ...(Array.isArray(metadata?.sharedNotes) && metadata.sharedNotes.length
      ? { sharedNotes: metadata.sharedNotes.slice(0, 8) }
      : {}),
    ...(latestSessionUpdatedAt !== undefined ? { latestSessionUpdatedAt } : {}),
    ...(latestRunUpdatedAt !== undefined ? { latestRunUpdatedAt } : {})
  }
}

const sortWorkflowRuns = (runs: AssistantRunRecord[]): AssistantRunRecord[] =>
  [...runs].sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt)

const pickWorkflowTaskGroupState = (
  runs: AssistantRunRecord[]
): AssistantTaskGroupState | undefined => {
  const latestGroupRun = [...runs]
    .filter((run) => run.taskGroup?.taskGroupId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0]
  if (!latestGroupRun?.taskGroup) return undefined
  return normalizeTaskGroupState(latestGroupRun.taskGroup)
}

const pickWorkflowQualityGateState = (
  runs: AssistantRunRecord[],
  taskGroup?: AssistantTaskGroupState
): AssistantQualityGateState | undefined => {
  const latestGateRun = [...runs]
    .filter((run) => run.taskGroup?.qualityGate?.gateId || run.taskGroup?.taskGroupId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0]

  return (
    normalizeQualityGateState(latestGateRun?.taskGroup?.qualityGate) ||
    taskGroup?.qualityGate ||
    undefined
  )
}

const buildWorkflowSummary = (
  workflowId: string,
  runs: AssistantRunRecord[],
  sessionsByKey: Map<string, AssistantSessionRecord>
): AssistantWorkflowSummary => {
  const orderedRuns = sortWorkflowRuns(runs)
  const root = orderedRuns.find((run) => run.runId === workflowId) || orderedRuns[0]
  const latestRun =
    [...orderedRuns].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ||
    root
  const sessionKeys = Array.from(new Set(orderedRuns.map((run) => run.sessionKey)))
  const runIds = new Set(orderedRuns.map((run) => run.runId))
  const sessions = sessionKeys
    .map((sessionKey) => sessionsByKey.get(sessionKey))
    .filter((session): session is AssistantSessionRecord => Boolean(session))
  const eventCount = sessions.reduce(
    (count, session) => count + session.eventLog.filter((event) => runIds.has(event.runId)).length,
    0
  )
  const artifactCount = sessions.reduce(
    (count, session) =>
      count + session.artifacts.filter((artifact) => runIds.has(artifact.runId)).length,
    0
  )
  const runOrigins = Array.from(new Set(orderedRuns.map((run) => run.runOrigin)))
  const taskGroup = pickWorkflowTaskGroupState(orderedRuns)
  const qualityGate = pickWorkflowQualityGateState(orderedRuns, taskGroup)

  return {
    workflowId,
    rootRunId: root.rootRunId || root.runId,
    workspaceId: root.workspaceId,
    route: root.route,
    sessionKeys,
    status: latestRun.status,
    createdAt: orderedRuns[0]?.createdAt || root.createdAt,
    updatedAt: latestRun.updatedAt,
    latestRunId: latestRun.runId,
    ...(latestRun.errorMessage ? { latestErrorMessage: latestRun.errorMessage } : {}),
    runCount: orderedRuns.length,
    eventCount,
    artifactCount,
    runOrigins,
    ...(taskGroup ? { taskGroup } : {}),
    ...(qualityGate ? { qualityGate } : {})
  }
}

const buildWorkflowRecord = (
  workflowId: string,
  runs: AssistantRunRecord[],
  sessionsByKey: Map<string, AssistantSessionRecord>
): AssistantWorkflowRecord => {
  const orderedRuns = sortWorkflowRuns(runs)
  return {
    ...buildWorkflowSummary(workflowId, orderedRuns, sessionsByKey),
    recordVersion: 1,
    runIds: orderedRuns.map((run) => run.runId),
    resumeEligibleRunIds: orderedRuns
      .filter((run) => getRunResumeEligibility(run).resumeEligible)
      .map((run) => run.runId)
  }
}

const normalizeWorkflowRecord = (
  workflow?: Partial<AssistantWorkflowRecord> | null
): AssistantWorkflowRecord | null => {
  const workflowId = cleanString(workflow?.workflowId, 120)
  if (!workflowId) {
    return null
  }

  const rootRunId = cleanString(workflow?.rootRunId, 120) || workflowId
  const workspaceId = cleanString(workflow?.workspaceId, 120) || 'workspace-unknown'
  const route = normalizeAssistantRoute(
    workflow?.route || { channel: 'generic', scopeType: 'dm', scopeId: workflowId }
  )
  const sessionKeys = Array.isArray(workflow?.sessionKeys)
    ? workflow.sessionKeys
        .map((sessionKey) => cleanString(sessionKey, 200))
        .filter((sessionKey): sessionKey is string => Boolean(sessionKey))
    : []
  const runIds = Array.isArray(workflow?.runIds)
    ? workflow.runIds
        .map((runId) => cleanString(runId, 120))
        .filter((runId): runId is string => Boolean(runId))
    : [rootRunId]
  const resumeEligibleRunIds = Array.isArray(workflow?.resumeEligibleRunIds)
    ? workflow.resumeEligibleRunIds
        .map((runId) => cleanString(runId, 120))
        .filter((runId): runId is string => Boolean(runId))
    : []
  const runOrigins = Array.isArray(workflow?.runOrigins)
    ? workflow.runOrigins.filter(
        (runOrigin): runOrigin is AssistantRunOrigin =>
          runOrigin === 'new' ||
          runOrigin === 'continue' ||
          runOrigin === 'retry' ||
          runOrigin === 'resume'
      )
    : []

  return {
    workflowId,
    rootRunId,
    workspaceId,
    route,
    sessionKeys,
    status: workflow?.status || 'queued',
    createdAt: isFiniteNumber(workflow?.createdAt) ? Number(workflow?.createdAt) : Date.now(),
    updatedAt: isFiniteNumber(workflow?.updatedAt) ? Number(workflow?.updatedAt) : Date.now(),
    latestRunId: cleanString(workflow?.latestRunId, 120) || rootRunId,
    ...(cleanString(workflow?.latestErrorMessage)
      ? { latestErrorMessage: cleanString(workflow?.latestErrorMessage) }
      : {}),
    runCount:
      Number.isFinite(workflow?.runCount) && Number(workflow?.runCount) > 0
        ? Math.trunc(Number(workflow?.runCount))
        : runIds.length,
    eventCount:
      Number.isFinite(workflow?.eventCount) && Number(workflow?.eventCount) >= 0
        ? Math.trunc(Number(workflow?.eventCount))
        : 0,
    artifactCount:
      Number.isFinite(workflow?.artifactCount) && Number(workflow?.artifactCount) >= 0
        ? Math.trunc(Number(workflow?.artifactCount))
        : 0,
    runOrigins,
    ...(workflow?.taskGroup ? { taskGroup: normalizeTaskGroupState(workflow.taskGroup) } : {}),
    ...(workflow?.qualityGate || workflow?.taskGroup?.qualityGate
      ? {
          qualityGate: normalizeQualityGateState(
            workflow.qualityGate || workflow.taskGroup?.qualityGate
          )
        }
      : {}),
    recordVersion: 1,
    runIds,
    resumeEligibleRunIds
  }
}

export class AssistantSessionStore {
  private readonly filePath: string
  private readonly records = new Map<string, AssistantSessionRecord>()
  private readonly workflowRecords = new Map<string, AssistantWorkflowRecord>()
  private loadPromise: Promise<void> | null = null
  private persistPromise: Promise<void> = Promise.resolve()

  constructor(filePath?: string) {
    if (filePath) {
      this.filePath = filePath
      return
    }

    const baseDir = getBuildEnv().pathMap.data
    this.filePath = path.join(baseDir, STORE_FILENAME)
  }

  private normalizePersistedRecord(
    session: Partial<AssistantSessionRecord>
  ): AssistantSessionRecord {
    const route = normalizeAssistantRoute(
      session.route || { channel: 'generic', scopeType: 'dm', scopeId: 'default' }
    )
    const sessionKey = getAssistantSessionKey(route)
    const preferredWorkspaceId =
      cleanString(session.workspace?.workspaceId, 120) ||
      cleanString(session.contextSnapshot?.workspaceId, 120)
    const derivedWorkspace = getAssistantWorkspaceState(route, preferredWorkspaceId)
    const workspace =
      session.workspace && session.workspace.rootDir
        ? {
            ...derivedWorkspace,
            ...session.workspace
          }
        : derivedWorkspace
    const contextSnapshot = normalizeContextSnapshot(
      route,
      sessionKey,
      workspace.workspaceId,
      session.contextSnapshot
    )
    const runs = Array.isArray(session.runs)
      ? session.runs
          .map((run) => normalizeRunRecord(route, workspace.workspaceId, run))
          .filter((run): run is AssistantRunRecord => Boolean(run))
          .slice(-ASSISTANT_SESSION_STORE_LIMITS.maxRunRecords)
      : []

    return {
      sessionKey,
      route,
      messages: Array.isArray(session.messages) ? session.messages : [],
      createdAt: Number.isFinite(session.createdAt) ? Number(session.createdAt) : Date.now(),
      updatedAt: Number.isFinite(session.updatedAt) ? Number(session.updatedAt) : Date.now(),
      workspace,
      ...(contextSnapshot ? { contextSnapshot } : {}),
      runs,
      artifacts: Array.isArray(session.artifacts)
        ? session.artifacts.slice(-ASSISTANT_SESSION_STORE_LIMITS.maxArtifactRecords)
        : [],
      eventLog: Array.isArray(session.eventLog)
        ? session.eventLog.slice(-ASSISTANT_SESSION_STORE_LIMITS.maxEventLogEntries)
        : []
    }
  }

  private rebuildWorkflowRecords(): void {
    const sessions = [...this.records.values()]
    const sessionsByKey = new Map(sessions.map((session) => [session.sessionKey, session]))
    const workflowRuns = new Map<string, AssistantRunRecord[]>()

    for (const session of sessions) {
      for (const run of session.runs) {
        const workflowId = cleanString(run.rootRunId, 120) || run.runId
        const existing = workflowRuns.get(workflowId) || []
        existing.push(run)
        workflowRuns.set(workflowId, existing)
      }
    }

    this.workflowRecords.clear()
    for (const [workflowId, runs] of workflowRuns.entries()) {
      this.workflowRecords.set(workflowId, buildWorkflowRecord(workflowId, runs, sessionsByKey))
    }
  }

  private async mutateSession(
    route: AssistantRoute,
    mutate: (current: AssistantSessionRecord) => AssistantSessionRecord
  ): Promise<AssistantSessionRecord> {
    await this.ensureLoaded()
    const normalizedRoute = normalizeAssistantRoute(route)
    const sessionKey = getAssistantSessionKey(normalizedRoute)
    const current =
      this.records.get(sessionKey) ||
      this.normalizePersistedRecord({
        route: normalizedRoute
      })
    const next = this.normalizePersistedRecord(mutate(current))
    this.records.set(sessionKey, next)
    this.rebuildWorkflowRecords()
    await this.queuePersist()
    return next
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    this.loadPromise = (async () => {
      try {
        const raw = await fs.readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw) as PersistedSessionFile
        const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : []
        const workflows = Array.isArray(parsed?.workflows) ? parsed.workflows : []

        this.records.clear()
        for (const session of sessions) {
          const normalized = this.normalizePersistedRecord(session)
          this.records.set(normalized.sessionKey, normalized)
        }

        this.workflowRecords.clear()
        if (workflows.length > 0) {
          for (const workflow of workflows) {
            const normalized = normalizeWorkflowRecord(workflow)
            if (normalized) {
              this.workflowRecords.set(normalized.workflowId, normalized)
            }
          }
        }

        if (this.workflowRecords.size === 0) {
          this.rebuildWorkflowRecords()
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err?.code !== 'ENOENT') {
          console.error('[AssistantSessionStore] Failed to load session store:', error)
        }
      }
    })()

    await this.loadPromise
  }

  private queuePersist(): Promise<void> {
    const payload: PersistedSessionFile = {
      version: 3,
      sessions: [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt),
      workflows: [...this.workflowRecords.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
      )
    }

    this.persistPromise = this.persistPromise
      .catch(() => undefined)
      .then(() => writeJsonFileAtomic(this.filePath, payload))

    return this.persistPromise
  }

  async getSession(route: AssistantRoute): Promise<AssistantSessionRecord | null> {
    await this.ensureLoaded()
    const sessionKey = getAssistantSessionKey(route)
    return this.records.get(sessionKey) || null
  }

  async listSessions(): Promise<AssistantSessionRecord[]> {
    await this.ensureLoaded()
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async getSessionSummary(route: AssistantRoute): Promise<AssistantSessionSummary | null> {
    const session = await this.getSession(route)
    return session ? toSessionSummary(session) : null
  }

  async listSessionSummaries(limit?: number): Promise<AssistantSessionSummary[]> {
    const sessions = await this.listSessions()
    const capped =
      Number.isFinite(limit) && Number(limit) > 0
        ? sessions.slice(0, Math.trunc(Number(limit)))
        : sessions
    return capped.map(toSessionSummary)
  }

  async listWorkspaceSummaries(limit?: number): Promise<AssistantWorkspaceSummary[]> {
    const sessions = await this.listSessions()
    const workspaceMetas = await listAssistantWorkspaceMetas()
    const sessionsByWorkspace = new Map<string, AssistantSessionRecord[]>()

    for (const session of sessions) {
      const workspaceId = session.workspace?.workspaceId || session.contextSnapshot?.workspaceId
      if (!workspaceId) continue
      const existing = sessionsByWorkspace.get(workspaceId) || []
      existing.push(session)
      sessionsByWorkspace.set(workspaceId, existing)
    }

    const workspaceMetaById = new Map(workspaceMetas.map((meta) => [meta.workspaceId, meta]))
    const workspaceIds = new Set<string>([
      ...workspaceMetaById.keys(),
      ...sessionsByWorkspace.keys()
    ])

    const summaries = [...workspaceIds].map((workspaceId) =>
      buildWorkspaceSummary(
        workspaceId,
        sessionsByWorkspace.get(workspaceId) || [],
        workspaceMetaById.get(workspaceId)
      )
    )

    const sorted = summaries.sort(
      (a, b) =>
        (b.latestRunUpdatedAt || b.latestSessionUpdatedAt || b.updatedAt || b.createdAt || 0) -
        (a.latestRunUpdatedAt || a.latestSessionUpdatedAt || a.updatedAt || a.createdAt || 0)
    )

    if (!Number.isFinite(limit) || !limit || limit <= 0) {
      return sorted
    }

    return sorted.slice(0, Math.trunc(Number(limit)))
  }

  async getWorkspaceInspection(
    workspaceId: string,
    options?: {
      runLimit?: number
    }
  ): Promise<AssistantWorkspaceInspection | null> {
    const normalizedWorkspaceId = cleanString(workspaceId, 120)
    if (!normalizedWorkspaceId) return null

    const sessions = (await this.listSessions()).filter(
      (session) =>
        session.workspace?.workspaceId === normalizedWorkspaceId ||
        session.contextSnapshot?.workspaceId === normalizedWorkspaceId
    )
    const summary = (await this.listWorkspaceSummaries()).find(
      (item) => item.workspaceId === normalizedWorkspaceId
    )

    if (!summary && sessions.length === 0) {
      return null
    }

    const runLimit =
      Number.isFinite(options?.runLimit) && Number(options?.runLimit) > 0
        ? Math.trunc(Number(options?.runLimit))
        : 20

    return {
      ...(summary || buildWorkspaceSummary(normalizedWorkspaceId, sessions)),
      sessions: sessions.map(toSessionSummary),
      recentRuns: sessions
        .flatMap((session) => session.runs)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, runLimit)
    }
  }

  async appendTurn(
    route: AssistantRoute,
    messages: ChatMessage[],
    maxHistoryMessages: number,
    options?: {
      workspace?: AssistantWorkspaceState
      contextSnapshot?: AssistantContextSnapshot
      run?: AssistantRunRecord
      artifacts?: AssistantArtifactRef[]
      events?: AssistantRunEvent[]
    }
  ): Promise<AssistantSessionRecord> {
    return this.mutateSession(route, (current) => {
      const nextRuns = [...current.runs]
      if (options?.run) {
        const index = nextRuns.findIndex((item) => item.runId === options.run?.runId)
        if (index >= 0) {
          nextRuns[index] = options.run
        } else {
          nextRuns.push(options.run)
        }
      }

      return {
        ...current,
        updatedAt: Date.now(),
        workspace: options?.workspace || current.workspace,
        contextSnapshot: options?.contextSnapshot || current.contextSnapshot,
        messages: [...current.messages, ...messages].slice(-clampHistorySize(maxHistoryMessages)),
        runs: nextRuns.slice(-ASSISTANT_SESSION_STORE_LIMITS.maxRunRecords),
        artifacts: [...current.artifacts, ...(options?.artifacts || [])].slice(
          -ASSISTANT_SESSION_STORE_LIMITS.maxArtifactRecords
        ),
        eventLog: [...current.eventLog, ...(options?.events || [])].slice(
          -ASSISTANT_SESSION_STORE_LIMITS.maxEventLogEntries
        )
      }
    })
  }

  async upsertRun(
    route: AssistantRoute,
    run: AssistantRunRecord,
    options?: {
      workspace?: AssistantWorkspaceState
      contextSnapshot?: AssistantContextSnapshot
      events?: AssistantRunEvent[]
      artifacts?: AssistantArtifactRef[]
    }
  ): Promise<AssistantSessionRecord> {
    return this.mutateSession(route, (current) => {
      const nextRuns = [...current.runs]
      const index = nextRuns.findIndex((item) => item.runId === run.runId)
      if (index >= 0) {
        nextRuns[index] = run
      } else {
        nextRuns.push(run)
      }

      return {
        ...current,
        updatedAt: Date.now(),
        workspace: options?.workspace || current.workspace,
        contextSnapshot: options?.contextSnapshot || current.contextSnapshot,
        runs: nextRuns.slice(-ASSISTANT_SESSION_STORE_LIMITS.maxRunRecords),
        artifacts: [...current.artifacts, ...(options?.artifacts || [])].slice(
          -ASSISTANT_SESSION_STORE_LIMITS.maxArtifactRecords
        ),
        eventLog: [...current.eventLog, ...(options?.events || [])].slice(
          -ASSISTANT_SESSION_STORE_LIMITS.maxEventLogEntries
        )
      }
    })
  }

  async appendEvents(
    route: AssistantRoute,
    events: AssistantRunEvent[]
  ): Promise<AssistantSessionRecord> {
    return this.mutateSession(route, (current) => ({
      ...current,
      updatedAt: Date.now(),
      eventLog: [...current.eventLog, ...events].slice(
        -ASSISTANT_SESSION_STORE_LIMITS.maxEventLogEntries
      )
    }))
  }

  async appendArtifacts(
    route: AssistantRoute,
    artifacts: AssistantArtifactRef[]
  ): Promise<AssistantSessionRecord> {
    return this.mutateSession(route, (current) => ({
      ...current,
      updatedAt: Date.now(),
      artifacts: [...current.artifacts, ...artifacts].slice(
        -ASSISTANT_SESSION_STORE_LIMITS.maxArtifactRecords
      )
    }))
  }

  async attachWorkspace(
    route: AssistantRoute,
    workspace: AssistantWorkspaceState,
    contextSnapshot?: AssistantContextSnapshot
  ): Promise<AssistantSessionRecord> {
    return this.mutateSession(route, (current) => ({
      ...current,
      updatedAt: Date.now(),
      workspace,
      ...(contextSnapshot ? { contextSnapshot } : {})
    }))
  }

  async listEvents(limit = 100, route?: AssistantRoute): Promise<AssistantRunEvent[]> {
    const sessions = route
      ? [await this.getSession(route)].filter(Boolean)
      : await this.listSessions()
    return (sessions as AssistantSessionRecord[])
      .flatMap((session) => session.eventLog)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
  }

  async listArtifacts(limit = 100, route?: AssistantRoute): Promise<AssistantArtifactRef[]> {
    const sessions = route
      ? [await this.getSession(route)].filter(Boolean)
      : await this.listSessions()
    return (sessions as AssistantSessionRecord[])
      .flatMap((session) => session.artifacts)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
  }

  async getRun(runId: string, route?: AssistantRoute): Promise<AssistantRunRecord | null> {
    const sessions = route
      ? [await this.getSession(route)].filter(Boolean)
      : await this.listSessions()

    for (const session of sessions as AssistantSessionRecord[]) {
      const run = session.runs.find((item) => item.runId === runId)
      if (run) return run
    }

    return null
  }

  async listRuns(limit = 100, route?: AssistantRoute): Promise<AssistantRunRecord[]> {
    const sessions = route
      ? [await this.getSession(route)].filter(Boolean)
      : await this.listSessions()
    return (sessions as AssistantSessionRecord[])
      .flatMap((session) => session.runs)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit))
  }

  async listWorkflowSummaries(options?: {
    limit?: number
    route?: AssistantRoute
  }): Promise<AssistantWorkflowSummary[]> {
    await this.ensureLoaded()
    const sessionKey = options?.route ? getAssistantSessionKey(options.route) : undefined

    const limit =
      Number.isFinite(options?.limit) && Number(options?.limit) > 0
        ? Math.trunc(Number(options?.limit))
        : 20

    return [...this.workflowRecords.values()]
      .filter(
        (workflow) =>
          !sessionKey ||
          workflow.sessionKeys.includes(sessionKey) ||
          getAssistantSessionKey(workflow.route) === sessionKey
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
  }

  async getRunTrace(runId: string, route?: AssistantRoute): Promise<AssistantRunTrace | null> {
    const sessions = route
      ? [await this.getSession(route)].filter(Boolean)
      : await this.listSessions()

    for (const session of sessions as AssistantSessionRecord[]) {
      const run = session.runs.find((item) => item.runId === runId)
      if (!run) continue

      const eventEntries: AssistantRunTraceEntry[] = session.eventLog
        .filter((event) => event.runId === runId)
        .map((event) => ({
          traceId: `event:${event.eventId}`,
          runId,
          sessionKey: session.sessionKey,
          route: session.route,
          category: 'event',
          type: event.type,
          level: event.level,
          message: event.message,
          createdAt: event.createdAt,
          ...(event.metadata ? { metadata: event.metadata } : {})
        }))

      const artifactEntries: AssistantRunTraceEntry[] = session.artifacts
        .filter((artifact) => artifact.runId === runId)
        .map((artifact) => ({
          traceId: `artifact:${artifact.artifactId}`,
          runId,
          sessionKey: session.sessionKey,
          route: session.route,
          category: 'artifact',
          type: 'artifact',
          level: 'info',
          message: `Artifact recorded: ${artifact.fileName || artifact.kind}`,
          createdAt: artifact.createdAt,
          artifact: {
            artifactId: artifact.artifactId,
            kind: artifact.kind,
            url: artifact.url,
            mimeType: artifact.mimeType,
            fileName: artifact.fileName,
            source: artifact.source
          }
        }))

      const timeline = [...eventEntries, ...artifactEntries].sort(
        (a, b) => a.createdAt - b.createdAt
      )

      return {
        runId: run.runId,
        sessionKey: run.sessionKey,
        workspaceId: run.workspaceId,
        route: run.route,
        status: run.status,
        runOrigin: run.runOrigin,
        rootRunId: run.rootRunId,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.resumeSourceRunId ? { resumeSourceRunId: run.resumeSourceRunId } : {}),
        ...(isFiniteNumber(run.resumeAttempt) ? { resumeAttempt: run.resumeAttempt } : {}),
        ...(run.resumeMode ? { resumeMode: run.resumeMode } : {}),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(isFiniteNumber(run.startedAt) ? { startedAt: run.startedAt } : {}),
        ...(isFiniteNumber(run.finishedAt) ? { finishedAt: run.finishedAt } : {}),
        ...(computeQueueDelayMs(run) !== undefined
          ? { queueDelayMs: computeQueueDelayMs(run) }
          : {}),
        ...(computeDurationMs(run) !== undefined ? { durationMs: computeDurationMs(run) } : {}),
        toolCallCount: run.toolCalls?.length || 0,
        artifactCount: artifactEntries.length,
        eventCount: eventEntries.length,
        ...(run.requestText ? { requestText: run.requestText } : {}),
        ...(run.responseText ? { responseText: run.responseText } : {}),
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        timeline
      }
    }

    return null
  }

  async getRunLineage(runId: string, route?: AssistantRoute): Promise<AssistantRunLineage | null> {
    const targetRun = route ? await this.getRun(runId, route) : await this.getRun(runId)
    if (!targetRun) {
      return null
    }

    const allRuns = (await this.listSessions())
      .flatMap((session) => session.runs)
      .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt)
    const runById = new Map(allRuns.map((run) => [run.runId, run]))
    const root =
      runById.get(targetRun.rootRunId) || runById.get(targetRun.parentRunId || '') || targetRun
    const chain = allRuns.filter((run) => run.rootRunId === root.runId || run.runId === root.runId)
    const ancestors: AssistantRunRecord[] = []
    const ancestorSeen = new Set<string>()
    let cursor = targetRun.parentRunId ? runById.get(targetRun.parentRunId) : undefined

    while (cursor && !ancestorSeen.has(cursor.runId)) {
      ancestors.unshift(cursor)
      ancestorSeen.add(cursor.runId)
      cursor = cursor.parentRunId ? runById.get(cursor.parentRunId) : undefined
    }

    const children = chain.filter((run) => run.parentRunId === targetRun.runId)
    const descendants: AssistantRunRecord[] = []
    const descendantQueue = [...children]
    const descendantSeen = new Set<string>()

    while (descendantQueue.length > 0) {
      const next = descendantQueue.shift()
      if (!next || descendantSeen.has(next.runId)) {
        continue
      }

      descendantSeen.add(next.runId)
      descendants.push(next)
      descendantQueue.push(...chain.filter((run) => run.parentRunId === next.runId))
    }

    const resumeState = getRunResumeEligibility(targetRun)

    const lineage: AssistantRunLineage = {
      runId: targetRun.runId,
      sessionKey: targetRun.sessionKey,
      workspaceId: targetRun.workspaceId,
      route: targetRun.route,
      status: targetRun.status,
      runOrigin: targetRun.runOrigin,
      rootRunId: targetRun.rootRunId,
      ...(targetRun.parentRunId ? { parentRunId: targetRun.parentRunId } : {}),
      ...(targetRun.resumeSourceRunId ? { resumeSourceRunId: targetRun.resumeSourceRunId } : {}),
      ...(isFiniteNumber(targetRun.resumeAttempt)
        ? { resumeAttempt: targetRun.resumeAttempt }
        : {}),
      ...(targetRun.resumeMode ? { resumeMode: targetRun.resumeMode } : {}),
      createdAt: targetRun.createdAt,
      updatedAt: targetRun.updatedAt,
      ...resumeState,
      root,
      ancestors,
      children,
      descendants,
      chain
    }
    return lineage
  }

  async getWorkflowInspection(
    workflowIdOrRunId: string,
    options?: {
      route?: AssistantRoute
      runLimit?: number
      eventLimit?: number
      artifactLimit?: number
    }
  ): Promise<AssistantWorkflowInspection | null> {
    const normalizedWorkflowId = cleanString(workflowIdOrRunId, 120)
    if (!normalizedWorkflowId) {
      return null
    }

    await this.ensureLoaded()
    const sessionKey = options?.route ? getAssistantSessionKey(options.route) : undefined
    const workflowRecord =
      [...this.workflowRecords.values()].find(
        (workflow) =>
          (!sessionKey ||
            workflow.sessionKeys.includes(sessionKey) ||
            getAssistantSessionKey(workflow.route) === sessionKey) &&
          (workflow.workflowId === normalizedWorkflowId ||
            workflow.rootRunId === normalizedWorkflowId ||
            workflow.runIds.includes(normalizedWorkflowId))
      ) || null

    if (!workflowRecord) {
      return null
    }

    const sessions = options?.route
      ? [await this.getSession(options.route)].filter(Boolean)
      : await this.listSessions()
    const typedSessions = sessions as AssistantSessionRecord[]
    const allRuns = typedSessions.flatMap((session) => session.runs)
    const runIds = new Set(workflowRecord.runIds)
    const workflowRuns = sortWorkflowRuns(allRuns.filter((run) => runIds.has(run.runId)))

    if (workflowRuns.length === 0) {
      return null
    }

    const root =
      workflowRuns.find((run) => run.runId === workflowRecord.rootRunId) || workflowRuns[0]
    const runLimit =
      Number.isFinite(options?.runLimit) && Number(options?.runLimit) > 0
        ? Math.trunc(Number(options?.runLimit))
        : 50
    const eventLimit =
      Number.isFinite(options?.eventLimit) && Number(options?.eventLimit) > 0
        ? Math.trunc(Number(options?.eventLimit))
        : 50
    const artifactLimit =
      Number.isFinite(options?.artifactLimit) && Number(options?.artifactLimit) > 0
        ? Math.trunc(Number(options?.artifactLimit))
        : 50
    const runs =
      workflowRuns.length <= runLimit
        ? workflowRuns
        : [workflowRuns[0], ...workflowRuns.slice(-(Math.max(2, runLimit) - 1))].filter(
            (run, index, array) => array.findIndex((item) => item.runId === run.runId) === index
          )
    const recentEvents = typedSessions
      .flatMap((session) => session.eventLog.filter((event) => runIds.has(event.runId)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, eventLimit))
    const recentArtifacts = typedSessions
      .flatMap((session) => session.artifacts.filter((artifact) => runIds.has(artifact.runId)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, artifactLimit))

    const inspection: AssistantWorkflowInspection = {
      ...workflowRecord,
      root,
      runs,
      recentEvents,
      recentArtifacts
    }
    return inspection
  }

  async listAuditTimeline(options?: {
    limit?: number
    route?: AssistantRoute
    runId?: string
  }): Promise<AssistantAuditTimelineEntry[]> {
    const sessions = options?.route
      ? [await this.getSession(options.route)].filter(Boolean)
      : await this.listSessions()
    const runId = String(options?.runId || '').trim()

    const timeline = (sessions as AssistantSessionRecord[]).flatMap((session) => {
      const runStatusById = new Map(session.runs.map((item) => [item.runId, item.status]))
      const runById = new Map(session.runs.map((item) => [item.runId, item]))

      const events: AssistantAuditTimelineEntry[] = session.eventLog
        .filter((event) => !runId || event.runId === runId)
        .map((event) => {
          const run = runById.get(event.runId)
          return {
            entryId: `event:${event.eventId}`,
            sessionKey: session.sessionKey,
            route: session.route,
            runId: event.runId,
            ...(run ? { workspaceId: run.workspaceId } : {}),
            category: 'event',
            type: event.type,
            level: event.level,
            message: event.message,
            createdAt: event.createdAt,
            ...(runStatusById.get(event.runId) ? { status: runStatusById.get(event.runId) } : {}),
            ...(run
              ? {
                  runOrigin: run.runOrigin,
                  rootRunId: run.rootRunId,
                  ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
                  ...(run.resumeSourceRunId ? { resumeSourceRunId: run.resumeSourceRunId } : {}),
                  ...(isFiniteNumber(run.resumeAttempt)
                    ? { resumeAttempt: run.resumeAttempt }
                    : {}),
                  ...(run.resumeMode ? { resumeMode: run.resumeMode } : {})
                }
              : {}),
            ...(event.metadata ? { metadata: event.metadata } : {})
          }
        })

      const artifacts: AssistantAuditTimelineEntry[] = session.artifacts
        .filter((artifact) => !runId || artifact.runId === runId)
        .map((artifact) => {
          const run = runById.get(artifact.runId)
          return {
            entryId: `artifact:${artifact.artifactId}`,
            sessionKey: session.sessionKey,
            route: session.route,
            runId: artifact.runId,
            ...(run ? { workspaceId: run.workspaceId } : {}),
            category: 'artifact',
            type: 'artifact',
            level: 'info',
            message: `Artifact recorded: ${artifact.fileName || artifact.kind}`,
            createdAt: artifact.createdAt,
            ...(runStatusById.get(artifact.runId)
              ? { status: runStatusById.get(artifact.runId) }
              : {}),
            ...(run
              ? {
                  runOrigin: run.runOrigin,
                  rootRunId: run.rootRunId,
                  ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
                  ...(run.resumeSourceRunId ? { resumeSourceRunId: run.resumeSourceRunId } : {}),
                  ...(isFiniteNumber(run.resumeAttempt)
                    ? { resumeAttempt: run.resumeAttempt }
                    : {}),
                  ...(run.resumeMode ? { resumeMode: run.resumeMode } : {})
                }
              : {}),
            artifactId: artifact.artifactId,
            artifactKind: artifact.kind
          }
        })

      return [...events, ...artifacts]
    })

    return timeline
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, options?.limit || 50))
  }

  async getOpsStatus(options?: {
    limit?: number
    route?: AssistantRoute
  }): Promise<AssistantOpsStatus> {
    const sessions = options?.route
      ? [await this.getSession(options.route)].filter(Boolean)
      : await this.listSessions()
    const typedSessions = sessions as AssistantSessionRecord[]
    const runs = typedSessions.flatMap((session) => session.runs)
    const events = typedSessions.flatMap((session) => session.eventLog)
    const artifacts = typedSessions.flatMap((session) => session.artifacts)
    const queueDelays = runs
      .map((run) => computeQueueDelayMs(run))
      .filter((value): value is number => value !== undefined)
    const durations = runs
      .map((run) => computeDurationMs(run))
      .filter((value): value is number => value !== undefined)

    const channels = [
      ...typedSessions
        .reduce((map, session) => {
          const existing =
            map.get(session.route.channel) ||
            ({
              channel: session.route.channel,
              sessionCount: 0,
              runCount: 0,
              eventCount: 0,
              artifactCount: 0,
              completedRunCount: 0,
              failedRunCount: 0,
              cancelledRunCount: 0,
              queuedRunCount: 0,
              runningRunCount: 0,
              acknowledgedRunCount: 0
            } satisfies AssistantOpsChannelSummary)

          existing.sessionCount += 1
          existing.runCount += session.runs.length
          existing.eventCount += session.eventLog.length
          existing.artifactCount += session.artifacts.length
          existing.completedRunCount += session.runs.filter(
            (run) => run.status === 'completed'
          ).length
          existing.failedRunCount += session.runs.filter((run) => run.status === 'failed').length
          existing.cancelledRunCount += session.runs.filter(
            (run) => run.status === 'cancelled'
          ).length
          existing.queuedRunCount += session.runs.filter((run) => run.status === 'queued').length
          existing.runningRunCount += session.runs.filter((run) => run.status === 'running').length
          existing.acknowledgedRunCount += session.runs.filter(
            (run) => run.status === 'acknowledged'
          ).length
          existing.newestUpdatedAt = Math.max(existing.newestUpdatedAt || 0, session.updatedAt)
          map.set(session.route.channel, existing)
          return map
        }, new Map<string, AssistantOpsChannelSummary>())
        .values()
    ].sort((a, b) => (b.newestUpdatedAt || 0) - (a.newestUpdatedAt || 0))

    const recentRuns: AssistantOpsRunSummary[] = runs
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, options?.limit || 10))
      .map((run) => ({
        runId: run.runId,
        sessionKey: run.sessionKey,
        workspaceId: run.workspaceId,
        route: run.route,
        status: run.status,
        runOrigin: run.runOrigin,
        rootRunId: run.rootRunId,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.resumeSourceRunId ? { resumeSourceRunId: run.resumeSourceRunId } : {}),
        ...(isFiniteNumber(run.resumeAttempt) ? { resumeAttempt: run.resumeAttempt } : {}),
        ...(run.resumeMode ? { resumeMode: run.resumeMode } : {}),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(isFiniteNumber(run.startedAt) ? { startedAt: run.startedAt } : {}),
        ...(isFiniteNumber(run.finishedAt) ? { finishedAt: run.finishedAt } : {}),
        ...(computeQueueDelayMs(run) !== undefined
          ? { queueDelayMs: computeQueueDelayMs(run) }
          : {}),
        ...(computeDurationMs(run) !== undefined ? { durationMs: computeDurationMs(run) } : {}),
        toolCallCount: run.toolCalls?.length || 0,
        artifactCount: run.artifactIds.length,
        eventCount: events.filter((event) => event.runId === run.runId).length,
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {})
      }))

    const runCount = runs.length
    const failedRunCount = runs.filter((run) => run.status === 'failed').length
    const cancelledRunCount = runs.filter((run) => run.status === 'cancelled').length

    return {
      generatedAt: Date.now(),
      ...(options?.route ? { route: normalizeAssistantRoute(options.route) } : {}),
      sessionCount: typedSessions.length,
      runCount,
      eventCount: events.length,
      artifactCount: artifacts.length,
      completedRunCount: runs.filter((run) => run.status === 'completed').length,
      failedRunCount,
      cancelledRunCount,
      queuedRunCount: runs.filter((run) => run.status === 'queued').length,
      runningRunCount: runs.filter((run) => run.status === 'running').length,
      acknowledgedRunCount: runs.filter((run) => run.status === 'acknowledged').length,
      ...(queueDelays.length > 0
        ? {
            averageQueueDelayMs: Math.round(
              queueDelays.reduce((total, value) => total + value, 0) / queueDelays.length
            )
          }
        : {}),
      ...(durations.length > 0
        ? {
            averageRunDurationMs: Math.round(
              durations.reduce((total, value) => total + value, 0) / durations.length
            )
          }
        : {}),
      failureRate: runCount > 0 ? roundRate(failedRunCount / runCount) : 0,
      cancellationRate: runCount > 0 ? roundRate(cancelledRunCount / runCount) : 0,
      retention: await this.getRetentionState(),
      recentRuns,
      channels
    }
  }

  async clearSession(route: AssistantRoute): Promise<void> {
    await this.ensureLoaded()
    const sessionKey = getAssistantSessionKey(route)
    this.records.delete(sessionKey)
    this.rebuildWorkflowRecords()
    await this.queuePersist()
  }

  async getRetentionState(): Promise<AssistantRetentionState> {
    await this.ensureLoaded()
    const sessions = [...this.records.values()]
    const updatedAtValues = sessions.map((session) => session.updatedAt).filter(isFiniteNumber)

    const retention: AssistantRetentionState = {
      sessionCount: sessions.length,
      totalMessageCount: sessions.reduce((total, session) => total + session.messages.length, 0),
      totalRunCount: sessions.reduce((total, session) => total + session.runs.length, 0),
      totalEventCount: sessions.reduce((total, session) => total + session.eventLog.length, 0),
      totalArtifactCount: sessions.reduce((total, session) => total + session.artifacts.length, 0),
      ...(updatedAtValues.length > 0
        ? {
            oldestUpdatedAt: Math.min(...updatedAtValues),
            newestUpdatedAt: Math.max(...updatedAtValues)
          }
        : {}),
      limits: ASSISTANT_SESSION_STORE_LIMITS
    }

    return retention
  }

  async pruneSessions(beforeUpdatedAt: number): Promise<AssistantPruneResult> {
    await this.ensureLoaded()
    const cutoff = Number(beforeUpdatedAt)
    if (!Number.isFinite(cutoff)) {
      throw new Error('Invalid session prune cutoff.')
    }

    const removedSessions: AssistantPruneResult['removedSessions'] = []
    for (const [sessionKey, session] of [...this.records.entries()]) {
      if (session.updatedAt < cutoff) {
        removedSessions.push({
          sessionKey,
          route: session.route,
          updatedAt: session.updatedAt
        })
        this.records.delete(sessionKey)
      }
    }

    if (removedSessions.length > 0) {
      this.rebuildWorkflowRecords()
      await this.queuePersist()
    }

    return {
      removedCount: removedSessions.length,
      removedSessionKeys: removedSessions.map((session) => session.sessionKey),
      removedSessions,
      retention: await this.getRetentionState()
    }
  }

  async getMessageCount(route: AssistantRoute): Promise<number> {
    const session = await this.getSession(route)
    return session?.messages.length || 0
  }

  async flush(): Promise<void> {
    await this.persistPromise
  }
}
