import type { GenerationTaskPack, GenerationRouteChoice } from './canvasGenerationTaskPack'

// ─── Generation Trace Types ───

export type GenerationTraceStage =
  | 'task_pack_built'
  | 'route_selected'
  | 'generation_started'
  | 'generation_completed'
  | 'candidate_returned'
  | 'user_approved'
  | 'user_retried'
  | 'user_refined'
  | 'user_discarded'

export type GenerationTraceCandidateEntry = {
  id: string
  canvasItemId?: string
  fileName?: string
  src?: string
  thumbnailSrc?: string
  generatedAt: string
}

export type GenerationTraceTimelineEntry = {
  at: string
  stage: GenerationTraceStage
  message: string
}

export type GenerationTraceRecord = {
  sessionId: string
  createdAt: string
  updatedAt: string
  projectId: string
  projectName: string
  agentScope?: string
  agentSessionKey?: string
  selectedItemIds: string[]
  routeChoice: GenerationRouteChoice
  taskPackSnapshot: GenerationTaskPackSnapshot
  candidates: GenerationTraceCandidateEntry[]
  userDecision: 'pending' | 'approved' | 'retried' | 'refined' | 'discarded'
  followUpSessionId?: string
  notes?: string
  timeline: GenerationTraceTimelineEntry[]
}

export type GenerationTaskPackSnapshot = {
  summary: GenerationTaskPack['summary']
  requirementDocTitles: string[]
  referenceDocTitles: string[]
  referenceImageCount: number
  styleReferenceImageCount: number
  taskNoteTitles: string[]
  existingAssetTitles: string[]
}

// ─── Constants ───

const GENERATION_TRACE_LIMIT = 30
const TRACE_TEXT_LIMIT = 2000
const STORAGE_KEY_PREFIX = 'canvas.generationTrace.'

// ─── Internal helpers ───

function truncateText(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= TRACE_TEXT_LIMIT) return value
  return `${value.slice(0, TRACE_TEXT_LIMIT)}...`
}

function getStorageKey(canvasId: string): string {
  return `${STORAGE_KEY_PREFIX}${canvasId}`
}

function readTraceRecords(canvasId: string): GenerationTraceRecord[] {
  try {
    const raw = localStorage.getItem(getStorageKey(canvasId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as GenerationTraceRecord[]) : []
  } catch {
    return []
  }
}

function dedupeTimelineEntries(
  entries: GenerationTraceTimelineEntry[]
): GenerationTraceTimelineEntry[] {
  const seen = new Set<string>()
  const result: GenerationTraceTimelineEntry[] = []

  for (const entry of [...entries].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
  )) {
    const key = `${entry.at}::${entry.stage}::${entry.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }

  return result
}

// ─── Public API ───

export function snapshotTaskPack(taskPack: GenerationTaskPack): GenerationTaskPackSnapshot {
  return {
    summary: { ...taskPack.summary },
    requirementDocTitles: taskPack.requirementDocs.map((d) => d.title),
    referenceDocTitles: taskPack.referenceDocs.map((d) => d.title),
    referenceImageCount: taskPack.referenceImages.length,
    styleReferenceImageCount: taskPack.styleReferenceImages.length,
    taskNoteTitles: taskPack.taskNotes.map((n) => truncateText(n.title) || n.id),
    existingAssetTitles: taskPack.existingAssets.map((a) => a.title)
  }
}

export type CreateGenerationTraceRecordOptions = {
  sessionId: string
  projectId: string
  projectName: string
  agentScope?: string
  agentSessionKey?: string
  selectedItemIds: string[]
  routeChoice: GenerationRouteChoice
  taskPack: GenerationTaskPack
  notes?: string
}

export function createGenerationTraceRecord(
  options: CreateGenerationTraceRecordOptions
): GenerationTraceRecord {
  const now = new Date().toISOString()

  const routeMessage =
    options.routeChoice.type === 'project-style-model'
      ? `选择了项目模型「${options.routeChoice.modelLabel}」`
      : '使用默认 Agent 生成（当前项目没有可用模型）'

  return {
    sessionId: options.sessionId,
    createdAt: now,
    updatedAt: now,
    projectId: options.projectId,
    projectName: options.projectName,
    agentScope: truncateText(options.agentScope),
    agentSessionKey: truncateText(options.agentSessionKey),
    selectedItemIds: [...options.selectedItemIds],
    routeChoice: { ...options.routeChoice },
    taskPackSnapshot: snapshotTaskPack(options.taskPack),
    candidates: [],
    userDecision: 'pending',
    notes: truncateText(options.notes),
    timeline: dedupeTimelineEntries([
      {
        at: now,
        stage: 'task_pack_built',
        message: `构建了包含 ${options.taskPack.summary.totalItems} 项的出图任务包`
      },
      {
        at: now,
        stage: 'route_selected',
        message: routeMessage
      }
    ])
  }
}

export function addCandidateToTraceRecord(
  record: GenerationTraceRecord,
  candidate: GenerationTraceCandidateEntry
): GenerationTraceRecord {
  const now = new Date().toISOString()
  return {
    ...record,
    updatedAt: now,
    candidates: [...record.candidates, { ...candidate }],
    timeline: dedupeTimelineEntries([
      ...record.timeline,
      {
        at: now,
        stage: 'candidate_returned',
        message: `收到候选图：${candidate.fileName || candidate.id}`
      }
    ])
  }
}

export function updateTraceUserDecision(
  record: GenerationTraceRecord,
  decision: GenerationTraceRecord['userDecision'],
  followUpSessionId?: string,
  notes?: string
): GenerationTraceRecord {
  const now = new Date().toISOString()

  const stageMap: Record<typeof decision, GenerationTraceStage> = {
    pending: 'generation_started',
    approved: 'user_approved',
    retried: 'user_retried',
    refined: 'user_refined',
    discarded: 'user_discarded'
  }

  const messageMap: Record<typeof decision, string> = {
    pending: '任务进行中',
    approved: '用户采纳了本轮候选图',
    retried: '用户要求重新生成',
    refined: '用户在本轮基础上追加了细化要求',
    discarded: '用户放弃了本轮候选图'
  }

  return {
    ...record,
    updatedAt: now,
    userDecision: decision,
    followUpSessionId: followUpSessionId || record.followUpSessionId,
    notes: truncateText(notes) || record.notes,
    timeline: dedupeTimelineEntries([
      ...record.timeline,
      {
        at: now,
        stage: stageMap[decision],
        message: messageMap[decision]
      }
    ])
  }
}

export function listGenerationTraceRecords(canvasId: string): GenerationTraceRecord[] {
  return readTraceRecords(canvasId)
}

export function upsertGenerationTraceRecord(
  canvasId: string,
  record: GenerationTraceRecord
): GenerationTraceRecord[] {
  const existing = readTraceRecords(canvasId)
  const previousRecord = existing.find((entry) => entry.sessionId === record.sessionId)
  const mergedRecord = previousRecord
    ? {
        ...record,
        createdAt: previousRecord.createdAt,
        timeline: dedupeTimelineEntries([...previousRecord.timeline, ...record.timeline])
      }
    : record
  const nextRecords = existing.filter((entry) => entry.sessionId !== record.sessionId)
  nextRecords.unshift(mergedRecord)
  const limitedRecords = nextRecords.slice(0, GENERATION_TRACE_LIMIT)
  localStorage.setItem(getStorageKey(canvasId), JSON.stringify(limitedRecords))
  return limitedRecords
}

export function removeGenerationTraceRecord(
  canvasId: string,
  sessionId: string
): GenerationTraceRecord[] {
  const existing = readTraceRecords(canvasId)
  const nextRecords = existing.filter((entry) => entry.sessionId !== sessionId)
  const storageKey = getStorageKey(canvasId)

  if (nextRecords.length > 0) {
    localStorage.setItem(storageKey, JSON.stringify(nextRecords))
  } else {
    localStorage.removeItem(storageKey)
  }

  return nextRecords
}
