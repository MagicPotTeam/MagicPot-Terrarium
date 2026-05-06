import type {
  DesignInspectionApproval,
  DesignInspectionApprovalStatus,
  DesignInspectionAction,
  DesignInspectionArtifact,
  DesignInspectionContextPack,
  DesignInspectionDocumentSummary,
  DesignInspectionExecutionResult,
  DesignInspectionExecutionStatus,
  DesignInspectionFallbackSignal,
  DesignInspectionIssue,
  DesignInspectionItemSummary,
  DesignInspectionProposal,
  DesignInspectionReferenceSummary,
  DesignInspectionRuleSource,
  DesignInspectionTraceStage
} from '@shared/designInspection'

const TRACE_TEXT_LIMIT = 2000

export type DesignInspectionContextTraceSnapshot = {
  id: string
  createdAt: string
  task: string
  projectId?: string
  projectName?: string
  structureFirst: boolean
  selection: DesignInspectionContextPack['selection']
  selectionItems: DesignInspectionItemSummary[]
  canvasSnapshot: Pick<
    NonNullable<DesignInspectionContextPack['canvasSnapshot']>,
    'type' | 'label' | 'mimeType'
  > | null
  documents: DesignInspectionDocumentSummary[]
  references: DesignInspectionReferenceSummary[]
  rules: DesignInspectionRuleSource[]
  fallbackSignals: DesignInspectionFallbackSignal[]
}

export type DesignInspectionProposalTraceSnapshot = {
  id: string
  contextPackId: string
  generatedAt: string
  summary: string
  issues: DesignInspectionIssue[]
  actions: DesignInspectionAction[]
  rationale: string
  expectedResult: string
  executionPlan: DesignInspectionProposal['executionPlan']
}

export type DesignInspectionExecutionResultTraceSnapshot = {
  id: string
  contextPackId: string
  proposalId: string
  approvalId: string
  status: DesignInspectionExecutionStatus
  executor: DesignInspectionExecutionResult['executor']
  appliedChanges: DesignInspectionExecutionResult['appliedChanges']
  artifacts: DesignInspectionArtifact[]
  error?: string
  trace: DesignInspectionExecutionResult['trace']
}

export type HydratedDesignInspectionTraceSession = {
  sessionId: string
  targetItemIds: string[]
  contextPack: DesignInspectionContextPack
  proposal: DesignInspectionProposal
  approval: DesignInspectionApproval
  executionResult: DesignInspectionExecutionResult | null
  notes: string
  selectedActionIds: string[]
}

export type DesignInspectionTraceTimelineEntry = {
  at: string
  stage: DesignInspectionTraceStage
  message: string
  contextPackId?: string
  proposalId?: string
  approvalId?: string
  executionResultId?: string
  approvalStatus?: DesignInspectionApprovalStatus
  executionStatus?: DesignInspectionExecutionStatus
}

export type DesignInspectionTraceRecord = {
  sessionId: string
  createdAt: string
  updatedAt: string
  task: string
  selectionItemIds: string[]
  selectedActionIds: string[]
  issueCount: number
  actionCount: number
  approvedActionCount: number
  approvalStatus: DesignInspectionApprovalStatus
  executionStatus?: DesignInspectionExecutionStatus
  executor?: string
  summary: string
  proposalId: string
  contextPackId: string
  approvalId?: string
  executionResultId?: string
  notes?: string
  contextSnapshot: DesignInspectionContextTraceSnapshot
  proposalSnapshot: DesignInspectionProposalTraceSnapshot
  approvalSnapshot: DesignInspectionApproval
  executionResultSnapshot?: DesignInspectionExecutionResultTraceSnapshot | null
  timeline: DesignInspectionTraceTimelineEntry[]
}

const DESIGN_INSPECTION_TRACE_LIMIT = 20

type CreateDesignInspectionTraceRecordOptions = {
  sessionId: string
  contextPack: DesignInspectionContextPack
  proposal: DesignInspectionProposal
  approval: DesignInspectionApproval
  executionResult?: DesignInspectionExecutionResult | null
  selectedActionIds?: string[]
  notes?: string
}

export type RestoredDesignInspectionTraceSession = {
  contextPack: DesignInspectionContextPack
  proposal: DesignInspectionProposal
  approval: DesignInspectionApproval
  executionResult: DesignInspectionExecutionResult | null
  selectedActionIds: string[]
  notes: string
}

function truncateText(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= TRACE_TEXT_LIMIT) return value
  return `${value.slice(0, TRACE_TEXT_LIMIT)}...`
}

function snapshotArtifact(artifact: DesignInspectionArtifact): Pick<
  DesignInspectionArtifact,
  'type' | 'label' | 'mimeType'
> & {
  url?: string
  content?: string
} {
  return {
    type: artifact.type,
    label: artifact.label,
    mimeType: artifact.mimeType,
    url: truncateText(artifact.url),
    content: truncateText(artifact.content)
  }
}

function snapshotSelectionItem(item: DesignInspectionItemSummary): DesignInspectionItemSummary {
  return {
    ...item,
    textContent: truncateText(item.textContent),
    previewText: truncateText(item.previewText),
    provenance: item.provenance
      ? {
          ...item.provenance,
          notes: truncateText(item.provenance.notes)
        }
      : undefined
  }
}

function snapshotDocument(
  document: DesignInspectionDocumentSummary
): DesignInspectionDocumentSummary {
  return {
    ...document,
    previewText: truncateText(document.previewText) || ''
  }
}

function snapshotFallbackSignal(
  signal: DesignInspectionFallbackSignal
): DesignInspectionFallbackSignal {
  return {
    ...signal,
    content: truncateText(signal.content) || ''
  }
}

function snapshotRule(rule: DesignInspectionRuleSource): DesignInspectionRuleSource {
  return {
    ...rule,
    content: truncateText(rule.content) || ''
  }
}

function snapshotAction(action: DesignInspectionAction): DesignInspectionAction {
  if (action.type !== 'update-file-content') return action
  return {
    ...action,
    payload: {
      content: truncateText(action.payload.content) || ''
    }
  }
}

function snapshotContextPack(
  contextPack: DesignInspectionContextPack
): DesignInspectionContextTraceSnapshot {
  return {
    id: contextPack.id,
    createdAt: contextPack.createdAt,
    task: truncateText(contextPack.task) || '',
    projectId: contextPack.projectId,
    projectName: contextPack.projectName,
    structureFirst: contextPack.structureFirst,
    selection: contextPack.selection,
    selectionItems: contextPack.selectionItems.map(snapshotSelectionItem),
    canvasSnapshot: contextPack.canvasSnapshot
      ? {
          type: contextPack.canvasSnapshot.type,
          label: contextPack.canvasSnapshot.label,
          mimeType: contextPack.canvasSnapshot.mimeType
        }
      : null,
    documents: contextPack.documents.map(snapshotDocument),
    references: contextPack.references.map((reference) => ({
      ...reference,
      detail: truncateText(reference.detail)
    })),
    rules: contextPack.rules.map(snapshotRule),
    fallbackSignals: contextPack.fallbackSignals.map(snapshotFallbackSignal)
  }
}

function snapshotProposal(
  proposal: DesignInspectionProposal
): DesignInspectionProposalTraceSnapshot {
  return {
    id: proposal.id,
    contextPackId: proposal.contextPackId,
    generatedAt: proposal.generatedAt,
    summary: truncateText(proposal.summary) || '',
    issues: proposal.issues.map((issue) => ({
      ...issue,
      title: truncateText(issue.title) || '',
      summary: truncateText(issue.summary) || '',
      evidence: issue.evidence.map((entry) => truncateText(entry) || '')
    })),
    actions: proposal.actions.map(snapshotAction),
    rationale: truncateText(proposal.rationale) || '',
    expectedResult: truncateText(proposal.expectedResult) || '',
    executionPlan: proposal.executionPlan.map((step) => ({
      ...step,
      description: truncateText(step.description) || ''
    }))
  }
}

function snapshotExecutionResult(
  executionResult: DesignInspectionExecutionResult
): DesignInspectionExecutionResultTraceSnapshot {
  return {
    id: executionResult.id,
    contextPackId: executionResult.contextPackId,
    proposalId: executionResult.proposalId,
    approvalId: executionResult.approvalId,
    status: executionResult.status,
    executor: executionResult.executor,
    appliedChanges: executionResult.appliedChanges.map((change) => ({
      ...change,
      description: truncateText(change.description) || ''
    })),
    artifacts: executionResult.artifacts.map(snapshotArtifact),
    error: truncateText(executionResult.error),
    trace: executionResult.trace.map((entry) => ({
      ...entry,
      message: truncateText(entry.message) || ''
    }))
  }
}

function formatApprovalStatusSummary(status: DesignInspectionApprovalStatus): string {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'retry_requested':
      return 'retry requested'
    default:
      return 'pending'
  }
}

function formatExecutionStatusSummary(status: DesignInspectionExecutionStatus): string {
  switch (status) {
    case 'success':
      return 'completed'
    case 'partial':
      return 'partially completed'
    case 'failed':
      return 'failed'
    default:
      return status
  }
}

function compareTimelineEntries(
  left: DesignInspectionTraceTimelineEntry,
  right: DesignInspectionTraceTimelineEntry
): number {
  const leftTime = new Date(left.at).getTime()
  const rightTime = new Date(right.at).getTime()

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return 0
}

function getTimelineEntryKey(entry: DesignInspectionTraceTimelineEntry): string {
  return [
    entry.at,
    entry.stage,
    entry.message,
    entry.contextPackId ?? '',
    entry.proposalId ?? '',
    entry.approvalId ?? '',
    entry.executionResultId ?? '',
    entry.approvalStatus ?? '',
    entry.executionStatus ?? ''
  ].join('::')
}

function dedupeTimelineEntries(
  entries: DesignInspectionTraceTimelineEntry[]
): DesignInspectionTraceTimelineEntry[] {
  const seen = new Set<string>()
  const nextEntries: DesignInspectionTraceTimelineEntry[] = []

  for (const entry of [...entries].sort(compareTimelineEntries)) {
    const key = getTimelineEntryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    nextEntries.push(entry)
  }

  return nextEntries
}

function buildTraceTimelineEntries(options: {
  contextPack: Pick<DesignInspectionContextPack, 'id' | 'createdAt' | 'selection'>
  proposal: Pick<DesignInspectionProposal, 'id' | 'generatedAt' | 'issues' | 'actions'>
  approval: Pick<
    DesignInspectionApproval,
    'id' | 'createdAt' | 'updatedAt' | 'status' | 'approvedActions'
  >
  executionResult?: Pick<
    DesignInspectionExecutionResultTraceSnapshot,
    'id' | 'status' | 'trace'
  > | null
}): DesignInspectionTraceTimelineEntry[] {
  const { contextPack, proposal, approval, executionResult } = options
  const entries: DesignInspectionTraceTimelineEntry[] = [
    {
      at: contextPack.createdAt,
      stage: 'context_pack_built',
      message: `Captured context for ${contextPack.selection.itemIds.length} selected item(s).`,
      contextPackId: contextPack.id
    },
    {
      at: proposal.generatedAt,
      stage: 'proposal_generated',
      message: `Generated proposal with ${proposal.issues.length} issue(s) and ${proposal.actions.length} action(s).`,
      contextPackId: contextPack.id,
      proposalId: proposal.id
    },
    {
      at: approval.updatedAt || approval.createdAt,
      stage: 'approval_recorded',
      message:
        `Approval status updated to ${formatApprovalStatusSummary(approval.status)}` +
        ` for ${approval.approvedActions.length} action(s).`,
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      approvalId: approval.id,
      approvalStatus: approval.status
    }
  ]

  if (executionResult?.trace?.length) {
    entries.push(
      ...executionResult.trace.map((entry) => ({
        at: entry.at,
        stage: entry.stage,
        message: entry.message,
        contextPackId: contextPack.id,
        proposalId: proposal.id,
        approvalId: approval.id,
        executionResultId: executionResult.id,
        approvalStatus: entry.stage === 'approval_recorded' ? approval.status : undefined,
        executionStatus: entry.stage === 'execution_applied' ? executionResult.status : undefined
      }))
    )
  } else if (executionResult) {
    entries.push({
      at: approval.updatedAt || approval.createdAt,
      stage: 'execution_applied',
      message: `Execution ${formatExecutionStatusSummary(executionResult.status)}.`,
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      approvalId: approval.id,
      executionResultId: executionResult.id,
      executionStatus: executionResult.status
    })
  }

  return dedupeTimelineEntries(entries)
}

function normalizeSelectedActionIds(
  selectedActionIds: string[] | undefined,
  proposalActions: Array<{ id: string }>,
  approvedActions?: string[]
): string[] {
  const proposalActionIds = proposalActions.map((action) => action.id)

  if (Array.isArray(selectedActionIds)) {
    return proposalActionIds.filter((actionId) => selectedActionIds.includes(actionId))
  }

  if (Array.isArray(approvedActions) && approvedActions.length > 0) {
    return proposalActionIds.filter((actionId) => approvedActions.includes(actionId))
  }

  return proposalActionIds
}

function normalizeTraceRecord(record: DesignInspectionTraceRecord): DesignInspectionTraceRecord {
  const timeline = Array.isArray(record.timeline)
    ? dedupeTimelineEntries(record.timeline)
    : buildTraceTimelineEntries({
        contextPack: record.contextSnapshot,
        proposal: record.proposalSnapshot,
        approval: record.approvalSnapshot,
        executionResult: record.executionResultSnapshot
      })

  return {
    ...record,
    selectedActionIds: normalizeSelectedActionIds(
      Array.isArray(record.selectedActionIds) ? record.selectedActionIds : undefined,
      record.proposalSnapshot.actions,
      record.approvalSnapshot.approvedActions
    ),
    timeline
  }
}

function getDesignInspectionTraceStorageKey(canvasId: string): string {
  return `canvas.designInspectionTrace.${canvasId}`
}

function formatExecutionStatusLabel(status: DesignInspectionExecutionStatus): string {
  switch (status) {
    case 'success':
      return '已完成'
    case 'partial':
      return '部分完成'
    case 'failed':
      return '失败'
    default:
      return status
  }
}

function readTraceRecords(canvasId: string): DesignInspectionTraceRecord[] {
  try {
    const raw = localStorage.getItem(getDesignInspectionTraceStorageKey(canvasId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as DesignInspectionTraceRecord[]).map(normalizeTraceRecord)
      : []
  } catch {
    return []
  }
}

export function listDesignInspectionTraceRecords(canvasId: string): DesignInspectionTraceRecord[] {
  return readTraceRecords(canvasId)
}

export function createDesignInspectionTraceRecord({
  sessionId,
  contextPack,
  proposal,
  approval,
  executionResult,
  selectedActionIds,
  notes
}: CreateDesignInspectionTraceRecordOptions): DesignInspectionTraceRecord {
  const nextSelectedActionIds = normalizeSelectedActionIds(
    selectedActionIds,
    proposal.actions,
    approval.approvedActions
  )

  return {
    sessionId,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    task: truncateText(contextPack.task) || '',
    selectionItemIds: contextPack.selection.itemIds,
    selectedActionIds: nextSelectedActionIds,
    issueCount: proposal.issues.length,
    actionCount: proposal.actions.length,
    approvedActionCount: approval.approvedActions.length,
    approvalStatus: approval.status,
    executionStatus: executionResult?.status,
    executor: executionResult?.executor,
    summary: executionResult
      ? `执行结果：${formatExecutionStatusLabel(executionResult.status)}，已应用 ${executionResult.appliedChanges.length} 项修改。`
      : truncateText(proposal.summary) || '',
    proposalId: proposal.id,
    contextPackId: contextPack.id,
    approvalId: approval.id,
    executionResultId: executionResult?.id,
    notes: truncateText(notes?.trim()),
    contextSnapshot: snapshotContextPack(contextPack),
    proposalSnapshot: snapshotProposal(proposal),
    approvalSnapshot: approval,
    executionResultSnapshot: executionResult ? snapshotExecutionResult(executionResult) : null,
    timeline: buildTraceTimelineEntries({
      contextPack,
      proposal,
      approval,
      executionResult: executionResult ? snapshotExecutionResult(executionResult) : null
    })
  }
}

export function restoreDesignInspectionTraceRecord(
  record: DesignInspectionTraceRecord
): RestoredDesignInspectionTraceSession {
  return {
    contextPack: {
      ...record.contextSnapshot
    },
    proposal: {
      ...record.proposalSnapshot
    },
    approval: {
      ...record.approvalSnapshot
    },
    executionResult: record.executionResultSnapshot
      ? {
          ...record.executionResultSnapshot
        }
      : null,
    selectedActionIds: normalizeSelectedActionIds(
      Array.isArray(record.selectedActionIds) ? record.selectedActionIds : undefined,
      record.proposalSnapshot.actions,
      record.approvalSnapshot.approvedActions
    ),
    notes: record.notes || record.approvalSnapshot.userNotes || ''
  }
}

export function hydrateDesignInspectionTraceSession(
  record: DesignInspectionTraceRecord
): HydratedDesignInspectionTraceSession {
  const selectedActionIds = normalizeSelectedActionIds(
    Array.isArray(record.selectedActionIds) ? record.selectedActionIds : undefined,
    record.proposalSnapshot.actions,
    record.approvalSnapshot.approvedActions
  )

  return {
    sessionId: record.sessionId,
    targetItemIds: [...record.selectionItemIds],
    contextPack: {
      ...record.contextSnapshot,
      canvasSnapshot: record.contextSnapshot.canvasSnapshot
        ? {
            ...record.contextSnapshot.canvasSnapshot
          }
        : null
    },
    proposal: {
      ...record.proposalSnapshot
    },
    approval: {
      ...record.approvalSnapshot
    },
    executionResult: record.executionResultSnapshot
      ? {
          ...record.executionResultSnapshot
        }
      : null,
    notes: record.notes || record.approvalSnapshot.userNotes || '',
    selectedActionIds
  }
}

export function upsertDesignInspectionTraceRecord(
  canvasId: string,
  record: DesignInspectionTraceRecord
): DesignInspectionTraceRecord[] {
  const existing = readTraceRecords(canvasId)
  const normalizedRecord = normalizeTraceRecord(record)
  const previousRecord = existing.find((entry) => entry.sessionId === normalizedRecord.sessionId)
  const mergedRecord = previousRecord
    ? {
        ...normalizedRecord,
        createdAt: previousRecord.createdAt,
        timeline: dedupeTimelineEntries([...previousRecord.timeline, ...normalizedRecord.timeline])
      }
    : normalizedRecord
  const nextRecords = existing.filter((entry) => entry.sessionId !== record.sessionId)
  nextRecords.unshift(mergedRecord)
  const limitedRecords = nextRecords.slice(0, DESIGN_INSPECTION_TRACE_LIMIT)
  localStorage.setItem(getDesignInspectionTraceStorageKey(canvasId), JSON.stringify(limitedRecords))
  return limitedRecords
}

export function removeDesignInspectionTraceRecord(
  canvasId: string,
  sessionId: string
): DesignInspectionTraceRecord[] {
  const existing = readTraceRecords(canvasId)
  const nextRecords = existing.filter((entry) => entry.sessionId !== sessionId)
  const storageKey = getDesignInspectionTraceStorageKey(canvasId)

  if (nextRecords.length > 0) {
    localStorage.setItem(storageKey, JSON.stringify(nextRecords))
  } else {
    localStorage.removeItem(storageKey)
  }

  return nextRecords
}
