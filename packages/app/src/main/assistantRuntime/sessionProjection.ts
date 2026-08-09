import type { ChatMessage } from '@shared/api/svcLLMProxy'
import type {
  AssistantArtifactRef,
  AssistantRoute,
  AssistantRunEvent,
  AssistantRunRecord,
  AssistantSessionRecord
} from './types'

export const ASSISTANT_SESSION_PROJECTION_LIMITS = {
  maxDepth: 6,
  maxArrayItems: 100,
  maxStringLength: 4_000,
  maxTotalBytes: 512_000
} as const

export type AssistantProjectionCategory =
  | 'messages'
  | 'lifecycleEvents'
  | 'tools'
  | 'routeIdentity'
  | 'legacyTaskGroups'
  | 'durableDrives'
  | 'approvals'
  | 'artifacts'
  | 'errorsAndRetries'
  | 'usageAndTiming'
  | 'graphVersions'
  | 'teams'
  | 'runtimeChannels'
  | 'fileDiffs'

export type AssistantProjectionAvailability = {
  status: 'available' | 'unavailable'
  reason?: string
}

export type AssistantSessionProjection = {
  schemaVersion: 1
  redacted: true
  bounded: true
  session: {
    sessionKey: string
    createdAt: number
    updatedAt: number
    route: AssistantRoute
    workspaceId: string
    lineage?: unknown
    attributionQuality?: 'exact' | 'legacy-approximate'
  }
  availability: Record<AssistantProjectionCategory, AssistantProjectionAvailability>
  messages: unknown[]
  lifecycleEvents: unknown[]
  tools: unknown[]
  legacyTaskGroups: unknown[]
  approvals: unknown[]
  artifacts: unknown[]
  errorsAndRetries: unknown[]
  usageAndTiming: unknown[]
  timeline: Array<{ id: string; at: number; kind: string; runId?: string; value: unknown }>
  truncation: { truncated: boolean; limits: typeof ASSISTANT_SESSION_PROJECTION_LIMITS }
}

export type AssistantSessionDiffDimension = AssistantProjectionCategory | 'lineage'
export type AssistantSessionProjectionDiff = {
  schemaVersion: 1
  leftSessionKey: string
  rightSessionKey: string
  lineage: {
    relationship:
      | 'same'
      | 'left-forked-from-right'
      | 'right-forked-from-left'
      | 'related-forks'
      | 'unrelated'
    commonSourceSessionKey?: string
  }
  dimensions: Record<
    AssistantSessionDiffDimension,
    {
      classification: 'equal' | 'changed' | 'left-only' | 'right-only' | 'unavailable'
      leftAvailable: boolean
      rightAvailable: boolean
      leftCount?: number
      rightCount?: number
    }
  >
  mergedTimeline: Array<{
    side: 'left' | 'right' | 'both'
    at: number
    kind: string
    left?: unknown
    right?: unknown
  }>
  sideBySide: Array<{
    index: number
    left?: unknown
    right?: unknown
    classification: 'equal' | 'changed' | 'left-only' | 'right-only'
  }>
}

const SECRET_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i
const SECRET_TEXT =
  /((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+|((?:api[-_]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi
const CREDENTIAL_URL = /\b(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi
const URL_SECRET_QUERY =
  /([?&](?:token|key|api_key|apikey|access_token|signature|sig|password)=)[^&#\s]*/gi

const redactString = (input: string, maxLength: number): string => {
  const redacted = input
    .replace(CREDENTIAL_URL, '$1[REDACTED]@')
    .replace(URL_SECRET_QUERY, '$1[REDACTED]')
    .replace(SECRET_TEXT, (_match, prefix1, prefix2) => `${prefix1 || prefix2}[REDACTED]`)
  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 14))}...[TRUNCATED]`
    : redacted
}

const sanitize = (
  value: unknown,
  limits = ASSISTANT_SESSION_PROJECTION_LIMITS,
  depth = 0,
  key = ''
): unknown => {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactString(value, limits.maxStringLength)
  if (typeof value === 'bigint') return value.toString()
  if (depth >= limits.maxDepth) return '[MAX_DEPTH]'
  if (Array.isArray(value)) {
    const result = value
      .slice(0, limits.maxArrayItems)
      .map((item) => sanitize(item, limits, depth + 1))
    if (value.length > limits.maxArrayItems)
      result.push(`[${value.length - limits.maxArrayItems} ITEMS TRUNCATED]`)
    return result
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([childKey, childValue]) => [
          childKey,
          sanitize(childValue, limits, depth + 1, childKey)
        ])
    )
  }
  return String(value)
}

const routeIdentity = (route: AssistantRoute): AssistantRoute => sanitize(route) as AssistantRoute

const messageProjection = (message: ChatMessage, index: number): unknown => ({
  index,
  role: message.role,
  content: sanitize(message.content),
  ...(message.modelName ? { modelName: sanitize(message.modelName) } : {}),
  ...(message.attachments?.length
    ? {
        attachments: message.attachments.map((attachment) =>
          sanitize({
            type: attachment.type,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes
          })
        )
      }
    : {})
})

const runTiming = (run: AssistantRunRecord): unknown => ({
  runId: run.runId,
  status: run.status,
  runOrigin: run.runOrigin,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  queueDelayMs:
    run.startedAt === undefined ? undefined : Math.max(0, run.startedAt - run.createdAt),
  durationMs:
    run.startedAt === undefined || run.finishedAt === undefined
      ? undefined
      : Math.max(0, run.finishedAt - run.startedAt),
  executionHistorySize: run.executionHistorySize
})

const artifactMetadata = (artifact: AssistantArtifactRef): unknown =>
  sanitize({
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    fileName: artifact.fileName,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    source: artifact.source,
    traceId: artifact.traceId,
    executionMode: artifact.executionMode,
    originatingRunId: artifact.originatingRunId,
    executionTraceLabel: artifact.executionTraceLabel,
    lineage: artifact.lineage
  })

const isApprovalEvent = (event: AssistantRunEvent): boolean =>
  /approv|den(?:y|ied)|reject|permission/i.test(
    `${event.type} ${event.message} ${JSON.stringify(event.metadata || {})}`
  )

const categoryUnavailable = (reason: string): AssistantProjectionAvailability => ({
  status: 'unavailable',
  reason
})
const categoryAvailable = (): AssistantProjectionAvailability => ({ status: 'available' })

export const projectAssistantSession = (
  source: AssistantSessionRecord,
  limits: typeof ASSISTANT_SESSION_PROJECTION_LIMITS = ASSISTANT_SESSION_PROJECTION_LIMITS
): AssistantSessionProjection => {
  const lifecycleEvents = [...source.eventLog]
    .sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId))
    .map((event) => sanitize(event))
    .slice(0, limits.maxArrayItems)
  const tools = source.runs
    .flatMap((run) =>
      (run.toolCalls || []).map((tool, index) =>
        sanitize({ runId: run.runId, index, toolName: tool.toolName, args: tool.args })
      )
    )
    .slice(0, limits.maxArrayItems)
  const legacyTaskGroups = source.runs
    .filter((run) => run.taskGroup)
    .map((run) => sanitize({ runId: run.runId, taskGroup: run.taskGroup }))
  const approvals = source.eventLog.filter(isApprovalEvent).map((event) => sanitize(event))
  const errorsAndRetries = source.runs
    .filter((run) => run.errorMessage || run.runOrigin === 'retry' || run.runOrigin === 'resume')
    .map((run) =>
      sanitize({
        runId: run.runId,
        status: run.status,
        runOrigin: run.runOrigin,
        errorMessage: run.errorMessage,
        resumeAttempt: run.resumeAttempt,
        resumeMode: run.resumeMode,
        resumeSourceRunId: run.resumeSourceRunId
      })
    )
  const usageAndTiming = source.runs.map(runTiming).map((value) => sanitize(value))
  const messages = source.messages.slice(0, limits.maxArrayItems).map(messageProjection)
  const inputArrayTruncated =
    source.messages.length > limits.maxArrayItems ||
    source.eventLog.length > limits.maxArrayItems ||
    source.runs.length > limits.maxArrayItems ||
    source.artifacts.length > limits.maxArrayItems
  const artifacts = source.artifacts.slice(0, limits.maxArrayItems).map(artifactMetadata)
  const timeline = [
    ...source.eventLog.map((event) => ({
      id: event.eventId,
      at: event.createdAt,
      kind: `event:${event.type}`,
      runId: event.runId,
      value: sanitize(event)
    })),
    ...source.artifacts.map((artifact) => ({
      id: artifact.artifactId,
      at: artifact.createdAt,
      kind: 'artifact',
      runId: artifact.runId,
      value: artifactMetadata(artifact)
    })),
    ...source.runs.map((run) => ({
      id: run.runId,
      at: run.createdAt,
      kind: `run:${run.status}`,
      runId: run.runId,
      value: sanitize(runTiming(run))
    }))
  ]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(0, limits.maxArrayItems)

  const unavailable = 'Not recorded by AssistantSessionStore.'
  const availability: AssistantSessionProjection['availability'] = {
    messages: categoryAvailable(),
    lifecycleEvents: categoryAvailable(),
    tools: categoryAvailable(),
    routeIdentity: categoryAvailable(),
    legacyTaskGroups: legacyTaskGroups.length
      ? categoryAvailable()
      : categoryUnavailable('No legacy task-group facts were recorded.'),
    durableDrives: categoryUnavailable(unavailable),
    approvals: approvals.length
      ? categoryAvailable()
      : categoryUnavailable('No approval facts were recorded in session events.'),
    artifacts: categoryAvailable(),
    errorsAndRetries: categoryAvailable(),
    usageAndTiming: categoryAvailable(),
    graphVersions: categoryUnavailable(unavailable),
    teams: categoryUnavailable(unavailable),
    runtimeChannels: categoryUnavailable(unavailable),
    fileDiffs: categoryUnavailable(unavailable)
  }

  const projection: AssistantSessionProjection = {
    schemaVersion: 1,
    redacted: true,
    bounded: true,
    session: {
      sessionKey: redactString(source.sessionKey, limits.maxStringLength),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      route: routeIdentity(source.route),
      workspaceId: redactString(source.workspace.workspaceId, limits.maxStringLength),
      attributionQuality: (source.messageEntries || []).every(
        (entry) => entry.attributionQuality === 'exact'
      )
        ? 'exact'
        : 'legacy-approximate',
      ...(source.lineage ? { lineage: sanitize(source.lineage, limits) } : {})
    },
    availability,
    messages,
    lifecycleEvents,
    tools,
    legacyTaskGroups,
    approvals,
    artifacts,
    errorsAndRetries,
    usageAndTiming,
    timeline,
    truncation: { truncated: inputArrayTruncated, limits }
  }

  const bounded = projection as AssistantSessionProjection & Record<string, unknown>
  const arrays = [
    'timeline',
    'lifecycleEvents',
    'messages',
    'tools',
    'artifacts',
    'usageAndTiming',
    'errorsAndRetries',
    'legacyTaskGroups',
    'approvals'
  ]
  while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > limits.maxTotalBytes) {
    const key = arrays.find((candidate) => (bounded[candidate] as unknown[]).length > 0)
    if (!key) break
    ;(bounded[key] as unknown[]).pop()
    bounded.truncation.truncated = true
  }
  return projection
}

const stable = (value: unknown): string => JSON.stringify(value)
const dimensionValue = (
  projection: AssistantSessionProjection,
  dimension: AssistantSessionDiffDimension
): unknown => {
  if (dimension === 'routeIdentity') return projection.session.route
  if (dimension === 'lineage') return projection.session.lineage
  if (dimension in projection) return projection[dimension as keyof AssistantSessionProjection]
  return undefined
}
const dimensionCount = (value: unknown): number | undefined =>
  Array.isArray(value) ? value.length : undefined

const lineageRelationship = (
  left: AssistantSessionProjection,
  right: AssistantSessionProjection
): AssistantSessionProjectionDiff['lineage'] => {
  if (left.session.sessionKey === right.session.sessionKey) return { relationship: 'same' }
  const leftLineage = left.session.lineage as { sourceSessionKey?: string } | undefined
  const rightLineage = right.session.lineage as { sourceSessionKey?: string } | undefined
  if (leftLineage?.sourceSessionKey === right.session.sessionKey)
    return {
      relationship: 'left-forked-from-right',
      commonSourceSessionKey: right.session.sessionKey
    }
  if (rightLineage?.sourceSessionKey === left.session.sessionKey)
    return {
      relationship: 'right-forked-from-left',
      commonSourceSessionKey: left.session.sessionKey
    }
  if (
    leftLineage?.sourceSessionKey &&
    leftLineage.sourceSessionKey === rightLineage?.sourceSessionKey
  )
    return { relationship: 'related-forks', commonSourceSessionKey: leftLineage.sourceSessionKey }
  return { relationship: 'unrelated' }
}

export const diffAssistantSessionProjections = (
  left: AssistantSessionProjection,
  right: AssistantSessionProjection
): AssistantSessionProjectionDiff => {
  const dimensions = [
    ...Object.keys(left.availability),
    'lineage'
  ] as AssistantSessionDiffDimension[]
  const classified = Object.fromEntries(
    dimensions.map((dimension) => {
      const leftAvailable =
        dimension === 'lineage'
          ? Boolean(left.session.lineage)
          : left.availability[dimension].status === 'available'
      const rightAvailable =
        dimension === 'lineage'
          ? Boolean(right.session.lineage)
          : right.availability[dimension].status === 'available'
      const leftValue = dimensionValue(left, dimension)
      const rightValue = dimensionValue(right, dimension)
      let classification: 'equal' | 'changed' | 'left-only' | 'right-only' | 'unavailable'
      if (!leftAvailable && !rightAvailable) classification = 'unavailable'
      else if (!leftAvailable) classification = 'right-only'
      else if (!rightAvailable) classification = 'left-only'
      else classification = stable(leftValue) === stable(rightValue) ? 'equal' : 'changed'
      return [
        dimension,
        {
          classification,
          leftAvailable,
          rightAvailable,
          leftCount: dimensionCount(leftValue),
          rightCount: dimensionCount(rightValue)
        }
      ]
    })
  ) as AssistantSessionProjectionDiff['dimensions']

  const maxMessages = Math.max(left.messages.length, right.messages.length)
  const sideBySide = Array.from({ length: maxMessages }, (_, index) => {
    const leftValue = left.messages[index]
    const rightValue = right.messages[index]
    return {
      index,
      ...(leftValue === undefined ? {} : { left: leftValue }),
      ...(rightValue === undefined ? {} : { right: rightValue }),
      classification:
        leftValue === undefined
          ? ('right-only' as const)
          : rightValue === undefined
            ? ('left-only' as const)
            : stable(leftValue) === stable(rightValue)
              ? ('equal' as const)
              : ('changed' as const)
    }
  })

  const merged = [
    ...left.timeline.map((item) => ({ side: 'left' as const, item })),
    ...right.timeline.map((item) => ({ side: 'right' as const, item }))
  ].sort(
    (a, b) =>
      a.item.at - b.item.at || a.item.id.localeCompare(b.item.id) || a.side.localeCompare(b.side)
  )
  const mergedTimeline: AssistantSessionProjectionDiff['mergedTimeline'] = []
  for (const entry of merged) {
    const previous = mergedTimeline.at(-1)
    if (
      previous &&
      previous.at === entry.item.at &&
      previous.kind === entry.item.kind &&
      previous.side !== entry.side &&
      stable(previous.left || previous.right) === stable(entry.item.value)
    ) {
      previous.side = 'both'
      previous.left = entry.item.value
      previous.right = entry.item.value
    } else {
      mergedTimeline.push({
        side: entry.side,
        at: entry.item.at,
        kind: entry.item.kind,
        ...(entry.side === 'left' ? { left: entry.item.value } : { right: entry.item.value })
      })
    }
  }
  return {
    schemaVersion: 1,
    leftSessionKey: left.session.sessionKey,
    rightSessionKey: right.session.sessionKey,
    lineage: lineageRelationship(left, right),
    dimensions: classified,
    mergedTimeline,
    sideBySide
  }
}

const escapeMarkdown = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/([`*_{}[\]()#+.!|<>-])/g, '\\$1')
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export const exportAssistantSessionJsonl = (projection: AssistantSessionProjection): string => {
  const records = [
    { type: 'session', value: projection.session },
    { type: 'availability', value: projection.availability },
    ...projection.messages.map((value) => ({ type: 'message', value })),
    ...projection.lifecycleEvents.map((value) => ({ type: 'lifecycleEvent', value })),
    ...projection.tools.map((value) => ({ type: 'tool', value })),
    ...projection.artifacts.map((value) => ({ type: 'artifact', value })),
    ...projection.errorsAndRetries.map((value) => ({ type: 'errorOrRetry', value })),
    ...projection.usageAndTiming.map((value) => ({ type: 'usageOrTiming', value }))
  ]
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

export const exportAssistantSessionMarkdown = (projection: AssistantSessionProjection): string => {
  const lines = [
    `# Assistant session ${escapeMarkdown(projection.session.sessionKey)}`,
    '',
    '## Availability',
    ''
  ]
  for (const [category, availability] of Object.entries(projection.availability))
    lines.push(
      `- **${escapeMarkdown(category)}**: ${availability.status}${availability.reason ? ` — ${escapeMarkdown(availability.reason)}` : ''}`
    )
  lines.push('', '## Messages', '')
  for (const message of projection.messages)
    lines.push(`- \`${escapeMarkdown(JSON.stringify(message))}\``)
  lines.push('', '## Timeline', '')
  for (const item of projection.timeline)
    lines.push(
      `- ${item.at} **${escapeMarkdown(item.kind)}**: \`${escapeMarkdown(JSON.stringify(item.value))}\``
    )
  return `${lines.join('\n')}\n`
}

export const exportAssistantSessionHtml = (projection: AssistantSessionProjection): string => {
  const availability = Object.entries(projection.availability)
    .map(
      ([key, value]) =>
        `<li><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value.status)}${value.reason ? ` — ${escapeHtml(value.reason)}` : ''}</li>`
    )
    .join('')
  const messages = projection.messages
    .map((message) => `<li><pre>${escapeHtml(JSON.stringify(message, null, 2))}</pre></li>`)
    .join('')
  const timeline = projection.timeline
    .map(
      (item) =>
        `<li><time>${item.at}</time> <strong>${escapeHtml(item.kind)}</strong><pre>${escapeHtml(JSON.stringify(item.value, null, 2))}</pre></li>`
    )
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Assistant session ${escapeHtml(projection.session.sessionKey)}</title><style>body{font-family:system-ui;max-width:960px;margin:auto;padding:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:.75rem}</style></head><body><h1>Assistant session ${escapeHtml(projection.session.sessionKey)}</h1><h2>Availability</h2><ul>${availability}</ul><h2>Messages</h2><ol>${messages}</ol><h2>Timeline</h2><ol>${timeline}</ol></body></html>`
}
