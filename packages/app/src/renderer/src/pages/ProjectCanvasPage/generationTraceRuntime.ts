import type { GenerationRouteChoice, GenerationTaskPack } from './canvasGenerationTaskPack'
import {
  addCandidateToTraceRecord,
  createGenerationTraceRecord,
  listGenerationTraceRecords,
  updateTraceUserDecision,
  upsertGenerationTraceRecord,
  type GenerationTraceCandidateEntry,
  type GenerationTraceRecord
} from './generationTraceStorage'
import { createTimestampedSecureId } from './secureId'

export function createGenerationTraceSessionId(): string {
  return createTimestampedSecureId('generation')
}

type BeginGenerationTraceSessionOptions = {
  canvasId: string
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

export function beginGenerationTraceSession(
  options: BeginGenerationTraceSessionOptions
): GenerationTraceRecord {
  const record = createGenerationTraceRecord({
    sessionId: options.sessionId,
    projectId: options.projectId,
    projectName: options.projectName,
    agentScope: options.agentScope,
    agentSessionKey: options.agentSessionKey,
    selectedItemIds: options.selectedItemIds,
    routeChoice: options.routeChoice,
    taskPack: options.taskPack,
    notes: options.notes
  })
  const startedRecord = updateTraceUserDecision(record, 'pending', undefined, options.notes)
  upsertGenerationTraceRecord(options.canvasId, startedRecord)
  return startedRecord
}

type AppendGenerationTraceCandidateOptions = {
  canvasId: string
  sessionId?: string | null
  candidate: Omit<GenerationTraceCandidateEntry, 'id' | 'generatedAt'> & {
    id?: string
    generatedAt?: string
  }
}

export function appendGenerationTraceCandidate(
  options: AppendGenerationTraceCandidateOptions
): GenerationTraceRecord | null {
  const sessionId = options.sessionId?.trim()
  if (!sessionId) return null

  const targetRecord = listGenerationTraceRecords(options.canvasId).find(
    (record) => record.sessionId === sessionId
  )
  if (!targetRecord) return null

  const candidate: GenerationTraceCandidateEntry = {
    id:
      options.candidate.id?.trim() ||
      options.candidate.canvasItemId?.trim() ||
      createTimestampedSecureId('candidate'),
    canvasItemId: options.candidate.canvasItemId,
    fileName: options.candidate.fileName,
    src: options.candidate.src,
    thumbnailSrc: options.candidate.thumbnailSrc,
    generatedAt: options.candidate.generatedAt || new Date().toISOString()
  }

  const updatedRecord = addCandidateToTraceRecord(targetRecord, candidate)
  upsertGenerationTraceRecord(options.canvasId, updatedRecord)
  return updatedRecord
}
