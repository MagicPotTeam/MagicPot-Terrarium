import type { LLMReasoningEffort } from '@shared/llm'
import { normalizeReasoningEffort } from '@shared/llm'
import type {
  ProjectTraceDocument,
  ProjectTraceExecutableRule,
  ProjectTraceEventScope,
  ProjectTraceEventStatus,
  ProjectTraceEventSummary,
  ProjectTraceProjectRef,
  ProjectTraceRealtimeAdvice,
  ProjectTraceReference,
  ProjectTraceSemanticRule
} from '@shared/projectTrace'
import {
  extractProjectTraceMovementLimitPx,
  extractProjectTraceRuleText
} from '@shared/projectTraceMemory'

export { extractProjectTraceMovementLimitPx } from '@shared/projectTraceMemory'

export const PROJECT_TRACE_RUNTIME_EVENT = 'project-trace:event'
export const PROJECT_TRACE_CAPTURE_STATE_EVENT = 'project-trace:capture-state-changed'
export const PROJECT_TRACE_TARGET_REFERENCE_EVENT = 'project-trace:target-reference-changed'
export const PROJECT_TRACE_REALTIME_ADVICE_EVENT = 'project-trace:realtime-advice'
const RECENT_EVENT_LIMIT = 120
const REALTIME_ADVICE_COOLDOWN_MS = 5000
const STORAGE_KEY_PREFIX = 'projectTrace.recentEvents.'
const ACTIVE_CAPTURE_KEY_PREFIX = 'projectTrace.activeCapture.'
const ACTIVE_REALTIME_KEY_PREFIX = 'projectTrace.activeRealtime.'
const TARGET_REFERENCE_KEY_PREFIX = 'projectTrace.targetReferences.'
const realtimeAdviceLastDispatchedAt = new Map<string, number>()

export type ProjectTraceRuntimeEvent = {
  projectId?: string
  projectName?: string
  event: ProjectTraceEventSummary
}

export type ProjectTraceCaptureStateEvent = {
  projectId: string
  traceId?: string
  traceIds?: string[]
  active: boolean
  mode?: 'capture' | 'realtime'
}

export type ProjectTraceActiveCaptureTarget = {
  projectId: string
  projectName?: string
  project: ProjectTraceProjectRef
  traceId: string
}

export type ProjectTraceActiveRealtimeTarget = {
  projectId: string
  projectName?: string
  referenceTraceIds: string[]
  referenceTraceId?: string
  modelProfileId?: string
  modelReasoningEffort?: LLMReasoningEffort
}

export type ProjectTraceTargetReferenceState = {
  projectId: string
  traceIds: string[]
}

export type ProjectTraceRealtimeAdviceEvent = {
  projectId: string
  advice: ProjectTraceRealtimeAdvice
}

type ProjectTraceRealtimeModelReview = {
  shouldFeedback: boolean
  advice?: string
  reason?: string
}

function normalizeText(value: unknown, maxLength = 500): string {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted-token]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[redacted-local-path]')
    .replace(/\b(?:file|local-media):\/\/\/?[^\s"'<>]+/gi, '[redacted-local-media]')
    .trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function truncateRuntimeText(value: string | undefined, maxLength = 1600): string {
  return normalizeText(value || '', maxLength)
}

function normalizeScope(value: ProjectTraceEventScope | undefined): ProjectTraceEventScope {
  return value || 'system'
}

function normalizeStatus(value: ProjectTraceEventStatus | undefined): ProjectTraceEventStatus {
  return value || 'info'
}

function normalizeMetric(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.round(value * 100) / 100)
}

function shouldDispatchRealtimeAdvice(projectId: string, traceId: string, kind: string): boolean {
  const key = `${projectId}:${traceId}:${kind}`
  const now = Date.now()
  const previous = realtimeAdviceLastDispatchedAt.get(key) || 0
  if (now - previous < REALTIME_ADVICE_COOLDOWN_MS) {
    return false
  }
  realtimeAdviceLastDispatchedAt.set(key, now)
  return true
}

function parseRealtimeModelReview(content: string): ProjectTraceRealtimeModelReview | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced || content.match(/\{[\s\S]*\}/)?.[0] || content
  try {
    const parsed = JSON.parse(source) as Partial<ProjectTraceRealtimeModelReview>
    if (typeof parsed.shouldFeedback !== 'boolean') return null
    return {
      shouldFeedback: parsed.shouldFeedback,
      ...(typeof parsed.advice === 'string' ? { advice: normalizeText(parsed.advice, 500) } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: normalizeText(parsed.reason, 300) } : {})
    }
  } catch {
    return null
  }
}

async function reviewRealtimeAdviceWithModel(options: {
  modelProfileId: string
  modelReasoningEffort?: LLMReasoningEffort
  trace: ProjectTraceDocument
  event: ProjectTraceEventSummary
  rule: ProjectTraceExecutableRule
  metricValue: number
  softwareAdvice: string
}): Promise<ProjectTraceRealtimeModelReview | null> {
  const abortController = new AbortController()
  const timeout = window.setTimeout(() => abortController.abort(), 4000)
  try {
    const { api } = await import('@renderer/utils/windowUtils')
    const response = await api().svcLLMProxy.chat(
      {
        profileId: options.modelProfileId,
        reasoningEffort: options.modelReasoningEffort,
        messages: [
          {
            role: 'system',
            content:
              'You review realtime trace candidate anomalies. Use only redacted trace summaries and event metrics. Return strict JSON only: {"shouldFeedback": boolean, "advice": string, "reason": string}. Advice must be concise Chinese.'
          },
          {
            role: 'user',
            content: JSON.stringify(
              {
                trace: {
                  name: options.trace.manifest.name,
                  description: options.trace.manifest.description || '',
                  contentPreview: truncateRuntimeText(options.trace.markdown, 1200)
                },
                event: {
                  action: options.event.action,
                  scope: options.event.scope,
                  status: options.event.status,
                  safeSummary: options.event.safeSummary,
                  movementDistancePx: options.event.movementDistancePx,
                  maxScaleChangeRatio: options.event.maxScaleChangeRatio,
                  maxRotationDeltaDeg: options.event.maxRotationDeltaDeg,
                  removedItemCount: options.event.removedItemCount,
                  reorderedItemCount: options.event.reorderedItemCount,
                  maxLayerDelta: options.event.maxLayerDelta
                },
                softwareCandidate: {
                  kind: options.rule.type,
                  rule: options.rule,
                  metricValue: options.metricValue,
                  advice: options.softwareAdvice
                }
              },
              null,
              2
            )
          }
        ]
      },
      { signal: abortController.signal }
    )
    return parseRealtimeModelReview(response.content || '')
  } catch (error) {
    console.warn('[ProjectTrace] realtime model review failed; using software advice.', error)
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

async function reviewRealtimeSemanticRuleWithModel(options: {
  modelProfileId: string
  modelReasoningEffort?: LLMReasoningEffort
  trace: ProjectTraceDocument
  event: ProjectTraceEventSummary
  semanticRule: ProjectTraceSemanticRule
}): Promise<ProjectTraceRealtimeModelReview | null> {
  const abortController = new AbortController()
  const timeout = window.setTimeout(() => abortController.abort(), 4000)
  try {
    const { api } = await import('@renderer/utils/windowUtils')
    const response = await api().svcLLMProxy.chat(
      {
        profileId: options.modelProfileId,
        reasoningEffort: options.modelReasoningEffort,
        messages: [
          {
            role: 'system',
            content:
              'You review realtime trace semantic-rule candidates. Use only redacted trace summaries and event metrics. Return strict JSON only: {"shouldFeedback": boolean, "advice": string, "reason": string}. Advice must be concise Chinese. If the event does not clearly conflict with the semantic rule, return shouldFeedback false.'
          },
          {
            role: 'user',
            content: JSON.stringify(
              {
                trace: {
                  name: options.trace.manifest.name,
                  description: options.trace.manifest.description || '',
                  skillSummary: options.trace.skillSummary?.summary || '',
                  semanticRule: {
                    requirement: options.semanticRule.requirement,
                    target: options.semanticRule.target || '',
                    feedback: options.semanticRule.feedback
                  }
                },
                event: {
                  action: options.event.action,
                  scope: options.event.scope,
                  status: options.event.status,
                  safeSummary: options.event.safeSummary,
                  movementDistancePx: options.event.movementDistancePx,
                  maxScaleChangeRatio: options.event.maxScaleChangeRatio,
                  maxRotationDeltaDeg: options.event.maxRotationDeltaDeg,
                  removedItemCount: options.event.removedItemCount,
                  reorderedItemCount: options.event.reorderedItemCount,
                  maxLayerDelta: options.event.maxLayerDelta,
                  affectedItemCount: options.event.affectedItemCount,
                  createdItemCount: options.event.createdItemCount
                }
              },
              null,
              2
            )
          }
        ]
      },
      { signal: abortController.signal }
    )
    return parseRealtimeModelReview(response.content || '')
  } catch (error) {
    console.warn('[ProjectTrace] realtime semantic model review failed.', error)
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

type ProjectTraceRealtimeRuleMatch = {
  rule: ProjectTraceExecutableRule
  metricValue: number
  advice: string
  summary: string
}

function compareRealtimeRuleMetric(
  metricValue: number,
  operator: ProjectTraceExecutableRule['condition']['operator'],
  threshold: number
): boolean {
  if (operator === '>') return metricValue > threshold
  if (operator === '>=') return metricValue >= threshold
  if (operator === '<') return metricValue < threshold
  if (operator === '<=') return metricValue <= threshold
  return metricValue === threshold
}

function resolveRealtimeRuleMetric(
  rule: ProjectTraceExecutableRule,
  event: ProjectTraceEventSummary
): number | null {
  if (rule.type === 'canvas.move.distance') return event.movementDistancePx ?? null
  if (rule.type === 'canvas.resize.scale') return event.maxScaleChangeRatio ?? null
  if (rule.type === 'canvas.rotate.angle') return event.maxRotationDeltaDeg ?? null
  if (rule.type === 'canvas.delete.item') return event.removedItemCount ?? 0
  if (rule.type === 'canvas.layer.change')
    return event.maxLayerDelta ?? event.reorderedItemCount ?? 0
  return null
}

function formatRealtimeRuleMetric(
  value: number,
  unit: ProjectTraceExecutableRule['condition']['unit']
): string {
  if (unit === 'ratio') return `${Math.round(value * 100)}%`
  if (unit === 'deg') return `${Math.round(value)}°`
  if (unit === 'px') return `${Math.round(value)}px`
  return `${Math.round(value)}`
}

function buildRealtimeRuleAdvice(options: {
  trace: ProjectTraceDocument
  rule: ProjectTraceExecutableRule
  metricValue: number
}): string {
  if (options.rule.feedback) return options.rule.feedback
  const value = formatRealtimeRuleMetric(options.metricValue, options.rule.condition.unit)
  const limit = formatRealtimeRuleMetric(options.rule.condition.value, options.rule.condition.unit)
  return `实时追踪发现偏离：本次操作指标为 ${value}，命中追踪记录「${options.trace.manifest.name}」里的 ${limit} 规则。请复核本次操作是否符合该追踪记忆。`
}

function buildFallbackMovementRule(movementLimitPx: number): ProjectTraceExecutableRule {
  return {
    id: 'fallback-canvas-move-distance',
    type: 'canvas.move.distance',
    target: 'selected.image',
    condition: {
      operator: '>',
      value: movementLimitPx,
      unit: 'px'
    },
    feedback: `图片移动距离过大，请复核位置，或将单次移动控制在 ${Math.round(movementLimitPx)}px 以内。`,
    mode: 'software',
    source: 'trace_intent',
    confidence: 0.72
  }
}

function resolveRealtimeExecutableRules(trace: ProjectTraceDocument): ProjectTraceExecutableRule[] {
  const softwareRules =
    trace.executableRules?.rules.filter(
      (rule) => rule.mode === 'software' || rule.mode === 'model_review'
    ) || []
  if (softwareRules.length > 0) return softwareRules
  const fallbackMovementLimitPx = extractProjectTraceMovementLimitPx(
    extractProjectTraceRuleText(trace)
  )
  return fallbackMovementLimitPx ? [buildFallbackMovementRule(fallbackMovementLimitPx)] : []
}

function resolveRealtimeSemanticRules(trace: ProjectTraceDocument): ProjectTraceSemanticRule[] {
  return trace.executableRules?.semanticRules?.filter((rule) => rule.mode === 'model_review') || []
}

function evaluateRealtimeTraceRule(
  trace: ProjectTraceDocument,
  event: ProjectTraceEventSummary
): ProjectTraceRealtimeRuleMatch | null {
  for (const rule of resolveRealtimeExecutableRules(trace)) {
    const metricValue = resolveRealtimeRuleMetric(rule, event)
    if (metricValue === null) continue
    if (!compareRealtimeRuleMetric(metricValue, rule.condition.operator, rule.condition.value)) {
      continue
    }
    const value = formatRealtimeRuleMetric(metricValue, rule.condition.unit)
    const threshold = formatRealtimeRuleMetric(rule.condition.value, rule.condition.unit)
    return {
      rule,
      metricValue,
      advice: buildRealtimeRuleAdvice({ trace, rule, metricValue }),
      summary: `${rule.type} ${value} matched ${rule.condition.operator} ${threshold}.`
    }
  }
  return null
}

function getStorageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`
}

function getActiveCaptureKey(projectId: string): string {
  return `${ACTIVE_CAPTURE_KEY_PREFIX}${projectId}`
}

function getActiveRealtimeKey(projectId: string): string {
  return `${ACTIVE_REALTIME_KEY_PREFIX}${projectId}`
}

function getTargetReferenceKey(projectId: string): string {
  return `${TARGET_REFERENCE_KEY_PREFIX}${projectId}`
}

function dispatchCaptureStateChange(detail: ProjectTraceCaptureStateEvent): void {
  window.dispatchEvent(
    new CustomEvent<ProjectTraceCaptureStateEvent>(PROJECT_TRACE_CAPTURE_STATE_EVENT, {
      detail
    })
  )
}

function dispatchTargetReferenceChange(detail: ProjectTraceTargetReferenceState): void {
  window.dispatchEvent(
    new CustomEvent<ProjectTraceTargetReferenceState>(PROJECT_TRACE_TARGET_REFERENCE_EVENT, {
      detail
    })
  )
}

function dispatchRealtimeAdvice(detail: ProjectTraceRealtimeAdviceEvent): void {
  window.dispatchEvent(
    new CustomEvent<ProjectTraceRealtimeAdviceEvent>(PROJECT_TRACE_REALTIME_ADVICE_EVENT, {
      detail
    })
  )
}

export function readRecentProjectTraceEvents(projectId: string): ProjectTraceEventSummary[] {
  try {
    const raw = localStorage.getItem(getStorageKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ProjectTraceEventSummary[]) : []
  } catch {
    return []
  }
}

export function writeRecentProjectTraceEvents(
  projectId: string,
  events: ProjectTraceEventSummary[]
): void {
  try {
    localStorage.setItem(
      getStorageKey(projectId),
      JSON.stringify(events.slice(-RECENT_EVENT_LIMIT))
    )
  } catch {
    /* ignore storage failures */
  }
}

export function readActiveProjectTraceCapture(
  projectId: string
): ProjectTraceActiveCaptureTarget | null {
  try {
    const raw = localStorage.getItem(getActiveCaptureKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ProjectTraceActiveCaptureTarget>
    if (!parsed.projectId || !parsed.project || !parsed.traceId) return null
    return {
      projectId: parsed.projectId,
      ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
      project: parsed.project,
      traceId: parsed.traceId
    }
  } catch {
    return null
  }
}

export function writeActiveProjectTraceCapture(target: ProjectTraceActiveCaptureTarget): void {
  localStorage.setItem(
    getActiveCaptureKey(target.projectId),
    JSON.stringify({
      projectId: target.projectId,
      ...(target.projectName ? { projectName: target.projectName } : {}),
      project: {
        projectId: target.project.projectId,
        ...(target.project.projectName ? { projectName: target.project.projectName } : {}),
        ...(target.project.projectStorageDirName
          ? { projectStorageDirName: target.project.projectStorageDirName }
          : {})
      },
      traceId: target.traceId
    } satisfies ProjectTraceActiveCaptureTarget)
  )
  dispatchCaptureStateChange({
    projectId: target.projectId,
    traceId: target.traceId,
    active: true,
    mode: 'capture'
  })
}

export function clearActiveProjectTraceCapture(projectId: string): void {
  localStorage.removeItem(getActiveCaptureKey(projectId))
  dispatchCaptureStateChange({
    projectId,
    active: false,
    mode: 'capture'
  })
}

export function readActiveProjectTraceRealtime(
  projectId: string
): ProjectTraceActiveRealtimeTarget | null {
  try {
    const raw = localStorage.getItem(getActiveRealtimeKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ProjectTraceActiveRealtimeTarget>
    const referenceTraceIds = Array.from(
      new Set(
        (Array.isArray(parsed.referenceTraceIds)
          ? parsed.referenceTraceIds
          : typeof parsed.referenceTraceId === 'string'
            ? [parsed.referenceTraceId]
            : []
        ).filter((traceId): traceId is string => typeof traceId === 'string' && traceId.length > 0)
      )
    )
    if (!parsed.projectId || referenceTraceIds.length === 0) return null
    return {
      projectId: parsed.projectId,
      ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
      referenceTraceIds,
      referenceTraceId: referenceTraceIds[0],
      ...(parsed.modelProfileId ? { modelProfileId: parsed.modelProfileId } : {}),
      ...(normalizeReasoningEffort(parsed.modelReasoningEffort)
        ? { modelReasoningEffort: normalizeReasoningEffort(parsed.modelReasoningEffort) }
        : {})
    }
  } catch {
    return null
  }
}

export function writeActiveProjectTraceRealtime(target: ProjectTraceActiveRealtimeTarget): void {
  const referenceTraceIds = Array.from(
    new Set(
      (target.referenceTraceIds?.length
        ? target.referenceTraceIds
        : target.referenceTraceId
          ? [target.referenceTraceId]
          : []
      ).filter((traceId) => traceId.length > 0)
    )
  )
  localStorage.setItem(
    getActiveRealtimeKey(target.projectId),
    JSON.stringify({
      projectId: target.projectId,
      ...(target.projectName ? { projectName: target.projectName } : {}),
      referenceTraceIds,
      referenceTraceId: referenceTraceIds[0],
      ...(target.modelProfileId ? { modelProfileId: target.modelProfileId } : {}),
      ...(normalizeReasoningEffort(target.modelReasoningEffort)
        ? { modelReasoningEffort: normalizeReasoningEffort(target.modelReasoningEffort) }
        : {})
    } satisfies ProjectTraceActiveRealtimeTarget)
  )
  dispatchCaptureStateChange({
    projectId: target.projectId,
    traceId: referenceTraceIds[0],
    traceIds: referenceTraceIds,
    active: true,
    mode: 'realtime'
  })
}

export function clearActiveProjectTraceRealtime(projectId: string): void {
  localStorage.removeItem(getActiveRealtimeKey(projectId))
  dispatchCaptureStateChange({
    projectId,
    active: false,
    mode: 'realtime'
  })
}

export function readProjectTraceTargetReferenceState(
  projectId: string
): ProjectTraceTargetReferenceState {
  try {
    const raw = localStorage.getItem(getTargetReferenceKey(projectId))
    if (!raw) return { projectId, traceIds: [] }
    const parsed = JSON.parse(raw) as Partial<ProjectTraceTargetReferenceState>
    return {
      projectId,
      traceIds: Array.isArray(parsed.traceIds)
        ? Array.from(new Set(parsed.traceIds.filter((id): id is string => typeof id === 'string')))
        : []
    }
  } catch {
    return { projectId, traceIds: [] }
  }
}

export function writeProjectTraceTargetReferenceState(projectId: string, traceIds: string[]): void {
  const nextState: ProjectTraceTargetReferenceState = {
    projectId,
    traceIds: Array.from(new Set(traceIds.filter(Boolean)))
  }
  if (nextState.traceIds.length > 0) {
    localStorage.setItem(getTargetReferenceKey(projectId), JSON.stringify(nextState))
  } else {
    localStorage.removeItem(getTargetReferenceKey(projectId))
  }
  dispatchTargetReferenceChange(nextState)
}

async function appendActiveProjectTraceCaptureEvent(
  projectId: string,
  event: ProjectTraceEventSummary
): Promise<void> {
  const capture = readActiveProjectTraceCapture(projectId)
  if (!capture) return

  try {
    const { api } = await import('@renderer/utils/windowUtils')
    const { resolveCanvasProjectTraceProjectRef } = await import('./projectTraceProjectRef')
    const project = await resolveCanvasProjectTraceProjectRef(projectId, capture.projectName)
    await api().svcProjectTrace.appendProjectTraceEvent({
      project: {
        ...capture.project,
        ...project
      },
      traceId: capture.traceId,
      event
    })
  } catch (error) {
    console.warn('[ProjectTrace] failed to append active capture event.', error)
  }
}

function buildReferenceBackedTraceDocument(reference: ProjectTraceReference): ProjectTraceDocument {
  const referencePack = reference.referencePack
  const generatedAt = referencePack?.generatedAt || reference.updatedAt || new Date().toISOString()
  const skillSummary =
    reference.skillSummary ||
    (referencePack
      ? {
          version: 1 as const,
          generatedAt,
          summary: referencePack.contentBrief,
          applicableTo: [],
          notes: referencePack.safetyNotes,
          source: 'software' as const
        }
      : undefined)
  const executableRules =
    reference.executableRules ||
    (referencePack
      ? {
          version: 1 as const,
          generatedAt,
          rules: referencePack.softwareRules,
          ...(referencePack.semanticRules?.length
            ? { semanticRules: referencePack.semanticRules }
            : {}),
          unsupportedNotes: referencePack.unsupportedNotes
        }
      : undefined)

  return {
    manifest: {
      version: 1,
      id: reference.id,
      name: reference.name,
      ...(reference.description ? { description: reference.description } : {}),
      sourceKind: reference.sourceKind,
      createdAt: reference.updatedAt,
      updatedAt: reference.updatedAt,
      tags: reference.tags,
      eventCount: reference.eventCount,
      ...(referencePack?.trust || reference.trust
        ? { trust: referencePack?.trust || reference.trust }
        : {}),
      ...(referencePack?.runtimePolicy || reference.runtimePolicy
        ? { runtimePolicy: referencePack?.runtimePolicy || reference.runtimePolicy }
        : {}),
      files: {
        markdown: 'document.md',
        ...(skillSummary ? { skillSummary: 'skill-summary.json' as const } : {}),
        ...(executableRules ? { executableRules: 'executable-rules.json' as const } : {}),
        ...(referencePack ? { referencePack: 'reference-pack.json' as const } : {}),
        redactionReport: 'redaction-report.json'
      },
      redaction: {
        policyVersion: 1,
        containsSensitiveData: false,
        llmEnhanced: false
      }
    },
    markdown: referencePack?.contentBrief || reference.contentPreview,
    ...(skillSummary ? { skillSummary } : {}),
    ...(executableRules ? { executableRules } : {}),
    ...(referencePack ? { referencePack } : {}),
    redactionReport: {
      policyVersion: 1,
      generatedAt,
      containsSensitiveData: false,
      removedFields: [],
      replacementCount: 0,
      notes: ['Realtime evaluation uses compact reference packs, not full trace documents.']
    }
  }
}

async function evaluateActiveProjectTraceRealtimeEvent(
  projectId: string,
  event: ProjectTraceEventSummary
): Promise<void> {
  // Realtime trace pipeline: user operation -> redacted software event -> software rule screening
  // -> candidate anomaly -> optional model review with redacted summaries. Without a selected
  // review model, software rules produce feedback directly. Runtime reads compact reference packs;
  // full trace documents, full canvas, and raw media are not sent.
  const realtime = readActiveProjectTraceRealtime(projectId)
  if (!realtime || event.scope !== 'canvas') return

  try {
    const { api } = await import('@renderer/utils/windowUtils')
    const { resolveCanvasProjectTraceProjectRef } = await import('./projectTraceProjectRef')
    const project = await resolveCanvasProjectTraceProjectRef(projectId, realtime.projectName)
    const references = (
      await api().svcProjectTrace.readProjectTraceReferences({
        project,
        traceIds: realtime.referenceTraceIds,
        maxCharsPerTrace: 1200
      })
    ).references
    for (const reference of references) {
      const runtimePolicy = reference.referencePack?.runtimePolicy || reference.runtimePolicy
      if (runtimePolicy?.allowRealtime === false) continue
      const referenceTraceId = reference.id
      const trace = buildReferenceBackedTraceDocument(reference)
      const canUseModelReview =
        Boolean(realtime.modelProfileId) && runtimePolicy?.allowModelReview !== false

      const ruleMatch = evaluateRealtimeTraceRule(trace, event)
      if (!ruleMatch) {
        if (!canUseModelReview || !event.canvasMutation) continue
        for (const semanticRule of resolveRealtimeSemanticRules(trace)) {
          if (
            !shouldDispatchRealtimeAdvice(
              projectId,
              referenceTraceId,
              `semantic:${semanticRule.id}`
            )
          ) {
            continue
          }
          const modelReview = await reviewRealtimeSemanticRuleWithModel({
            modelProfileId: realtime.modelProfileId!,
            modelReasoningEffort: realtime.modelReasoningEffort,
            trace,
            event,
            semanticRule
          })
          if (!modelReview?.shouldFeedback) continue
          const adviceText = modelReview.advice || semanticRule.feedback
          dispatchRealtimeAdvice({
            projectId,
            advice: {
              id: `advice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              generatedAt: new Date().toISOString(),
              traceIds: [referenceTraceId],
              anomalies: [
                {
                  kind: 'trace_deviation',
                  severity: 'warning',
                  summary: modelReview.reason || semanticRule.requirement,
                  eventIds: [event.id]
                }
              ],
              advice: adviceText,
              modelProfileId: realtime.modelProfileId
            }
          })
          emitProjectTraceRuntimeEvent({
            projectId,
            scope: 'system',
            action: 'realtime_trace_advice',
            status: 'warning',
            safeSummary: adviceText,
            riskSignals: ['trace_deviation']
          })
        }
        continue
      }
      if (!shouldDispatchRealtimeAdvice(projectId, referenceTraceId, ruleMatch.rule.type)) {
        continue
      }

      const modelReview = canUseModelReview
        ? await reviewRealtimeAdviceWithModel({
            modelProfileId: realtime.modelProfileId!,
            modelReasoningEffort: realtime.modelReasoningEffort,
            trace,
            event,
            rule: ruleMatch.rule,
            metricValue: ruleMatch.metricValue,
            softwareAdvice: ruleMatch.advice
          })
        : null
      if (modelReview && !modelReview.shouldFeedback) {
        continue
      }
      const adviceText = modelReview?.advice || ruleMatch.advice
      dispatchRealtimeAdvice({
        projectId,
        advice: {
          id: `advice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          generatedAt: new Date().toISOString(),
          traceIds: [referenceTraceId],
          anomalies: [
            {
              kind: 'trace_deviation',
              severity: 'warning',
              summary: ruleMatch.summary,
              eventIds: [event.id]
            }
          ],
          advice: adviceText,
          ...(modelReview && realtime.modelProfileId
            ? { modelProfileId: realtime.modelProfileId }
            : {})
        }
      })
      emitProjectTraceRuntimeEvent({
        projectId,
        scope: 'system',
        action: 'realtime_trace_advice',
        status: 'warning',
        safeSummary: adviceText,
        riskSignals: ['trace_deviation']
      })
    }
  } catch (error) {
    console.warn('[ProjectTrace] failed to evaluate active realtime trace event.', error)
  }
}

export function emitProjectTraceRuntimeEvent(input: {
  projectId?: string
  projectName?: string
  scope: ProjectTraceEventScope
  action: string
  label?: string
  status?: ProjectTraceEventStatus
  safeSummary: string
  entityType?: string
  entityCount?: number
  inputKinds?: string[]
  outputKinds?: string[]
  affectedItemCount?: number
  createdItemCount?: number
  removedItemCount?: number
  resizedItemCount?: number
  rotatedItemCount?: number
  reorderedItemCount?: number
  movementDistancePx?: number
  maxScaleChangeRatio?: number
  maxRotationDeltaDeg?: number
  maxLayerDelta?: number
  canvasMutation?: boolean
  riskSignals?: string[]
}): ProjectTraceEventSummary {
  const event: ProjectTraceEventSummary = {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    scope: normalizeScope(input.scope),
    action: normalizeText(input.action, 120) || 'operation',
    ...(input.label ? { label: normalizeText(input.label, 180) } : {}),
    status: normalizeStatus(input.status),
    safeSummary: normalizeText(input.safeSummary, 500) || 'Operation recorded.',
    ...(input.entityType ? { entityType: normalizeText(input.entityType, 80) } : {}),
    ...(typeof input.entityCount === 'number' ? { entityCount: input.entityCount } : {}),
    ...(input.inputKinds?.length ? { inputKinds: input.inputKinds.slice(0, 12) } : {}),
    ...(input.outputKinds?.length ? { outputKinds: input.outputKinds.slice(0, 12) } : {}),
    ...(typeof input.affectedItemCount === 'number'
      ? { affectedItemCount: input.affectedItemCount }
      : {}),
    ...(typeof input.createdItemCount === 'number'
      ? { createdItemCount: input.createdItemCount }
      : {}),
    ...(typeof input.removedItemCount === 'number'
      ? { removedItemCount: input.removedItemCount }
      : {}),
    ...(typeof input.resizedItemCount === 'number'
      ? { resizedItemCount: input.resizedItemCount }
      : {}),
    ...(typeof input.rotatedItemCount === 'number'
      ? { rotatedItemCount: input.rotatedItemCount }
      : {}),
    ...(typeof input.reorderedItemCount === 'number'
      ? { reorderedItemCount: input.reorderedItemCount }
      : {}),
    ...(normalizeMetric(input.movementDistancePx) !== undefined
      ? { movementDistancePx: normalizeMetric(input.movementDistancePx) }
      : {}),
    ...(normalizeMetric(input.maxScaleChangeRatio) !== undefined
      ? { maxScaleChangeRatio: normalizeMetric(input.maxScaleChangeRatio) }
      : {}),
    ...(normalizeMetric(input.maxRotationDeltaDeg) !== undefined
      ? { maxRotationDeltaDeg: normalizeMetric(input.maxRotationDeltaDeg) }
      : {}),
    ...(normalizeMetric(input.maxLayerDelta) !== undefined
      ? { maxLayerDelta: normalizeMetric(input.maxLayerDelta) }
      : {}),
    ...(typeof input.canvasMutation === 'boolean' ? { canvasMutation: input.canvasMutation } : {}),
    ...(input.riskSignals?.length ? { riskSignals: input.riskSignals.slice(0, 12) } : {})
  }

  if (input.projectId) {
    const recent = readRecentProjectTraceEvents(input.projectId)
    writeRecentProjectTraceEvents(input.projectId, [...recent, event])
    void appendActiveProjectTraceCaptureEvent(input.projectId, event)
    void evaluateActiveProjectTraceRealtimeEvent(input.projectId, event)
  }

  window.dispatchEvent(
    new CustomEvent<ProjectTraceRuntimeEvent>(PROJECT_TRACE_RUNTIME_EVENT, {
      detail: {
        projectId: input.projectId,
        projectName: input.projectName,
        event
      }
    })
  )

  return event
}
