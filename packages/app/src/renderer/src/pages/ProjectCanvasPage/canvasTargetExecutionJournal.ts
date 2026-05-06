import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type {
  CanvasTargetCapabilityAction,
  CanvasTargetCapabilityActionPhase
} from './canvasTargetCapabilities'

export type CanvasTargetExecutionJournalKind =
  | 'control_plan'
  | 'model'
  | 'quick_app'
  | 'canvas_action'
  | 'final_presentation'

export type CanvasTargetExecutionJournalStatus = 'success' | 'fallback'

export type CanvasTargetExecutionJournalAttachmentSummary = {
  type: ChatAttachment['type']
  fileName?: string
  mimeType?: string
  relativePath?: string
  sizeBytes?: number
  sourceWidth?: number
  sourceHeight?: number
}

export type CanvasTargetExecutionJournalActionSummary = {
  type: CanvasTargetCapabilityAction['type']
  id: string
  label?: string
  phase: CanvasTargetCapabilityActionPhase
  stageId?: string
  beforeStageId?: string
  afterStageId?: string
  outputTarget?: string
  qAppKey?: string
  inputAssignments?: Array<{
    slot?: string
    label?: string
    source?: string
    hasLiteralValue?: boolean
  }>
  action?: string
  source?: string
  sourceStageId?: string
  sourceStageIds?: string[]
  coordinateSpace?: string
  itemIds?: string[]
  count?: number
  arrangement?: string
  columns?: number
  transform?: {
    x?: number
    y?: number
    deltaX?: number
    deltaY?: number
    width?: number
    height?: number
    scaleX?: number
    scaleY?: number
    rotation?: number
  }
  zOrder?: string
  tool?: string
  annotationShape?: string
  hasSourceUrl?: boolean
  imageCount?: number
  textPreview?: string
  destructive?: boolean
}

export type CanvasTargetExecutionJournalEntry = {
  stageId: string
  kind: CanvasTargetExecutionJournalKind
  label: string
  status: CanvasTargetExecutionJournalStatus
  inputCanvasVersion: number
  outputCanvasVersion: number
  inputItemIds: string[]
  outputItemIds: string[]
  affectedItemIds: string[]
  createdItemIds: string[]
  canvasMutation: boolean
  summary: string
  action?: CanvasTargetExecutionJournalActionSummary
  attachmentSummaries?: CanvasTargetExecutionJournalAttachmentSummary[]
  fallbackReason?: string
}

export type CanvasTargetExecutionJournalDigest = {
  canvasVersion: number
  entryCount: number
  omittedEntryCount: number
  artifactGraphSummary?: string
  counters: {
    byKind: Record<CanvasTargetExecutionJournalKind, number>
    byStatus: Record<CanvasTargetExecutionJournalStatus, number>
    canvasMutationCount: number
  }
  recentEntries: CanvasTargetExecutionJournalEntry[]
}

const JOURNAL_TEXT_PREVIEW_LIMIT = 180
const JOURNAL_ARRAY_LIMIT = 24

function truncateJournalText(value: string | undefined, maxLength = JOURNAL_TEXT_PREVIEW_LIMIT) {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function uniqueLimited(values: string[] | undefined, maxLength = JOURNAL_ARRAY_LIMIT): string[] {
  if (!Array.isArray(values) || values.length === 0) return []
  return Array.from(new Set(values.filter(Boolean))).slice(0, maxLength)
}

function compactTransform(
  action: Extract<CanvasTargetCapabilityAction, { type: 'canvas' }>
): CanvasTargetExecutionJournalActionSummary['transform'] | undefined {
  const transform = {
    ...(action.x != null ? { x: action.x } : {}),
    ...(action.y != null ? { y: action.y } : {}),
    ...(action.deltaX != null ? { deltaX: action.deltaX } : {}),
    ...(action.deltaY != null ? { deltaY: action.deltaY } : {}),
    ...(action.width != null ? { width: action.width } : {}),
    ...(action.height != null ? { height: action.height } : {}),
    ...(action.scaleX != null ? { scaleX: action.scaleX } : {}),
    ...(action.scaleY != null ? { scaleY: action.scaleY } : {}),
    ...(action.rotation != null ? { rotation: action.rotation } : {})
  }
  return Object.keys(transform).length > 0 ? transform : undefined
}

export function summarizeCanvasTargetAttachmentsForJournal(
  attachments: ChatAttachment[] | undefined,
  maxLength = 8
): CanvasTargetExecutionJournalAttachmentSummary[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.slice(0, maxLength).map((attachment) => ({
    type: attachment.type,
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.relativePath ? { relativePath: attachment.relativePath } : {}),
    ...(typeof attachment.sizeBytes === 'number' ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(typeof attachment.sourceWidth === 'number' ? { sourceWidth: attachment.sourceWidth } : {}),
    ...(typeof attachment.sourceHeight === 'number'
      ? { sourceHeight: attachment.sourceHeight }
      : {})
  }))
}

export function summarizeCanvasTargetActionForJournal(
  action: CanvasTargetCapabilityAction | undefined
): CanvasTargetExecutionJournalActionSummary | undefined {
  if (!action) return undefined

  if (action.type === 'quick_app') {
    return {
      type: action.type,
      id: action.id,
      ...(action.label ? { label: action.label } : {}),
      phase: action.phase,
      ...(action.stageId ? { stageId: action.stageId } : {}),
      ...(action.beforeStageId ? { beforeStageId: action.beforeStageId } : {}),
      ...(action.afterStageId ? { afterStageId: action.afterStageId } : {}),
      outputTarget: action.outputTarget,
      qAppKey: action.qAppKey,
      inputAssignments: action.inputAssignments.slice(0, 8).map((assignment) => ({
        ...(assignment.slot ? { slot: assignment.slot } : {}),
        ...(assignment.label ? { label: assignment.label } : {}),
        ...(assignment.source ? { source: assignment.source } : {}),
        ...(assignment.sourceStageId ? { sourceStageId: assignment.sourceStageId } : {}),
        ...(assignment.sourceStageIds
          ? { sourceStageIds: assignment.sourceStageIds.slice(0, 8) }
          : {}),
        ...(assignment.artifactId ? { artifactId: assignment.artifactId } : {}),
        ...(assignment.artifactIds ? { artifactIds: assignment.artifactIds.slice(0, 8) } : {}),
        ...(assignment.itemIds ? { itemIds: assignment.itemIds.slice(0, 8) } : {}),
        ...(assignment.value !== undefined ? { hasLiteralValue: true } : {})
      }))
    }
  }

  return {
    type: action.type,
    id: action.id,
    ...(action.label ? { label: action.label } : {}),
    phase: action.phase,
    ...(action.stageId ? { stageId: action.stageId } : {}),
    ...(action.beforeStageId ? { beforeStageId: action.beforeStageId } : {}),
    ...(action.afterStageId ? { afterStageId: action.afterStageId } : {}),
    outputTarget: action.outputTarget,
    action: action.action,
    ...(action.source ? { source: action.source } : {}),
    ...(action.sourceStageId ? { sourceStageId: action.sourceStageId } : {}),
    ...(action.sourceStageIds?.length
      ? { sourceStageIds: uniqueLimited(action.sourceStageIds, 16) }
      : {}),
    ...(action.coordinateSpace ? { coordinateSpace: action.coordinateSpace } : {}),
    ...(action.itemIds?.length ? { itemIds: uniqueLimited(action.itemIds, 16) } : {}),
    ...(action.count != null ? { count: action.count } : {}),
    ...(action.arrangement ? { arrangement: action.arrangement } : {}),
    ...(action.columns != null ? { columns: action.columns } : {}),
    ...(compactTransform(action) ? { transform: compactTransform(action) } : {}),
    ...(action.zOrder ? { zOrder: action.zOrder } : {}),
    ...(action.tool ? { tool: action.tool } : {}),
    ...(action.annotationShape ? { annotationShape: action.annotationShape } : {}),
    ...(action.sourceUrl ? { hasSourceUrl: true } : {}),
    ...(truncateJournalText(action.text) ? { textPreview: truncateJournalText(action.text) } : {}),
    ...(action.action === 'delete_items' || action.action === 'clear_canvas'
      ? { destructive: true }
      : {})
  }
}

export function summarizeCanvasTargetJournal(
  journal: CanvasTargetExecutionJournalEntry[],
  canvasVersion: number,
  maxRecentEntries = 8
): CanvasTargetExecutionJournalDigest {
  const byKind: Record<CanvasTargetExecutionJournalKind, number> = {
    control_plan: 0,
    model: 0,
    quick_app: 0,
    canvas_action: 0,
    final_presentation: 0
  }
  const byStatus: Record<CanvasTargetExecutionJournalStatus, number> = {
    success: 0,
    fallback: 0
  }
  let canvasMutationCount = 0

  for (const entry of journal) {
    byKind[entry.kind] += 1
    byStatus[entry.status] += 1
    if (entry.canvasMutation) {
      canvasMutationCount += 1
    }
  }

  const recentEntries = journal.slice(-Math.max(0, maxRecentEntries)).map((entry) => ({
    ...entry,
    inputItemIds: uniqueLimited(entry.inputItemIds),
    outputItemIds: uniqueLimited(entry.outputItemIds),
    affectedItemIds: uniqueLimited(entry.affectedItemIds),
    createdItemIds: uniqueLimited(entry.createdItemIds),
    summary: truncateJournalText(entry.summary) || '',
    ...(entry.fallbackReason
      ? { fallbackReason: truncateJournalText(entry.fallbackReason, 160) }
      : {})
  }))

  return {
    canvasVersion,
    entryCount: journal.length,
    omittedEntryCount: Math.max(0, journal.length - recentEntries.length),
    counters: {
      byKind,
      byStatus,
      canvasMutationCount
    },
    recentEntries
  }
}
