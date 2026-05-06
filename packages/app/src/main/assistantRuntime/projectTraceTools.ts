import type {
  ProjectTraceDocument,
  ProjectTraceEventSummary,
  ProjectTraceExecutableRule,
  ProjectTraceExecutableRuleType,
  ProjectTraceReference,
  ProjectTraceSemanticRule
} from '@shared/projectTrace'

const DEFAULT_REPLAY_MARKDOWN_LIMIT = 4_000
const REPLAY_EVENT_SUMMARY_LIMIT = 80

type ProjectTraceReplayStep = {
  index: number
  id?: string
  at?: string
  scope: string
  action: string
  status: string
  summary: string
  metrics: Record<string, number | boolean | string[]>
  riskSignals: string[]
}

type ProjectTraceRuleCheckStatus = 'pass' | 'deviation' | 'insufficient_data' | 'review_required'

type ProjectTraceRuleCheck = {
  traceId: string
  ruleId: string
  type: ProjectTraceExecutableRuleType
  status: ProjectTraceRuleCheckStatus
  measuredValue?: number
  condition: ProjectTraceExecutableRule['condition']
  feedback: string
  reason: string
}

type ProjectTraceVerificationEvent = Partial<ProjectTraceEventSummary>

function previewText(value: string | undefined, maxChars = DEFAULT_REPLAY_MARKDOWN_LIMIT): string {
  const normalized = (value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!normalized) return ''
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized
}

function compactNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]))
}

function collectReplayWarnings(trace: ProjectTraceDocument): string[] {
  const warnings: string[] = []
  if (!trace.eventSummaries?.length) {
    warnings.push('Trace has no event summaries; replay is document-guided only.')
  }
  if (!trace.executableRules?.rules.length) {
    warnings.push('Trace has no software-executable rules; verification may need human review.')
  }
  if (trace.executableRules?.semanticRules?.length) {
    warnings.push('Trace includes semantic rules that require model or human review.')
  }
  warnings.push(...(trace.executableRules?.unsupportedNotes || []))
  return uniqueStrings(warnings)
}

function eventToReplayStep(event: ProjectTraceEventSummary, index: number): ProjectTraceReplayStep {
  const metrics: Record<string, number | boolean | string[]> = {}
  const metricKeys = [
    'entityCount',
    'affectedItemCount',
    'createdItemCount',
    'removedItemCount',
    'resizedItemCount',
    'rotatedItemCount',
    'reorderedItemCount',
    'movementDistancePx',
    'maxScaleChangeRatio',
    'maxRotationDeltaDeg',
    'maxLayerDelta'
  ] as const

  for (const key of metricKeys) {
    const value = event[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      metrics[key] = value
    }
  }
  if (typeof event.canvasMutation === 'boolean') {
    metrics.canvasMutation = event.canvasMutation
  }
  if (event.inputKinds?.length) {
    metrics.inputKinds = event.inputKinds
  }
  if (event.outputKinds?.length) {
    metrics.outputKinds = event.outputKinds
  }

  return {
    index,
    ...(event.id ? { id: event.id } : {}),
    ...(event.at ? { at: event.at } : {}),
    scope: event.scope,
    action: event.action,
    status: event.status,
    summary: event.safeSummary,
    metrics,
    riskSignals: event.riskSignals || []
  }
}

function buildDocumentReplaySteps(trace: ProjectTraceDocument): ProjectTraceReplayStep[] {
  if (!trace.documentJson?.sections.length) return []

  return trace.documentJson.sections.slice(0, 24).flatMap((section, sectionIndex) =>
    section.items.slice(0, 12).map((item, itemIndex) => ({
      index: sectionIndex * 100 + itemIndex + 1,
      scope: 'trace_document',
      action: section.title || 'document_note',
      status: 'info',
      summary: item,
      metrics: {},
      riskSignals: []
    }))
  )
}

export function buildProjectTraceReplayBundle(
  trace: ProjectTraceDocument | null,
  references: ProjectTraceReference[],
  options?: {
    traceId?: string
    markdownLimit?: number
  }
): Record<string, unknown> {
  if (!trace) {
    return {
      traceId: options?.traceId || '',
      found: false,
      references,
      replay: {
        replayable: false,
        source: 'missing',
        steps: [],
        rules: [],
        semanticRules: [],
        unsupportedNotes: [],
        warnings: ['Project trace not found.']
      }
    }
  }

  const replayEvents = (trace.eventSummaries || []).slice(-REPLAY_EVENT_SUMMARY_LIMIT)
  const eventSteps = replayEvents.map((event, index) => eventToReplayStep(event, index + 1))
  const documentSteps = eventSteps.length ? [] : buildDocumentReplaySteps(trace)
  const executableRules = trace.executableRules?.rules || []
  const semanticRules = trace.executableRules?.semanticRules || []
  const unsupportedNotes = trace.executableRules?.unsupportedNotes || []

  return {
    traceId: trace.manifest.id,
    found: true,
    trace: {
      manifest: trace.manifest,
      markdownPreview: previewText(trace.markdown, options?.markdownLimit),
      ...(trace.documentJson ? { documentJson: trace.documentJson } : {}),
      ...(trace.skillSummary ? { skillSummary: trace.skillSummary } : {}),
      ...(trace.executableRules ? { executableRules: trace.executableRules } : {}),
      ...(trace.referencePack ? { referencePack: trace.referencePack } : {}),
      eventSummaries: replayEvents,
      eventSummaryLimit: REPLAY_EVENT_SUMMARY_LIMIT
    },
    references,
    replay: {
      replayable: Boolean(eventSteps.length || documentSteps.length || references.length),
      source: eventSteps.length ? 'event_summaries' : 'document',
      steps: eventSteps.length ? eventSteps : documentSteps,
      rules: executableRules,
      semanticRules,
      unsupportedNotes,
      warnings: collectReplayWarnings(trace)
    }
  }
}

export function normalizeProjectTraceVerificationEvents(
  value: unknown
): ProjectTraceVerificationEvent[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
    )
    .slice(0, 200)
    .map((entry) => ({
      action: typeof entry.action === 'string' ? entry.action : undefined,
      safeSummary: typeof entry.safeSummary === 'string' ? entry.safeSummary : undefined,
      movementDistancePx: compactNumber(entry.movementDistancePx),
      maxScaleChangeRatio: compactNumber(entry.maxScaleChangeRatio),
      maxRotationDeltaDeg: compactNumber(entry.maxRotationDeltaDeg),
      removedItemCount: compactNumber(entry.removedItemCount),
      maxLayerDelta: compactNumber(entry.maxLayerDelta),
      affectedItemCount: compactNumber(entry.affectedItemCount),
      riskSignals: Array.isArray(entry.riskSignals)
        ? entry.riskSignals.filter((item): item is string => typeof item === 'string')
        : undefined
    }))
}

function compareRuleCondition(
  measuredValue: number,
  condition: ProjectTraceExecutableRule['condition']
): boolean {
  switch (condition.operator) {
    case '>':
      return measuredValue > condition.value
    case '>=':
      return measuredValue >= condition.value
    case '<':
      return measuredValue < condition.value
    case '<=':
      return measuredValue <= condition.value
    case '=':
      return measuredValue === condition.value
    default:
      return false
  }
}

function metricForRule(
  type: ProjectTraceExecutableRuleType,
  events: ProjectTraceVerificationEvent[]
): number | undefined {
  switch (type) {
    case 'canvas.move.distance':
      return maxMetric(events, 'movementDistancePx')
    case 'canvas.resize.scale':
      return maxMetric(events, 'maxScaleChangeRatio')
    case 'canvas.rotate.angle':
      return maxMetric(events, 'maxRotationDeltaDeg')
    case 'canvas.delete.item':
      return sumMetric(events, 'removedItemCount')
    case 'canvas.layer.change':
      return maxMetric(events, 'maxLayerDelta')
    default:
      return undefined
  }
}

function maxMetric(
  events: ProjectTraceVerificationEvent[],
  key: keyof ProjectTraceVerificationEvent
): number | undefined {
  const values = events
    .map((event) => compactNumber(event[key]))
    .filter((value): value is number => value !== undefined)
  return values.length ? Math.max(...values) : undefined
}

function sumMetric(
  events: ProjectTraceVerificationEvent[],
  key: keyof ProjectTraceVerificationEvent
): number | undefined {
  const values = events
    .map((event) => compactNumber(event[key]))
    .filter((value): value is number => value !== undefined)
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined
}

function verifyRule(
  traceId: string,
  rule: ProjectTraceExecutableRule,
  events: ProjectTraceVerificationEvent[]
): ProjectTraceRuleCheck {
  if (rule.mode !== 'software') {
    return {
      traceId,
      ruleId: rule.id,
      type: rule.type,
      status: 'review_required',
      condition: rule.condition,
      feedback: rule.feedback,
      reason: `Rule mode is ${rule.mode}; deterministic verification cannot prove it.`
    }
  }

  const measuredValue = metricForRule(rule.type, events)
  if (measuredValue === undefined) {
    return {
      traceId,
      ruleId: rule.id,
      type: rule.type,
      status: 'insufficient_data',
      condition: rule.condition,
      feedback: rule.feedback,
      reason: 'No matching runtime metric was provided for this rule.'
    }
  }

  const triggered = compareRuleCondition(measuredValue, rule.condition)
  return {
    traceId,
    ruleId: rule.id,
    type: rule.type,
    status: triggered ? 'deviation' : 'pass',
    measuredValue,
    condition: rule.condition,
    feedback: rule.feedback,
    reason: triggered
      ? 'Provided runtime metric triggered the trace rule.'
      : 'Provided runtime metric stayed outside the trace rule trigger.'
  }
}

export function buildProjectTraceVerificationBundle(options: {
  requestedTraceIds: string[]
  traces: ProjectTraceDocument[]
  references: ProjectTraceReference[]
  missingTraceIds: string[]
  operationSummary?: string
  eventSummaries?: ProjectTraceVerificationEvent[]
}): Record<string, unknown> {
  const eventSummaries = options.eventSummaries || []
  const ruleChecks = options.traces.flatMap((trace) =>
    (trace.executableRules?.rules || []).map((rule) =>
      verifyRule(trace.manifest.id, rule, eventSummaries)
    )
  )
  const semanticRules: Array<ProjectTraceSemanticRule & { traceId: string }> =
    options.traces.flatMap((trace) =>
      (trace.executableRules?.semanticRules || []).map((rule) => ({
        ...rule,
        traceId: trace.manifest.id
      }))
    )
  const unsupportedNotes = uniqueStrings(
    options.traces.flatMap((trace) => trace.executableRules?.unsupportedNotes || [])
  )
  const warnings = uniqueStrings([
    options.missingTraceIds.length
      ? `Missing project traces: ${options.missingTraceIds.join(', ')}.`
      : undefined,
    options.traces.length > 0 && ruleChecks.length === 0
      ? 'No software-executable trace rules were available; deterministic verification cannot prove a pass.'
      : undefined,
    eventSummaries.length
      ? undefined
      : 'No runtime event summaries were provided; software rule checks may be insufficient.',
    semanticRules.length
      ? 'Semantic trace rules require model or human review outside this deterministic tool.'
      : undefined,
    unsupportedNotes.length
      ? 'Some trace notes are unsupported by deterministic verification.'
      : undefined
  ])
  const deviationHints = uniqueStrings([
    ...ruleChecks
      .filter((check) => check.status === 'deviation')
      .map((check) => `${check.traceId}/${check.ruleId}: ${check.feedback}`),
    ...ruleChecks
      .filter((check) => check.status === 'insufficient_data')
      .map((check) => `${check.traceId}/${check.ruleId}: provide ${check.type} runtime metrics.`),
    ...semanticRules.map((rule) => `${rule.traceId}/${rule.id}: ${rule.feedback}`),
    ...unsupportedNotes
  ])

  return {
    requestedTraceIds: options.requestedTraceIds,
    foundTraceIds: options.traces.map((trace) => trace.manifest.id),
    missingTraceIds: options.missingTraceIds,
    operationSummary: previewText(options.operationSummary, 2_000),
    referenceCount: options.references.length,
    references: options.references,
    eventSummaryCount: eventSummaries.length,
    ruleChecks,
    semanticRules,
    unsupportedNotes,
    warnings,
    deviationHints,
    verdict: ruleChecks.some((check) => check.status === 'deviation')
      ? 'deviation_detected'
      : options.missingTraceIds.length ||
          (options.traces.length > 0 && ruleChecks.length === 0) ||
          ruleChecks.some((check) => check.status === 'insufficient_data') ||
          semanticRules.length
        ? 'needs_review'
        : 'pass'
  }
}
