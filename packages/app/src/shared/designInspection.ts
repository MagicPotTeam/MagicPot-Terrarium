export type DesignInspectionIssueCategory =
  | 'typography'
  | 'spacing'
  | 'radius'
  | 'alignment'
  | 'geometry'
  | 'content'

export type DesignInspectionSeverity = 'info' | 'warning' | 'error'

export type DesignInspectionExecutor =
  | 'magicpot-internal'
  | 'photoshop'
  | 'adobe-bridge'
  | 'dcc-bridge'

export type DesignInspectionApprovalStatus = 'pending' | 'approved' | 'rejected' | 'retry_requested'

export type DesignInspectionExecutionStatus = 'success' | 'partial' | 'failed'

export type DesignInspectionTraceStage =
  | 'context_pack_built'
  | 'proposal_generated'
  | 'approval_recorded'
  | 'execution_applied'

export type DesignInspectionActionType =
  | 'align-top'
  | 'align-bottom'
  | 'align-left'
  | 'align-right'
  | 'align-center'
  | 'align-middle'
  | 'shift-horizontal'
  | 'distribute-horizontal-spacing'
  | 'distribute-vertical-spacing'
  | 'normalize-annotation-corner-style'
  | 'normalize-corner-radius'
  | 'normalize-item-height'
  | 'normalize-item-width'
  | 'normalize-item-size'
  | 'normalize-text-style'
  | 'update-file-content'

export interface DesignInspectionSelectionBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesignInspectionSelection {
  itemIds: string[]
  groupIds: string[]
  bounds: DesignInspectionSelectionBounds | null
}

export type DesignInspectionItemProvenanceKind =
  | 'magicpot-native'
  | 'figma'
  | 'psd'
  | 'psb'
  | 'svg'
  | 'imported-file'
  | 'external'

export interface DesignInspectionItemProvenance {
  kind: DesignInspectionItemProvenanceKind
  sourceFileName?: string
  sourceDocumentId?: string
  sourceNodeId?: string
  sourceNodeName?: string
  bridgeTraceId?: string
  notes?: string
}

export interface DesignInspectionItemSummary {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  locked: boolean
  bounds: DesignInspectionSelectionBounds
  textContent?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  fill?: string
  stroke?: string
  label?: string
  shape?: string
  fileName?: string
  mimeType?: string
  previewText?: string
  provenance?: DesignInspectionItemProvenance
}

export interface DesignInspectionDocumentSummary {
  itemId: string
  fileName: string
  mimeType: string
  editable: boolean
  previewText: string
}

export interface DesignInspectionReferenceSummary {
  itemId: string
  type: 'image' | 'video' | 'model3d' | 'group'
  label: string
  detail?: string
}

export interface DesignInspectionRuleSource {
  source: string
  content: string
}

export interface DesignInspectionFallbackSignal {
  type: 'snapshot' | 'geometry-measurement' | 'document-summary' | 'selection-text'
  label: string
  content: string
}

export interface DesignInspectionArtifact {
  type: 'image' | 'file' | 'json' | 'text'
  label: string
  mimeType?: string
  url?: string
  content?: string
}

export interface DesignInspectionContextPack {
  id: string
  createdAt: string
  task: string
  projectId?: string
  projectName?: string
  structureFirst: boolean
  selection: DesignInspectionSelection
  selectionItems: DesignInspectionItemSummary[]
  canvasSnapshot: DesignInspectionArtifact | null
  documents: DesignInspectionDocumentSummary[]
  references: DesignInspectionReferenceSummary[]
  rules: DesignInspectionRuleSource[]
  fallbackSignals: DesignInspectionFallbackSignal[]
}

export interface DesignInspectionIssue {
  id: string
  category: DesignInspectionIssueCategory
  severity: DesignInspectionSeverity
  title: string
  summary: string
  itemIds: string[]
  evidence: string[]
  actionIds: string[]
}

interface DesignInspectionBaseAction<TType extends DesignInspectionActionType, TPayload> {
  id: string
  type: TType
  title: string
  description: string
  executor: DesignInspectionExecutor
  targetItemIds: string[]
  payload: TPayload
  expectedImpact: string
}

export type DesignInspectionAction =
  | DesignInspectionBaseAction<'align-top', { y: number }>
  | DesignInspectionBaseAction<'align-bottom', { y: number }>
  | DesignInspectionBaseAction<'align-left', { x: number }>
  | DesignInspectionBaseAction<'align-right', { x: number }>
  | DesignInspectionBaseAction<'align-center', { centerX: number }>
  | DesignInspectionBaseAction<'align-middle', { centerY: number }>
  | DesignInspectionBaseAction<'shift-horizontal', { deltaX: number }>
  | DesignInspectionBaseAction<
      'distribute-horizontal-spacing',
      { gap: number; anchorItemId: string }
    >
  | DesignInspectionBaseAction<'distribute-vertical-spacing', { gap: number; anchorItemId: string }>
  | DesignInspectionBaseAction<
      'normalize-annotation-corner-style',
      { shape: 'rect' | 'rounded-rect' }
    >
  | DesignInspectionBaseAction<'normalize-corner-radius', { radius: number }>
  | DesignInspectionBaseAction<'normalize-item-height', { height: number }>
  | DesignInspectionBaseAction<'normalize-item-width', { width: number }>
  | DesignInspectionBaseAction<'normalize-item-size', { width: number; height: number }>
  | DesignInspectionBaseAction<
      'normalize-text-style',
      {
        fontSize?: number
        fontFamily?: string
        fontWeight?: 'normal' | 'bold'
        fill?: string
      }
    >
  | DesignInspectionBaseAction<'update-file-content', { content: string }>

export interface DesignInspectionExecutionPlanStep {
  step: number
  executor: DesignInspectionExecutor
  actionIds: string[]
  description: string
}

export interface DesignInspectionProposal {
  id: string
  contextPackId: string
  generatedAt: string
  summary: string
  issues: DesignInspectionIssue[]
  actions: DesignInspectionAction[]
  rationale: string
  expectedResult: string
  executionPlan: DesignInspectionExecutionPlanStep[]
}

export interface DesignInspectionApproval {
  id: string
  contextPackId: string
  proposalId: string
  status: DesignInspectionApprovalStatus
  approvedActions: string[]
  userNotes: string
  createdAt: string
  updatedAt: string
}

export interface DesignInspectionAppliedChange {
  itemId: string
  field: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  description: string
}

export interface DesignInspectionTraceEntry {
  at: string
  stage: DesignInspectionTraceStage
  message: string
}

export interface DesignInspectionExecutionResult {
  id: string
  contextPackId: string
  proposalId: string
  approvalId: string
  status: DesignInspectionExecutionStatus
  executor: DesignInspectionExecutor
  appliedChanges: DesignInspectionAppliedChange[]
  artifacts: DesignInspectionArtifact[]
  error?: string
  trace: DesignInspectionTraceEntry[]
}
