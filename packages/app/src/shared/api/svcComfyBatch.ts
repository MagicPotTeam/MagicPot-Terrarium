import type { Workflow } from '@shared/comfy/types'
import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type ComfyBatchProfile = {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  maxConcurrency: number
}

export type ComfyBatchProbeResult = {
  ok: boolean
  baseUrl: string
  latencyMs: number
  endpoint?: 'system_stats' | 'queue'
  error?: string
}

export type ComfyBatchJobState = 'idle' | 'running' | 'completed' | 'cancelled' | 'error'

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
export type RetryFailedComfyBatchReq = { jobId: string }
export type RetryFailedComfyBatchResp = { status: ComfyBatchStatus }
export type CancelComfyBatchReq = { jobId: string }
export type CancelComfyBatchResp = { status: ComfyBatchStatus }

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
  retryFailed(req: RetryFailedComfyBatchReq): Promise<RetryFailedComfyBatchResp>
  cancel(req: CancelComfyBatchReq): Promise<CancelComfyBatchResp>
}

export const comfyBatchSvcDef: ServiceDefSheet<ComfyBatchSvc> = {
  listProfiles: { type: 'unary' },
  replaceProfiles: { type: 'unary' },
  probeProfile: { type: 'unary' },
  start: { type: 'unary' },
  status: { type: 'unary' },
  retryFailed: { type: 'unary' },
  cancel: { type: 'unary' }
}
