import crypto from 'node:crypto'

export const ASSISTANT_SESSION_ENVELOPE_VERSION = 4 as const
export type AssistantSessionEnvelopeVersion = 1 | 2 | 3 | 4

export type AssistantSessionEnvelopeV4 = {
  version: 4
  sessions: Record<string, unknown>[]
  workflows: Record<string, unknown>[]
}

export type AssistantSessionMigrationResult = {
  sourceVersion: AssistantSessionEnvelopeVersion
  migrated: boolean
  envelope: AssistantSessionEnvelopeV4
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const stringValue = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value : fallback

const pick = (
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}

const SESSION_FIELDS = [
  'sessionKey',
  'route',
  'messages',
  'messageEntries',
  'createdAt',
  'updatedAt',
  'workspace',
  'contextSnapshot',
  'runs',
  'artifacts',
  'eventLog',
  'lineage'
] as const

const RUN_FIELDS = [
  'runId',
  'sessionKey',
  'workspaceId',
  'route',
  'status',
  'runOrigin',
  'rootRunId',
  'parentRunId',
  'resumeSourceRunId',
  'resumeAttempt',
  'resumeMode',
  'executionMode',
  'executionHistorySize',
  'executionTraceLabel',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'queuePosition',
  'requestText',
  'responseText',
  'profileId',
  'errorMessage',
  'cancelRequested',
  'toolCalls',
  'artifactIds',
  'taskGroup',
  'lineage'
] as const

const WORKFLOW_FIELDS = [
  'workflowId',
  'rootRunId',
  'workspaceId',
  'route',
  'sessionKeys',
  'status',
  'createdAt',
  'updatedAt',
  'latestRunId',
  'latestErrorMessage',
  'runCount',
  'eventCount',
  'artifactCount',
  'runOrigins',
  'taskGroup',
  'qualityGate',
  'recordVersion',
  'runIds',
  'resumeEligibleRunIds'
] as const

const normalizeQualityGate = (value: unknown, updatedAt: number): unknown => {
  if (!isRecord(value)) return value
  return {
    ...pick(value, ['gateId', 'status', 'summary', 'checks']),
    updatedAt: finiteNumber(value.updatedAt, updatedAt)
  }
}

const normalizeTaskGroup = (value: unknown, updatedAt: number): unknown => {
  if (!isRecord(value)) return value
  const taskGroupId = stringValue(value.taskGroupId, '')
  if (!taskGroupId) return undefined
  const normalized = {
    ...pick(value, [
      'taskGroupId',
      'title',
      'description',
      'status',
      'progress',
      'approvedAt',
      'approvedBy',
      'exportedAt',
      'exportTarget',
      'exportArtifactIds',
      'workspaceRunId',
      'rootRunId'
    ]),
    status: stringValue(value.status, 'draft'),
    updatedAt: finiteNumber(value.updatedAt, updatedAt)
  } as Record<string, unknown>
  if (value.qualityGate !== undefined) {
    normalized.qualityGate = normalizeQualityGate(value.qualityGate, normalized.updatedAt as number)
  }
  return normalized
}

const normalizeRun = (value: unknown, sessionCreatedAt: number): Record<string, unknown> | null => {
  if (!isRecord(value)) return null
  const runId = stringValue(value.runId, '')
  if (!runId) return null
  const createdAt = finiteNumber(value.createdAt, sessionCreatedAt)
  const updatedAt = finiteNumber(value.updatedAt, createdAt)
  const run = {
    ...pick(value, RUN_FIELDS),
    runId,
    status: stringValue(value.status, 'queued'),
    runOrigin: stringValue(value.runOrigin, 'new'),
    rootRunId: stringValue(value.rootRunId, stringValue(value.parentRunId, runId)),
    createdAt,
    updatedAt,
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : [],
    artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds : []
  } as Record<string, unknown>
  if (value.taskGroup !== undefined) run.taskGroup = normalizeTaskGroup(value.taskGroup, updatedAt)
  return run
}

const legacyMessageId = (sessionKey: string, index: number): string =>
  `legacy-${crypto.createHash('sha256').update(`${sessionKey}:${index}`).digest('hex').slice(0, 24)}`

const normalizeSession = (
  value: unknown,
  sourceVersion: AssistantSessionEnvelopeVersion
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error('Assistant session envelope contains a non-object session.')
  const route = isRecord(value.route) ? value.route : {}
  const sessionKey = stringValue(
    value.sessionKey,
    `${stringValue(route.channel, 'generic')}:${stringValue(route.scopeType, 'dm')}:${stringValue(route.scopeId, 'default')}`
  )
  const createdAt = finiteNumber(value.createdAt, 0)
  const updatedAt = finiteNumber(value.updatedAt, createdAt)
  const messages = Array.isArray(value.messages) ? value.messages : []
  const entries = Array.isArray(value.messageEntries) ? value.messageEntries : []
  const canPreserveEntries =
    sourceVersion === 4 &&
    entries.length === messages.length &&
    entries.every((entry) => isRecord(entry) && typeof entry.messageId === 'string')
  const messageEntries = messages.map((message, index) => {
    if (canPreserveEntries) {
      const entry = entries[index] as Record<string, unknown>
      return {
        ...pick(entry, ['messageId', 'runId', 'eventId']),
        message,
        order: index,
        createdAt: finiteNumber(entry.createdAt, createdAt + index),
        attributionQuality: entry.attributionQuality === 'exact' ? 'exact' : 'legacy-approximate'
      }
    }
    return {
      messageId: legacyMessageId(sessionKey, index),
      message,
      order: index,
      createdAt: createdAt + index,
      attributionQuality: 'legacy-approximate'
    }
  })
  return {
    ...pick(value, SESSION_FIELDS),
    sessionKey,
    route,
    messages,
    messageEntries,
    createdAt,
    updatedAt,
    runs: (Array.isArray(value.runs) ? value.runs : [])
      .map((run) => normalizeRun(run, createdAt))
      .filter((run): run is Record<string, unknown> => run !== null),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    eventLog: Array.isArray(value.eventLog) ? value.eventLog : []
  }
}

const normalizeWorkflow = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null
  const workflowId = stringValue(value.workflowId, '')
  if (!workflowId) return null
  const rootRunId = stringValue(value.rootRunId, workflowId)
  const createdAt = finiteNumber(value.createdAt, 0)
  const updatedAt = finiteNumber(value.updatedAt, createdAt)
  const workflow = {
    ...pick(value, WORKFLOW_FIELDS),
    workflowId,
    rootRunId,
    status: stringValue(value.status, 'queued'),
    createdAt,
    updatedAt,
    latestRunId: stringValue(value.latestRunId, rootRunId),
    runCount: finiteNumber(value.runCount, Array.isArray(value.runIds) ? value.runIds.length : 0),
    eventCount: finiteNumber(value.eventCount, 0),
    artifactCount: finiteNumber(value.artifactCount, 0),
    runOrigins: Array.isArray(value.runOrigins) ? value.runOrigins : [],
    recordVersion: 1,
    runIds: Array.isArray(value.runIds) ? value.runIds : [rootRunId],
    resumeEligibleRunIds: Array.isArray(value.resumeEligibleRunIds)
      ? value.resumeEligibleRunIds
      : []
  } as Record<string, unknown>
  if (value.taskGroup !== undefined)
    workflow.taskGroup = normalizeTaskGroup(value.taskGroup, updatedAt)
  if (value.qualityGate !== undefined) {
    workflow.qualityGate = normalizeQualityGate(value.qualityGate, updatedAt)
  }
  return workflow
}

export function parseAndMigrateAssistantSessionEnvelope(
  input: unknown
): AssistantSessionMigrationResult {
  if (!isRecord(input)) throw new Error('Assistant session store must be a JSON object.')
  const version = input.version
  if (!Number.isInteger(version) || typeof version !== 'number' || version < 1 || version > 4) {
    throw new Error(`Unsupported assistant session store version: ${String(version)}`)
  }
  if (!Array.isArray(input.sessions)) {
    throw new Error('Assistant session store sessions must be an array.')
  }
  if (input.workflows !== undefined && !Array.isArray(input.workflows)) {
    throw new Error('Assistant session store workflows must be an array when present.')
  }
  const sourceVersion = version as AssistantSessionEnvelopeVersion
  const envelope: AssistantSessionEnvelopeV4 = {
    version: 4,
    sessions: input.sessions.map((session) => normalizeSession(session, sourceVersion)),
    workflows: (Array.isArray(input.workflows) ? input.workflows : [])
      .map(normalizeWorkflow)
      .filter((workflow): workflow is Record<string, unknown> => workflow !== null)
  }
  validateAssistantSessionEnvelopeV4(envelope)
  return { sourceVersion, migrated: sourceVersion !== 4, envelope }
}

export function validateAssistantSessionEnvelopeV4(
  input: unknown
): asserts input is AssistantSessionEnvelopeV4 {
  if (!isRecord(input) || input.version !== 4 || !Array.isArray(input.sessions)) {
    throw new Error('Invalid normalized assistant session store v4 envelope.')
  }
  if (!Array.isArray(input.workflows)) {
    throw new Error('Invalid normalized assistant session store v4 workflows.')
  }
  for (const session of input.sessions) {
    if (
      !isRecord(session) ||
      !isRecord(session.route) ||
      typeof session.sessionKey !== 'string' ||
      !Array.isArray(session.messages) ||
      !Array.isArray(session.messageEntries) ||
      session.messageEntries.length !== session.messages.length ||
      !Array.isArray(session.runs) ||
      !Array.isArray(session.artifacts) ||
      !Array.isArray(session.eventLog) ||
      typeof session.createdAt !== 'number' ||
      typeof session.updatedAt !== 'number'
    ) {
      throw new Error('Invalid normalized assistant session store v4 session.')
    }
  }
}

export const serializeAssistantSessionEnvelopeV4 = (
  envelope: AssistantSessionEnvelopeV4
): string => {
  validateAssistantSessionEnvelopeV4(envelope)
  return `${JSON.stringify(envelope, null, 2)}\n`
}
