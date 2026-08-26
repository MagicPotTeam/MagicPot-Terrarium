import type { Workflow } from '@shared/comfy/types'
import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ComfyBatchProfile = {
  id: string
  baseUrl: string
  enabled: boolean
  /** Number of prompts ComfyUI may execute concurrently for this instance. */
  maxConcurrency: number
}

export type ComfyBatchProbeResult = {
  ok: boolean
  baseUrl: string
  latencyMs: number
  endpoint?: 'system_stats' | 'queue'
  error?: string
}

export type ComfyBatchJobState = 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'error'

export type ComfyBatchItemTiming = {
  relativePath: string
  durationMs: number
  startedAt: number
  finishedAt: number
  profileId?: string
  attempt: number
  state: 'success' | 'failed'
}

export type ComfyBatchRunningItem = {
  relativePath: string
  startedAt: number
  profileId: string
  attempt: number
}

export type ComfyBatchStatus = {
  jobId?: string
  state: ComfyBatchJobState
  sourceDir?: string
  outputDir?: string
  qAppKey?: string
  planFingerprint?: string
  total: number
  success: number
  failed: number
  skipped: number
  running: number
  pending: number
  error?: string
  failedFiles: string[]
  startedAt?: number
  finishedAt?: number
  submittedAt?: number
  elapsedMs?: number
  averageItemMs?: number
  etaMs?: number
  queuePosition?: number
  recentItems?: ComfyBatchItemTiming[]
  runningItems?: ComfyBatchRunningItem[]
  lastItem?: ComfyBatchItemTiming
}

export type StartComfyBatchReq = {
  sourceDir: string
  qAppKey: string
  workflow: Workflow
  imageInputSlot: string
  outputNodeIds: string[]
}

export type StartComfyBatchResp = { status: ComfyBatchStatus }
export type GetComfyBatchStatusReq = { jobId?: string }
export type GetComfyBatchStatusResp = { status: ComfyBatchStatus }
export type ListComfyBatchJobsReq = Record<string, never>
export type ListComfyBatchJobsResp = { jobs: ComfyBatchStatus[] }
export type RetryFailedComfyBatchReq = { jobId: string }
export type RetryFailedComfyBatchResp = { status: ComfyBatchStatus }
export type CancelComfyBatchReq = { jobId: string }
export type CancelComfyBatchResp = { status: ComfyBatchStatus }
export type DismissComfyBatchReq = { jobId: string }
export type DismissComfyBatchResp = { status: ComfyBatchStatus }

export type ListComfyBatchProfilesReq = Record<string, never>
export type ListComfyBatchProfilesResp = { profiles: ComfyBatchProfile[] }
export type ProbeComfyBatchProfileReq = { id?: string; baseUrl?: string }
export type ProbeComfyBatchProfileResp = { result: ComfyBatchProbeResult }
export type ReplaceComfyBatchProfilesReq = { profiles: ComfyBatchProfile[] }
export type ReplaceComfyBatchProfilesResp = { profiles: ComfyBatchProfile[] }

export type ComfyBatchSvc = {
  listProfiles(req: ListComfyBatchProfilesReq): Promise<ListComfyBatchProfilesResp>
  replaceProfiles(req: ReplaceComfyBatchProfilesReq): Promise<ReplaceComfyBatchProfilesResp>
  probeProfile(req: ProbeComfyBatchProfileReq): Promise<ProbeComfyBatchProfileResp>
  start(req: StartComfyBatchReq): Promise<StartComfyBatchResp>
  status(req: GetComfyBatchStatusReq): Promise<GetComfyBatchStatusResp>
  listJobs(req: ListComfyBatchJobsReq): Promise<ListComfyBatchJobsResp>
  retryFailed(req: RetryFailedComfyBatchReq): Promise<RetryFailedComfyBatchResp>
  cancel(req: CancelComfyBatchReq): Promise<CancelComfyBatchResp>
  dismiss(req: DismissComfyBatchReq): Promise<DismissComfyBatchResp>
}

export const comfyBatchSvcDef: ServiceDefSheet<ComfyBatchSvc> = {
  listProfiles: { type: 'unary' },
  replaceProfiles: { type: 'unary' },
  probeProfile: { type: 'unary' },
  start: { type: 'unary' },
  status: { type: 'unary' },
  listJobs: { type: 'unary' },
  retryFailed: { type: 'unary' },
  cancel: { type: 'unary' },
  dismiss: { type: 'unary' }
}
