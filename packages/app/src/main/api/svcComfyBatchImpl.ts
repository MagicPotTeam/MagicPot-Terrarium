import path from 'node:path'
import type {
  CancelComfyBatchReq,
  CancelComfyBatchResp,
  ComfyBatchProfile,
  ComfyBatchStatus,
  ComfyBatchSvc,
  GetComfyBatchStatusReq,
  GetComfyBatchStatusResp,
  ListComfyBatchProfilesReq,
  ListComfyBatchProfilesResp,
  ProbeComfyBatchProfileReq,
  ProbeComfyBatchProfileResp,
  ReplaceComfyBatchProfilesReq,
  ReplaceComfyBatchProfilesResp,
  RetryFailedComfyBatchReq,
  RetryFailedComfyBatchResp,
  StartComfyBatchReq,
  StartComfyBatchResp
} from '@shared/api/svcComfyBatch'
import { ConfigUtils } from '@shared/config/configUtils'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig, saveConfig } from '../config/config'
import { ComfyBatchHttpClient, normalizeComfyBatchBaseUrl } from '../comfy/batchHttp'
import { ComfyBatchRunner } from '../comfy/batchRunner'
import { QAppFSCli } from '../qApp/fs'

const IDLE_STATUS: ComfyBatchStatus = {
  state: 'idle',
  total: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  running: 0,
  pending: 0,
  failedFiles: []
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

type JobRecord = {
  request: StartComfyBatchReq
  runner: ComfyBatchRunner
  status: ComfyBatchStatus
}

function normalizeProfile(profile: ComfyBatchProfile): ComfyBatchProfile {
  const id = String(profile.id || '').trim()
  const name = String(profile.name || '').trim()
  if (!id) throw new Error('Profile id is required')
  if (!name) throw new Error('Profile name is required')
  return {
    id,
    name,
    baseUrl: normalizeComfyBatchBaseUrl(profile.baseUrl),
    enabled: profile.enabled !== false,
    maxConcurrency: Math.max(1, Math.min(32, Math.floor(profile.maxConcurrency || 1)))
  }
}

function savedProfiles(): ComfyBatchProfile[] {
  return (getConfig().comfy_batch_profiles ?? []).map(normalizeProfile)
}

function defaultProfile(): ComfyBatchProfile {
  const config = getConfig()
  const baseUrl = new ConfigUtils(config, getBuildEnv(), path).getComfyUIOrigin()
  return {
    id: 'default',
    name: 'Default ComfyUI',
    baseUrl: normalizeComfyBatchBaseUrl(baseUrl),
    enabled: true,
    maxConcurrency: 1
  }
}

function configuredProfiles(): ComfyBatchProfile[] {
  const profiles = savedProfiles()
  return profiles.length ? profiles : [defaultProfile()]
}

export class ComfyBatchSvcImpl implements ComfyBatchSvc {
  private jobs = new Map<string, JobRecord>()
  private latestJobId: string | undefined

  private async persistProfiles(profiles: ComfyBatchProfile[]): Promise<void> {
    await saveConfig({ comfy_batch_profiles: profiles })
  }

  private rememberJob(record: JobRecord): void {
    this.jobs.set(record.runner.jobId, record)
    this.latestJobId = record.runner.jobId
    while (this.jobs.size > 20) {
      const oldest = this.jobs.keys().next().value
      if (!oldest) break
      this.jobs.delete(oldest)
    }
  }

  private launch(request: StartComfyBatchReq): ComfyBatchStatus {
    const profiles = configuredProfiles()
    const record = {} as JobRecord
    const runner = new ComfyBatchRunner(request, profiles, {
      onStatus: (status) => {
        record.status = status
      }
    })
    Object.assign(record, { request, runner, status: runner.startingStatus() })
    this.rememberJob(record)
    void runner.run().then((status) => {
      record.status = status
    })
    return record.status
  }

  listProfiles = async (_req: ListComfyBatchProfilesReq): Promise<ListComfyBatchProfilesResp> => ({
    profiles: configuredProfiles()
  })

  replaceProfiles = async (
    req: ReplaceComfyBatchProfilesReq
  ): Promise<ReplaceComfyBatchProfilesResp> => {
    const profiles = req.profiles.map(normalizeProfile)
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new Error('ComfyUI profile ids must be unique')
    }
    await this.persistProfiles(profiles)
    return { profiles: profiles.length ? profiles : [defaultProfile()] }
  }

  probeProfile = async (req: ProbeComfyBatchProfileReq): Promise<ProbeComfyBatchProfileResp> => {
    const profile = req.id
      ? configuredProfiles().find((candidate) => candidate.id === req.id)
      : undefined
    const baseUrl = normalizeComfyBatchBaseUrl(req.baseUrl || profile?.baseUrl || '')
    const startedAt = Date.now()
    try {
      const probe = await new ComfyBatchHttpClient(baseUrl).probe()
      return { result: { ok: true, baseUrl, ...probe } }
    } catch (error) {
      return {
        result: {
          ok: false,
          baseUrl,
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  start = async (req: StartComfyBatchReq): Promise<StartComfyBatchResp> => {
    const active = [...this.jobs.values()].find(
      (record) => record.runner.status.state === 'running'
    )
    if (active) throw new Error('Another ComfyUI batch is already running')
    const selected = await new QAppFSCli().getQApp(req.qAppKey)
    if (
      selected.cfg.batchProcess?.enabled !== true ||
      selected.cfg.batchProcess.imageInputSlot !== req.imageInputSlot ||
      stableJson(selected.workflow) !== stableJson(req.workflow) ||
      stableJson(selected.cfg.outputNodeIds || []) !== stableJson(req.outputNodeIds)
    ) {
      throw new Error('Quick App batch plan changed; reopen the Quick App and try again')
    }
    return { status: this.launch(req) }
  }

  status = async (req: GetComfyBatchStatusReq): Promise<GetComfyBatchStatusResp> => {
    const jobId = req.jobId || this.latestJobId
    const record = jobId ? this.jobs.get(jobId) : undefined
    return { status: record?.runner.status || { ...IDLE_STATUS } }
  }

  retryFailed = async (req: RetryFailedComfyBatchReq): Promise<RetryFailedComfyBatchResp> => {
    const previous = this.jobs.get(req.jobId)
    if (!previous) throw new Error(`Batch job not found: ${req.jobId}`)
    const status = previous.runner.status
    if (status.state === 'running') throw new Error('Cannot retry a running batch job')
    if (status.failed === 0) throw new Error('No failed batch items to retry')
    return { status: this.launch(previous.request) }
  }

  cancel = async (req: CancelComfyBatchReq): Promise<CancelComfyBatchResp> => {
    const record = this.jobs.get(req.jobId)
    if (!record) throw new Error(`Batch job not found: ${req.jobId}`)
    record.runner.cancel()
    record.status = record.runner.status
    return { status: record.status }
  }
}
