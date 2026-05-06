import type { ChatAttachment, OCRResult } from './api/svcLLMProxy'
import type { ProjectTraceReference } from './projectTrace'
import type { TargetScheme, TargetSchemeFile } from './targetScheme'
import type { DesignInspectionArtifact, DesignInspectionContextPack } from './designInspection'

export type CanvasTargetAssetType =
  | 'image'
  | 'video'
  | 'model3d'
  | 'file'
  | 'text'
  | 'annotation'
  | 'html'
  | 'unknown'

export type CanvasTargetAssetMetadata = {
  itemId: string
  type: CanvasTargetAssetType
  fileName?: string
  originalFileName?: string
  mimeType?: string
  sizeBytes?: number
  sourceWidth?: number
  sourceHeight?: number
  sourceAspectRatio?: number
  fileKind?: string
  promptId?: string
  sourceUrl?: string
  previewText?: string
  textContent?: string
  textures?: string[]
  previewImageCount?: number
  provenance?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export type CanvasTargetRawScene = {
  items: Record<string, unknown>[]
  groups: Record<string, unknown>[]
}

export type CanvasTargetEvidenceMode = 'structured_only' | 'selection_region' | 'selected_sources'

export type CanvasTargetEvidencePolicy = {
  mode: CanvasTargetEvidenceMode
  label: string
  tokenCost: 'low' | 'medium' | 'high'
  includeSelectionSnapshot: boolean
  includeSelectedSourceAssets: boolean
  privacyBoundary: string
}

export type CanvasTargetContextPack = {
  id: string
  createdAt: string
  projectId?: string
  projectName?: string
  task: string
  scheme: Pick<TargetScheme, 'id' | 'name' | 'description'>
  schemeFiles: TargetSchemeFile[]
  traceReferences?: ProjectTraceReference[]
  designContext: DesignInspectionContextPack
  rawScene: CanvasTargetRawScene
  assetMetadata: CanvasTargetAssetMetadata[]
  canvasSnapshot: DesignInspectionArtifact | null
  evidencePolicy?: CanvasTargetEvidencePolicy
}

export type CanvasTargetFindingSeverity = 'info' | 'warning' | 'error'

export type CanvasTargetFindingCategory =
  | 'layout'
  | 'visual'
  | 'content'
  | 'consistency'
  | 'usability'
  | 'accessibility'
  | 'other'

export type CanvasTargetFinding = {
  id: string
  title: string
  summary: string
  severity: CanvasTargetFindingSeverity
  category: CanvasTargetFindingCategory
  itemIds: string[]
  evidence: string[]
  suggestions: string[]
  sourceStageId?: string
  sourceStageLabel?: string
  sourceModelId?: string
}

export type CanvasTargetReportStageKind =
  | 'preferred-agent'
  | 'default-vision'
  | 'structured'
  | 'control-plan'
  | 'quick-app'
  | 'canvas-action'
  | 'model-check'
  | 'control-summary'

export type CanvasTargetReportStageStatus = 'success' | 'fallback'

export type CanvasTargetReportStage = {
  id: string
  kind: CanvasTargetReportStageKind
  label: string
  status: CanvasTargetReportStageStatus
  modelId?: string
  displayModelLabel?: string
  summary: string
  overview: string
  findings: CanvasTargetFinding[]
  upstreamStageIds?: string[]
  inputSourceAttachments?: ChatAttachment[]
  responseContent?: string
  responseAttachments?: ChatAttachment[]
  responseOcrResult?: OCRResult
  rawResponse?: string
  fallbackReason?: string
  inputCanvasVersion?: number
  outputCanvasVersion?: number
  executionJournalIndex?: number
}

export type CanvasTargetReport = {
  id: string
  contextPackId: string
  generatedAt: string
  modelId?: string
  summary: string
  overview: string
  findings: CanvasTargetFinding[]
  stages?: CanvasTargetReportStage[]
  rawResponse?: string
  fallbackReason?: string
}
