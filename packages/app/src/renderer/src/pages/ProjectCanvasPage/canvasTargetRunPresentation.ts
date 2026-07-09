import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'
import type { CanvasTargetReport, CanvasTargetReportStage } from '@shared/canvasTarget'

import type {
  CanvasTargetCanvasAction,
  CanvasTargetCapabilityAction
} from './canvasTargetCapabilityTypes'
import type { CanvasTargetControlPlan } from './canvasTargetWorkflow'
import type { CanvasItem } from './types'

export function buildCanvasTargetStage(
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

export function truncateCanvasTargetStagePreview(
  value: string | undefined,
  maxLength = 180
): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

export function buildCanvasTargetStageSummaryFromResult(
  result: {
    content?: string
    attachments?: ChatAttachment[]
    ocrResult?: OCRResult
    fallbackReason?: string
  },
  isChineseUi: boolean
): string {
  void isChineseUi
  const contentPreview = truncateCanvasTargetStagePreview(result.content)
  if (contentPreview) return contentPreview

  if (result.ocrResult) {
    if (result.ocrResult.kind === 'table') {
      return 'Returned OCR table data.'
    }
    if (result.ocrResult.kind === 'document') {
      return 'Returned OCR document data.'
    }
    return 'Returned OCR text data.'
  }

  if (result.attachments?.length) {
    return `Returned ${result.attachments.length} attachment(s).`
  }

  if (result.fallbackReason) {
    return 'Stage fell back.'
  }

  return 'Stage completed.'
}

export function buildCanvasTargetStageOverviewFromPlan(options: {
  isChineseUi: boolean
  stagePrompt?: string
  referenceNotes?: string[]
  upstreamStageLabels?: string[]
  attachmentCount?: number
  fallbackReason?: string
}): string {
  void options.isChineseUi
  const lines: string[] = []

  if (options.stagePrompt?.trim()) {
    lines.push(`Stage prompt: ${options.stagePrompt.trim()}`)
  }

  if (options.referenceNotes && options.referenceNotes.length > 0) {
    lines.push(`Planner notes: ${options.referenceNotes.join(' | ')}`)
  }

  if (options.upstreamStageLabels && options.upstreamStageLabels.length > 0) {
    lines.push(`Upstream stages: ${options.upstreamStageLabels.join(' -> ')}`)
  }

  if (typeof options.attachmentCount === 'number') {
    lines.push(`Input attachments: ${options.attachmentCount}`)
  }

  if (options.fallbackReason) {
    lines.push(`Fallback reason: ${options.fallbackReason}`)
  }

  return lines.join('\n')
}

export function dedupeCanvasTargetAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type CanvasTargetCanvasActionResult = {
  content: string
  attachments?: ChatAttachment[]
  canvasDispatchCount: number
  placedCanvasItemIds?: string[]
  placedCanvasItems?: CanvasItem[]
  affectedCanvasItemIds?: string[]
  fallbackReason?: string
}

export function buildCanvasTargetCanvasActionDisplayContent(
  action: CanvasTargetCanvasAction,
  result: CanvasTargetCanvasActionResult,
  isChineseUi: boolean
): string {
  if (!isChineseUi) return result.content

  if (result.fallbackReason) {
    return `Canvas action ${action.action} did not complete: ${result.fallbackReason}`
  }

  const placedCount = result.placedCanvasItemIds?.length ?? result.canvasDispatchCount
  const affectedCount = result.affectedCanvasItemIds?.length ?? result.canvasDispatchCount

  switch (action.action) {
    case 'duplicate_items':
      return `Copied ${placedCount} canvas item(s).`
    case 'arrange_items':
      return `Arranged ${affectedCount} canvas item(s).`
    case 'select_items':
      return `Selected ${affectedCount} canvas item(s).`
    case 'transform_items':
      return `Transformed ${affectedCount} canvas item(s).`
    case 'crop_image':
      return `Cropped ${affectedCount} image item(s).`
    case 'extract_image_region':
      return `Extracted ${placedCount} transparent image item(s).`
    case 'add_text':
      return `Added text to the canvas.${action.text ? `\n\n${action.text}` : ''}`
    case 'add_annotation':
      return `Added ${placedCount} annotation item(s) to the canvas.`
    case 'update_text':
      return `Updated ${affectedCount} text item(s).`
    case 'update_annotation':
      return `Updated ${affectedCount} annotation item(s).`
    case 'set_z_order':
      return `Changed z-order for ${affectedCount} canvas item(s).`
    case 'flip_items':
      return `Flipped ${affectedCount} canvas item(s).`
    case 'add_image':
      return 'Added an image to the canvas.'
    case 'add_video':
      return 'Added a video to the canvas.'
    case 'add_model3d':
      return 'Added a 3D model to the canvas.'
    case 'set_grid_visibility':
      return action.showGrid ? 'Canvas grid is now visible.' : 'Canvas grid is now hidden.'
    case 'set_canvas_background':
      return action.bgColor
        ? `Set canvas background to ${action.bgColor}.`
        : 'Updated canvas background.'
    case 'set_canvas_tool':
      return 'Updated canvas tool state.'
    case 'delete_items':
      return `Deleted ${affectedCount} canvas item(s).`
    case 'clear_canvas':
      return 'Cleared the canvas.'
    default:
      return result.content || `Canvas action ${action.action} executed.`
  }
}

export function describeCanvasTargetCapabilityAction(
  action: CanvasTargetCapabilityAction,
  isChineseUi: boolean
): string {
  void isChineseUi
  const label = action.label?.trim() || action.id
  const phase = action.phase || 'after_model_stages'
  if (action.type === 'quick_app') {
    return `QuickApp ${action.qAppKey}: ${label} (${phase})`
  }

  return `Canvas ${action.action}: ${label} (${phase})`
}

export function buildCanvasTargetExecutionPlanPreview(options: {
  controlPlan: CanvasTargetControlPlan
  controlModelLabel: string
  isChineseUi: boolean
}): string {
  const { controlPlan, controlModelLabel, isChineseUi } = options
  void isChineseUi
  const lines = [
    'Target execution plan',
    '',
    `1. Control model: ${controlModelLabel}, responsible for semantic planning and orchestration.`
  ]

  let stepIndex = 2
  for (const action of controlPlan.capabilityActions || []) {
    lines.push(`${stepIndex}. ${describeCanvasTargetCapabilityAction(action, isChineseUi)}`)
    stepIndex += 1
  }

  for (const stage of controlPlan.stageInstructions) {
    lines.push(`${stepIndex}. Auxiliary model ${stage.modelId}: ${stage.label}`)
    stepIndex += 1
  }

  lines.push(
    `${stepIndex}. Control model: inspect the final canvas evidence and execution journal for final acceptance; deliver Agent result files only when the target itself requires a document.`
  )
  lines.push('')
  lines.push(
    'Please confirm before execution. The software layer will only validate and execute these explicit actions; it will not infer target semantics locally.'
  )

  return lines.join('\n')
}
