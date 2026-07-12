export const PROJECT_TRACE_DIR_NAME = 'traces'
export const PROJECT_TRACE_MANIFEST_FILENAME = 'manifest.json'
export const PROJECT_TRACE_DOCUMENT_FILENAME = 'document.md'
export const PROJECT_TRACE_DOCUMENT_JSON_FILENAME = 'document.json'
export const PROJECT_TRACE_SKILL_SUMMARY_FILENAME = 'skill-summary.json'
export const PROJECT_TRACE_EXECUTABLE_RULES_FILENAME = 'executable-rules.json'
export const PROJECT_TRACE_REFERENCE_PACK_FILENAME = 'reference-pack.json'
export const PROJECT_TRACE_REDACTION_REPORT_FILENAME = 'redaction-report.json'
export const PROJECT_TRACE_EVENTS_SUMMARY_FILENAME = 'events.summary.jsonl'
export const PROJECT_TRACE_INTEGRITY_FILENAME = 'integrity.json'

import type { LLMReasoningEffort } from './llm'

export type ProjectTraceSourceKind =
  | 'manual'
  | 'canvas'
  | 'canvas_target'
  | 'quick_app'
  | 'agent'
  | 'imported'

export type ProjectTraceEventScope = 'canvas' | 'quick_app' | 'agent' | 'target' | 'system'

export type ProjectTraceEventStatus = 'success' | 'fallback' | 'warning' | 'error' | 'info'

export type ProjectTraceEventSummary = {
  id: string
  at: string
  scope: ProjectTraceEventScope
  action: string
  label?: string
  status: ProjectTraceEventStatus
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
}

export type ProjectTraceRedactionReport = {
  policyVersion: 1
  generatedAt: string
  containsSensitiveData: false
  removedFields: string[]
  replacementCount: number
  notes: string[]
}

export type ProjectTraceTrustLevel = 'builtin_preset' | 'local' | 'imported'

export type ProjectTraceTrust = {
  level: ProjectTraceTrustLevel
  origin: 'builtin' | 'local_project' | 'exported_bundle' | 'external_import'
  importedAt?: string
  signatureVerified?: boolean
}

export type ProjectTraceRuntimePolicy = {
  allowRealtime: boolean
  allowTargetReference: boolean
  allowModelReview: boolean
  allowTerminal: boolean
}

export type ProjectTraceLocalTrustReason =
  | 'trusted'
  | 'missing_local_trust'
  | 'content_changed'
  | 'project_mismatch'
  | 'runtime_disabled'

export type ProjectTraceLocalTrustStatus = {
  trusted: boolean
  reason: ProjectTraceLocalTrustReason
  trustedAt?: string
}

export type ProjectTraceManifest = {
  version: 1
  id: string
  name: string
  description?: string
  sourceKind: ProjectTraceSourceKind
  projectId?: string
  projectName?: string
  createdAt: string
  updatedAt: string
  tags: string[]
  eventCount: number
  trust?: ProjectTraceTrust
  runtimePolicy?: ProjectTraceRuntimePolicy
  files: {
    markdown: typeof PROJECT_TRACE_DOCUMENT_FILENAME
    documentJson?: typeof PROJECT_TRACE_DOCUMENT_JSON_FILENAME
    skillSummary?: typeof PROJECT_TRACE_SKILL_SUMMARY_FILENAME
    executableRules?: typeof PROJECT_TRACE_EXECUTABLE_RULES_FILENAME
    referencePack?: typeof PROJECT_TRACE_REFERENCE_PACK_FILENAME
    redactionReport: typeof PROJECT_TRACE_REDACTION_REPORT_FILENAME
    eventsSummary?: typeof PROJECT_TRACE_EVENTS_SUMMARY_FILENAME
    integrity?: typeof PROJECT_TRACE_INTEGRITY_FILENAME
  }
  redaction: {
    policyVersion: 1
    containsSensitiveData: false
    llmEnhanced: boolean
    llmProfileId?: string
    llmReasoningEffort?: LLMReasoningEffort
  }
}

export type ProjectTraceDocumentJson = {
  title: string
  summary: string
  sourceKind: ProjectTraceSourceKind
  sections: Array<{
    title: string
    items: string[]
  }>
  metadata?: Record<string, string | number | boolean | null | string[]>
}

export type ProjectTraceSkillSummary = {
  version: 1
  generatedAt: string
  summary: string
  applicableTo: string[]
  notes: string[]
  source: 'software' | 'model'
}

export type ProjectTraceExecutableRuleOperator = '>' | '>=' | '<' | '<=' | '='

export type ProjectTraceExecutableRuleType =
  | 'canvas.move.distance'
  | 'canvas.resize.scale'
  | 'canvas.rotate.angle'
  | 'canvas.delete.item'
  | 'canvas.layer.change'

export type ProjectTraceExecutableRuleUnit = 'px' | 'ratio' | 'deg' | 'count'

export type ProjectTraceExecutableRule = {
  id: string
  type: ProjectTraceExecutableRuleType
  target: 'image' | 'selected.image' | 'canvas_item' | 'selected.canvas_item'
  condition: {
    operator: ProjectTraceExecutableRuleOperator
    value: number
    unit: ProjectTraceExecutableRuleUnit
  }
  feedback: string
  mode: 'software' | 'model_review' | 'unsupported'
  source: 'trace_intent' | 'events' | 'model'
  confidence: number
}

export type ProjectTraceSemanticRule = {
  id: string
  requirement: string
  target?: string
  appliesTo: string[]
  feedback: string
  mode: 'model_review'
  source: 'trace_intent' | 'events' | 'model'
  confidence: number
}

export type ProjectTraceExecutableRulesDocument = {
  version: 1
  generatedAt: string
  rules: ProjectTraceExecutableRule[]
  semanticRules?: ProjectTraceSemanticRule[]
  unsupportedNotes: string[]
}

export type ProjectTraceReferencePack = {
  version: 1
  generatedAt: string
  traceId: string
  name: string
  description?: string
  sourceKind: ProjectTraceSourceKind
  tags: string[]
  trust: ProjectTraceTrust
  runtimePolicy: ProjectTraceRuntimePolicy
  budget: {
    maxChars: number
    contentBriefChars: number
    softwareRuleCount: number
    semanticRuleCount: number
  }
  contentBrief: string
  softwareRules: ProjectTraceExecutableRule[]
  semanticRules?: ProjectTraceSemanticRule[]
  unsupportedNotes: string[]
  safetyNotes: string[]
}

export type ProjectTraceDocument = {
  manifest: ProjectTraceManifest
  markdown: string
  documentJson?: ProjectTraceDocumentJson
  skillSummary?: ProjectTraceSkillSummary
  executableRules?: ProjectTraceExecutableRulesDocument
  referencePack?: ProjectTraceReferencePack
  redactionReport: ProjectTraceRedactionReport
  eventSummaries?: ProjectTraceEventSummary[]
}

export type ProjectTraceDocumentDraft = {
  id?: string
  name: string
  description?: string
  sourceKind: ProjectTraceSourceKind
  projectId?: string
  projectName?: string
  tags?: string[]
  markdown?: string
  documentJson?: ProjectTraceDocumentJson
  skillSummary?: ProjectTraceSkillSummary
  executableRules?: ProjectTraceExecutableRulesDocument
  eventSummaries?: ProjectTraceEventSummary[]
  llmEnhanced?: boolean
  llmProfileId?: string
  llmReasoningEffort?: LLMReasoningEffort
  trust?: ProjectTraceTrust
  runtimePolicy?: ProjectTraceRuntimePolicy
}

export type ProjectTraceDocumentSummary = {
  id: string
  name: string
  description?: string
  sourceKind: ProjectTraceSourceKind
  projectId?: string
  projectName?: string
  createdAt: string
  updatedAt: string
  tags: string[]
  eventCount: number
  sizeBytes: number
  storageRelativePath: string
  containsSensitiveData: false
  llmEnhanced: boolean
  trust?: ProjectTraceTrust
  runtimePolicy?: ProjectTraceRuntimePolicy
  localTrust?: ProjectTraceLocalTrustStatus
  referencePack?: ProjectTraceReferencePack
  skillSummary?: ProjectTraceSkillSummary
  executableRules?: ProjectTraceExecutableRulesDocument
}

export type ProjectTraceIntegrityFile = {
  path: string
  sha256: string
  sizeBytes: number
}

export type ProjectTraceIntegrityReport = {
  version: 1
  generatedAt: string
  algorithm: 'sha256'
  files: ProjectTraceIntegrityFile[]
}

export type ProjectTraceReference = {
  id: string
  name: string
  description?: string
  sourceKind: ProjectTraceSourceKind
  updatedAt: string
  contentPreview: string
  referencePack?: ProjectTraceReferencePack
  trust?: ProjectTraceTrust
  runtimePolicy?: ProjectTraceRuntimePolicy
  skillSummary?: ProjectTraceSkillSummary
  executableRules?: ProjectTraceExecutableRulesDocument
  eventCount: number
  tags: string[]
}

export type ProjectTraceProjectRef = {
  projectId: string
  projectName?: string
  projectStorageDirName?: string
  projectRootDir?: string
}

export type ProjectTraceRealtimeAnomalyKind =
  | 'repeated_fallback'
  | 'destructive_action'
  | 'stalled_flow'
  | 'trace_deviation'
  | 'unsafe_content'

export type ProjectTraceRealtimeAnomaly = {
  kind: ProjectTraceRealtimeAnomalyKind
  severity: 'info' | 'warning' | 'error'
  summary: string
  eventIds: string[]
}

export type ProjectTraceRealtimeAdvice = {
  id: string
  generatedAt: string
  traceIds: string[]
  anomalies: ProjectTraceRealtimeAnomaly[]
  advice: string
  modelProfileId?: string
}
