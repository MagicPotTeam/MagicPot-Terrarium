import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { useDispatch } from 'react-redux'
import type { ChatAttachment, LLMListProfilesResp, OCRResult } from '@shared/api/svcLLMProxy'
import type { ProjectTraceSvc } from '@shared/api/svcProjectTrace'
import type { DuplicateCheckVisualModelConfig } from '@shared/duplicateCheck/types'
import type {
  ProjectTraceDocumentSummary,
  ProjectTraceEventScope,
  ProjectTraceEventStatus,
  ProjectTraceProjectRef,
  ProjectTraceReference
} from '@shared/projectTrace'
import { compressProjectTraceReferencesForTarget } from '@shared/projectTraceRetrieval'
import type {
  CanvasTargetAssetMetadata,
  CanvasTargetContextPack,
  CanvasTargetReport,
  CanvasTargetReportStage
} from '@shared/canvasTarget'
import type { TargetHistoryEntry } from '@shared/targetHistory'
import type { TargetScheme } from '@shared/targetScheme'
import { openRightPanel } from '../../store/slices/layoutSlice'
import { api } from '../../utils/windowUtils'
import { useConfig } from '../../hooks/useConfig'
import {
  emitProjectTraceRuntimeEvent,
  writeProjectTraceTargetReferenceState
} from '@renderer/features/projectTrace/projectTraceRuntime'
import { updateScopedExternalLoadingSessionId } from '../ChatPage/chatPageShared'
import {
  buildCanvasTargetAgentFinalSummaryText,
  buildCanvasTargetAgentMessagePayload,
  materializeCanvasTargetAgentMessagePayload
} from './canvasTargetAgentArtifacts'
import {
  CANVAS_TARGET_CANVAS_ACTIONS,
  loadCanvasTargetCapabilityCatalog,
  type CanvasTargetCanvasAction,
  type CanvasTargetCapabilityAction,
  type CanvasTargetCapabilityActionPhase,
  type CanvasTargetCapabilityCatalog,
  type CanvasTargetFinalPresentation,
  type CanvasTargetOutputTarget,
  type CanvasTargetQuickAppAction,
  type CanvasTargetQAppCapability
} from './canvasTargetCapabilities'
import { runCanvasTargetQuickAppAction } from './canvasTargetQuickAppRuntime'
import {
  applyCanvasTargetEvidenceModeToControlPlan,
  buildCanvasTargetAttachments,
  buildCanvasTargetContextPack,
  buildCanvasTargetSchemeImageAttachments,
  buildCanvasTargetSourceAttachments,
  requestCanvasTargetControlPlan,
  requestCanvasTargetStageExecution,
  requestCanvasTargetSummaryExecution,
  resolveCanvasTargetEvidenceAttachments,
  shouldAttachCanvasTargetSelectionSnapshot,
  type CanvasTargetControlPlan
} from './canvasTargetWorkflow'
import {
  buildCanvasTargetAuxiliaryExecutionRuleSummary,
  applyCanvasTargetStageDraftProfileConstraints,
  normalizeCanvasTargetQuickAppDraft,
  normalizeCanvasTargetStageDraft,
  resolveCanvasTargetSupportedOutputFormats,
  sanitizeCanvasTargetStageOutputFormats,
  type CanvasTargetQuickAppDraft,
  type CanvasTargetStageDraft
} from './canvasTargetTypes'
import { createTimestampedSecureId } from './secureId'
import {
  buildCanvasTargetHistoryTargetRecord,
  materializeCanvasTargetQuickAppsForOptions,
  materializeCanvasTargetStageProfilesForOptions,
  resolveCanvasTargetHistoryTargetDraft,
  upsertCanvasTargetHistoryTargets
} from './canvasTargetHistoryTargets'
import { resolveCanvasProjectTraceProjectRef } from '@renderer/features/projectTrace/projectTraceProjectRef'
import type { CanvasTool } from './projectCanvasPageShared'
import type { CanvasGroup, CanvasImageItem, CanvasItem } from './types'
import {
  executeCanvasTargetLocalVisualStage,
  type CanvasTargetLocalVisualAttachmentGroup
} from './canvasTargetLocalVisualStage'
import {
  executeCanvasTargetSemanticCanvasAction,
  isCanvasTargetSemanticCanvasActionName,
  resolveCropRectangleForImage,
  resolveCanvasTargetSemanticCanvasActionSourceIds,
  type CanvasTargetSemanticCanvasActionState,
  type CanvasTargetSemanticCanvasActionResult
} from './canvasTargetCanvasActions'
import {
  summarizeCanvasTargetActionForJournal,
  summarizeCanvasTargetAttachmentsForJournal,
  summarizeCanvasTargetJournal,
  type CanvasTargetExecutionJournalEntry,
  type CanvasTargetExecutionJournalKind
} from './canvasTargetExecutionJournal'
import type { AnnotationShape } from './types'
import {
  DEFAULT_CANVAS_TARGET_EVIDENCE_MODE,
  normalizeCanvasTargetEvidenceMode,
  type CanvasTargetEvidenceMode
} from './canvasTargetEvidence'
import {
  createCanvasTargetArtifactGraph,
  findCanvasTargetArtifact,
  linkCanvasTargetArtifactToCanvasItem,
  listCanvasTargetArtifacts,
  registerCanvasTargetArtifact,
  type CanvasTargetArtifact,
  type CanvasTargetArtifactGraph,
  type CanvasTargetArtifactType
} from './canvasTargetArtifactGraph'
import { createCanvasImageItemDraft, createCanvasItemId } from './canvasAssetDraftFactories'
import { hydrateCanvasImageItemForCanvas, loadImageFromSrc } from './canvasAssetIntakeHelpers'
import { createMagicPotNativeProvenance } from './canvasProvenanceUtils'
import { extractImageRegionLocally } from './localImageExtract'

type NotifyFn = (message: string) => unknown

const PROJECT_TRACE_DRAFT_TAG = 'draft'
const PROJECT_TRACE_REFERENCE_READY_TAG = 'reference-ready'
const CANVAS_TARGET_FAILURES_ROOT_DIR = '.canvas-target-failures'

function getProjectTraceSvc(): ProjectTraceSvc | null {
  return (
    (
      api() as unknown as {
        svcProjectTrace?: ProjectTraceSvc
      }
    ).svcProjectTrace || null
  )
}

function isUsableProjectTraceReference(trace: ProjectTraceDocumentSummary): boolean {
  return (
    trace.tags.includes(PROJECT_TRACE_REFERENCE_READY_TAG) &&
    !trace.tags.includes(PROJECT_TRACE_DRAFT_TAG) &&
    trace.localTrust?.trusted !== false &&
    trace.runtimePolicy?.allowTargetReference !== false
  )
}

function resolveTraceScopeForCanvasTargetJournal(
  kind: CanvasTargetExecutionJournalKind
): ProjectTraceEventScope {
  if (kind === 'quick_app') return 'quick_app'
  if (kind === 'canvas_action') return 'canvas'
  return 'target'
}

function resolveTraceStatusForCanvasTargetJournal(
  status: CanvasTargetExecutionJournalEntry['status']
): ProjectTraceEventStatus {
  return status === 'fallback' ? 'fallback' : 'success'
}

export type SelectionRect = {
  startX: number
  startY: number
  x: number
  y: number
  w: number
  h: number
} | null

export type CanvasTargetSelectionBounds = {
  x: number
  y: number
  width: number
  height: number
}

type CanvasTargetBounds = {
  x: number
  y: number
  width: number
  height: number
}

type CanvasTargetProfileSelectOption = {
  id: string
  label: string
  modelUse?: string
  isVisionModel?: boolean
  isOcrModel?: boolean
  sourceType?: 'api' | 'local'
  executionBackend?: 'llm' | 'local_model'
  localVisualModelId?: string
}

function normalizeCanvasTargetSelectionBounds(
  bounds: CanvasTargetSelectionBounds | null | undefined
): CanvasTargetSelectionBounds | null {
  if (!bounds) return null
  const width = Math.abs(Number(bounds.width) || 0)
  const height = Math.abs(Number(bounds.height) || 0)
  if (width <= 0 || height <= 0) return null

  return {
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width,
    height
  }
}

function resolveCanvasTargetProfileSourceType(profile: {
  call_type?: string
  deployment?: string
  is_ollama?: boolean
}): 'api' | 'local' {
  if (
    profile.call_type === 'local' ||
    profile.deployment === 'local' ||
    profile.is_ollama === true
  ) {
    return 'local'
  }

  return 'api'
}

function buildCanvasTargetLocalVisualOption(
  model: DuplicateCheckVisualModelConfig
): CanvasTargetProfileSelectOption {
  return {
    id: model.id,
    label: model.name || model.id,
    modelUse: 'vision',
    isVisionModel: true,
    sourceType: 'local',
    executionBackend: 'local_model',
    localVisualModelId: model.id
  }
}

type UseCanvasTargetWorkflowOptions = {
  canvasId: string
  projectName: string
  isChineseUi: boolean
  items: CanvasItem[]
  selectedIds: Set<string>
  selectedIdsRef?: MutableRefObject<Set<string>>
  groups: CanvasGroup[]
  buildCanvasAssetMetadata: (targetItems: CanvasItem[]) => CanvasTargetAssetMetadata[]
  resolveCanvasTargetItemBounds: (item: CanvasItem) => CanvasTargetBounds
  renderCanvasItemsImageDataUrl: (
    targetItems: CanvasItem[],
    includeBackground?: boolean,
    clipBounds?: CanvasTargetSelectionBounds | null
  ) => Promise<string>
  setSelectionRect: Dispatch<SetStateAction<SelectionRect>>
  setItemsWithHistory: Dispatch<SetStateAction<CanvasItem[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  handleBgColorChange: (color: string) => void
  setShowGrid: Dispatch<SetStateAction<boolean>>
  setAnnoTool: Dispatch<SetStateAction<AnnotationShape>>
  setAnnotationColor: Dispatch<SetStateAction<string>>
  setAnnotationStrokeWidth: Dispatch<SetStateAction<number>>
  setAnnotationFillOpacity: Dispatch<SetStateAction<number>>
  nextZIndexRef: MutableRefObject<number>
  notifySuccess: NotifyFn
  notifyError: NotifyFn
  notifyWarning: NotifyFn
  notifyInfo: NotifyFn
  resolveDefaultProfileId?: () => string | null
  resolveActiveAgentScope: () => string
  openTargetManager: () => void
}

type ExternalChatSeedMessage = {
  role: 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  modelName?: string
}

type CanvasTargetExternalChatRun = {
  runId: string
  scope: string
  sessionId: string | null
}

function buildCanvasTargetStage(
  stage: Omit<CanvasTargetReportStage, 'findings'> & {
    findings: CanvasTargetReport['findings']
  }
): CanvasTargetReportStage {
  return {
    ...stage,
    findings: stage.findings.map((finding) => ({
      ...finding,
      sourceStageId: stage.id,
      sourceStageLabel: stage.label,
      sourceModelId: stage.modelId
    }))
  }
}

function truncateCanvasTargetStagePreview(
  value: string | undefined,
  maxLength = 180
): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function buildCanvasTargetStageSummaryFromResult(
  result: {
    content?: string
    attachments?: ChatAttachment[]
    ocrResult?: OCRResult
    fallbackReason?: string
  },
  isChineseUi: boolean
): string {
  const contentPreview = truncateCanvasTargetStagePreview(result.content)
  if (contentPreview) return contentPreview

  if (result.ocrResult) {
    if (result.ocrResult.kind === 'table') {
      return isChineseUi ? '已返回 OCR 表格数据。' : 'Returned OCR table data.'
    }
    if (result.ocrResult.kind === 'document') {
      return isChineseUi ? '已返回 OCR 文档数据。' : 'Returned OCR document data.'
    }
    return isChineseUi ? '已返回 OCR 文本数据。' : 'Returned OCR text data.'
  }

  if (result.attachments?.length) {
    return isChineseUi
      ? `已返回 ${result.attachments.length} 个附件。`
      : `Returned ${result.attachments.length} attachment(s).`
  }

  if (result.fallbackReason) {
    return isChineseUi ? '当前阶段已回退执行。' : 'Stage fell back.'
  }

  return isChineseUi ? '当前阶段已完成。' : 'Stage completed.'
}

function buildCanvasTargetStageOverviewFromPlan(options: {
  isChineseUi: boolean
  stagePrompt?: string
  referenceNotes?: string[]
  upstreamStageLabels?: string[]
  attachmentCount?: number
  fallbackReason?: string
}): string {
  const lines: string[] = []

  if (options.stagePrompt?.trim()) {
    lines.push(
      options.isChineseUi
        ? `阶段提示：${options.stagePrompt.trim()}`
        : `Stage prompt: ${options.stagePrompt.trim()}`
    )
  }

  if (options.referenceNotes && options.referenceNotes.length > 0) {
    lines.push(
      options.isChineseUi
        ? `规划说明：${options.referenceNotes.join(' | ')}`
        : `Planner notes: ${options.referenceNotes.join(' | ')}`
    )
  }

  if (options.upstreamStageLabels && options.upstreamStageLabels.length > 0) {
    lines.push(
      options.isChineseUi
        ? `上游阶段：${options.upstreamStageLabels.join(' -> ')}`
        : `Upstream stages: ${options.upstreamStageLabels.join(' -> ')}`
    )
  }

  if (typeof options.attachmentCount === 'number') {
    lines.push(
      options.isChineseUi
        ? `输入附件数：${options.attachmentCount}`
        : `Input attachments: ${options.attachmentCount}`
    )
  }

  if (options.fallbackReason) {
    lines.push(
      options.isChineseUi
        ? `失败原因：${options.fallbackReason}`
        : `Fallback reason: ${options.fallbackReason}`
    )
  }

  return lines.join('\n')
}

function dedupeCanvasTargetAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type CanvasTargetCanvasActionResult = {
  content: string
  attachments?: ChatAttachment[]
  canvasDispatchCount: number
  placedCanvasItemIds?: string[]
  placedCanvasItems?: CanvasItem[]
  affectedCanvasItemIds?: string[]
  fallbackReason?: string
}

function buildCanvasTargetCanvasActionDisplayContent(
  action: CanvasTargetCanvasAction,
  result: CanvasTargetCanvasActionResult,
  isChineseUi: boolean
): string {
  if (!isChineseUi) return result.content

  if (result.fallbackReason) {
    return `画布动作 ${action.action} 未完成：${result.fallbackReason}`
  }

  const placedCount = result.placedCanvasItemIds?.length ?? result.canvasDispatchCount
  const affectedCount = result.affectedCanvasItemIds?.length ?? result.canvasDispatchCount

  switch (action.action) {
    case 'duplicate_items':
      return `已复制 ${placedCount} 个画布元素。`
    case 'arrange_items':
      return `已排列 ${affectedCount} 个画布元素。`
    case 'select_items':
      return `已选中 ${affectedCount} 个画布元素。`
    case 'transform_items':
      return `已调整 ${affectedCount} 个画布元素。`
    case 'crop_image':
      return `已裁剪 ${affectedCount} 个图片元素。`
    case 'extract_image_region':
      return `已提取 ${placedCount} 个透明图片元素。`
    case 'add_text':
      return `已向画布添加文本。${action.text ? `\n\n${action.text}` : ''}`
    case 'add_annotation':
      return `\u5df2\u5411\u753b\u5e03\u6dfb\u52a0 ${placedCount} \u4e2a\u6807\u6ce8\u5143\u7d20\u3002`
    case 'update_text':
      return `\u5df2\u66f4\u65b0 ${affectedCount} \u4e2a\u6587\u672c\u5143\u7d20\u3002`
    case 'update_annotation':
      return `\u5df2\u66f4\u65b0 ${affectedCount} \u4e2a\u6807\u6ce8\u5143\u7d20\u3002`
    case 'set_z_order':
      return `\u5df2\u8c03\u6574 ${affectedCount} \u4e2a\u753b\u5e03\u5143\u7d20\u7684\u5c42\u7ea7\u3002`
    case 'flip_items':
      return `\u5df2\u7ffb\u8f6c ${affectedCount} \u4e2a\u753b\u5e03\u5143\u7d20\u3002`
    case 'add_image':
      return '已向画布添加图片。'
    case 'add_video':
      return '已向画布添加视频。'
    case 'add_model3d':
      return '已向画布添加 3D 模型。'
    case 'set_grid_visibility':
      return action.showGrid ? '已显示画布网格。' : '已隐藏画布网格。'
    case 'set_canvas_background':
      return action.bgColor ? `已将画布背景设置为 ${action.bgColor}。` : '已更新画布背景。'
    case 'set_canvas_tool':
      return '已更新画布工具状态。'
    case 'delete_items':
      return `已删除 ${affectedCount} 个画布元素。`
    case 'clear_canvas':
      return '已清空画布。'
    default:
      return result.content || `画布动作 ${action.action} 已执行。`
  }
}

function describeCanvasTargetCapabilityAction(
  action: CanvasTargetCapabilityAction,
  isChineseUi: boolean
): string {
  const label = action.label?.trim() || action.id
  const phase = action.phase || 'after_model_stages'
  if (action.type === 'quick_app') {
    return isChineseUi
      ? `\u5feb\u5e94\u7528 ${action.qAppKey}\uff1a${label}\uff08${phase}\uff09`
      : `QuickApp ${action.qAppKey}: ${label} (${phase})`
  }

  return isChineseUi
    ? `\u753b\u5e03 ${action.action}\uff1a${label}\uff08${phase}\uff09`
    : `Canvas ${action.action}: ${label} (${phase})`
}

function buildCanvasTargetExecutionPlanPreview(options: {
  controlPlan: CanvasTargetControlPlan
  controlModelLabel: string
  isChineseUi: boolean
}): string {
  const { controlPlan, controlModelLabel, isChineseUi } = options
  const lines = [
    isChineseUi ? '\u76ee\u6807\u6267\u884c\u65b9\u6848' : 'Target execution plan',
    '',
    isChineseUi
      ? `1. \u4e3b\u63a7\u6a21\u578b\uff1a${controlModelLabel}\uff0c\u8d1f\u8d23\u8bed\u4e49\u62c6\u89e3\u548c\u8c03\u5ea6\u3002`
      : `1. Control model: ${controlModelLabel}, responsible for semantic planning and orchestration.`
  ]

  let stepIndex = 2
  for (const action of controlPlan.capabilityActions || []) {
    lines.push(`${stepIndex}. ${describeCanvasTargetCapabilityAction(action, isChineseUi)}`)
    stepIndex += 1
  }

  for (const stage of controlPlan.stageInstructions) {
    lines.push(
      isChineseUi
        ? `${stepIndex}. \u9644\u5c5e\u6a21\u578b ${stage.modelId}\uff1a${stage.label}`
        : `${stepIndex}. Auxiliary model ${stage.modelId}: ${stage.label}`
    )
    stepIndex += 1
  }

  lines.push(
    isChineseUi
      ? `${stepIndex}. \u4e3b\u63a7\u6a21\u578b\uff1a\u6839\u636e\u6700\u7ec8\u753b\u5e03\u8bc1\u636e\u548c\u6267\u884c\u65e5\u5fd7\u505a\u6700\u7ec8\u9a8c\u6536\uff1b\u53ea\u5728\u76ee\u6807\u672c\u8eab\u9700\u8981\u6587\u6863\u65f6\u4ea4\u4ed8 Agent \u7ed3\u679c\u6587\u4ef6\u3002`
      : `${stepIndex}. Control model: inspect the final canvas evidence and execution journal for final acceptance; deliver Agent result files only when the target itself requires a document.`
  )
  lines.push('')
  lines.push(
    isChineseUi
      ? '\u8bf7\u786e\u8ba4\u540e\u518d\u6267\u884c\u3002\u8f6f\u4ef6\u5c42\u53ea\u4f1a\u6821\u9a8c\u548c\u6267\u884c\u8fd9\u4e9b\u660e\u786e\u52a8\u4f5c\uff0c\u4e0d\u518d\u81ea\u884c\u731c\u6d4b\u76ee\u6807\u8bed\u4e49\u3002'
      : 'Please confirm before execution. The software layer will only validate and execute these explicit actions; it will not infer target semantics locally.'
  )

  return lines.join('\n')
}

function waitForCanvasTargetPlacementCallbacks(
  expectedCount: number,
  placedItems: CanvasItem[],
  timeoutMs = 5000
): Promise<void> {
  if (expectedCount <= 0 || placedItems.length >= expectedCount) return Promise.resolve()

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const check = () => {
      if (placedItems.length >= expectedCount || Date.now() - startedAt >= timeoutMs) {
        resolve()
        return
      }
      window.setTimeout(check, 25)
    }
    check()
  })
}

function isCanvasTargetPlacedItem(value: unknown): value is CanvasItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.type === 'string'
}

async function dispatchCanvasTargetMediaAttachmentToCanvas(
  attachment: ChatAttachment,
  projectId: string,
  generationSessionId?: string
): Promise<{ dispatched: boolean; placedCanvasItems: CanvasItem[] }> {
  if (!attachment.url?.trim()) {
    return {
      dispatched: false,
      placedCanvasItems: []
    }
  }

  const placedCanvasItems: CanvasItem[] = []
  const onAdded = (item: unknown) => {
    if (isCanvasTargetPlacedItem(item)) {
      placedCanvasItems.push(item)
    }
  }

  if (attachment.type === 'image') {
    window.dispatchEvent(
      new CustomEvent('canvas:add-image', {
        detail: {
          src: attachment.url,
          fileName: attachment.fileName,
          projectId,
          generationSessionId,
          select: false,
          sourceWidth: attachment.sourceWidth,
          sourceHeight: attachment.sourceHeight,
          onAdded
        }
      })
    )
    await waitForCanvasTargetPlacementCallbacks(1, placedCanvasItems)
    return {
      dispatched: true,
      placedCanvasItems
    }
  }

  if (attachment.type === 'video') {
    window.dispatchEvent(
      new CustomEvent('canvas:add-video', {
        detail: {
          src: attachment.url,
          fileName: attachment.fileName,
          projectId,
          generationSessionId,
          select: false,
          onAdded
        }
      })
    )
    await waitForCanvasTargetPlacementCallbacks(1, placedCanvasItems)
    return {
      dispatched: true,
      placedCanvasItems
    }
  }

  if (attachment.type === 'model3d') {
    window.dispatchEvent(
      new CustomEvent('canvas:add-model3d', {
        detail: {
          src: attachment.url,
          fileName: attachment.fileName,
          projectId,
          generationSessionId,
          select: false,
          onAdded
        }
      })
    )
    await waitForCanvasTargetPlacementCallbacks(1, placedCanvasItems)
    return {
      dispatched: true,
      placedCanvasItems
    }
  }

  return {
    dispatched: false,
    placedCanvasItems: []
  }
}

function isCanvasTargetImageItem(item: CanvasItem | undefined): item is CanvasImageItem {
  return item?.type === 'image' && typeof item.src === 'string' && item.src.trim().length > 0
}

function canvasItemToQuickAppAttachment(item: CanvasItem | undefined): ChatAttachment | null {
  if (!item) return null
  if (item.type === 'image' && typeof item.src === 'string' && item.src.trim()) {
    return {
      type: 'image',
      url: item.src,
      fileName: item.fileName || `${item.id}.png`,
      mimeType: 'image/png',
      sourceWidth: item.sourceWidth,
      sourceHeight: item.sourceHeight
    }
  }
  if (item.type === 'video' && typeof item.src === 'string' && item.src.trim()) {
    return {
      type: 'video',
      url: item.src,
      fileName: item.fileName || `${item.id}.mp4`,
      mimeType: 'video/mp4'
    }
  }
  return null
}

function stripCanvasTargetFileExtension(fileName: string | undefined, fallback: string): string {
  const normalized = fileName?.trim() || fallback
  return normalized.replace(/\.[^/.]+$/, '') || fallback
}

function resolveCanvasTargetNextZIndex(items: CanvasItem[], fallback: number): number {
  const maxZIndex = items.reduce(
    (maxValue, item) => Math.max(maxValue, Number.isFinite(item.zIndex) ? item.zIndex : 0),
    0
  )
  return Math.max(fallback, maxZIndex + 1)
}

async function executeCanvasTargetExtractImageRegionAction(
  action: CanvasTargetCanvasAction,
  options: {
    semanticState?: CanvasTargetSemanticCanvasActionState
    commitSemanticResult?: (result: CanvasTargetSemanticCanvasActionResult) => void
    resolveCanvasTargetItemBounds?: (item: CanvasItem) => CanvasTargetBounds
  }
): Promise<CanvasTargetCanvasActionResult> {
  if (!options.semanticState || !options.commitSemanticResult) {
    return {
      content:
        'Canvas extract_image_region action skipped because semantic canvas state was not available.',
      canvasDispatchCount: 0,
      fallbackReason: 'Semantic canvas state unavailable.'
    }
  }

  const sourceIds = resolveCanvasTargetSemanticCanvasActionSourceIds(action, options.semanticState)
  const itemById = new Map(options.semanticState.items.map((item) => [item.id, item] as const))
  const sourceItems = sourceIds.map((id) => itemById.get(id)).filter(isCanvasTargetImageItem)

  if (sourceItems.length === 0) {
    return {
      content:
        'Canvas extract_image_region action skipped. No image items were available to extract.',
      canvasDispatchCount: 0,
      fallbackReason: 'No image items were available to extract.'
    }
  }

  const createdItems: CanvasImageItem[] = []
  const attachments: ChatAttachment[] = []
  let nextZIndex = resolveCanvasTargetNextZIndex(
    options.semanticState.items,
    options.semanticState.nextZIndex
  )
  let missingRegion = false

  for (const sourceItem of sourceItems) {
    const cropRegion = resolveCropRectangleForImage(action, sourceItem)
    if (!cropRegion) {
      missingRegion = true
      continue
    }

    const sourceImage = await loadImageFromSrc(sourceItem.src)
    const extractedRegion = await extractImageRegionLocally({
      item: sourceItem,
      region: cropRegion,
      loadImage: loadImageFromSrc,
      loadedImage: sourceImage
    })
    if (!extractedRegion) continue

    const visibleSourceWidth = sourceItem.crop?.width || sourceItem.sourceWidth || sourceImage.width
    const visibleSourceHeight =
      sourceItem.crop?.height || sourceItem.sourceHeight || sourceImage.height
    const renderedWidth = Math.max(1, Math.abs(sourceItem.width * sourceItem.scaleX))
    const renderedHeight = Math.max(1, Math.abs(sourceItem.height * sourceItem.scaleY))
    const pixelsToCanvasScaleX = renderedWidth / Math.max(visibleSourceWidth, 1)
    const pixelsToCanvasScaleY = renderedHeight / Math.max(visibleSourceHeight, 1)
    const sourceBounds = options.resolveCanvasTargetItemBounds?.(sourceItem) || {
      x: sourceItem.x,
      y: sourceItem.y,
      width: renderedWidth,
      height: renderedHeight
    }
    const createdIndex = createdItems.length + 1
    const src = URL.createObjectURL(extractedRegion.blob)
    const baseName = stripCanvasTargetFileExtension(sourceItem.fileName, sourceItem.id)
    const draft = createCanvasImageItemDraft({
      id: createCanvasItemId('canvas-target-extract'),
      src,
      fileName: `${baseName}-extract-${createdIndex}.png`,
      sizeBytes: extractedRegion.sizeBytes,
      hasAlpha: true,
      sourceWidth: extractedRegion.sourceWidth,
      sourceHeight: extractedRegion.sourceHeight,
      width: Math.max(1, Math.round(extractedRegion.sourceWidth * pixelsToCanvasScaleX)),
      height: Math.max(1, Math.round(extractedRegion.sourceHeight * pixelsToCanvasScaleY)),
      x: sourceBounds.x + sourceBounds.width + 24,
      y: sourceBounds.y + (createdIndex - 1) * 24,
      zIndex: nextZIndex,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      locked: false,
      provenance: createMagicPotNativeProvenance({
        notes: `Canvas Target extract_image_region from ${sourceItem.id}`
      })
    })

    const hydratedItem = await hydrateCanvasImageItemForCanvas({
      item: draft,
      loadImageFromSrc
    })
    if (!hydratedItem) {
      URL.revokeObjectURL(src)
      continue
    }

    nextZIndex += 1
    createdItems.push(hydratedItem)
    attachments.push({
      type: 'image',
      url: hydratedItem.src,
      fileName: hydratedItem.fileName,
      mimeType: 'image/png',
      sourceWidth: hydratedItem.sourceWidth,
      sourceHeight: hydratedItem.sourceHeight
    })
  }

  if (createdItems.length === 0) {
    const fallbackReason = missingRegion
      ? 'Missing a valid crop rectangle for extract_image_region.'
      : 'No extractable image region was produced.'
    return {
      content: `Canvas extract_image_region action skipped. ${fallbackReason}`,
      canvasDispatchCount: 0,
      fallbackReason
    }
  }

  const createdIds = createdItems.map((item) => item.id)
  const semanticResult: CanvasTargetSemanticCanvasActionResult = {
    items: [...options.semanticState.items, ...createdItems],
    groups: options.semanticState.groups,
    selectedIds:
      action.selectResult === false
        ? new Set(options.semanticState.selectedIds)
        : new Set(createdIds),
    nextZIndex,
    affectedIds: sourceItems.map((item) => item.id),
    createdIds,
    resultIds: createdIds,
    content: `Extracted ${createdItems.length} transparent image region item(s).`,
    canvasDispatchCount: createdItems.length
  }
  options.commitSemanticResult(semanticResult)

  return {
    content: semanticResult.content,
    canvasDispatchCount: semanticResult.canvasDispatchCount,
    placedCanvasItemIds: createdIds,
    placedCanvasItems: createdItems,
    affectedCanvasItemIds: semanticResult.affectedIds,
    attachments
  }
}

async function executeCanvasTargetCanvasAction(
  action: CanvasTargetCanvasAction,
  options: {
    projectId: string
    fallbackText?: string
    generationSessionId?: string
    semanticState?: CanvasTargetSemanticCanvasActionState
    commitSemanticResult?: (result: CanvasTargetSemanticCanvasActionResult) => void
    resolveCanvasTargetItemBounds?: (item: CanvasItem) => CanvasTargetBounds
  }
): Promise<CanvasTargetCanvasActionResult> {
  const target = action.outputTarget
  const shouldDispatch = target === 'canvas' || target === 'both'
  const text = action.text?.trim() || ''

  if (isCanvasTargetSemanticCanvasActionName(action.action)) {
    if (!shouldDispatch) {
      return {
        content:
          action.reason || action.label || `Canvas action ${action.action} planned for Agent.`,
        canvasDispatchCount: 0
      }
    }

    if (!options.semanticState || !options.commitSemanticResult) {
      return {
        content: `Canvas ${action.action} action skipped because semantic canvas state was not available.`,
        canvasDispatchCount: 0,
        fallbackReason: 'Semantic canvas state unavailable.'
      }
    }

    const semanticResult = executeCanvasTargetSemanticCanvasAction(action, options.semanticState)
    options.commitSemanticResult(semanticResult)
    return {
      content: semanticResult.content,
      canvasDispatchCount: semanticResult.canvasDispatchCount,
      placedCanvasItemIds: semanticResult.createdIds,
      placedCanvasItems: semanticResult.items.filter((item) =>
        semanticResult.createdIds.includes(item.id)
      ),
      affectedCanvasItemIds: semanticResult.affectedIds,
      fallbackReason: semanticResult.fallbackReason
    }
  }

  if (!shouldDispatch) {
    return {
      content: action.reason || action.label || `Canvas action ${action.action} planned for Agent.`,
      canvasDispatchCount: 0
    }
  }

  switch (action.action) {
    case 'extract_image_region':
      return executeCanvasTargetExtractImageRegionAction(action, options)
    case 'add_text': {
      if (!text) {
        return {
          content: 'Canvas add_text action skipped because no text was available.',
          canvasDispatchCount: 0,
          fallbackReason: 'Missing text for canvas add_text action.'
        }
      }
      const placedCanvasItems: CanvasItem[] = []
      window.dispatchEvent(
        new CustomEvent('canvas:add-text', {
          detail: {
            text,
            projectId: options.projectId,
            onAdded: (item: unknown) => {
              if (isCanvasTargetPlacedItem(item)) {
                placedCanvasItems.push(item)
              }
            }
          }
        })
      )
      return {
        content: `Placed text on the canvas.\n\n${text}`,
        canvasDispatchCount: 1,
        placedCanvasItemIds: placedCanvasItems.map((item) => item.id),
        placedCanvasItems
      }
    }
    case 'add_image':
    case 'add_video':
    case 'add_model3d': {
      if (!action.sourceUrl?.trim()) {
        return {
          content: `Canvas ${action.action} action skipped because no sourceUrl was available.`,
          canvasDispatchCount: 0,
          fallbackReason: `Missing sourceUrl for canvas ${action.action} action.`
        }
      }
      const dispatchResult = await dispatchCanvasTargetMediaAttachmentToCanvas(
        {
          type:
            action.action === 'add_image'
              ? 'image'
              : action.action === 'add_video'
                ? 'video'
                : 'model3d',
          url: action.sourceUrl,
          fileName: action.fileName
        },
        options.projectId,
        options.generationSessionId
      )
      return {
        content: `Placed ${action.action.replace('add_', '')} on the canvas.`,
        canvasDispatchCount: 1,
        placedCanvasItemIds: dispatchResult.placedCanvasItems.map((item) => item.id),
        placedCanvasItems: dispatchResult.placedCanvasItems,
        attachments: [
          {
            type:
              action.action === 'add_image'
                ? 'image'
                : action.action === 'add_video'
                  ? 'video'
                  : 'model3d',
            url: action.sourceUrl,
            fileName: action.fileName
          }
        ]
      }
    }
    default:
      return {
        content: `Unsupported canvas action: ${(action as CanvasTargetCanvasAction).action}`,
        canvasDispatchCount: 0,
        fallbackReason: 'Unsupported canvas action.'
      }
  }
}

function shouldCanvasTargetFinalMediaGoToCanvas(
  target: CanvasTargetOutputTarget,
  presentation?: CanvasTargetFinalPresentation
): boolean {
  if (typeof presentation?.addMediaToCanvas === 'boolean') {
    return presentation.addMediaToCanvas
  }
  if (target === 'canvas' || target === 'both') return true
  if (target === 'agent') return false
  return false
}

async function presentCanvasTargetFinalResult(options: {
  stage: CanvasTargetReportStage
  presentation?: CanvasTargetFinalPresentation
  projectId: string
  generationSessionId?: string
}): Promise<CanvasTargetCanvasActionResult> {
  const target = options.presentation?.target || 'auto'
  const mediaAttachments = (options.stage.responseAttachments || []).filter((attachment) =>
    ['image', 'video', 'model3d'].includes(attachment.type)
  )
  let canvasDispatchCount = 0
  const placedCanvasItems: CanvasItem[] = []

  if (shouldCanvasTargetFinalMediaGoToCanvas(target, options.presentation)) {
    for (const attachment of mediaAttachments) {
      const dispatchResult = await dispatchCanvasTargetMediaAttachmentToCanvas(
        attachment,
        options.projectId,
        options.generationSessionId
      )
      if (dispatchResult.dispatched) {
        canvasDispatchCount += 1
      }
      placedCanvasItems.push(...dispatchResult.placedCanvasItems)
    }
  }

  return {
    content: [
      options.presentation?.reason
        ? `Final presentation decision: ${options.presentation.reason}`
        : `Final presentation target: ${target}.`,
      canvasDispatchCount > 0
        ? `Placed ${canvasDispatchCount} final result item(s) on the canvas.`
        : 'Final result stayed in the Agent conversation.'
    ].join('\n'),
    attachments: mediaAttachments,
    canvasDispatchCount,
    placedCanvasItemIds: placedCanvasItems.map((item) => item.id),
    placedCanvasItems
  }
}

function createCanvasTargetRunId(): string {
  return createTimestampedSecureId('canvas-target-run')
}

function createCanvasTargetArtifactId(stageId: string, suffix: string): string {
  return `${stageId}-artifact-${suffix}`
}

function canvasTargetAttachmentArtifactType(attachment: ChatAttachment): CanvasTargetArtifactType {
  if (attachment.type === 'image' || attachment.type === 'video' || attachment.type === 'model3d') {
    return attachment.type
  }
  return 'media_attachment'
}

function summarizeCanvasTargetArtifactGraph(graph: CanvasTargetArtifactGraph): string {
  const artifacts = listCanvasTargetArtifacts(graph)
  if (artifacts.length === 0) return 'Artifact Graph: empty.'
  const lines = artifacts.slice(-24).map((artifact) => {
    const canvasItem = artifact.canvasItemId ? ` canvasItemId=${artifact.canvasItemId}` : ''
    return `- ${artifact.id} type=${artifact.type} source=${artifact.source} stage=${artifact.stageId}${canvasItem}`
  })
  return ['Artifact Graph:', ...lines].join('\n')
}

function formatCanvasTargetErrorMessage(message: string, runId?: string | null): string {
  if (!runId) return message
  return `${message} (Run: ${runId})`
}

async function persistCanvasTargetFailureArchive(options: {
  runId?: string | null
  baseDir?: string | null
  error: string
  contextPack?: CanvasTargetContextPack | null
  schemeId?: string | null
  projectId?: string | null
  projectName?: string | null
  userIntent?: string
  controlProfileId?: string | null
  stageProfiles?: CanvasTargetStageDraft[]
  targetItemIds?: string[]
}): Promise<void> {
  if (!options.baseDir || !options.runId) return
  const svcFs = api().svcFs
  if (!svcFs || typeof svcFs.writeTextFile !== 'function') return

  const outputPath = window.path?.join
    ? window.path.join(options.baseDir, CANVAS_TARGET_FAILURES_ROOT_DIR, options.runId)
    : `${options.baseDir.replace(/[\\/]+$/g, '')}/${CANVAS_TARGET_FAILURES_ROOT_DIR}/${options.runId}`

  const payload = {
    runId: options.runId,
    error: options.error,
    createdAt: new Date().toISOString(),
    projectId: options.projectId ?? null,
    projectName: options.projectName ?? null,
    schemeId: options.schemeId ?? null,
    userIntent: options.userIntent ?? '',
    controlProfileId: options.controlProfileId ?? null,
    stageProfiles: options.stageProfiles ?? [],
    stageProfileIds: (options.stageProfiles ?? []).map((stage) => stage.profileId).filter(Boolean),
    targetItemIds: options.targetItemIds ?? [],
    contextPack: options.contextPack ?? null
  }

  try {
    await svcFs.writeTextFile({
      outputPath,
      filename: 'error.json',
      content: JSON.stringify(payload, null, 2)
    })
  } catch (error) {
    console.warn('[CanvasTarget] Failed to archive failure payload:', error)
  }
}

class CanvasTargetCancelledError extends Error {
  constructor() {
    super('Canvas check cancelled.')
    this.name = 'CanvasTargetCancelledError'
  }
}

function isCanvasTargetCancelledError(error: unknown): error is CanvasTargetCancelledError {
  return error instanceof CanvasTargetCancelledError
}

function waitForExternalChatScopeReady(options: {
  scope: string
  timeoutMs?: number
}): Promise<void> {
  const requestId = `chat-scope-ready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('chat:scope-ready', handleReady as EventListener)
      window.clearTimeout(timeoutId)
    }

    const handleReady = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; requestId?: string }>).detail

      if (detail?.scope !== options.scope || detail.requestId !== requestId) {
        return
      }

      cleanup()
      resolve()
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while waiting for the Agent conversation to become ready.'))
    }, options.timeoutMs ?? 6000)

    window.addEventListener('chat:scope-ready', handleReady as EventListener)
    window.dispatchEvent(
      new CustomEvent('chat:ping-scope-ready', {
        detail: {
          scope: options.scope,
          requestId
        }
      })
    )
  })
}

async function openExternalChatSession(options: {
  scope: string
  title: string
  profileId?: string | null
  initialMessages?: ExternalChatSeedMessage[]
  timeoutMs?: number
}): Promise<string> {
  await waitForExternalChatScopeReady({
    scope: options.scope,
    timeoutMs: options.timeoutMs
  })

  const requestId = `chat-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('chat:session-created', handleCreated as EventListener)
      window.clearTimeout(timeoutId)
    }

    const handleCreated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
          requestId?: string
        }>
      ).detail

      if (!detail?.sessionId || detail.requestId !== requestId || detail.scope !== options.scope) {
        return
      }

      cleanup()
      resolve(detail.sessionId)
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while creating the Agent conversation.'))
    }, options.timeoutMs ?? 6000)

    window.addEventListener('chat:session-created', handleCreated as EventListener)
    window.dispatchEvent(
      new CustomEvent('chat:newSession', {
        detail: {
          scope: options.scope,
          title: options.title,
          profileId: options.profileId,
          initialMessages: options.initialMessages,
          requestId
        }
      })
    )
  })
}

function openExternalAgentPane(options: {
  projectId: string
  timeoutMs?: number
}): Promise<{ paneId: string; scope: string }> {
  const requestId = `agent-pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('agent-workspace:pane-created', handleCreated as EventListener)
      window.clearTimeout(timeoutId)
    }

    const handleCreated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          projectId?: string
          paneId?: string
          scope?: string
          requestId?: string
        }>
      ).detail

      if (
        detail?.projectId !== options.projectId ||
        detail?.requestId !== requestId ||
        !detail.paneId ||
        !detail.scope
      ) {
        return
      }

      cleanup()
      resolve({
        paneId: detail.paneId,
        scope: detail.scope
      })
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while creating the Agent thread.'))
    }, options.timeoutMs ?? 6000)

    window.addEventListener('agent-workspace:pane-created', handleCreated as EventListener)
    window.dispatchEvent(
      new CustomEvent('agent-workspace:create-pane', {
        detail: {
          projectId: options.projectId,
          requestId
        }
      })
    )
  })
}

function appendMessageToExternalChat(options: {
  scope: string
  sessionId?: string | null
  role: 'user' | 'assistant'
  content?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  modelName?: string
}) {
  if (!options.sessionId) return

  window.dispatchEvent(
    new CustomEvent('chat:append-message', {
      detail: {
        scope: options.scope,
        sessionId: options.sessionId,
        role: options.role,
        content: options.content,
        attachments: options.attachments,
        ocrResult: options.ocrResult,
        modelName: options.modelName
      }
    })
  )
}

function setExternalChatSessionLoading(options: {
  scope: string
  sessionId?: string | null
  loading: boolean
}) {
  if (!options.sessionId) return

  updateScopedExternalLoadingSessionId(options.scope, options.sessionId, options.loading)

  window.dispatchEvent(
    new CustomEvent('chat:set-external-loading', {
      detail: {
        scope: options.scope,
        sessionId: options.sessionId,
        loading: options.loading
      }
    })
  )
}

async function waitForCanvasTargetProgressPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
  if (typeof window.requestAnimationFrame !== 'function') return
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

function terminateExternalChatSession(options: { scope: string; sessionId?: string | null }) {
  if (!options.sessionId) return

  window.dispatchEvent(
    new CustomEvent('chat:terminate-session', {
      detail: {
        scope: options.scope,
        sessionId: options.sessionId
      }
    })
  )
}

function requestExternalChatConfirmation(options: {
  scope: string
  sessionId?: string | null
  prompt: string
  confirmLabel: string
  cancelLabel: string
  confirmedUserContent: string
  cancelledUserContent: string
  timeoutMs?: number
}): Promise<boolean> {
  if (!options.sessionId) {
    return Promise.resolve(false)
  }

  const requestId = `chat-confirmation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener('chat:confirmation-response', handleResponse as EventListener)
      window.removeEventListener(
        'chat:session-terminated',
        handleSessionTerminated as EventListener
      )
      window.clearTimeout(timeoutId)
    }

    const handleResponse = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
          requestId?: string
          confirmed?: boolean
        }>
      ).detail

      if (
        detail?.scope !== options.scope ||
        detail.sessionId !== options.sessionId ||
        detail.requestId !== requestId
      ) {
        return
      }

      cleanup()
      resolve(detail.confirmed === true)
    }

    const handleSessionTerminated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
        }>
      ).detail

      if (detail?.scope !== options.scope || detail.sessionId !== options.sessionId) {
        return
      }

      cleanup()
      resolve(false)
    }

    const timeoutId = window.setTimeout(
      () => {
        cleanup()
        resolve(false)
      },
      options.timeoutMs ?? 30 * 60 * 1000
    )

    window.addEventListener('chat:confirmation-response', handleResponse as EventListener)
    window.addEventListener('chat:session-terminated', handleSessionTerminated as EventListener)
    window.dispatchEvent(
      new CustomEvent('chat:request-confirmation', {
        detail: {
          scope: options.scope,
          sessionId: options.sessionId,
          requestId,
          prompt: options.prompt,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          confirmedUserContent: options.confirmedUserContent,
          cancelledUserContent: options.cancelledUserContent
        }
      })
    )
  })
}

function buildCoordinatedCanvasTargetReport(
  contextPack: CanvasTargetContextPack,
  stages: CanvasTargetReportStage[],
  isChineseUi: boolean
): CanvasTargetReport {
  const controlSummaryStage = stages.find((stage) => stage.kind === 'control-summary')
  const findings = stages.flatMap((stage) => stage.findings)
  const fallbackReasons = stages
    .map((stage) => (stage.fallbackReason ? `${stage.label}: ${stage.fallbackReason}` : null))
    .filter((value): value is string => Boolean(value))
  const lastCompletedStage = [...stages]
    .reverse()
    .find((stage) => stage.kind !== 'control-plan' && stage.kind !== 'control-summary')
  const summaryPreview =
    controlSummaryStage?.responseContent?.trim() ||
    controlSummaryStage?.summary ||
    lastCompletedStage?.summary

  return {
    id: `canvas-target-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    contextPackId: contextPack.id,
    generatedAt: new Date().toISOString(),
    modelId: controlSummaryStage?.modelId || stages.find((stage) => stage.modelId)?.modelId,
    summary:
      summaryPreview ||
      (findings.length > 0
        ? isChineseUi
          ? `已完成 ${stages.length} 个目标阶段，发现 ${findings.length} 条结果。`
          : `Completed ${stages.length} target stages with ${findings.length} findings.`
        : isChineseUi
          ? `已完成 ${stages.length} 个目标阶段，当前未发现明显问题。`
          : `Completed ${stages.length} target stages with no obvious issues.`),
    overview:
      controlSummaryStage?.overview ||
      controlSummaryStage?.responseContent ||
      stages.map((stage) => `${stage.label}: ${stage.summary}`).join('\n'),
    findings,
    stages,
    fallbackReason: fallbackReasons.length > 0 ? fallbackReasons.join('; ') : undefined
  }
}

export function resolveCanvasTargetAcceptanceStatus(
  content: string | undefined
): 'accepted' | 'needs_fix' | 'unknown' {
  const firstLine = (content || '').trim().split(/\r?\n/)[0]?.trim().toUpperCase()
  if (!firstLine) return 'unknown'
  const firstToken = firstLine.match(/^[A-Z_]+/)?.[0]
  if (firstToken === 'NEEDS_FIX') return 'needs_fix'
  if (firstToken === 'ACCEPTED') return 'accepted'
  return 'unknown'
}

function formatCanvasTargetRunRequestForAgent(options: {
  projectName?: string
  schemeName: string
  controlModelLabel: string
  stageModelLabels: string[]
  selectedItemCount: number
  userIntent: string
  isChineseUi: boolean
}): string {
  const userIntent = options.userIntent.trim()
  return options.isChineseUi
    ? [
        '\u753b\u5e03\u76ee\u6807\u5df2\u5f00\u59cb\u3002\u6267\u884c\u8fc7\u7a0b\u548c\u7ed3\u679c\u5c06\u4ee5\u76ee\u6807\u7ed3\u679c\u6587\u4ef6\u66f4\u65b0\u3002',
        `\u672c\u6b21\u6267\u884c\u5185\u5bb9\uff1a\n${userIntent || '\u672a\u586b\u5199'}`,
        `\u76ee\u6807\u65b9\u6848\uff1a${options.schemeName}`,
        `\u4e3b\u63a7\u6a21\u578b\uff1a${options.controlModelLabel}`,
        `\u9009\u4e2d\u5143\u7d20\uff1a${options.selectedItemCount}`
      ].join('\n\n')
    : [
        'Canvas target started. Execution progress and results will be updated as target result files.',
        `Run request:\n${userIntent || 'Not provided'}`,
        `Target scheme: ${options.schemeName}`,
        `Master model: ${options.controlModelLabel}`,
        `Selected items: ${options.selectedItemCount}`
      ].join('\n\n')
}

function applyCanvasTargetQuickAppSelectionsToCatalog(
  catalog: CanvasTargetCapabilityCatalog,
  quickApps: CanvasTargetQuickAppDraft[]
): CanvasTargetCapabilityCatalog {
  const selectedByKey = new Map<string, CanvasTargetQuickAppDraft>()
  quickApps
    .map((quickApp) => normalizeCanvasTargetQuickAppDraft(quickApp))
    .forEach((quickApp) => {
      if (quickApp.qAppKey && !selectedByKey.has(quickApp.qAppKey)) {
        selectedByKey.set(quickApp.qAppKey, quickApp)
      }
    })

  if (selectedByKey.size === 0) {
    return {
      ...catalog,
      quickApps: []
    }
  }

  return {
    ...catalog,
    quickApps: catalog.quickApps
      .filter((quickApp) => selectedByKey.has(quickApp.key))
      .map((quickApp) => {
        const selected = selectedByKey.get(quickApp.key)
        return {
          ...quickApp,
          ...(selected?.mustFollow ? { mustFollow: selected.mustFollow } : {}),
          ...(selected?.forbiddenActions ? { forbiddenActions: selected.forbiddenActions } : {})
        }
      })
  }
}

export function useCanvasTargetWorkflow({
  canvasId,
  projectName,
  isChineseUi,
  items,
  selectedIds,
  selectedIdsRef,
  groups,
  buildCanvasAssetMetadata,
  resolveCanvasTargetItemBounds,
  renderCanvasItemsImageDataUrl,
  setSelectionRect,
  setItemsWithHistory,
  setSelectedIds,
  setGroups,
  setTool,
  handleBgColorChange,
  setShowGrid,
  setAnnoTool,
  setAnnotationColor,
  setAnnotationStrokeWidth,
  setAnnotationFillOpacity,
  nextZIndexRef,
  notifySuccess,
  notifyError,
  notifyWarning,
  notifyInfo,
  resolveDefaultProfileId,
  resolveActiveAgentScope,
  openTargetManager
}: UseCanvasTargetWorkflowOptions) {
  const dispatch = useDispatch()
  const { config, buildEnv } = useConfig()
  const [targetSchemes, setTargetSchemes] = useState<TargetScheme[]>([])
  const [canvasTargetHistoryTargets, setCanvasTargetHistoryTargets] = useState<
    TargetHistoryEntry[]
  >([])
  const [canvasTargetReferenceTraces, setCanvasTargetReferenceTraces] = useState<
    ProjectTraceDocumentSummary[]
  >([])
  const [canvasTargetSelectedTraceIds, setCanvasTargetSelectedTraceIds] = useState<string[]>([])
  const [canvasTargetEvidenceMode, setCanvasTargetEvidenceMode] =
    useState<CanvasTargetEvidenceMode>(DEFAULT_CANVAS_TARGET_EVIDENCE_MODE)
  const [canvasTargetDialogOpen, setCanvasTargetDialogOpen] = useState(false)
  const [canvasTargetTargetItemIds, setCanvasTargetTargetItemIds] = useState<string[]>([])
  const [canvasTargetSelectionBounds, setCanvasTargetSelectionBounds] =
    useState<CanvasTargetSelectionBounds | null>(null)
  const [canvasTargetTargetName, setCanvasTargetTargetName] = useState('')
  const [canvasTargetSelectedHistoryTargetId, setCanvasTargetSelectedHistoryTargetId] = useState<
    string | null
  >(null)
  const [canvasTargetSelectedSchemeId, setCanvasTargetSelectedSchemeId] = useState<string | null>(
    null
  )
  const [canvasTargetProfileOptions, setCanvasTargetProfileOptions] = useState<
    LLMListProfilesResp['profiles']
  >([])
  const [canvasTargetControlProfileId, setCanvasTargetControlProfileId] = useState('')
  const [canvasTargetStageProfiles, setCanvasTargetStageProfiles] = useState<
    CanvasTargetStageDraft[]
  >([])
  const [canvasTargetQuickAppOptions, setCanvasTargetQuickAppOptions] = useState<
    CanvasTargetQAppCapability[]
  >([])
  const [canvasTargetQuickApps, setCanvasTargetQuickApps] = useState<CanvasTargetQuickAppDraft[]>(
    []
  )
  const [canvasTargetUserIntent, setCanvasTargetUserIntent] = useState('')
  const [canvasTargetLoading, setCanvasTargetLoading] = useState(false)
  const [canvasTargetError, setCanvasTargetError] = useState<string | null>(null)
  const [, setCanvasTargetContextPack] = useState<CanvasTargetContextPack | null>(null)
  const [canvasTargetReport, setCanvasTargetReport] = useState<CanvasTargetReport | null>(null)
  const canvasTargetActiveRunIdRef = useRef<string | null>(null)
  const canvasTargetExternalChatRef = useRef<CanvasTargetExternalChatRun | null>(null)
  const latestItemsRef = useRef(items)
  const latestSelectedIdsRef = useRef(selectedIds)

  latestItemsRef.current = items
  latestSelectedIdsRef.current = selectedIds

  useEffect(() => {
    const targetReferencesActive =
      (canvasTargetDialogOpen || canvasTargetLoading) && canvasTargetSelectedTraceIds.length > 0
    if (!targetReferencesActive) {
      writeProjectTraceTargetReferenceState(canvasId, [])
      return
    }
    writeProjectTraceTargetReferenceState(canvasId, canvasTargetSelectedTraceIds)
    return () => {
      writeProjectTraceTargetReferenceState(canvasId, [])
    }
  }, [canvasId, canvasTargetDialogOpen, canvasTargetLoading, canvasTargetSelectedTraceIds])

  const canvasTargetLocalVisualOptions = useMemo<CanvasTargetProfileSelectOption[]>(
    () =>
      (config.plugin_config?.duplicateCheck?.visualModels || [])
        .filter((model) => model?.enabled && model.modelPath?.trim())
        .map((model) => buildCanvasTargetLocalVisualOption(model)),
    [config.plugin_config?.duplicateCheck?.visualModels]
  )

  const canvasTargetProfileSelectOptions = useMemo<CanvasTargetProfileSelectOption[]>(
    () =>
      canvasTargetProfileOptions.map((profile) => ({
        id: profile.id,
        label: profile.model_name || profile.id,
        modelUse: profile.model_use,
        isVisionModel: profile.is_vision_model,
        isOcrModel: profile.is_ocr_model,
        sourceType:
          resolveCanvasTargetProfileSourceType(
            config.llm_config.api_profiles.find((entry) => entry.id === profile.id) || {}
          ) || 'api',
        executionBackend: 'llm'
      })),
    [canvasTargetProfileOptions, config.llm_config.api_profiles]
  )

  const canvasTargetControlProfileSelectOptions = useMemo<CanvasTargetProfileSelectOption[]>(
    () =>
      canvasTargetProfileSelectOptions.filter(
        (profile) => profile.executionBackend !== 'local_model'
      ),
    [canvasTargetProfileSelectOptions]
  )

  const canvasTargetStageProfileSelectOptions = useMemo<CanvasTargetProfileSelectOption[]>(
    () => [...canvasTargetProfileSelectOptions, ...canvasTargetLocalVisualOptions],
    [canvasTargetLocalVisualOptions, canvasTargetProfileSelectOptions]
  )

  const canvasTargetTargetItemCount = useMemo(
    () => items.filter((item) => canvasTargetTargetItemIds.includes(item.id)).length,
    [canvasTargetTargetItemIds, items]
  )

  const handleCloseCanvasTargetDialog = useCallback(() => {
    setCanvasTargetDialogOpen(false)
  }, [])

  const handleBeginCanvasTargetSelection = useCallback(() => {
    setCanvasTargetDialogOpen(false)
    setCanvasTargetError(null)
    setCanvasTargetContextPack(null)
    setCanvasTargetReport(null)
    setCanvasTargetTargetItemIds([])
    setCanvasTargetSelectionBounds(null)
    setCanvasTargetSelectedTraceIds([])
    setSelectionRect(null)
    setSelectedIds(new Set())
    setTool('target-select')
    notifyInfo(
      isChineseUi
        ? '请拖拽框选要执行目标的画布区域。'
        : 'Drag to choose the canvas region for the target.'
    )
  }, [isChineseUi, notifyInfo, setSelectedIds, setSelectionRect, setTool])

  const handleOpenCanvasTargetDialog = useCallback(
    async (targetItems: CanvasItem[], selectionBounds?: CanvasTargetSelectionBounds | null) => {
      if (targetItems.length === 0) return

      try {
        const projectTraceRef = await resolveCanvasProjectTraceProjectRef(canvasId, projectName)
        const projectTraceSvc = getProjectTraceSvc()
        const [
          schemeResponse,
          profileResponse,
          historyResponse,
          traceResponse,
          capabilityResponse
        ] = await Promise.all([
          api().svcTargetScheme.listTargetSchemes({}),
          api().svcLLMProxy.listProfiles({}),
          api()
            .svcTargetScheme.listTargetHistoryTargets({})
            .catch(() => ({ targets: [] as TargetHistoryEntry[] })),
          projectTraceSvc
            ? projectTraceSvc
                .listProjectTraces({ project: projectTraceRef })
                .catch(() => ({ traces: [] as ProjectTraceDocumentSummary[] }))
            : Promise.resolve({ traces: [] as ProjectTraceDocumentSummary[] }),
          loadCanvasTargetCapabilityCatalog(api().svcQApp).catch((error) => {
            console.warn('[CanvasTarget] Failed to load target QuickApp options.', error)
            return {
              quickApps: [] as CanvasTargetQAppCapability[],
              canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
            }
          })
        ])
        const enabledSchemes = (schemeResponse.schemes || []).filter((scheme) => scheme.enabled)
        const profiles = profileResponse.profiles || []
        const historyTargets = historyResponse.targets || []
        const traceDocuments = (traceResponse.traces || []).filter(isUsableProjectTraceReference)
        const quickAppOptions = capabilityResponse.quickApps || []
        const controlOptions = profiles.map((profile) => {
          const savedProfile = config.llm_config.api_profiles.find(
            (entry) => entry.id === profile.id
          )
          return {
            id: profile.id,
            label: profile.model_name || profile.id,
            modelUse: profile.model_use,
            isVisionModel: profile.is_vision_model,
            isOcrModel: profile.is_ocr_model,
            sourceType: resolveCanvasTargetProfileSourceType(savedProfile || {}),
            executionBackend: 'llm' as const
          }
        })
        const stageOptions = [...controlOptions, ...canvasTargetLocalVisualOptions]

        if (enabledSchemes.length === 0) {
          notifyWarning(
            isChineseUi
              ? '未找到已启用的目标方案，请先到自定义目标工坊创建并启用。'
              : 'No enabled target scheme found. Please create one first.'
          )
          openTargetManager()
          return
        }

        if (profiles.length === 0) {
          notifyWarning(
            isChineseUi ? '当前没有可用的 LLM 配置。' : 'No available LLM profiles were found.'
          )
          return
        }

        const activeProfileId = resolveDefaultProfileId?.()
        const defaultProfileId =
          (canvasTargetControlProfileId &&
          controlOptions.some((profile) => profile.id === canvasTargetControlProfileId)
            ? canvasTargetControlProfileId
            : activeProfileId && controlOptions.some((profile) => profile.id === activeProfileId)
              ? activeProfileId
              : controlOptions[0]?.id) || ''
        const preservedStageProfiles = materializeCanvasTargetStageProfilesForOptions(
          canvasTargetStageProfiles.map((stageProfile) =>
            normalizeCanvasTargetStageDraft(stageProfile)
          ),
          stageOptions,
          defaultProfileId
        )
        const preservedQuickApps = materializeCanvasTargetQuickAppsForOptions(
          canvasTargetQuickApps,
          quickAppOptions
        )

        setTargetSchemes(enabledSchemes)
        setCanvasTargetHistoryTargets(historyTargets)
        setCanvasTargetReferenceTraces(traceDocuments)
        setCanvasTargetProfileOptions(profiles)
        setCanvasTargetQuickAppOptions(quickAppOptions)
        setCanvasTargetTargetItemIds(targetItems.map((item) => item.id))
        setCanvasTargetSelectionBounds(normalizeCanvasTargetSelectionBounds(selectionBounds))
        setCanvasTargetTargetName('')
        setCanvasTargetSelectedHistoryTargetId(null)
        setCanvasTargetSelectedTraceIds((current) =>
          current.filter((traceId) => traceDocuments.some((trace) => trace.id === traceId))
        )
        setCanvasTargetSelectedSchemeId((current) => {
          if (current && enabledSchemes.some((scheme) => scheme.id === current)) {
            return current
          }
          return enabledSchemes[0]?.id || null
        })
        setCanvasTargetControlProfileId(defaultProfileId)
        setCanvasTargetStageProfiles(preservedStageProfiles)
        setCanvasTargetQuickApps(preservedQuickApps)
        setCanvasTargetUserIntent('')
        setCanvasTargetError(null)
        setCanvasTargetContextPack(null)
        setCanvasTargetReport(null)
        setCanvasTargetDialogOpen(true)
      } catch (error) {
        notifyError(
          error instanceof Error
            ? error.message
            : isChineseUi
              ? '加载目标选项失败。'
              : 'Failed to load target options.'
        )
      }
    },
    [
      canvasTargetControlProfileId,
      canvasTargetLocalVisualOptions,
      canvasTargetQuickApps,
      canvasTargetStageProfiles,
      canvasId,
      config.llm_config.api_profiles,
      isChineseUi,
      notifyError,
      notifyWarning,
      openTargetManager,
      projectName,
      resolveDefaultProfileId
    ]
  )

  const cancelActiveCanvasTargetRun = useCallback(
    (options?: { terminateAgentSession?: boolean; notify?: boolean }) => {
      const hadActiveRun = Boolean(canvasTargetActiveRunIdRef.current)
      const externalChat = canvasTargetExternalChatRef.current

      canvasTargetActiveRunIdRef.current = null
      canvasTargetExternalChatRef.current = null
      setCanvasTargetLoading(false)
      setCanvasTargetDialogOpen(false)
      setCanvasTargetError(null)
      setTool('select')

      if (options?.terminateAgentSession !== false && externalChat?.sessionId) {
        terminateExternalChatSession({
          scope: externalChat.scope,
          sessionId: externalChat.sessionId
        })
      }

      if (hadActiveRun && options?.notify !== false) {
        notifyInfo(isChineseUi ? '已取消当前目标。' : 'Cancelled the current target.')
      }
    },
    [isChineseUi, notifyInfo, setTool]
  )

  const handleCancelCanvasTarget = useCallback(() => {
    if (!canvasTargetLoading && !canvasTargetActiveRunIdRef.current) {
      setCanvasTargetDialogOpen(false)
      return
    }

    cancelActiveCanvasTargetRun({ terminateAgentSession: true })
  }, [cancelActiveCanvasTargetRun, canvasTargetLoading])

  useEffect(() => {
    const handleChatSessionTerminated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
        }>
      ).detail
      const externalChat = canvasTargetExternalChatRef.current

      if (
        !externalChat?.sessionId ||
        detail?.scope !== externalChat.scope ||
        detail.sessionId !== externalChat.sessionId
      ) {
        return
      }

      cancelActiveCanvasTargetRun({ terminateAgentSession: false })
    }

    window.addEventListener('chat:session-terminated', handleChatSessionTerminated as EventListener)
    return () => {
      window.removeEventListener(
        'chat:session-terminated',
        handleChatSessionTerminated as EventListener
      )
    }
  }, [cancelActiveCanvasTargetRun])

  const handleApplyCanvasTargetHistoryTarget = useCallback(
    (targetId: string) => {
      const target = canvasTargetHistoryTargets.find((entry) => entry.id === targetId)
      if (!target) {
        return
      }

      const fallbackControlProfileId =
        (canvasTargetControlProfileId &&
        canvasTargetControlProfileSelectOptions.some(
          (profile) => profile.id === canvasTargetControlProfileId
        )
          ? canvasTargetControlProfileId
          : canvasTargetControlProfileSelectOptions[0]?.id) || ''

      const resolvedDraft = resolveCanvasTargetHistoryTargetDraft({
        target,
        schemes: targetSchemes,
        controlOptions: canvasTargetControlProfileSelectOptions,
        stageOptions: canvasTargetStageProfileSelectOptions,
        quickAppOptions: canvasTargetQuickAppOptions,
        fallbackControlProfileId
      })

      setCanvasTargetSelectedHistoryTargetId(target.id)
      setCanvasTargetTargetName(resolvedDraft.targetName)
      setCanvasTargetSelectedSchemeId(resolvedDraft.selectedSchemeId)
      setCanvasTargetControlProfileId(resolvedDraft.controlProfileId)
      setCanvasTargetEvidenceMode(normalizeCanvasTargetEvidenceMode(resolvedDraft.evidenceMode))
      setCanvasTargetUserIntent(resolvedDraft.userIntent)
      setCanvasTargetStageProfiles(resolvedDraft.stageProfiles)
      setCanvasTargetQuickApps(resolvedDraft.quickApps)
      setCanvasTargetSelectedTraceIds(
        (resolvedDraft.traceReferenceIds || []).filter((traceId) =>
          canvasTargetReferenceTraces.some((trace) => trace.id === traceId)
        )
      )
      setCanvasTargetError(null)
      setCanvasTargetReport(null)
    },
    [
      canvasTargetControlProfileId,
      canvasTargetControlProfileSelectOptions,
      canvasTargetHistoryTargets,
      canvasTargetQuickAppOptions,
      canvasTargetStageProfileSelectOptions,
      canvasTargetReferenceTraces,
      targetSchemes
    ]
  )

  const handleRenameCanvasTargetHistoryTarget = useCallback(
    async (targetId: string, name: string) => {
      const trimmedName = name.trim()
      const existingTarget = canvasTargetHistoryTargets.find((entry) => entry.id === targetId)
      if (!existingTarget || !trimmedName || trimmedName === existingTarget.name) {
        return
      }

      const updatedTarget: TargetHistoryEntry = {
        ...existingTarget,
        name: trimmedName,
        updatedAt: new Date().toISOString()
      }

      setCanvasTargetHistoryTargets((current) =>
        upsertCanvasTargetHistoryTargets(current, updatedTarget)
      )
      if (canvasTargetSelectedHistoryTargetId === targetId) {
        setCanvasTargetTargetName(trimmedName)
      }

      try {
        await api().svcTargetScheme.saveTargetHistoryTarget({ target: updatedTarget })
      } catch (error) {
        setCanvasTargetHistoryTargets((current) =>
          upsertCanvasTargetHistoryTargets(current, existingTarget)
        )
        if (canvasTargetSelectedHistoryTargetId === targetId) {
          setCanvasTargetTargetName(existingTarget.name)
        }
        notifyError(
          error instanceof Error
            ? error.message
            : isChineseUi
              ? '保存历史目标名称失败。'
              : 'Failed to save the target history name.'
        )
      }
    },
    [canvasTargetHistoryTargets, canvasTargetSelectedHistoryTargetId, isChineseUi, notifyError]
  )

  const handleDeleteCanvasTargetHistoryTarget = useCallback(
    async (targetId: string) => {
      const existingTarget = canvasTargetHistoryTargets.find((entry) => entry.id === targetId)
      if (!existingTarget) {
        return
      }
      const shouldRestoreSelection = canvasTargetSelectedHistoryTargetId === targetId

      setCanvasTargetHistoryTargets((current) => current.filter((entry) => entry.id !== targetId))
      if (shouldRestoreSelection) {
        setCanvasTargetSelectedHistoryTargetId(null)
      }

      try {
        await api().svcTargetScheme.deleteTargetHistoryTarget({ id: targetId })
      } catch (error) {
        setCanvasTargetHistoryTargets((current) =>
          upsertCanvasTargetHistoryTargets(current, existingTarget)
        )
        if (shouldRestoreSelection) {
          setCanvasTargetSelectedHistoryTargetId(targetId)
        }
        notifyError(
          error instanceof Error
            ? error.message
            : isChineseUi
              ? '删除历史目标失败。'
              : 'Failed to delete the target history.'
        )
      }
    },
    [canvasTargetHistoryTargets, canvasTargetSelectedHistoryTargetId, isChineseUi, notifyError]
  )

  const handleRunCanvasTarget = useCallback(async () => {
    const targetItems = items.filter((item) => canvasTargetTargetItemIds.includes(item.id))
    const selectedScheme =
      targetSchemes.find((scheme) => scheme.id === canvasTargetSelectedSchemeId) || null
    const stageProfiles = canvasTargetStageProfiles.filter((stageProfile) =>
      stageProfile.profileId.trim()
    )
    const selectedQuickApps = materializeCanvasTargetQuickAppsForOptions(
      canvasTargetQuickApps,
      canvasTargetQuickAppOptions
    )
    let runId: string | null = null
    let contextPack!: CanvasTargetContextPack
    let projectTraceRef: ProjectTraceProjectRef | null = null

    if (targetItems.length === 0) {
      setCanvasTargetError(
        isChineseUi
          ? '当前没有可用于目标的画布元素。'
          : 'No selected canvas items available for the target.'
      )
      return
    }

    if (!selectedScheme) {
      setCanvasTargetError(isChineseUi ? '请选择目标方案。' : 'Please choose a target scheme.')
      return
    }

    if (!canvasTargetControlProfileId) {
      setCanvasTargetError(isChineseUi ? '请选择主控模型。' : 'Please choose a control model.')
      return
    }

    if (!canvasTargetUserIntent.trim()) {
      setCanvasTargetError(
        isChineseUi
          ? '请填写本次执行内容。'
          : 'Please describe what this target run should focus on.'
      )
      return
    }

    const effectiveTraceIds = canvasTargetSelectedTraceIds

    const historyTargetRecord = buildCanvasTargetHistoryTargetRecord({
      selectedHistoryTargetId: canvasTargetSelectedHistoryTargetId,
      historyTargets: canvasTargetHistoryTargets,
      targetName: canvasTargetTargetName,
      schemeId: selectedScheme.id,
      schemeName: selectedScheme.name,
      controlProfileId: canvasTargetControlProfileId,
      evidenceMode: canvasTargetEvidenceMode,
      userIntent: canvasTargetUserIntent,
      stageProfiles,
      quickApps: selectedQuickApps,
      traceReferenceIds: effectiveTraceIds,
      untitledName: isChineseUi ? '未命名目标' : 'Untitled target'
    })
    setCanvasTargetSelectedHistoryTargetId(historyTargetRecord.id)
    setCanvasTargetTargetName(historyTargetRecord.name)
    setCanvasTargetHistoryTargets((current) =>
      upsertCanvasTargetHistoryTargets(current, historyTargetRecord)
    )

    runId = createCanvasTargetRunId()
    canvasTargetActiveRunIdRef.current = runId
    const reportBundleRootDir = (config.download_dir || buildEnv.pathMap.data || '').trim()
    const ensureCanvasTargetRunActive = () => {
      if (canvasTargetActiveRunIdRef.current !== runId) {
        throw new CanvasTargetCancelledError()
      }
    }

    setCanvasTargetDialogOpen(false)
    setCanvasTargetLoading(true)
    setCanvasTargetError(null)
    let agentScope = resolveActiveAgentScope()
    let agentSessionId: string | null = null

    try {
      try {
        await api().svcTargetScheme.saveTargetHistoryTarget({ target: historyTargetRecord })
      } catch (historyError) {
        console.warn('[CanvasTarget] Failed to persist history target.', historyError)
      }

      let snapshotDataUrl: string | null = null
      try {
        snapshotDataUrl = await renderCanvasItemsImageDataUrl(
          targetItems,
          false,
          canvasTargetSelectionBounds
        )
      } catch (snapshotError) {
        console.warn('[CanvasTarget] Failed to render selection snapshot.', snapshotError)
      }
      ensureCanvasTargetRunActive()

      const assetMetadata = buildCanvasAssetMetadata(targetItems)
      projectTraceRef = await resolveCanvasProjectTraceProjectRef(canvasId, projectName).catch(
        (error) => {
          console.warn('[CanvasTarget] Failed to resolve project trace storage.', error)
          return null
        }
      )
      let traceReferences: ProjectTraceReference[] = []
      const projectTraceSvc = getProjectTraceSvc()
      if (projectTraceRef && projectTraceSvc && effectiveTraceIds.length > 0) {
        try {
          const traceReferenceResponse = await projectTraceSvc.readProjectTraceReferences({
            project: projectTraceRef,
            traceIds: effectiveTraceIds,
            maxCharsPerTrace: effectiveTraceIds.length > 2 ? 900 : 1200
          })
          traceReferences = compressProjectTraceReferencesForTarget(
            traceReferenceResponse.references || [],
            6000
          )
        } catch (traceError) {
          console.warn('[CanvasTarget] Failed to load selected trace references.', traceError)
          notifyWarning(
            isChineseUi
              ? '部分追踪引用加载失败，本次目标会继续执行。'
              : 'Some trace references failed to load. The target will continue.'
          )
        }
      }
      ensureCanvasTargetRunActive()
      contextPack = buildCanvasTargetContextPack({
        scheme: selectedScheme,
        projectId: canvasId,
        projectName,
        targetItems,
        groups,
        snapshotDataUrl,
        assetMetadata,
        traceReferences,
        evidenceMode: canvasTargetEvidenceMode,
        preferredLanguage: isChineseUi ? 'zh-CN' : 'en-US',
        getItemBounds: resolveCanvasTargetItemBounds
      })
      const stageOptionById = new Map(
        canvasTargetStageProfileSelectOptions.map((profile) => [profile.id, profile] as const)
      )
      const profileLabelById = new Map<string, string>(
        canvasTargetStageProfileSelectOptions.map((profile) => [profile.id, profile.label])
      )
      const controlModelLabel =
        profileLabelById.get(canvasTargetControlProfileId) || canvasTargetControlProfileId
      const stageCandidates = stageProfiles.map((stageProfile, index) => {
        const matchedProfile = stageOptionById.get(stageProfile.profileId)
        const normalizedStageProfile = applyCanvasTargetStageDraftProfileConstraints(
          normalizeCanvasTargetStageDraft(stageProfile),
          matchedProfile
        )
        const supportedOutputFormats = resolveCanvasTargetSupportedOutputFormats(matchedProfile)
        const sanitizedOutputFormats = sanitizeCanvasTargetStageOutputFormats(
          normalizedStageProfile.outputFormats,
          supportedOutputFormats
        )
        const responsibilityType =
          matchedProfile?.executionBackend === 'local_model'
            ? normalizedStageProfile.responsibilityType
            : undefined

        return {
          candidateId: `candidate-stage-${index + 1}`,
          id: stageProfile.profileId,
          label:
            profileLabelById.get(stageProfile.profileId) ||
            `${isChineseUi ? '阶段模型 ' : 'Stage model '}${String(index + 1)}`,
          executionRule:
            buildCanvasTargetAuxiliaryExecutionRuleSummary(normalizedStageProfile) || undefined,
          executionBackend: matchedProfile?.executionBackend || 'llm',
          ...(responsibilityType ? { responsibilityType } : {}),
          mustFollow: normalizedStageProfile.mustFollow || undefined,
          forbiddenActions: normalizedStageProfile.forbiddenActions || undefined,
          allowedInputs: normalizedStageProfile.allowedInputs,
          outputFormats: sanitizedOutputFormats,
          outputFormat: sanitizedOutputFormats[0],
          modelUse: matchedProfile?.modelUse,
          isVisionModel: matchedProfile?.isVisionModel,
          isOcrModel: matchedProfile?.isOcrModel,
          sourceType: matchedProfile?.sourceType
        }
      })

      const snapshotAttachment: ChatAttachment | null = snapshotDataUrl
        ? {
            type: 'image',
            url: snapshotDataUrl,
            mimeType: 'image/png',
            fileName: 'canvas-target-selection.png'
          }
        : null
      const sourceAttachments = buildCanvasTargetSourceAttachments(targetItems)
      const shouldAttachSelectionSnapshot = shouldAttachCanvasTargetSelectionSnapshot({
        targetItems,
        sourceAttachments
      })
      const normalizedEvidenceMode = normalizeCanvasTargetEvidenceMode(canvasTargetEvidenceMode)
      const includeSelectionSnapshotAttachment =
        normalizedEvidenceMode === 'selection_region' ||
        (normalizedEvidenceMode === 'selected_sources' &&
          (shouldAttachSelectionSnapshot || Boolean(canvasTargetSelectionBounds)))
      const evidenceAttachments = resolveCanvasTargetEvidenceAttachments({
        evidenceMode: normalizedEvidenceMode,
        sourceAttachments,
        snapshotAttachment,
        includeSelectionSnapshot: includeSelectionSnapshotAttachment
      })
      const evidenceSourceAttachments = evidenceAttachments.sourceAttachments
      const evidenceSnapshotAttachment = evidenceAttachments.snapshotAttachment
      const schemeImageAttachments = buildCanvasTargetSchemeImageAttachments(selectedScheme)
      const controlPlanAttachments = buildCanvasTargetAttachments({
        sourceAttachments: evidenceSourceAttachments,
        snapshotAttachment: evidenceSnapshotAttachment,
        schemeImageAttachments
      })
      const initialAgentMessage = formatCanvasTargetRunRequestForAgent({
        projectName,
        schemeName: selectedScheme.name,
        controlModelLabel,
        stageModelLabels: stageCandidates.map((profile) => profile.label),
        selectedItemCount: targetItems.length,
        userIntent: canvasTargetUserIntent,
        isChineseUi
      })
      const initialAgentAttachments =
        controlPlanAttachments.length > 0 ? controlPlanAttachments : undefined
      const runtimeCapabilities = applyCanvasTargetQuickAppSelectionsToCatalog(
        await loadCanvasTargetCapabilityCatalog(api().svcQApp).catch((error) => {
          console.warn('[CanvasTarget] Failed to load target runtime capabilities.', error)
          return {
            quickApps: [],
            canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
          }
        }),
        selectedQuickApps
      )

      dispatch(openRightPanel())
      try {
        const pane = await openExternalAgentPane({ projectId: canvasId })
        agentScope = pane.scope
      } catch (error) {
        console.warn('[CanvasTarget] Failed to create a dedicated Agent thread.', error)
      }
      ensureCanvasTargetRunActive()

      try {
        agentSessionId = await openExternalChatSession({
          scope: agentScope,
          title: controlModelLabel,
          profileId: canvasTargetControlProfileId,
          initialMessages: [
            {
              role: 'user',
              content: initialAgentMessage
            }
          ]
        })
      } catch (error) {
        console.warn('[CanvasTarget] Failed to open Agent conversation.', error)
      }
      canvasTargetExternalChatRef.current = {
        runId,
        scope: agentScope,
        sessionId: agentSessionId
      }
      setExternalChatSessionLoading({
        scope: agentScope,
        sessionId: agentSessionId,
        loading: true
      })
      ensureCanvasTargetRunActive()

      const stages: CanvasTargetReportStage[] = []
      setCanvasTargetContextPack(contextPack)
      setCanvasTargetReport(null)
      const shouldCreateDocumentDeliverable = false

      const publishStage = async (
        stageEntry: CanvasTargetReportStage,
        options?: {
          modelName?: string
          sourceLabel?: string
          delivery?: 'auto' | 'force' | 'silent'
          includeReportFile?: boolean
        }
      ) => {
        ensureCanvasTargetRunActive()
        const publishedStage =
          options?.sourceLabel?.trim() &&
          options.sourceLabel.trim() !== stageEntry.displayModelLabel
            ? {
                ...stageEntry,
                displayModelLabel: options.sourceLabel.trim()
              }
            : stageEntry
        stages.push(publishedStage)
        const nextReport = buildCoordinatedCanvasTargetReport(contextPack, [...stages], isChineseUi)
        setCanvasTargetReport(nextReport)
        const delivery = options?.delivery || 'auto'
        const hasResultAttachments = (publishedStage.responseAttachments || []).length > 0
        const shouldPostToAgent =
          delivery === 'force' ||
          (delivery === 'auto' && (hasResultAttachments || publishedStage.status === 'fallback'))
        if (delivery === 'silent' || !shouldPostToAgent) {
          return nextReport
        }

        const agentPayload = reportBundleRootDir
          ? await materializeCanvasTargetAgentMessagePayload({
              report: nextReport,
              stage: publishedStage,
              isChineseUi,
              sourceLabel: options?.sourceLabel,
              includeReportFile: options?.includeReportFile ?? shouldCreateDocumentDeliverable,
              bundleRootDir: reportBundleRootDir,
              saveImageToPath: (req) => api().svcFs.saveImageToPath(req),
              writeTextFile: (req) => api().svcFs.writeTextFile(req)
            })
          : buildCanvasTargetAgentMessagePayload({
              report: nextReport,
              stage: publishedStage,
              isChineseUi,
              sourceLabel: options?.sourceLabel,
              includeReportFile: options?.includeReportFile ?? shouldCreateDocumentDeliverable
            })
        appendMessageToExternalChat({
          scope: agentScope,
          sessionId: agentSessionId,
          role: 'assistant',
          content: agentPayload.content,
          attachments: dedupeCanvasTargetAttachments(agentPayload.attachments),
          modelName: options?.modelName
        })
        return nextReport
      }

      const executedStageResults: Array<CanvasTargetReportStage> = []
      const executedCapabilityActionIds = new Set<string>()
      let capabilityActionStageIndex = 0
      let runtimeCanvasItems = items
      let runtimeCanvasGroups = groups
      let runtimeCanvasVersion = 1
      let runtimeSelectedIds = new Set(selectedIds)
      let lastCanvasItemIds: string[] = []
      let lastQuickAppCanvasItemIds: string[] = []
      const stageCanvasItemIds = new Map<string, string[]>()
      const artifactCanvasItemIds = new Map<string, string[]>()
      let artifactGraph = createCanvasTargetArtifactGraph()
      const executionJournal: CanvasTargetExecutionJournalEntry[] = []

      const normalizeJournalIds = (ids: string[] | Iterable<string> | undefined): string[] =>
        Array.from(new Set(Array.from(ids || []).filter(Boolean)))

      const areCanvasTargetIdSetsEqual = (a: Set<string>, b: Set<string>): boolean => {
        if (a.size !== b.size) return false
        for (const id of a) {
          if (!b.has(id)) return false
        }
        return true
      }

      const registerArtifact = (artifact: Omit<CanvasTargetArtifact, 'createdAt'>) => {
        artifactGraph = registerCanvasTargetArtifact(artifactGraph, {
          ...artifact,
          createdAt: new Date().toISOString()
        })
      }

      const linkArtifactToCanvasItem = (artifactId: string, canvasItemId: string) => {
        artifactGraph = linkCanvasTargetArtifactToCanvasItem(
          artifactGraph,
          artifactId,
          canvasItemId
        )
        artifactCanvasItemIds.set(artifactId, [canvasItemId])
      }

      const buildExecutionJournalDigest = () => ({
        ...summarizeCanvasTargetJournal(executionJournal, runtimeCanvasVersion),
        artifactGraphSummary: summarizeCanvasTargetArtifactGraph(artifactGraph)
      })

      for (const item of targetItems) {
        const artifactId = createCanvasTargetArtifactId(runId, `user-input-${item.id}`)
        registerArtifact({
          id: artifactId,
          type: 'user_input',
          source: 'user',
          stageId: runId,
          canvasItemId: item.id,
          metadata: {
            canvasItemId: item.id,
            canvasItemType: item.type
          }
        })
        artifactCanvasItemIds.set(artifactId, [item.id])
      }

      const appendExecutionJournalEntry = (entry: {
        stageId: string
        kind: CanvasTargetExecutionJournalKind
        label: string
        status: CanvasTargetExecutionJournalEntry['status']
        inputCanvasVersion: number
        outputCanvasVersion: number
        inputItemIds?: string[]
        outputItemIds?: string[]
        affectedItemIds?: string[]
        createdItemIds?: string[]
        summary: string
        action?: CanvasTargetExecutionJournalEntry['action']
        attachmentSummaries?: CanvasTargetExecutionJournalEntry['attachmentSummaries']
        fallbackReason?: string
      }): number => {
        const journalEntry: CanvasTargetExecutionJournalEntry = {
          stageId: entry.stageId,
          kind: entry.kind,
          label: entry.label,
          status: entry.status,
          inputCanvasVersion: entry.inputCanvasVersion,
          outputCanvasVersion: entry.outputCanvasVersion,
          inputItemIds: normalizeJournalIds(entry.inputItemIds),
          outputItemIds: normalizeJournalIds(entry.outputItemIds),
          affectedItemIds: normalizeJournalIds(entry.affectedItemIds),
          createdItemIds: normalizeJournalIds(entry.createdItemIds),
          canvasMutation: entry.outputCanvasVersion !== entry.inputCanvasVersion,
          summary: entry.summary,
          ...(entry.action ? { action: entry.action } : {}),
          ...(entry.attachmentSummaries ? { attachmentSummaries: entry.attachmentSummaries } : {}),
          ...(entry.fallbackReason ? { fallbackReason: entry.fallbackReason } : {})
        }
        executionJournal.push(journalEntry)
        emitProjectTraceRuntimeEvent({
          projectId: canvasId,
          projectName,
          scope: resolveTraceScopeForCanvasTargetJournal(journalEntry.kind),
          action: journalEntry.kind,
          label: journalEntry.label,
          status: resolveTraceStatusForCanvasTargetJournal(journalEntry.status),
          safeSummary: [
            `${journalEntry.label} finished with ${journalEntry.status}.`,
            journalEntry.canvasMutation ? 'Canvas changed.' : 'Canvas unchanged.',
            `${journalEntry.affectedItemIds.length} affected item(s).`,
            `${journalEntry.createdItemIds.length} created item(s).`
          ].join(' '),
          entityType: 'canvas_target_stage',
          entityCount: 1,
          inputKinds: journalEntry.attachmentSummaries?.map((attachment) => attachment.type),
          outputKinds: journalEntry.action?.type ? [journalEntry.action.type] : undefined,
          affectedItemCount: journalEntry.affectedItemIds.length,
          createdItemCount: journalEntry.createdItemIds.length,
          canvasMutation: journalEntry.canvasMutation,
          riskSignals: [
            ...(journalEntry.action?.destructive ? ['destructive_action'] : []),
            ...(journalEntry.fallbackReason ? ['fallback_reason'] : [])
          ]
        })
        return executionJournal.length - 1
      }

      const rawControlPlan: CanvasTargetControlPlan = await requestCanvasTargetControlPlan({
        scheme: selectedScheme,
        contextPack,
        llmProxy: api().svcLLMProxy,
        attachments: initialAgentAttachments,
        userIntent: canvasTargetUserIntent,
        profileId: canvasTargetControlProfileId,
        preferExactProfile: true,
        stageProfiles: stageCandidates,
        preferredLanguage: isChineseUi ? 'zh-CN' : 'en-US',
        runtimeCapabilities
      })
      const controlPlan = applyCanvasTargetEvidenceModeToControlPlan(
        rawControlPlan,
        canvasTargetEvidenceMode
      )
      ensureCanvasTargetRunActive()

      await publishStage(
        buildCanvasTargetStage({
          id: runId + '-control-plan',
          kind: 'control-plan',
          label: isChineseUi ? '主控规划' : 'Control plan',
          status: controlPlan.rawResponse?.trim() ? 'success' : 'fallback',
          modelId: controlPlan.modelId,
          summary:
            controlPlan.summary || (isChineseUi ? '主控规划已生成。' : 'Control plan created.'),
          overview:
            controlPlan.stageInstructions.length > 0
              ? controlPlan.stageInstructions
                  .map((instruction, index) => String(index + 1) + '. ' + instruction.label)
                  .join('\n')
              : isChineseUi
                ? '当前没有生成阶段指令。'
                : 'No stage instructions were generated.',
          findings: [],
          rawResponse: controlPlan.rawResponse,
          fallbackReason: controlPlan.fallbackReason
        }),
        {
          modelName: controlModelLabel,
          sourceLabel: controlPlan.modelId ? controlModelLabel : undefined,
          delivery: 'silent'
        }
      )

      appendExecutionJournalEntry({
        stageId: runId + '-control-plan',
        kind: 'control_plan',
        label: isChineseUi ? 'Control plan' : 'Control plan',
        status: controlPlan.rawResponse?.trim() ? 'success' : 'fallback',
        inputCanvasVersion: runtimeCanvasVersion,
        outputCanvasVersion: runtimeCanvasVersion,
        inputItemIds: Array.from(runtimeSelectedIds),
        summary: controlPlan.summary || 'Control plan created.',
        fallbackReason: controlPlan.fallbackReason
      })

      const executionPlanPreview = buildCanvasTargetExecutionPlanPreview({
        controlPlan,
        controlModelLabel,
        isChineseUi
      })
      appendMessageToExternalChat({
        scope: agentScope,
        sessionId: agentSessionId,
        role: 'assistant',
        content: executionPlanPreview,
        modelName: controlModelLabel
      })
      setExternalChatSessionLoading({
        scope: agentScope,
        sessionId: agentSessionId,
        loading: false
      })
      const confirmed = await requestExternalChatConfirmation({
        scope: agentScope,
        sessionId: agentSessionId,
        prompt: isChineseUi
          ? '请先核对上面的目标执行方案。确认后，软件层只会校验并执行这些明确动作，不再自行猜测目标语义。'
          : 'Review the target execution plan above first. After confirmation, the software layer will validate and execute only those explicit actions.',
        confirmLabel: isChineseUi ? '确认执行' : 'Confirm execution',
        cancelLabel: isChineseUi ? '取消' : 'Cancel',
        confirmedUserContent: isChineseUi ? '确认执行该目标方案。' : 'Confirm this target plan.',
        cancelledUserContent: isChineseUi ? '取消执行该目标方案。' : 'Cancel this target plan.'
      })
      if (!confirmed) {
        appendMessageToExternalChat({
          scope: agentScope,
          sessionId: agentSessionId,
          role: 'assistant',
          content: isChineseUi
            ? '\u76ee\u6807\u6267\u884c\u5df2\u53d6\u6d88\u3002'
            : 'Target execution cancelled.',
          modelName: controlModelLabel
        })
        notifyWarning(
          isChineseUi
            ? '\u76ee\u6807\u6267\u884c\u5df2\u53d6\u6d88\u3002'
            : 'Target execution cancelled.'
        )
        return
      }
      appendMessageToExternalChat({
        scope: agentScope,
        sessionId: agentSessionId,
        role: 'assistant',
        content: isChineseUi
          ? '已确认，开始执行目标方案。'
          : 'Confirmed. Starting target execution.',
        modelName: controlModelLabel
      })
      setExternalChatSessionLoading({
        scope: agentScope,
        sessionId: agentSessionId,
        loading: true
      })
      await waitForCanvasTargetProgressPaint()
      ensureCanvasTargetRunActive()

      const mergeRuntimeCanvasItems = (placedItems: CanvasItem[]) => {
        if (placedItems.length === 0) return false
        const nextItems = [...runtimeCanvasItems]
        const indexById = new Map(nextItems.map((item, index) => [item.id, index] as const))
        let changed = false
        for (const item of placedItems) {
          const existingIndex = indexById.get(item.id)
          if (existingIndex == null) {
            indexById.set(item.id, nextItems.length)
            nextItems.push(item)
            changed = true
          } else {
            changed = nextItems[existingIndex] !== item || changed
            nextItems[existingIndex] = item
          }
        }
        if (changed) {
          runtimeCanvasItems = nextItems
          runtimeCanvasVersion += 1
        }
        return changed
      }

      const registerCanvasItemIds = (
        stageId: string,
        itemIds: string[],
        source?: 'quick_app' | 'canvas'
      ) => {
        const normalizedIds = Array.from(new Set(itemIds.filter(Boolean)))
        if (normalizedIds.length === 0) return
        stageCanvasItemIds.set(stageId, normalizedIds)
        lastCanvasItemIds = normalizedIds
        if (source === 'quick_app') {
          lastQuickAppCanvasItemIds = normalizedIds
        }
        normalizedIds.forEach((itemId, index) => {
          const artifactId = createCanvasTargetArtifactId(stageId, `canvas-item-${index + 1}`)
          registerArtifact({
            id: artifactId,
            type: 'canvas_item',
            source: source || 'canvas',
            stageId,
            canvasItemId: itemId,
            metadata: { canvasItemId: itemId }
          })
          artifactCanvasItemIds.set(artifactId, [itemId])
        })
      }

      const registerPlacedCanvasItems = (
        stageId: string,
        placedItems: CanvasItem[],
        source?: 'quick_app' | 'canvas'
      ) => {
        mergeRuntimeCanvasItems(placedItems)
        registerCanvasItemIds(
          stageId,
          placedItems.map((item) => item.id),
          source
        )
      }

      const registerStageTextArtifact = (
        stageId: string,
        source: string,
        content: string | undefined
      ) => {
        const text = content?.trim()
        if (!text) return
        registerArtifact({
          id: createCanvasTargetArtifactId(stageId, 'text'),
          type: 'text',
          source,
          stageId,
          metadata: {
            length: text.length,
            preview: text.slice(0, 240)
          }
        })
      }

      const registerStageAttachmentArtifacts = (
        stageId: string,
        source: string,
        attachments: ChatAttachment[] | undefined
      ): string[] => {
        return (attachments || []).map((attachment, index) => {
          const artifactId = createCanvasTargetArtifactId(stageId, `attachment-${index + 1}`)
          registerArtifact({
            id: artifactId,
            type: canvasTargetAttachmentArtifactType(attachment),
            source,
            stageId,
            metadata: {
              attachmentType: attachment.type,
              fileName: attachment.fileName,
              url: attachment.url,
              mimeType: attachment.mimeType,
              relativePath: attachment.relativePath,
              sourceWidth: attachment.sourceWidth,
              sourceHeight: attachment.sourceHeight
            }
          })
          return artifactId
        })
      }

      const materializeStageMediaAttachmentsToCanvas = async (options: {
        sourceStage: CanvasTargetReportStage
        attachments: ChatAttachment[]
      }): Promise<CanvasTargetReportStage | null> => {
        const mediaAttachments = options.attachments.filter((attachment) =>
          ['image', 'video', 'model3d'].includes(attachment.type)
        )
        if (mediaAttachments.length === 0) return null

        const stageId = `${options.sourceStage.id}-media-output`
        const inputCanvasVersion = runtimeCanvasVersion
        const inputItemIds = Array.from(runtimeSelectedIds)
        const placedCanvasItems: CanvasItem[] = []
        let canvasDispatchCount = 0

        for (
          let attachmentIndex = 0;
          attachmentIndex < mediaAttachments.length;
          attachmentIndex += 1
        ) {
          const attachment = mediaAttachments[attachmentIndex]
          const dispatchResult = await dispatchCanvasTargetMediaAttachmentToCanvas(
            attachment,
            canvasId,
            `${stageId}-${String(attachmentIndex + 1)}`
          )
          if (dispatchResult.dispatched) {
            canvasDispatchCount += 1
          }
          placedCanvasItems.push(...dispatchResult.placedCanvasItems)
        }

        const mediaArtifactIds = registerStageAttachmentArtifacts(
          options.sourceStage.id,
          options.sourceStage.kind === 'quick-app' ? 'quickapp' : 'model',
          mediaAttachments
        )
        placedCanvasItems.forEach((item, index) => {
          const artifactId = mediaArtifactIds[index]
          if (artifactId) linkArtifactToCanvasItem(artifactId, item.id)
        })
        registerPlacedCanvasItems(options.sourceStage.id, placedCanvasItems, 'canvas')
        registerPlacedCanvasItems(stageId, placedCanvasItems, 'canvas')

        const outputCanvasVersion = runtimeCanvasVersion
        const fallbackReason =
          placedCanvasItems.length === 0
            ? isChineseUi
              ? '阶段返回了媒体附件，但画布没有回传任何已创建元素。'
              : 'The stage returned media attachments, but the canvas did not report any placed item.'
            : undefined
        const content = fallbackReason
          ? fallbackReason
          : isChineseUi
            ? `已将阶段返回的 ${placedCanvasItems.length} 个媒体产物放入画布，并注册为阶段 ${options.sourceStage.id} 的可引用输出。`
            : `Placed ${placedCanvasItems.length} stage media output item(s) on the canvas and registered them as sourceStageId ${options.sourceStage.id}.`

        const materializedStage = buildCanvasTargetStage({
          id: stageId,
          kind: 'canvas-action',
          label: isChineseUi ? '阶段媒体产物入画布' : 'Stage media output materialization',
          status: fallbackReason ? 'fallback' : 'success',
          modelId: 'stage-media-output',
          displayModelLabel: 'MagicPot canvas',
          summary: content,
          overview: [
            isChineseUi
              ? `来源阶段：${options.sourceStage.label}`
              : `Source stage: ${options.sourceStage.label}`,
            isChineseUi
              ? `媒体附件数：${mediaAttachments.length}`
              : `Media attachments: ${mediaAttachments.length}`,
            isChineseUi
              ? `画布放置数量：${canvasDispatchCount}`
              : `Canvas placements: ${canvasDispatchCount}`
          ].join('\n'),
          findings: [],
          responseContent: content,
          responseAttachments: mediaAttachments,
          rawResponse: content,
          fallbackReason,
          inputCanvasVersion,
          outputCanvasVersion
        })
        materializedStage.executionJournalIndex = appendExecutionJournalEntry({
          stageId,
          kind: 'canvas_action',
          label: materializedStage.label,
          status: materializedStage.status,
          inputCanvasVersion,
          outputCanvasVersion,
          inputItemIds,
          outputItemIds: placedCanvasItems.map((item) => item.id),
          affectedItemIds: placedCanvasItems.map((item) => item.id),
          createdItemIds: placedCanvasItems.map((item) => item.id),
          summary: materializedStage.summary,
          attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal(mediaAttachments),
          fallbackReason
        })
        await publishStage(materializedStage, {
          modelName: isChineseUi
            ? '阶段媒体产物入画布 - Canvas'
            : 'Stage media output materialization - Canvas',
          sourceLabel: 'MagicPot canvas',
          delivery: fallbackReason ? 'force' : 'silent',
          includeReportFile: false
        })
        executedStageResults.push(materializedStage)
        return materializedStage
      }

      const getCanvasTargetMediaAttachments = (
        attachments: ChatAttachment[] | undefined
      ): ChatAttachment[] =>
        (attachments || []).filter((attachment) =>
          ['image', 'video', 'model3d'].includes(attachment.type)
        )

      const hasResolvedStageCanvasItems = (stageId: string): boolean => {
        const existingItemIds = new Set(runtimeCanvasItems.map((item) => item.id))
        return (stageCanvasItemIds.get(stageId) || []).some((itemId) => existingItemIds.has(itemId))
      }

      const materializeStageMediaOutputIfNeeded = async (stageId: string): Promise<boolean> => {
        if (!stageId.trim()) return false
        if (hasResolvedStageCanvasItems(stageId)) return true
        const sourceStage = executedStageResults.find((stage) => stage.id === stageId)
        if (!sourceStage) return false
        const mediaAttachments = getCanvasTargetMediaAttachments(sourceStage.responseAttachments)
        if (mediaAttachments.length === 0) return false
        await materializeStageMediaAttachmentsToCanvas({
          sourceStage,
          attachments: mediaAttachments
        })
        return hasResolvedStageCanvasItems(stageId)
      }

      const collectCanvasActionSourceStageIds = (
        action: CanvasTargetCapabilityAction
      ): string[] => {
        if (action.type !== 'canvas') return []
        const stageIds = [action.sourceStageId, ...(action.sourceStageIds || [])]
        return Array.from(new Set(stageIds.map((stageId) => stageId?.trim() || '').filter(Boolean)))
      }

      const materializeReferencedStageMediaForAction = async (
        action: CanvasTargetCapabilityAction
      ): Promise<void> => {
        for (const stageId of collectCanvasActionSourceStageIds(action)) {
          await materializeStageMediaOutputIfNeeded(stageId)
        }
      }

      const getCanvasItemQuickAppAttachments = (itemIds: string[]): ChatAttachment[] => {
        const itemById = new Map(runtimeCanvasItems.map((item) => [item.id, item] as const))
        return itemIds
          .map((itemId) => canvasItemToQuickAppAttachment(itemById.get(itemId)))
          .filter((attachment): attachment is ChatAttachment => Boolean(attachment))
      }

      const getStageQuickAppAttachments = (stageId: string): ChatAttachment[] => {
        const normalizedStageId = stageId.trim()
        if (!normalizedStageId) return []
        const sourceStage = executedStageResults.find((stage) => stage.id === normalizedStageId)
        return dedupeCanvasTargetAttachments([
          ...getCanvasTargetMediaAttachments(sourceStage?.responseAttachments),
          ...getCanvasItemQuickAppAttachments(stageCanvasItemIds.get(normalizedStageId) || [])
        ])
      }

      const attachmentFromArtifact = (
        artifact: CanvasTargetArtifact | undefined
      ): ChatAttachment[] => {
        if (!artifact) return []
        const metadata = artifact.metadata || {}
        const url = typeof metadata.url === 'string' ? metadata.url : undefined
        const fileName = typeof metadata.fileName === 'string' ? metadata.fileName : undefined
        const mimeType = typeof metadata.mimeType === 'string' ? metadata.mimeType : undefined
        const attachmentType =
          metadata.attachmentType === 'video' || artifact.type === 'video'
            ? 'video'
            : metadata.attachmentType === 'image' || artifact.type === 'image'
              ? 'image'
              : null
        const metadataAttachment =
          url && attachmentType
            ? [
                {
                  type: attachmentType,
                  url,
                  ...(fileName ? { fileName } : {}),
                  ...(mimeType ? { mimeType } : {})
                } satisfies ChatAttachment
              ]
            : []
        const canvasItemAttachments = getCanvasItemQuickAppAttachments([
          ...(artifact.canvasItemId ? [artifact.canvasItemId] : []),
          ...(artifactCanvasItemIds.get(artifact.id) || [])
        ])
        return dedupeCanvasTargetAttachments([...metadataAttachment, ...canvasItemAttachments])
      }

      const getArtifactQuickAppAttachments = (artifactId: string): ChatAttachment[] =>
        attachmentFromArtifact(findCanvasTargetArtifact(artifactGraph, artifactId.trim()))

      const getQuickAppAssignmentReferenceAttachments = (
        assignment: CanvasTargetQuickAppAction['inputAssignments'][number]
      ): ChatAttachment[] =>
        dedupeCanvasTargetAttachments([
          ...[assignment.sourceStageId, ...(assignment.sourceStageIds || [])]
            .map((stageId) => stageId?.trim() || '')
            .filter(Boolean)
            .flatMap(getStageQuickAppAttachments),
          ...[assignment.artifactId, ...(assignment.artifactIds || [])]
            .map((artifactId) => artifactId?.trim() || '')
            .filter(Boolean)
            .flatMap(getArtifactQuickAppAttachments),
          ...getCanvasItemQuickAppAttachments(assignment.itemIds || [])
        ])

      const getQuickAppAssignmentReferenceLabels = (
        assignment: CanvasTargetQuickAppAction['inputAssignments'][number]
      ): string[] =>
        [
          assignment.sourceStageId ? `sourceStageId=${assignment.sourceStageId}` : null,
          ...(assignment.sourceStageIds || []).map((stageId) => `sourceStageId=${stageId}`),
          assignment.artifactId ? `artifactId=${assignment.artifactId}` : null,
          ...(assignment.artifactIds || []).map((artifactId) => `artifactId=${artifactId}`),
          ...(assignment.itemIds || []).map((itemId) => `itemId=${itemId}`)
        ].filter((entry): entry is string => Boolean(entry?.trim()))

      const hasQuickAppAssignmentReferences = (
        assignment: CanvasTargetQuickAppAction['inputAssignments'][number]
      ): boolean => getQuickAppAssignmentReferenceLabels(assignment).length > 0

      const bindQuickAppActionInputReferences = (
        action: CanvasTargetQuickAppAction
      ): {
        action: CanvasTargetQuickAppAction
        referencedAttachments: ChatAttachment[]
        resolvedInputAssignmentAttachments: ChatAttachment[][]
        unresolvedReferences: string[]
      } => {
        const referencedAttachments: ChatAttachment[] = []
        const unresolvedReferences: string[] = []
        const resolvedInputAssignmentAttachments = action.inputAssignments.map(
          (assignment, assignmentIndex) => {
            const assignmentAttachments = getQuickAppAssignmentReferenceAttachments(assignment)
            if (assignmentAttachments.length > 0) {
              referencedAttachments.push(...assignmentAttachments)
              return assignmentAttachments
            }
            if (hasQuickAppAssignmentReferences(assignment)) {
              unresolvedReferences.push(
                `inputAssignments[${assignmentIndex}]: ${getQuickAppAssignmentReferenceLabels(
                  assignment
                ).join(', ')}`
              )
            }
            return []
          }
        )
        return {
          action,
          referencedAttachments: dedupeCanvasTargetAttachments(referencedAttachments),
          resolvedInputAssignmentAttachments,
          unresolvedReferences
        }
      }

      const buildQuickAppUnresolvedReferenceMessage = (unresolvedReferences: string[]): string => {
        const references = unresolvedReferences.join('; ')
        return isChineseUi
          ? `快应用输入引用未解析，已停止执行，避免改用原始选区图：${references}`
          : `QuickApp input references were not resolved, so execution stopped instead of falling back to the original selection: ${references}`
      }

      const commitSemanticCanvasResult = (
        stageId: string,
        result: CanvasTargetSemanticCanvasActionResult
      ) => {
        const itemsChanged = result.items !== runtimeCanvasItems
        const groupsChanged = Boolean(result.groups && result.groups !== runtimeCanvasGroups)
        const selectionChanged = !areCanvasTargetIdSetsEqual(runtimeSelectedIds, result.selectedIds)
        const surfaceStateChanged = Boolean(
          result.bgColor ||
          typeof result.showGrid === 'boolean' ||
          result.tool ||
          result.annotationShape ||
          result.annotationColor ||
          typeof result.annotationStrokeWidth === 'number' ||
          typeof result.annotationFillOpacity === 'number'
        )
        runtimeCanvasItems = result.items
        runtimeSelectedIds = new Set(result.selectedIds)
        nextZIndexRef.current = result.nextZIndex
        if (itemsChanged) {
          setItemsWithHistory(result.items)
        }
        if (result.groups) {
          runtimeCanvasGroups = result.groups
          setGroups(result.groups)
        }
        if (result.bgColor) {
          handleBgColorChange(result.bgColor)
        }
        if (typeof result.showGrid === 'boolean') {
          setShowGrid(result.showGrid)
        }
        if (result.tool) {
          setTool(result.tool)
        }
        if (result.annotationShape) {
          setAnnoTool(result.annotationShape)
        }
        if (result.annotationColor) {
          setAnnotationColor(result.annotationColor)
        }
        if (typeof result.annotationStrokeWidth === 'number') {
          setAnnotationStrokeWidth(result.annotationStrokeWidth)
        }
        if (typeof result.annotationFillOpacity === 'number') {
          setAnnotationFillOpacity(result.annotationFillOpacity)
        }
        if (itemsChanged || groupsChanged || selectionChanged || surfaceStateChanged) {
          runtimeCanvasVersion += 1
        }
        setSelectedIds(new Set(result.selectedIds))
        const existingItemIds = new Set(runtimeCanvasItems.map((item) => item.id))
        const resultItemIds = (
          result.resultIds.length > 0 ? result.resultIds : result.affectedIds
        ).filter((itemId) => existingItemIds.has(itemId))
        registerCanvasItemIds(stageId, resultItemIds)
      }

      const getCapabilityActionStageAnchor = (
        action: CanvasTargetCapabilityAction,
        phase: CanvasTargetCapabilityActionPhase
      ): string | undefined => {
        if (phase === 'before_stage') {
          return action.stageId || action.beforeStageId
        }
        if (phase === 'after_stage') {
          return action.stageId || action.afterStageId
        }
        return undefined
      }

      const shouldRunCapabilityActionForPhase = (
        action: CanvasTargetCapabilityAction,
        phase: CanvasTargetCapabilityActionPhase,
        stageId?: string
      ): boolean => {
        if (action.phase !== phase || executedCapabilityActionIds.has(action.id)) {
          return false
        }
        if (phase !== 'before_stage' && phase !== 'after_stage') {
          return true
        }
        const anchorStageId = getCapabilityActionStageAnchor(action, phase)
        return Boolean(stageId && anchorStageId === stageId)
      }

      const executeCapabilityActionsForPhase = async (
        phase: CanvasTargetCapabilityActionPhase,
        options?: {
          actions?: CanvasTargetCapabilityAction[]
          fallbackText?: string
          stageId?: string
          presentationStage?: CanvasTargetReportStage
          immediate?: boolean
        }
      ) => {
        const sourceActions = options?.actions || controlPlan.capabilityActions || []
        const actions = options?.immediate
          ? sourceActions
          : sourceActions.filter((action) =>
              shouldRunCapabilityActionForPhase(action, phase, options?.stageId)
            )

        for (const action of actions) {
          ensureCanvasTargetRunActive()
          await materializeReferencedStageMediaForAction(action)
          ensureCanvasTargetRunActive()
          if (!options?.immediate) {
            executedCapabilityActionIds.add(action.id)
          }
          capabilityActionStageIndex += 1
          const stageId = action.id || `${runId}-capability-${capabilityActionStageIndex}`
          const stageLabel =
            action.label ||
            (action.type === 'quick_app' ? `QuickApp ${action.qAppKey}` : `Canvas ${action.action}`)
          const inputCanvasVersion = runtimeCanvasVersion
          const inputItemIds = Array.from(runtimeSelectedIds)

          if (action.type === 'quick_app') {
            try {
              const quickAppInputBinding = bindQuickAppActionInputReferences(action)
              if (quickAppInputBinding.unresolvedReferences.length > 0) {
                throw new Error(
                  buildQuickAppUnresolvedReferenceMessage(quickAppInputBinding.unresolvedReferences)
                )
              }
              const quickAppResult = await runCanvasTargetQuickAppAction({
                action: quickAppInputBinding.action,
                api: api(),
                config,
                projectId: canvasId,
                userIntent: canvasTargetUserIntent,
                controlProfileId: canvasTargetControlProfileId,
                sourceAttachments: evidenceSourceAttachments,
                snapshotAttachment: evidenceSnapshotAttachment,
                upstreamAttachments: dedupeCanvasTargetAttachments([
                  ...quickAppInputBinding.referencedAttachments,
                  ...executedStageResults.flatMap((stage) => stage.responseAttachments || [])
                ]).slice(0, 8),
                resolvedInputAssignmentAttachments:
                  quickAppInputBinding.resolvedInputAssignmentAttachments,
                generationSessionId: stageId
              })
              ensureCanvasTargetRunActive()
              registerStageTextArtifact(stageId, 'quickapp', quickAppResult.content)
              const quickAppArtifactIds = registerStageAttachmentArtifacts(
                stageId,
                'quickapp',
                quickAppResult.attachments
              )
              quickAppResult.placedCanvasItems.forEach((item, index) => {
                const artifactId = quickAppArtifactIds[index]
                if (artifactId) linkArtifactToCanvasItem(artifactId, item.id)
              })
              registerPlacedCanvasItems(stageId, quickAppResult.placedCanvasItems, 'quick_app')
              const outputCanvasVersion = runtimeCanvasVersion

              const publishedStage = buildCanvasTargetStage({
                id: stageId,
                kind: 'quick-app',
                label: stageLabel,
                status: 'success',
                modelId: action.qAppKey,
                displayModelLabel: quickAppResult.qAppName,
                summary: buildCanvasTargetStageSummaryFromResult(quickAppResult, isChineseUi),
                overview: [
                  action.reason ? `Reason: ${action.reason}` : null,
                  `Output target: ${action.outputTarget}`,
                  `Canvas placements: ${quickAppResult.canvasDispatchCount}`
                ]
                  .filter(Boolean)
                  .join('\n'),
                findings: [],
                responseContent: quickAppResult.content,
                responseAttachments: quickAppResult.attachments,
                rawResponse: quickAppResult.content,
                inputCanvasVersion,
                outputCanvasVersion
              })
              publishedStage.executionJournalIndex = appendExecutionJournalEntry({
                stageId,
                kind: 'quick_app',
                label: stageLabel,
                status: 'success',
                inputCanvasVersion,
                outputCanvasVersion,
                inputItemIds,
                outputItemIds: quickAppResult.placedCanvasItemIds,
                affectedItemIds: quickAppResult.placedCanvasItemIds,
                createdItemIds: quickAppResult.placedCanvasItemIds,
                summary: publishedStage.summary,
                action: summarizeCanvasTargetActionForJournal(action),
                attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal(
                  quickAppResult.attachments
                )
              })
              await publishStage(publishedStage, {
                modelName: `${stageLabel} - QuickApp`,
                sourceLabel: quickAppResult.qAppName,
                delivery: action.outputTarget === 'canvas' ? 'silent' : 'force',
                includeReportFile: false
              })
              executedStageResults.push(publishedStage)
            } catch (error) {
              const fallbackReason =
                error instanceof Error ? error.message : 'QuickApp action failed.'
              const fallbackStage = buildCanvasTargetStage({
                id: stageId,
                kind: 'quick-app',
                label: stageLabel,
                status: 'fallback',
                modelId: action.qAppKey,
                summary: isChineseUi ? '快应用动作执行失败。' : 'QuickApp action failed.',
                overview: action.reason || '',
                findings: [],
                fallbackReason,
                inputCanvasVersion,
                outputCanvasVersion: runtimeCanvasVersion
              })
              fallbackStage.executionJournalIndex = appendExecutionJournalEntry({
                stageId,
                kind: 'quick_app',
                label: stageLabel,
                status: 'fallback',
                inputCanvasVersion,
                outputCanvasVersion: runtimeCanvasVersion,
                inputItemIds,
                summary: fallbackStage.summary,
                action: summarizeCanvasTargetActionForJournal(action),
                fallbackReason
              })
              await publishStage(fallbackStage, {
                modelName: `${stageLabel} - QuickApp`,
                sourceLabel: action.qAppKey,
                delivery: 'force',
                includeReportFile: false
              })
              executedStageResults.push(fallbackStage)
            }
            continue
          }

          const semanticState: CanvasTargetSemanticCanvasActionState = {
            items: runtimeCanvasItems,
            groups: runtimeCanvasGroups,
            selectedIds: runtimeSelectedIds,
            nextZIndex: nextZIndexRef.current,
            artifactCanvasItemIds,
            stageCanvasItemIds
          }
          const executableCanvasAction = action
          const canvasResult = await executeCanvasTargetCanvasAction(executableCanvasAction, {
            projectId: canvasId,
            fallbackText: options?.fallbackText,
            generationSessionId: stageId,
            semanticState,
            commitSemanticResult: (result) => commitSemanticCanvasResult(stageId, result),
            resolveCanvasTargetItemBounds
          })
          if (!isCanvasTargetSemanticCanvasActionName(executableCanvasAction.action)) {
            const canvasAttachmentArtifactIds = registerStageAttachmentArtifacts(
              stageId,
              'canvas',
              canvasResult.attachments
            )
            ;(canvasResult.placedCanvasItems || []).forEach((item, index) => {
              const artifactId = canvasAttachmentArtifactIds[index]
              if (artifactId) linkArtifactToCanvasItem(artifactId, item.id)
            })
            registerPlacedCanvasItems(stageId, canvasResult.placedCanvasItems || [], 'canvas')
          }
          registerStageTextArtifact(stageId, 'canvas', canvasResult.content)
          const outputCanvasVersion = runtimeCanvasVersion
          const displayCanvasContent = buildCanvasTargetCanvasActionDisplayContent(
            executableCanvasAction,
            canvasResult,
            isChineseUi
          )
          const publishedStage = buildCanvasTargetStage({
            id: stageId,
            kind: 'canvas-action',
            label: stageLabel,
            status: canvasResult.fallbackReason ? 'fallback' : 'success',
            modelId: action.action,
            displayModelLabel: 'MagicPot canvas',
            summary: buildCanvasTargetStageSummaryFromResult(
              {
                ...canvasResult,
                content: displayCanvasContent
              },
              isChineseUi
            ),
            overview: [
              action.reason
                ? isChineseUi
                  ? `原因：${action.reason}`
                  : `Reason: ${action.reason}`
                : null,
              isChineseUi
                ? `输出位置：${action.outputTarget}`
                : `Output target: ${action.outputTarget}`,
              isChineseUi
                ? `画布放置数量：${canvasResult.canvasDispatchCount}`
                : `Canvas placements: ${canvasResult.canvasDispatchCount}`
            ]
              .filter(Boolean)
              .join('\n'),
            findings: [],
            responseContent: displayCanvasContent,
            responseAttachments: canvasResult.attachments,
            rawResponse: displayCanvasContent,
            fallbackReason: canvasResult.fallbackReason,
            inputCanvasVersion,
            outputCanvasVersion
          })
          publishedStage.executionJournalIndex = appendExecutionJournalEntry({
            stageId,
            kind: 'canvas_action',
            label: stageLabel,
            status: publishedStage.status,
            inputCanvasVersion,
            outputCanvasVersion,
            inputItemIds,
            outputItemIds: canvasResult.placedCanvasItemIds || [],
            affectedItemIds: canvasResult.affectedCanvasItemIds || [],
            createdItemIds: canvasResult.placedCanvasItemIds || [],
            summary: publishedStage.summary,
            action: summarizeCanvasTargetActionForJournal(executableCanvasAction),
            attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal(
              canvasResult.attachments
            ),
            fallbackReason: canvasResult.fallbackReason
          })
          await publishStage(publishedStage, {
            modelName: `${stageLabel} - Canvas`,
            sourceLabel: 'MagicPot canvas',
            delivery:
              canvasResult.fallbackReason || action.outputTarget !== 'canvas' ? 'force' : 'silent',
            includeReportFile: false
          })
          executedStageResults.push(publishedStage)
        }

        if (phase === 'after_summary' && options?.presentationStage) {
          const presentationStageId = `${runId}-final-presentation`
          const inputCanvasVersion = runtimeCanvasVersion
          const inputItemIds = Array.from(runtimeSelectedIds)
          const presentationResult = await presentCanvasTargetFinalResult({
            stage: options.presentationStage,
            presentation: controlPlan.finalPresentation,
            projectId: canvasId,
            generationSessionId: presentationStageId
          })
          const presentationArtifactIds = registerStageAttachmentArtifacts(
            presentationStageId,
            'final_evidence',
            presentationResult.attachments
          )
          ;(presentationResult.placedCanvasItems || []).forEach((item, index) => {
            const artifactId = presentationArtifactIds[index]
            if (artifactId) linkArtifactToCanvasItem(artifactId, item.id)
          })
          registerPlacedCanvasItems(
            presentationStageId,
            presentationResult.placedCanvasItems || [],
            'canvas'
          )
          const outputCanvasVersion = runtimeCanvasVersion

          if (presentationResult.canvasDispatchCount > 0) {
            const presentationStage = buildCanvasTargetStage({
              id: presentationStageId,
              kind: 'canvas-action',
              label: isChineseUi ? '结果展示' : 'Result presentation',
              status: presentationResult.fallbackReason ? 'fallback' : 'success',
              modelId: 'canvas-presentation',
              displayModelLabel: 'MagicPot canvas',
              summary: buildCanvasTargetStageSummaryFromResult(presentationResult, isChineseUi),
              overview: presentationResult.content,
              findings: [],
              responseContent: presentationResult.content,
              responseAttachments: presentationResult.attachments,
              rawResponse: presentationResult.content,
              fallbackReason: presentationResult.fallbackReason,
              inputCanvasVersion,
              outputCanvasVersion
            })
            presentationStage.executionJournalIndex = appendExecutionJournalEntry({
              stageId: presentationStageId,
              kind: 'final_presentation',
              label: presentationStage.label,
              status: presentationStage.status,
              inputCanvasVersion,
              outputCanvasVersion,
              inputItemIds,
              outputItemIds: presentationResult.placedCanvasItemIds || [],
              affectedItemIds: presentationResult.placedCanvasItemIds || [],
              createdItemIds: presentationResult.placedCanvasItemIds || [],
              summary: presentationStage.summary,
              attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal(
                presentationResult.attachments
              ),
              fallbackReason: presentationResult.fallbackReason
            })
            await publishStage(presentationStage, {
              modelName: isChineseUi ? '结果展示 - Canvas' : 'Result presentation - Canvas',
              sourceLabel: 'MagicPot canvas',
              delivery: presentationResult.fallbackReason ? 'force' : 'silent',
              includeReportFile: false
            })
            executedStageResults.push(presentationStage)
          }
        }
      }

      await executeCapabilityActionsForPhase('before_model_stages')

      for (let index = 0; index < controlPlan.stageInstructions.length; index += 1) {
        const stageInstruction = controlPlan.stageInstructions[index]
        const modelStageId = stageInstruction.id || runId + '-model-stage-' + String(index + 1)
        await executeCapabilityActionsForPhase('before_stage', {
          stageId: modelStageId
        })
        const stageProfile =
          stageOptionById.get(stageInstruction.modelId) ||
          stageOptionById.get(stageCandidates[index]?.id || '')
        const upstreamStages = executedStageResults.filter((stage) =>
          (stageInstruction.upstreamStageIds || []).includes(stage.id)
        )
        const upstreamAttachments = dedupeCanvasTargetAttachments(
          upstreamStages.flatMap((stage) => stage.responseAttachments || [])
        ).slice(0, 6)
        const stageExecutionBackend = stageProfile?.executionBackend || 'llm'
        const stageSupportsVisualInputs = Boolean(
          stageProfile?.isVisionModel ||
          stageProfile?.isOcrModel ||
          stageExecutionBackend === 'local_model'
        )
        const allowedSchemeFileIds = new Set(
          (stageInstruction.allowedSchemeFileIds || [])
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
        )
        const selectedSourceAttachments =
          stageInstruction.includeSourceAttachments === false ? [] : evidenceSourceAttachments
        const selectedSnapshotAttachment =
          stageInstruction.includeSelectionSnapshot === false ? null : evidenceSnapshotAttachment
        const selectedSchemeImageAttachments =
          stageInstruction.includeSchemeImageAttachments === false
            ? []
            : schemeImageAttachments
                .filter((entry) => {
                  if (allowedSchemeFileIds.size === 0) return true
                  return allowedSchemeFileIds.has(entry.fileId)
                })
                .map((entry) => entry.attachment)
        const baseStageAttachments = stageSupportsVisualInputs
          ? dedupeCanvasTargetAttachments([
              ...selectedSourceAttachments,
              ...(selectedSnapshotAttachment ? [selectedSnapshotAttachment] : []),
              ...selectedSchemeImageAttachments
            ])
          : []
        const stageAttachments = dedupeCanvasTargetAttachments([
          ...baseStageAttachments,
          ...(stageSupportsVisualInputs ? upstreamAttachments : [])
        ])
        const inputCanvasVersion = runtimeCanvasVersion
        const inputItemIds = Array.from(runtimeSelectedIds)
        const localVisualAttachmentGroups: CanvasTargetLocalVisualAttachmentGroup[] = []
        if (selectedSourceAttachments.length > 0) {
          localVisualAttachmentGroups.push({
            kind: 'source_assets',
            label: isChineseUi ? '原始选区资源' : 'Source assets',
            attachments: selectedSourceAttachments
          })
        }
        if (selectedSnapshotAttachment) {
          localVisualAttachmentGroups.push({
            kind: 'selection_snapshot',
            label: isChineseUi ? '选区截图' : 'Selection snapshot',
            attachments: [selectedSnapshotAttachment]
          })
        }
        if (selectedSchemeImageAttachments.length > 0) {
          localVisualAttachmentGroups.push({
            kind: 'scheme_images',
            label: isChineseUi ? '方案图片' : 'Scheme images',
            attachments: selectedSchemeImageAttachments
          })
        }
        if (upstreamAttachments.length > 0) {
          localVisualAttachmentGroups.push({
            kind: 'upstream_results',
            label: isChineseUi ? '上游阶段图片结果' : 'Upstream stage image results',
            attachments: upstreamAttachments
          })
        }
        appendMessageToExternalChat({
          scope: agentScope,
          sessionId: agentSessionId,
          role: 'assistant',
          content: isChineseUi
            ? `正在执行阶段 ${index + 1}/${controlPlan.stageInstructions.length}：${stageInstruction.label}`
            : `Running stage ${index + 1}/${controlPlan.stageInstructions.length}: ${stageInstruction.label}`,
          modelName: stageProfile?.label || stageInstruction.modelId
        })
        await waitForCanvasTargetProgressPaint()
        ensureCanvasTargetRunActive()

        const stageResult =
          stageExecutionBackend === 'local_model'
            ? await executeCanvasTargetLocalVisualStage({
                duplicateCheckSvc: api().svcDuplicateCheck,
                modelId: stageInstruction.modelId,
                modelLabel: stageProfile?.label || stageInstruction.modelId,
                attachmentGroups: localVisualAttachmentGroups,
                stageLabel: stageInstruction.label,
                stagePrompt: stageInstruction.prompt,
                referenceNotes: stageInstruction.referenceNotes,
                userNotes: canvasTargetUserIntent,
                preferredOutputFormats: stageInstruction.expectedOutputFormats,
                isChineseUi
              })
            : await requestCanvasTargetStageExecution({
                scheme: selectedScheme,
                contextPack,
                llmProxy: api().svcLLMProxy,
                attachments: stageAttachments.length > 0 ? stageAttachments : undefined,
                userNotes: canvasTargetUserIntent,
                profileId: stageInstruction.modelId,
                preferExactProfile: true,
                preferredLanguage: isChineseUi ? 'zh-CN' : 'en-US',
                stageLabel: stageInstruction.label,
                stagePrompt: stageInstruction.prompt,
                referenceNotes: stageInstruction.referenceNotes,
                allowedSchemeFileIds: stageInstruction.allowedSchemeFileIds,
                executionJournalDigest: buildExecutionJournalDigest(),
                preferredOutputFormats: stageInstruction.expectedOutputFormats,
                upstreamStageResults: upstreamStages.map((stage) => ({
                  id: stage.id,
                  label: stage.label,
                  modelId: stage.modelId,
                  content: stage.responseContent,
                  attachments: stage.responseAttachments,
                  ocrResult: stage.responseOcrResult,
                  fallbackReason: stage.fallbackReason
                }))
              })
        ensureCanvasTargetRunActive()

        registerStageTextArtifact(modelStageId, 'model', stageResult.content)
        registerStageAttachmentArtifacts(modelStageId, 'model', stageResult.attachments)
        const mediaOutputAttachments = getCanvasTargetMediaAttachments(stageResult.attachments)
        const stageFallbackReason = stageResult.fallbackReason

        const publishedStage = buildCanvasTargetStage({
          id: modelStageId,
          kind: 'model-check',
          label:
            stageInstruction?.label ||
            `${isChineseUi ? '模型阶段 ' : 'Model stage '}${String(index + 1)}`,
          status:
            stageResult.fallbackReason &&
            !stageResult.content.trim() &&
            (!stageResult.attachments || stageResult.attachments.length === 0) &&
            !stageResult.ocrResult
              ? 'fallback'
              : 'success',
          modelId: stageResult.modelId,
          summary: buildCanvasTargetStageSummaryFromResult(stageResult, isChineseUi),
          overview: buildCanvasTargetStageOverviewFromPlan({
            isChineseUi,
            stagePrompt: stageInstruction.prompt,
            referenceNotes: stageInstruction.referenceNotes,
            upstreamStageLabels: upstreamStages.map((stage) => stage.label),
            attachmentCount: stageAttachments.length,
            fallbackReason: stageFallbackReason
          }),
          findings: [],
          upstreamStageIds: stageInstruction.upstreamStageIds,
          inputSourceAttachments:
            stageSupportsVisualInputs &&
            stageInstruction.includeSourceAttachments !== false &&
            selectedSourceAttachments.length > 0
              ? dedupeCanvasTargetAttachments(selectedSourceAttachments)
              : undefined,
          responseContent: stageResult.content,
          responseAttachments: stageResult.attachments,
          responseOcrResult: stageResult.ocrResult,
          rawResponse: stageResult.content,
          fallbackReason: stageFallbackReason,
          inputCanvasVersion,
          outputCanvasVersion: runtimeCanvasVersion
        })
        publishedStage.executionJournalIndex = appendExecutionJournalEntry({
          stageId: modelStageId,
          kind: 'model',
          label: publishedStage.label,
          status: publishedStage.status,
          inputCanvasVersion,
          outputCanvasVersion: runtimeCanvasVersion,
          inputItemIds,
          summary: publishedStage.summary,
          attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal(stageResult.attachments),
          fallbackReason: stageFallbackReason
        })
        const stageSourceLabel = stageResult.modelId
          ? stageProfile?.label || stageResult.modelId
          : undefined
        await publishStage(publishedStage, {
          modelName: stageSourceLabel
            ? `${publishedStage.label} - ${stageSourceLabel}`
            : `${publishedStage.label} - MagicPot`,
          sourceLabel: stageSourceLabel,
          delivery: 'auto',
          includeReportFile: false
        })
        executedStageResults.push(publishedStage)
        if (mediaOutputAttachments.length > 0) {
          await materializeStageMediaAttachmentsToCanvas({
            sourceStage: publishedStage,
            attachments: mediaOutputAttachments
          })
        }
        await executeCapabilityActionsForPhase('after_stage', {
          stageId: modelStageId,
          fallbackText: stageResult.content
        })
      }

      await executeCapabilityActionsForPhase('after_model_stages')
      await executeCapabilityActionsForPhase('after_summary', {
        fallbackText: executedStageResults
          .map((stage) => stage.responseContent || stage.summary || '')
          .filter(Boolean)
          .join('\n\n')
      })
      ensureCanvasTargetRunActive()
      const buildFinalCanvasEvidenceAttachment = async (): Promise<ChatAttachment | null> => {
        if (normalizedEvidenceMode === 'structured_only') return null
        const evidenceItemIds = new Set<string>()
        for (const item of targetItems) evidenceItemIds.add(item.id)
        for (const itemId of runtimeSelectedIds) evidenceItemIds.add(itemId)
        for (const itemId of lastCanvasItemIds) evidenceItemIds.add(itemId)
        for (const itemId of lastQuickAppCanvasItemIds) evidenceItemIds.add(itemId)
        for (const itemIds of stageCanvasItemIds.values()) {
          for (const itemId of itemIds) evidenceItemIds.add(itemId)
        }
        const finalEvidenceItems = runtimeCanvasItems.filter((item) => evidenceItemIds.has(item.id))
        if (finalEvidenceItems.length === 0) return null

        try {
          const finalEvidenceDataUrl = await renderCanvasItemsImageDataUrl(
            finalEvidenceItems,
            false,
            null
          )
          return finalEvidenceDataUrl
            ? {
                type: 'image',
                url: finalEvidenceDataUrl,
                mimeType: 'image/png',
                fileName: 'canvas-target-final-evidence.png'
              }
            : null
        } catch (snapshotError) {
          console.warn('[CanvasTarget] Failed to render final canvas evidence.', snapshotError)
          return null
        }
      }

      const buildSummaryStageResults = () =>
        executedStageResults.map((stage) => ({
          id: stage.id,
          label: stage.label,
          modelId: stage.modelId,
          summary: stage.summary,
          overview: stage.overview,
          findings: stage.findings,
          content: stage.responseContent,
          attachments: stage.responseAttachments,
          ocrResult: stage.responseOcrResult,
          upstreamStageIds: stage.upstreamStageIds,
          fallbackReason: stage.fallbackReason
        }))

      const buildSummaryAttachments = async (): Promise<ChatAttachment[]> => {
        const finalCanvasEvidenceAttachment = await buildFinalCanvasEvidenceAttachment()
        if (finalCanvasEvidenceAttachment) {
          registerStageAttachmentArtifacts(`${runId}-final-evidence`, 'final_evidence', [
            finalCanvasEvidenceAttachment
          ])
        }
        const summaryBaseAttachments = buildCanvasTargetAttachments({
          sourceAttachments: evidenceSourceAttachments,
          snapshotAttachment: evidenceSnapshotAttachment,
          schemeImageAttachments,
          allowedSchemeFileIds: controlPlan.relevantSchemeFileIds
        })
        const summaryUpstreamAttachments = dedupeCanvasTargetAttachments(
          executedStageResults.flatMap((stage) => stage.responseAttachments || [])
        ).slice(0, 6)
        return dedupeCanvasTargetAttachments([
          ...(finalCanvasEvidenceAttachment ? [finalCanvasEvidenceAttachment] : []),
          ...summaryBaseAttachments,
          ...summaryUpstreamAttachments
        ])
      }

      const requestAndPublishControlSummary = async (options: {
        id: string
        label: string
        delivery?: 'auto' | 'force'
      }) => {
        appendMessageToExternalChat({
          scope: agentScope,
          sessionId: agentSessionId,
          role: 'assistant',
          content: isChineseUi ? `正在进行${options.label}。` : `Running ${options.label}.`,
          modelName: controlModelLabel
        })
        await waitForCanvasTargetProgressPaint()
        ensureCanvasTargetRunActive()

        const summaryAttachments = await buildSummaryAttachments()
        const summaryInputCanvasVersion = runtimeCanvasVersion
        const summaryInputItemIds = Array.from(runtimeSelectedIds)
        const summaryResult = await requestCanvasTargetSummaryExecution({
          scheme: selectedScheme,
          contextPack,
          llmProxy: api().svcLLMProxy,
          attachments: summaryAttachments.length > 0 ? summaryAttachments : undefined,
          userIntent: canvasTargetUserIntent,
          profileId: canvasTargetControlProfileId,
          preferExactProfile: true,
          preferredLanguage: isChineseUi ? 'zh-CN' : 'en-US',
          controlPlan,
          executionJournalDigest: buildExecutionJournalDigest(),
          stageResults: buildSummaryStageResults()
        })
        ensureCanvasTargetRunActive()

        registerStageTextArtifact(options.id, 'model', summaryResult.content)
        registerStageAttachmentArtifacts(options.id, 'model', summaryResult.attachments)
        const finalSummaryStage = buildCanvasTargetStage({
          id: options.id,
          kind: 'control-summary',
          label: options.label,
          status:
            summaryResult.fallbackReason &&
            !summaryResult.content.trim() &&
            (!summaryResult.attachments || summaryResult.attachments.length === 0) &&
            !summaryResult.ocrResult
              ? 'fallback'
              : 'success',
          modelId: summaryResult.modelId,
          summary: buildCanvasTargetStageSummaryFromResult(summaryResult, isChineseUi),
          overview:
            buildCanvasTargetStageOverviewFromPlan({
              isChineseUi,
              attachmentCount: summaryAttachments.length,
              fallbackReason: summaryResult.fallbackReason
            }) || summaryResult.content,
          findings: [],
          responseContent: summaryResult.content,
          responseAttachments: summaryResult.attachments,
          responseOcrResult: summaryResult.ocrResult,
          rawResponse: summaryResult.content,
          fallbackReason: summaryResult.fallbackReason,
          inputCanvasVersion: summaryInputCanvasVersion,
          outputCanvasVersion: runtimeCanvasVersion
        })
        finalSummaryStage.executionJournalIndex = appendExecutionJournalEntry({
          stageId: finalSummaryStage.id,
          kind: 'model',
          label: finalSummaryStage.label,
          status: finalSummaryStage.status,
          inputCanvasVersion: summaryInputCanvasVersion,
          outputCanvasVersion: runtimeCanvasVersion,
          inputItemIds: summaryInputItemIds,
          summary: finalSummaryStage.summary,
          attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal(
            summaryResult.attachments
          ),
          fallbackReason: summaryResult.fallbackReason
        })
        const finalReport = await publishStage(finalSummaryStage, {
          modelName: controlModelLabel,
          sourceLabel: summaryResult.modelId ? controlModelLabel : undefined,
          delivery: options.delivery || (shouldCreateDocumentDeliverable ? 'force' : 'auto'),
          includeReportFile: shouldCreateDocumentDeliverable
        })
        return {
          finalReport,
          finalSummaryStage,
          summaryAttachments,
          summaryResult
        }
      }

      const finalSummaryRun = await requestAndPublishControlSummary({
        id: runId + '-control-summary',
        label: isChineseUi ? '控制总结' : 'Control summary'
      })
      const acceptanceStatus = resolveCanvasTargetAcceptanceStatus(
        finalSummaryRun.summaryResult.content
      )

      if (acceptanceStatus === 'needs_fix') {
        appendMessageToExternalChat({
          scope: agentScope,
          sessionId: agentSessionId,
          role: 'assistant',
          content: isChineseUi
            ? '控制总结返回 NEEDS_FIX。自动修正循环默认关闭，本次执行已停在验收反馈处；请查看 Agent 反馈后手动决定是否继续处理。'
            : 'The control summary returned NEEDS_FIX. Automatic correction is disabled by default, so this run stopped at the acceptance feedback. Review the Agent feedback and decide any manual follow-up.',
          modelName: controlModelLabel
        })
      }

      await executeCapabilityActionsForPhase('after_summary', {
        actions: [],
        fallbackText: finalSummaryRun.summaryResult.content,
        presentationStage: finalSummaryRun.finalSummaryStage
      })
      const finalReport = buildCoordinatedCanvasTargetReport(contextPack, [...stages], isChineseUi)
      setCanvasTargetReport(finalReport)

      const finalSummaryText = buildCanvasTargetAgentFinalSummaryText({
        stage: finalSummaryRun.finalSummaryStage
      })
      if (finalSummaryText && !shouldCreateDocumentDeliverable) {
        appendMessageToExternalChat({
          scope: agentScope,
          sessionId: agentSessionId,
          role: 'assistant',
          content: finalSummaryText,
          modelName: controlModelLabel
        })
      }

      if (finalReport.fallbackReason) {
        notifyWarning(
          (isChineseUi ? '部分目标阶段已回退：' : 'Some target stages fell back: ') +
            finalReport.fallbackReason
        )
      }

      if (acceptanceStatus === 'needs_fix') {
        notifyWarning(
          isChineseUi
            ? '主控模型最终验收认为结果仍需修正，请查看 Agent 反馈。'
            : 'The control model final acceptance says the result still needs fixes. Review the Agent feedback.'
        )
      } else if (acceptanceStatus === 'accepted') {
        notifySuccess(
          isChineseUi
            ? '画布目标已完成，可查看主控模型验收结果。'
            : 'Canvas target is complete. Review the control model acceptance result.'
        )
      } else {
        notifyWarning(
          isChineseUi
            ? '主控模型未返回明确的 ACCEPTED/NEEDS_FIX 验收状态，请查看 Agent 反馈。'
            : 'The control model did not return an explicit ACCEPTED/NEEDS_FIX status. Review the Agent feedback.'
        )
      }
    } catch (error) {
      if (isCanvasTargetCancelledError(error)) {
        return
      }
      const message =
        error instanceof Error
          ? error.message
          : isChineseUi
            ? '画布目标失败。'
            : 'Canvas target failed.'
      void persistCanvasTargetFailureArchive({
        runId,
        baseDir: reportBundleRootDir,
        error: message,
        contextPack,
        schemeId: selectedScheme?.id || null,
        projectId: canvasId,
        projectName,
        userIntent: canvasTargetUserIntent,
        controlProfileId: canvasTargetControlProfileId || null,
        stageProfiles,
        targetItemIds: targetItems.map((item) => item.id)
      })
      const decoratedMessage = formatCanvasTargetErrorMessage(message, runId)
      setCanvasTargetError(decoratedMessage)
      notifyError(decoratedMessage)
    } finally {
      setExternalChatSessionLoading({
        scope: agentScope,
        sessionId: agentSessionId,
        loading: false
      })
      if (canvasTargetActiveRunIdRef.current === runId) {
        canvasTargetActiveRunIdRef.current = null
        setCanvasTargetLoading(false)
      }
      if (canvasTargetExternalChatRef.current?.runId === runId) {
        canvasTargetExternalChatRef.current = null
      }
    }
  }, [
    buildEnv.pathMap.data,
    buildCanvasAssetMetadata,
    canvasTargetControlProfileId,
    canvasTargetEvidenceMode,
    canvasTargetHistoryTargets,
    canvasTargetQuickAppOptions,
    canvasTargetQuickApps,
    canvasTargetSelectedHistoryTargetId,
    canvasTargetStageProfileSelectOptions,
    canvasTargetSelectedSchemeId,
    canvasTargetSelectedTraceIds,
    canvasTargetSelectionBounds,
    canvasTargetStageProfiles,
    canvasTargetTargetItemIds,
    canvasTargetTargetName,
    canvasTargetUserIntent,
    canvasId,
    config,
    targetSchemes,
    dispatch,
    groups,
    handleBgColorChange,
    isChineseUi,
    items,
    nextZIndexRef,
    notifyError,
    notifySuccess,
    notifyWarning,
    projectName,
    renderCanvasItemsImageDataUrl,
    resolveActiveAgentScope,
    resolveCanvasTargetItemBounds,
    selectedIds,
    setAnnoTool,
    setAnnotationColor,
    setAnnotationFillOpacity,
    setAnnotationStrokeWidth,
    setGroups,
    setItemsWithHistory,
    setSelectedIds,
    setShowGrid,
    setTool
  ])

  useEffect(() => {
    const handleExternalCanvasTargetRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ canvasId?: string }>).detail
      if (detail?.canvasId && detail.canvasId !== canvasId) {
        return
      }

      if (canvasTargetLoading) {
        setTool('select')
        setCanvasTargetDialogOpen(true)
        return
      }

      const latestItems = latestItemsRef.current
      const latestSelectedIds = selectedIdsRef?.current || latestSelectedIdsRef.current
      const currentSelection = latestItems.filter((item) => latestSelectedIds.has(item.id))
      if (currentSelection.length > 0) {
        void handleOpenCanvasTargetDialog(currentSelection)
        notifyInfo(
          isChineseUi
            ? '已基于当前选区打开目标配置。'
            : 'Opened the target configuration for the current selection.'
        )
        return
      }

      handleBeginCanvasTargetSelection()
    }

    window.addEventListener(
      'canvas:run-check-request',
      handleExternalCanvasTargetRequest as EventListener
    )
    window.addEventListener(
      'canvas:run-target-request',
      handleExternalCanvasTargetRequest as EventListener
    )
    return () => {
      window.removeEventListener(
        'canvas:run-check-request',
        handleExternalCanvasTargetRequest as EventListener
      )
      window.removeEventListener(
        'canvas:run-target-request',
        handleExternalCanvasTargetRequest as EventListener
      )
    }
  }, [
    canvasTargetLoading,
    canvasId,
    handleBeginCanvasTargetSelection,
    handleOpenCanvasTargetDialog,
    isChineseUi,
    notifyInfo,
    selectedIdsRef,
    setTool
  ])

  return {
    targetSchemes,
    canvasTargetHistoryTargets,
    canvasTargetReferenceTraces,
    canvasTargetSelectedTraceIds,
    setCanvasTargetSelectedTraceIds,
    canvasTargetEvidenceMode,
    setCanvasTargetEvidenceMode,
    canvasTargetDialogOpen,
    canvasTargetLoading,
    canvasTargetError,
    canvasTargetTargetName,
    setCanvasTargetTargetName,
    canvasTargetSelectedHistoryTargetId,
    canvasTargetSelectedSchemeId,
    setCanvasTargetSelectedSchemeId,
    canvasTargetTargetItemCount,
    canvasTargetUserIntent,
    setCanvasTargetUserIntent,
    canvasTargetControlProfileId,
    setCanvasTargetControlProfileId,
    canvasTargetStageProfiles,
    setCanvasTargetStageProfiles,
    canvasTargetQuickAppOptions,
    canvasTargetQuickApps,
    setCanvasTargetQuickApps,
    canvasTargetControlProfileSelectOptions,
    canvasTargetStageProfileSelectOptions,
    canvasTargetReport,
    handleCloseCanvasTargetDialog,
    handleBeginCanvasTargetSelection,
    handleOpenCanvasTargetDialog,
    handleCancelCanvasTarget,
    handleApplyCanvasTargetHistoryTarget,
    handleRenameCanvasTargetHistoryTarget,
    handleDeleteCanvasTargetHistoryTarget,
    handleRunCanvasTarget,
    openTargetManager
  }
}
