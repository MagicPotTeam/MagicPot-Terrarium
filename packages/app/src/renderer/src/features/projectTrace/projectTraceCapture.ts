import type {
  ProjectTraceDocument,
  ProjectTraceEventSummary,
  ProjectTraceProjectRef
} from '@shared/projectTrace'
import { api } from '@renderer/utils/windowUtils'
import {
  clearActiveProjectTraceCapture,
  readActiveProjectTraceCapture
} from './projectTraceRuntime'
import { resolveCanvasProjectTraceProjectRef } from './projectTraceProjectRef'

export const DRAFT_TRACE_TAG = 'draft'
export const ACTIVE_CAPTURE_TRACE_TAG = 'active-capture'
export const REFERENCE_READY_TRACE_TAG = 'reference-ready'
export const REFERENCE_REVIEW_TRACE_TAG = 'needs-review'

const TRACE_QUALITY_TAGS = new Set([REFERENCE_READY_TRACE_TAG, REFERENCE_REVIEW_TRACE_TAG])
const MIN_TRACE_DESCRIPTION_CHARS = 12

export type FinalizedProjectTraceCapture = {
  trace: ProjectTraceDocument
  eventCount: number
}

export type ProjectTraceReferenceReadiness = {
  referenceReady: boolean
  reasons: string[]
}

export function isDraftTraceTagSet(tags: string[] | undefined): boolean {
  return Boolean(tags?.includes(DRAFT_TRACE_TAG))
}

export function isReferenceReadyTraceTagSet(tags: string[] | undefined): boolean {
  return Boolean(tags?.includes(REFERENCE_READY_TRACE_TAG))
}

export function getSavedTraceTags(tags: string[] | undefined): string[] {
  const nextTags = (tags || ['manual']).filter(
    (tag) => tag !== DRAFT_TRACE_TAG && tag !== ACTIVE_CAPTURE_TRACE_TAG
  )
  return nextTags.length > 0 ? nextTags : ['manual']
}

export function applyTraceReferenceReadinessTags(
  tags: string[] | undefined,
  referenceReady: boolean
): string[] {
  const nextTags = getSavedTraceTags(tags).filter((tag) => !TRACE_QUALITY_TAGS.has(tag))
  nextTags.push(referenceReady ? REFERENCE_READY_TRACE_TAG : REFERENCE_REVIEW_TRACE_TAG)
  return Array.from(new Set(nextTags))
}

export function getDraftTraceTags(tags: string[] | undefined, referenceReady: boolean): string[] {
  const nextTags = applyTraceReferenceReadinessTags(tags, referenceReady).filter(
    (tag) => tag !== ACTIVE_CAPTURE_TRACE_TAG
  )
  if (!nextTags.includes(DRAFT_TRACE_TAG)) {
    nextTags.push(DRAFT_TRACE_TAG)
  }
  return nextTags
}

export function evaluateTraceReferenceReadiness(
  description: string | undefined,
  events: ProjectTraceEventSummary[] | undefined
): ProjectTraceReferenceReadiness {
  const normalizedDescription = (description || '').replace(/\s+/g, '')
  const operationEvents = (events || []).filter((event) => event.scope !== 'system')
  const reasons: string[] = []

  if (normalizedDescription.length < MIN_TRACE_DESCRIPTION_CHARS) {
    reasons.push('用户追踪说明过短，无法判断这次追踪是否有可复用目标。')
  }
  if (operationEvents.length === 0) {
    reasons.push('没有捕获到画布、快应用、Agent 或目标执行层面的有效操作。')
  }

  return {
    referenceReady: reasons.length === 0,
    reasons
  }
}

function formatEventTime(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value
}

function summarizeEvents(events: ProjectTraceEventSummary[]): string {
  if (events.length === 0) {
    return '- 本次追踪没有捕获到可记录的操作。'
  }

  const scopeCounts = new Map<string, number>()
  const statusCounts = new Map<string, number>()
  for (const event of events) {
    scopeCounts.set(event.scope, (scopeCounts.get(event.scope) || 0) + 1)
    statusCounts.set(event.status, (statusCounts.get(event.status) || 0) + 1)
  }

  const formatCounts = (counts: Map<string, number>) =>
    Array.from(counts.entries())
      .map(([key, count]) => `${key}:${count}`)
      .join(', ')

  return [
    `- 捕获操作数：${events.length}`,
    `- 开始时间：${formatEventTime(events[0].at)}`,
    `- 结束时间：${formatEventTime(events[events.length - 1].at)}`,
    `- 操作范围：${formatCounts(scopeCounts) || 'none'}`,
    `- 状态分布：${formatCounts(statusCounts) || 'none'}`,
    '',
    '### 最近操作',
    ...events.slice(-12).map((event) => `- [${event.scope}/${event.status}] ${event.safeSummary}`)
  ].join('\n')
}

function summarizeReferenceReadiness(
  description: string | undefined,
  events: ProjectTraceEventSummary[]
): string {
  const decision = evaluateTraceReferenceReadiness(description, events)
  const descriptionText = (description || '').trim() || '未填写'
  const result = decision.referenceReady
    ? '可作为引用候选。保存追踪后，才会出现在实时追踪和目标执行的引用候选中。'
    : '待复核。即使保存，也只作为记录保留，不进入实时追踪或目标执行引用候选。'
  const reasons = decision.reasons.length
    ? decision.reasons.map((reason) => `- ${reason}`)
    : ['- 用户说明足够明确。', '- 捕获到至少一条非系统操作。']

  return [
    '## 可引用性判断',
    '',
    `- 结果：${result}`,
    `- 用户追踪说明：${descriptionText}`,
    '',
    '### 判断依据',
    ...reasons
  ].join('\n')
}

function appendFinalSummary(
  markdown: string,
  description: string | undefined,
  events: ProjectTraceEventSummary[]
): string {
  const marker = '## 本次追踪总结'
  const baseMarkdown = markdown.includes(marker)
    ? markdown.slice(0, markdown.indexOf(marker)).trim()
    : markdown.trim()

  return [
    baseMarkdown,
    '',
    marker,
    '',
    summarizeEvents(events),
    '',
    summarizeReferenceReadiness(description, events),
    ''
  ].join('\n')
}

export async function finalizeActiveProjectTraceCapture(
  projectId: string
): Promise<FinalizedProjectTraceCapture | null> {
  const capture = readActiveProjectTraceCapture(projectId)
  if (!capture) return null

  const traceSvc = api().svcProjectTrace
  const project = {
    ...capture.project,
    ...(await resolveCanvasProjectTraceProjectRef(projectId, capture.projectName))
  }
  const stopEvent: ProjectTraceEventSummary = {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    scope: 'system',
    action: 'stop_trace_capture',
    label: 'Stop trace capture',
    status: 'success',
    safeSummary: 'Trace capture stopped and final trace summary requested.'
  }

  const appended = await traceSvc
    .appendProjectTraceEvent({
      project: project as ProjectTraceProjectRef,
      traceId: capture.traceId,
      event: stopEvent
    })
    .catch(() => null)
  const trace =
    appended?.trace ||
    (
      await traceSvc.readProjectTraceDocument({
        project: project as ProjectTraceProjectRef,
        traceId: capture.traceId
      })
    ).trace
  if (!trace) {
    clearActiveProjectTraceCapture(projectId)
    return null
  }

  const eventSummaries = trace.eventSummaries || []
  const referenceReadiness = evaluateTraceReferenceReadiness(
    trace.manifest.description,
    eventSummaries
  )
  const saved = await traceSvc.saveProjectTraceDocument({
    project: project as ProjectTraceProjectRef,
    trace: {
      id: trace.manifest.id,
      name: trace.manifest.name,
      description: trace.manifest.description,
      sourceKind: trace.manifest.sourceKind,
      projectId: trace.manifest.projectId,
      projectName: trace.manifest.projectName,
      tags: getDraftTraceTags(trace.manifest.tags, referenceReadiness.referenceReady),
      markdown: appendFinalSummary(trace.markdown, trace.manifest.description, eventSummaries),
      documentJson: trace.documentJson,
      eventSummaries,
      llmEnhanced: trace.manifest.redaction.llmEnhanced,
      llmProfileId: trace.manifest.redaction.llmProfileId
    }
  })

  clearActiveProjectTraceCapture(projectId)
  return {
    trace: saved.trace,
    eventCount: saved.trace.eventSummaries?.length || saved.trace.manifest.eventCount
  }
}
