import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import type {
  CancelComfyBatchReq,
  CancelComfyBatchResp,
  ComfyBatchProfile,
  ComfyBatchStatus,
  ComfyBatchSvc,
  DismissComfyBatchReq,
  DismissComfyBatchResp,
  GetComfyBatchStatusReq,
  GetComfyBatchStatusResp,
  ListComfyBatchProfilesReq,
  ListComfyBatchProfilesResp,
  ListComfyBatchJobsReq,
  ListComfyBatchJobsResp,
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
import { normalizeQAppBatchConfig } from '@shared/qApp/batchConfig'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig, saveConfig } from '../config/config'
import { ComfyBatchHttpClient, normalizeComfyBatchBaseUrl } from '../comfy/batchHttp'
import {
  ComfyBatchRunner,
  getComfyBatchOutputDir,
  isValidComfyBatchRunKey,
  validateComfyBatchBindings
} from '../comfy/batchRunner'
import { getComfyInstancePool } from '../comfy/comfyInstancePool'
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

type JobRecord = {
  request: StartComfyBatchReq
  runKey?: string
  runner?: ComfyBatchRunner
  status: ComfyBatchStatus
  submittedAt: number
  sequence: number
  cancelRequested: boolean
  cancelRequestedAt?: number
  runActive: boolean
  invalid?: boolean
  retryOf?: string
}

type PersistedJob = {
  request?: StartComfyBatchReq
  runKey?: string
  status?: ComfyBatchStatus
  submittedAt?: number
  sequence?: number
  cancelRequested?: boolean
  cancelRequestedAt?: number
  retryOf?: string
}

type PersistedStore = {
  version?: number
  latestJobId?: string
  nextSequence?: number
  jobs?: PersistedJob[]
}

const JOB_STORE_FILENAME = 'comfy-batch-jobs.json'
const JOB_INDEX_FILENAME = 'comfy-batch-jobs.bin'
const JOB_STORE_VERSION = 3
const MAX_RETAINED_JOBS = 50
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

function formatComfyBatchRunKey(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return Math.max(0, finiteNumber(value, fallback))
}

function isKnownJobState(value: unknown): value is ComfyBatchStatus['state'] {
  return (
    value === 'idle' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'error'
  )
}

function isTerminalState(state: ComfyBatchStatus['state']): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'error'
}

function normalizeCompletedStatus(status: ComfyBatchStatus): ComfyBatchStatus {
  if (
    status.state !== 'completed' ||
    (status.failed <= 0 && status.pending <= 0 && status.running <= 0)
  ) {
    return status
  }
  return {
    ...status,
    state: 'error',
    error:
      status.error ||
      (status.failed > 0
        ? `${status.failed} batch item(s) failed`
        : 'Batch ended before all items were processed')
  }
}

function isValidStartRequest(value: unknown): value is StartComfyBatchReq {
  if (!isRecord(value)) return false
  return (
    typeof value.sourceDir === 'string' &&
    typeof value.qAppKey === 'string' &&
    typeof value.imageInputSlot === 'string' &&
    Array.isArray(value.outputNodeIds) &&
    value.outputNodeIds.every((nodeId) => typeof nodeId === 'string') &&
    isRecord(value.workflow)
  )
}

function fallbackRequest(value: unknown): StartComfyBatchReq {
  const input = isRecord(value) ? value : {}
  return {
    sourceDir: typeof input.sourceDir === 'string' ? input.sourceDir : '',
    qAppKey: typeof input.qAppKey === 'string' ? input.qAppKey : '',
    workflow: isRecord(input.workflow)
      ? (cloneJson(input.workflow) as StartComfyBatchReq['workflow'])
      : {},
    imageInputSlot: typeof input.imageInputSlot === 'string' ? input.imageInputSlot : '',
    outputNodeIds: Array.isArray(input.outputNodeIds)
      ? input.outputNodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string')
      : []
  }
}

function normalizeProfile(profile: ComfyBatchProfile): ComfyBatchProfile {
  const id = String(profile.id || '').trim()
  if (!id) throw new Error('Profile id is required')
  return {
    id,
    baseUrl: normalizeComfyBatchBaseUrl(profile.baseUrl),
    enabled: profile.enabled !== false,
    maxConcurrency: Math.max(1, Math.min(32, Math.floor(profile.maxConcurrency || 1)))
  }
}

function defaultProfile(): ComfyBatchProfile {
  const config = getConfig()
  const baseUrl = new ConfigUtils(config, getBuildEnv(), path).getComfyUIOrigin()
  return {
    id: 'default',
    baseUrl: normalizeComfyBatchBaseUrl(baseUrl),
    enabled: true,
    maxConcurrency: 1
  }
}

function configuredProfiles(): ComfyBatchProfile[] {
  const config = getConfig()
  const configured = config.comfy_batch_profiles
  if (!Array.isArray(configured) || configured.length === 0) {
    return [defaultProfile()]
  }
  return configured.map(normalizeProfile)
}

async function replaceStoreFile(tempPath: string, filename: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 4 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rename(tempPath, filename)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = ['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(code || '')
      if (!retryable || attempt === attempts) {
        if (process.platform === 'win32' && retryable && attempt === attempts) {
          await fs.rm(filename, { force: true })
          await fs.rename(tempPath, filename)
          return
        }
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
    }
  }
}

async function atomicWriteBytes(filename: string, bytes: Uint8Array): Promise<void> {
  const directory = path.dirname(filename)
  await fs.mkdir(directory, { recursive: true })
  const tempPath = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(tempPath, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await replaceStoreFile(tempPath, filename)
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  await atomicWriteBytes(filename, Buffer.from(JSON.stringify(value), 'utf8'))
}

export class ComfyBatchSvcImpl implements ComfyBatchSvc {
  private jobs = new Map<string, JobRecord>()
  private jobQueue: string[] = []
  private latestJobId: string | undefined
  private nextSequence = 1
  private operationQueue: Promise<void> = Promise.resolve()
  private restorePromise: Promise<void> | undefined
  private storeWriteQueue: Promise<void> = Promise.resolve()
  private pumpPromise: Promise<void> | undefined

  constructor() {
    // Warm the persisted state in the background, but never start recovered
    // work from an observer such as listJobs/status.
    void this.restoreJobs().catch((error) => this.reportRestoreError(error))
  }

  private reportRestoreError(error: unknown): void {
    console.error('[ComfyBatchSvcImpl] Failed to restore job store:', errorMessage(error))
  }

  private reportPersistenceError(error: unknown): void {
    console.error('[ComfyBatchSvcImpl] Failed to persist job store:', errorMessage(error))
  }

  private storePath(): string {
    return path.join(getBuildEnv().pathMap.data, JOB_INDEX_FILENAME)
  }

  private legacyStorePath(): string {
    return path.join(getBuildEnv().pathMap.data, JOB_STORE_FILENAME)
  }

  private async preserveMalformedStore(filename: string): Promise<void> {
    try {
      // Keep the active data directory to a single JSON document (the
      // per-batch manifest). Corrupt job indexes are recoverable backups,
      // not additional active JSON stores.
      const backup = `${filename}.corrupt-${Date.now()}-${randomUUID()}.bak`
      await fs.rename(filename, backup)
      console.error(`[ComfyBatchSvcImpl] Preserved malformed job store at ${backup}`)
    } catch (error) {
      this.reportRestoreError(error)
    }
  }

  private liveStatus(record: JobRecord): ComfyBatchStatus {
    let base = record.status
    if (record.runActive && record.runner) {
      try {
        base = record.runner.status
      } catch {
        base = record.status
      }
    }
    const status: ComfyBatchStatus = normalizeCompletedStatus({
      ...base,
      jobId: record.status.jobId,
      sourceDir: base.sourceDir ?? record.status.sourceDir,
      outputDir: base.outputDir ?? record.status.outputDir,
      qAppKey: base.qAppKey ?? record.status.qAppKey,
      submittedAt: record.submittedAt,
      failedFiles: [...(base.failedFiles || [])]
    })
    if (record.cancelRequested) {
      status.state = 'cancelled'
      status.error = undefined
      status.finishedAt = status.finishedAt ?? record.status.finishedAt
      status.queuePosition = undefined
    }
    if (status.state === 'running') status.queuePosition = undefined
    return cloneJson(status)
  }

  private setRecordStatus(record: JobRecord, status: ComfyBatchStatus): void {
    record.status = {
      ...status,
      jobId: record.status.jobId,
      submittedAt: record.submittedAt,
      failedFiles: [...(status.failedFiles || [])]
    }
  }

  private forceCancelled(record: JobRecord, status?: ComfyBatchStatus): void {
    const base = status || this.liveStatus(record)
    this.setRecordStatus(record, {
      ...base,
      state: 'cancelled',
      error: undefined,
      finishedAt: base.finishedAt ?? Date.now(),
      queuePosition: undefined
    })
  }

  private markError(record: JobRecord, error: unknown): void {
    if (record.cancelRequested) {
      this.forceCancelled(record)
      return
    }
    const base = this.liveStatus(record)
    this.setRecordStatus(record, {
      ...base,
      state: 'error',
      error: errorMessage(error),
      finishedAt: Date.now(),
      queuePosition: undefined
    })
  }

  private removeFromQueue(jobId: string): void {
    this.jobQueue = this.jobQueue.filter((candidate) => candidate !== jobId)
    this.updateQueuePositions()
  }

  private forgetJob(jobId: string): void {
    this.jobs.delete(jobId)
    this.removeFromQueue(jobId)
    if (this.latestJobId !== jobId) return
    const newest = [...this.jobs.values()].sort(
      (left, right) => right.sequence - left.sequence || right.submittedAt - left.submittedAt
    )[0]
    this.latestJobId = newest?.status.jobId
  }

  private updateQueuePositions(): void {
    this.jobQueue.forEach((jobId, index) => {
      const record = this.jobs.get(jobId)
      if (!record) return
      if (record.status.state === 'queued' && !record.cancelRequested) {
        record.status = {
          ...record.status,
          submittedAt: record.submittedAt,
          queuePosition: index + 1
        }
      } else if (record.status.state === 'running') {
        record.status = {
          ...record.status,
          submittedAt: record.submittedAt,
          queuePosition: undefined
        }
      }
    })
  }

  private isActiveRecord(record: JobRecord): boolean {
    return record.runActive || record.status.state === 'queued' || record.status.state === 'running'
  }

  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()]
      .filter((record) => !this.isActiveRecord(record))
      .sort((left, right) => left.sequence - right.sequence || left.submittedAt - right.submittedAt)
    while (terminal.length > MAX_RETAINED_JOBS) {
      const candidate = terminal.shift()
      if (!candidate) break
      const jobId = candidate.status.jobId
      if (!jobId || jobId === this.latestJobId) continue
      this.jobs.delete(jobId)
    }
  }

  private snapshotPersistedJobs(): PersistedJob[] {
    this.pruneTerminalJobs()
    return [...this.jobs.values()]
      .sort((left, right) => left.sequence - right.sequence || left.submittedAt - right.submittedAt)
      .map((record) => ({
        request: cloneJson(record.request),
        runKey: record.runKey,
        status: this.liveStatus(record),
        submittedAt: record.submittedAt,
        sequence: record.sequence,
        cancelRequested: record.cancelRequested || undefined,
        cancelRequestedAt: record.cancelRequestedAt,
        retryOf: record.retryOf
      }))
  }

  private async persistJobs(): Promise<void> {
    const write = this.storeWriteQueue.then(async () => {
      const filename = this.storePath()
      const records = this.snapshotPersistedJobs()
      const payload = {
        version: JOB_STORE_VERSION,
        latestJobId: this.latestJobId,
        nextSequence: this.nextSequence,
        jobs: records
      }
      const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), 'utf8'))
      await atomicWriteBytes(filename, compressed)
    })
    this.storeWriteQueue = write.then(
      () => undefined,
      () => undefined
    )
    await write
  }

  private async persistBestEffort(): Promise<void> {
    try {
      await this.persistJobs()
    } catch (error) {
      this.reportPersistenceError(error)
    }
  }

  private schedulePersist(): void {
    void this.persistJobs().catch((error) => this.reportPersistenceError(error))
  }

  private async restoreJobs(): Promise<void> {
    if (this.restorePromise) return this.restorePromise
    this.restorePromise = (async () => {
      let filename: string
      let legacyFilename: string
      try {
        filename = this.storePath()
        legacyFilename = this.legacyStorePath()
      } catch (error) {
        this.reportRestoreError(error)
        return
      }

      let rawText: string
      let loadedFromLegacy = false
      let sourceFilename = filename
      try {
        rawText = (await gunzipAsync(await fs.readFile(filename))).toString('utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.reportRestoreError(error)
          await this.preserveMalformedStore(filename)
          return
        }
        try {
          rawText = await fs.readFile(legacyFilename, 'utf8')
          loadedFromLegacy = true
          sourceFilename = legacyFilename
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.reportRestoreError(legacyError)
            await this.preserveMalformedStore(legacyFilename)
          }
          return
        }
      }

      let raw: unknown
      try {
        raw = JSON.parse(rawText) as PersistedStore
      } catch (error) {
        this.reportRestoreError(error)
        await this.preserveMalformedStore(sourceFilename)
        return
      }
      if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
        const error = new Error('Job store does not contain a jobs array')
        this.reportRestoreError(error)
        await this.preserveMalformedStore(sourceFilename)
        return
      }

      const entries = raw.jobs.map((value, index) => {
        const item = isRecord(value) ? value : {}
        return {
          item,
          index,
          submittedAt: finiteNumber(item.submittedAt, 0),
          sequence:
            Number.isSafeInteger(item.sequence) && Number(item.sequence) > 0
              ? Number(item.sequence)
              : undefined
        }
      })
      entries.sort((left, right) => {
        if (left.sequence !== undefined && right.sequence !== undefined) {
          return left.sequence - right.sequence || left.index - right.index
        }
        return left.submittedAt - right.submittedAt || left.index - right.index
      })

      const usedSequences = new Set<number>()
      let fallbackSequence = 1
      let malformedCount = 0
      let migrated = loadedFromLegacy || raw.version !== JOB_STORE_VERSION
      for (const entry of entries) {
        let sequence = entry.sequence
        if (sequence === undefined || usedSequences.has(sequence)) {
          while (usedSequences.has(fallbackSequence)) fallbackSequence += 1
          sequence = fallbackSequence
          migrated = true
        }
        usedSequences.add(sequence)
        fallbackSequence = Math.max(fallbackSequence, sequence + 1)

        const item = entry.item
        const rawStatus = isRecord(item.status) ? item.status : {}
        const requestValue = item.request
        const validRequest = isValidStartRequest(requestValue)
        const request = validRequest ? cloneJson(requestValue) : fallbackRequest(requestValue)
        const submittedAt = Math.max(0, finiteNumber(item.submittedAt, Date.now()))
        let jobId = typeof rawStatus.jobId === 'string' && rawStatus.jobId ? rawStatus.jobId : ''
        let malformed = !validRequest || !isRecord(item.status)
        if (!jobId || this.jobs.has(jobId)) {
          jobId = randomUUID()
          malformed = true
        }
        if (!jobId) {
          // randomUUID() above always supplies an id; keep this guard for
          // unusual crypto implementations and make the record addressable.
          jobId = `restored-${sequence}`
        }

        const rawState = rawStatus.state
        let recoveredState: ComfyBatchStatus['state'] = isKnownJobState(rawState)
          ? rawState
          : 'error'
        if (recoveredState === 'idle') {
          recoveredState = 'queued'
          migrated = true
        } else if (recoveredState === 'running') {
          // A process restart cannot safely reconnect to a ComfyUI prompt.
          recoveredState = 'queued'
          migrated = true
        }
        if (rawState === 'cancel-requested') {
          recoveredState = 'cancelled'
          migrated = true
        } else if (!isKnownJobState(rawState) && rawState !== undefined) {
          malformed = true
        }
        const persistedFailedFiles = Array.isArray(rawStatus.failedFiles)
          ? rawStatus.failedFiles.filter((file): file is string => typeof file === 'string')
          : []
        const persistedFailed = Math.max(
          nonNegativeNumber(rawStatus.failed),
          persistedFailedFiles.length
        )
        const hadItemFailures = persistedFailed > 0
        if (hadItemFailures && recoveredState !== 'cancelled') {
          // Legacy runners stopped after a bounded number of attempts. Those
          // files still exist in the durable input queue, so restore the job
          // as queued and let the new runner keep retrying them silently.
          recoveredState = 'queued'
          migrated = true
        }
        const cancelRequested = item.cancelRequested === true
        const state: ComfyBatchStatus['state'] = validRequest
          ? cancelRequested
            ? 'cancelled'
            : recoveredState
          : 'error'
        if (cancelRequested && recoveredState !== 'cancelled') migrated = true
        if (!validRequest) malformed = true
        if (malformed) malformedCount += 1

        const persistedRunKey = item.runKey
        const runKey =
          persistedRunKey === undefined
            ? undefined
            : isValidComfyBatchRunKey(persistedRunKey)
              ? persistedRunKey
              : undefined
        if (persistedRunKey !== undefined && runKey === undefined) migrated = true

        let outputDir = typeof rawStatus.outputDir === 'string' ? rawStatus.outputDir : undefined
        if (!outputDir && request.sourceDir) {
          try {
            outputDir = getComfyBatchOutputDir(request.sourceDir, runKey)
          } catch {
            // Keep a malformed descriptor recoverable without deriving a path.
          }
        }
        const restoredStatus: ComfyBatchStatus = {
          ...rawStatus,
          jobId,
          state,
          sourceDir:
            typeof rawStatus.sourceDir === 'string'
              ? rawStatus.sourceDir
              : request.sourceDir
                ? path.resolve(request.sourceDir)
                : undefined,
          outputDir,
          qAppKey: typeof rawStatus.qAppKey === 'string' ? rawStatus.qAppKey : request.qAppKey,
          total: nonNegativeNumber(rawStatus.total),
          success: nonNegativeNumber(rawStatus.success),
          failed: 0,
          skipped: nonNegativeNumber(rawStatus.skipped),
          running: 0,
          pending:
            state === 'queued'
              ? nonNegativeNumber(rawStatus.pending) +
                nonNegativeNumber(rawStatus.running) +
                persistedFailed
              : nonNegativeNumber(rawStatus.pending),
          failedFiles: [],
          error:
            hadItemFailures || typeof rawStatus.error !== 'string' ? undefined : rawStatus.error,
          finishedAt:
            state === 'queued'
              ? undefined
              : typeof rawStatus.finishedAt === 'number'
                ? rawStatus.finishedAt
                : undefined,
          submittedAt,
          queuePosition: undefined,
          ...(malformed
            ? {
                error:
                  typeof rawStatus.error === 'string'
                    ? rawStatus.error
                    : 'Malformed persisted ComfyUI batch job descriptor'
              }
            : {}),
          ...(state === 'cancelled' && typeof rawStatus.finishedAt === 'number'
            ? { finishedAt: rawStatus.finishedAt }
            : {})
        }
        const normalizedStatus = normalizeCompletedStatus(restoredStatus)
        if (
          normalizedStatus.state !== restoredStatus.state ||
          normalizedStatus.error !== restoredStatus.error
        ) {
          migrated = true
        }
        const record: JobRecord = {
          request,
          runKey,
          status: normalizedStatus,
          submittedAt,
          sequence,
          cancelRequested,
          cancelRequestedAt: finiteNumber(item.cancelRequestedAt, 0) || undefined,
          runActive: false,
          invalid: malformed || !validRequest,
          retryOf: typeof item.retryOf === 'string' ? item.retryOf : undefined
        }
        this.jobs.set(jobId, record)
        if (state === 'queued' && !record.invalid) this.jobQueue.push(jobId)
        this.nextSequence = Math.max(this.nextSequence, sequence + 1)
      }
      const rawLatest = typeof raw.latestJobId === 'string' ? raw.latestJobId : undefined
      const latestRecord = rawLatest ? this.jobs.get(rawLatest) : undefined
      if (latestRecord) {
        this.latestJobId = rawLatest
      } else {
        const newest = [...this.jobs.values()].sort(
          (left, right) => right.sequence - left.sequence || right.submittedAt - left.submittedAt
        )[0]
        this.latestJobId = newest?.status.jobId
        if (rawLatest !== this.latestJobId) migrated = true
      }
      const persistedNext = finiteNumber(raw.nextSequence, 0)
      if (persistedNext > this.nextSequence) this.nextSequence = Math.floor(persistedNext)
      if (raw.nextSequence !== undefined && persistedNext !== raw.nextSequence) migrated = true
      this.updateQueuePositions()

      if (malformedCount > 0) {
        console.error(
          `[ComfyBatchSvcImpl] Ignored or repaired ${malformedCount} malformed job descriptor(s)`
        )
        await this.preserveMalformedStore(sourceFilename)
        migrated = true
      }
      if (migrated) {
        await this.persistBestEffort()
      }
      // A successful binary restore makes the binary index authoritative. If
      // a previous interrupted migration left the legacy JSON beside it,
      // archive that copy so there is never a second active global JSON store.
      if (loadedFromLegacy || sourceFilename === filename) {
        const migratedFilename = `${legacyFilename.replace(/\.json$/i, '')}.migrated-${Date.now()}-${randomUUID()}.bak`
        await fs.rename(legacyFilename, migratedFilename).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.reportPersistenceError(error)
          }
        })
      }
    })().catch((error) => {
      this.reportRestoreError(error)
    })
    return this.restorePromise
  }

  private async ensureRestored(): Promise<void> {
    await this.restoreJobs()
  }

  /**
   * Resume persisted queued work only when the application explicitly starts
   * the service. Observers such as listJobs/status intentionally do not pump
   * the queue, so a direct service instance can inspect recovery state without
   * racing a runner.
   */
  async resumeRecoveredJobs(): Promise<void> {
    await this.ensureRestored()
    await this.pump()
  }

  private async persistProfiles(profiles: ComfyBatchProfile[]): Promise<void> {
    await saveConfig({ comfy_batch_profiles: profiles })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private rememberJob(record: JobRecord): void {
    const jobId = record.status.jobId
    if (!jobId) throw new Error('Batch job id is missing')
    this.jobs.set(jobId, record)
    this.latestJobId = jobId
  }

  private allocateRunKey(timestamp: number): string {
    const base = formatComfyBatchRunKey(timestamp)
    const usedRunKeys = new Set(
      [...this.jobs.values()]
        .map((record) => record.runKey)
        .filter((runKey): runKey is string => runKey !== undefined)
    )
    if (!usedRunKeys.has(base)) return base
    let suffix = 2
    while (usedRunKeys.has(`${base}-${suffix}`)) suffix += 1
    return `${base}-${suffix}`
  }

  private async enqueue(
    request: StartComfyBatchReq,
    retryOf?: string,
    runKey?: string
  ): Promise<ComfyBatchStatus> {
    const snapshot = cloneJson(request)
    const now = Date.now()
    const resolvedRunKey = runKey ?? (retryOf === undefined ? this.allocateRunKey(now) : undefined)
    const jobId = randomUUID()
    const previousNextSequence = this.nextSequence
    const sequence = this.nextSequence++
    const status: ComfyBatchStatus = {
      jobId,
      state: 'queued',
      sourceDir: path.resolve(snapshot.sourceDir),
      outputDir: getComfyBatchOutputDir(snapshot.sourceDir, resolvedRunKey),
      qAppKey: snapshot.qAppKey,
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      pending: 0,
      failedFiles: [],
      submittedAt: now,
      queuePosition: this.jobQueue.length + 1
    }
    const record: JobRecord = {
      request: snapshot,
      runKey: resolvedRunKey,
      runner: undefined,
      status,
      submittedAt: now,
      sequence,
      cancelRequested: false,
      runActive: false,
      retryOf
    }
    const previousLatestJobId = this.latestJobId
    this.rememberJob(record)
    this.jobQueue.push(jobId)
    this.updateQueuePositions()
    try {
      // A successful start does not return until its descriptor is durable.
      await this.persistJobs()
      this.pruneTerminalJobs()
    } catch (error) {
      this.jobs.delete(jobId)
      this.jobQueue = this.jobQueue.filter((candidate) => candidate !== jobId)
      this.latestJobId = previousLatestJobId
      this.nextSequence = previousNextSequence
      this.updateQueuePositions()
      throw error
    }
    this.schedulePump()
    // Return the enqueue snapshot. The runner may start before this method
    // yields back to the caller, but the API contract for a newly submitted
    // job is a queued descriptor.
    return cloneJson(status)
  }

  private schedulePump(): void {
    void this.pump().catch((error) => this.reportRestoreError(error))
  }

  private async processQueuedJob(nextId: string, record: JobRecord): Promise<void> {
    let runner: ComfyBatchRunner | undefined
    try {
      if (record.cancelRequested || record.status.state === 'cancelled') {
        this.forceCancelled(record)
        return
      }
      const profiles = configuredProfiles()
      runner = new ComfyBatchRunner(cloneJson(record.request), profiles, {
        jobId: nextId,
        runKey: record.runKey,
        getProfiles: () => configuredProfiles(),
        onStatus: (status) => {
          // Do not allow a late runner callback to resurrect a cancelled or
          // already terminal job.
          if (!record.runActive && isTerminalState(record.status.state)) return
          const nextStatus = {
            ...status,
            jobId: nextId,
            submittedAt: record.submittedAt,
            queuePosition: undefined
          }
          if (record.cancelRequested) {
            this.setRecordStatus(record, {
              ...nextStatus,
              state: 'cancelled',
              error: undefined,
              finishedAt: nextStatus.finishedAt ?? Date.now()
            })
          } else {
            this.setRecordStatus(record, nextStatus)
          }
          this.schedulePersist()
        }
      })
      record.runner = runner
      record.runActive = true
      const starting = runner.startingStatus()
      this.setRecordStatus(record, { ...starting, state: 'running', queuePosition: undefined })
      this.updateQueuePositions()
      await this.persistBestEffort()

      if (record.cancelRequested) {
        runner.cancel()
        this.forceCancelled(record)
        return
      }

      let finalStatus: ComfyBatchStatus
      try {
        finalStatus = await runner.run()
      } catch (error) {
        finalStatus = {
          ...this.liveStatus(record),
          state: 'error',
          error: errorMessage(error),
          finishedAt: Date.now()
        }
      }
      if (record.cancelRequested) {
        this.forceCancelled(record, finalStatus)
      } else if (!isTerminalState(finalStatus.state)) {
        this.markError(record, 'ComfyUI batch runner returned a non-terminal status')
      } else {
        this.setRecordStatus(record, { ...finalStatus, queuePosition: undefined })
      }
    } catch (error) {
      if (record.cancelRequested) this.forceCancelled(record)
      else this.markError(record, error)
    } finally {
      record.runActive = false
      record.runner = undefined
      this.removeFromQueue(nextId)
      await this.persistBestEffort()
    }
  }

  private pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise
    const run = (async () => {
      while (this.jobQueue.length) {
        const nextId = this.jobQueue[0]
        const record = this.jobs.get(nextId)
        if (!record) {
          this.jobQueue.shift()
          continue
        }
        if (record.status.state === 'cancelled' && !record.runActive) {
          this.jobQueue.shift()
          this.updateQueuePositions()
          await this.persistBestEffort()
          continue
        }
        if (record.status.state !== 'queued' && !record.runActive) {
          this.jobQueue.shift()
          this.updateQueuePositions()
          await this.persistBestEffort()
          continue
        }
        await this.processQueuedJob(nextId, record)
      }
    })().catch((error) => {
      // A per-job failure is handled by processQueuedJob. This guard is for
      // unexpected queue bookkeeping failures and must not leave future jobs
      // permanently blocked.
      this.reportRestoreError(error)
    })
    this.pumpPromise = run.finally(() => {
      this.pumpPromise = undefined
      if (this.jobQueue.length) this.schedulePump()
    })
    return this.pumpPromise
  }

  private async validateRequestBindings(request: StartComfyBatchReq): Promise<void> {
    const selected = await new QAppFSCli().getQApp(request.qAppKey)
    const normalized = normalizeQAppBatchConfig(selected.cfg, selected.workflow)
    const selectedBatchSlot =
      normalized.imageInputSlot || normalized.cfg.batchProcess?.imageInputSlot
    const selectedOutputIds = normalized.outputNodeIds
    const requestedOutputIds = request.outputNodeIds || []
    const outputBindingsMatch =
      selectedOutputIds.length === requestedOutputIds.length &&
      selectedOutputIds.every((nodeId) => requestedOutputIds.includes(nodeId))
    if (
      normalized.cfg.batchProcess?.enabled !== true ||
      typeof selectedBatchSlot !== 'string' ||
      selectedBatchSlot !== request.imageInputSlot ||
      !outputBindingsMatch
    ) {
      throw new Error('Quick App batch bindings changed; reopen the Quick App and try again')
    }

    // The renderer builds the request from the current runtime inputs. Those
    // inputs may legitimately change values or add dynamic nodes (for example
    // the LoRA chain), so comparing the entire workflow with the saved QApp
    // template rejects valid batch requests. Validate the persisted and
    // runtime workflows' binding contracts instead, while allowing their
    // runtime parameters to differ.
    validateComfyBatchBindings(selected.workflow, selectedBatchSlot, selectedOutputIds)
    validateComfyBatchBindings(request.workflow, request.imageInputSlot, requestedOutputIds)
  }

  private hasActiveRetry(sourceJobId: string): boolean {
    return [...this.jobs.values()].some(
      (record) =>
        record.retryOf === sourceJobId &&
        (record.runActive || record.status.state === 'queued' || record.status.state === 'running')
    )
  }

  listProfiles = async (_req: ListComfyBatchProfilesReq): Promise<ListComfyBatchProfilesResp> => ({
    profiles: configuredProfiles()
  })

  listJobs = async (_req: ListComfyBatchJobsReq): Promise<ListComfyBatchJobsResp> => {
    await this.ensureRestored()
    return {
      jobs: [...this.jobs.values()]
        .sort(
          (left, right) => right.sequence - left.sequence || right.submittedAt - left.submittedAt
        )
        .map((record) => this.liveStatus(record))
    }
  }

  replaceProfiles = async (
    req: ReplaceComfyBatchProfilesReq
  ): Promise<ReplaceComfyBatchProfilesResp> => {
    const profiles = req.profiles.map(normalizeProfile)
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new Error('ComfyUI profile ids must be unique')
    }
    await this.persistProfiles(profiles)
    getComfyInstancePool().invalidate()
    return { profiles }
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
    // Clone before entering the serialized async operation. The caller may
    // reuse or mutate its workflow while QApp validation is awaiting I/O.
    const snapshot = cloneJson(req)
    return this.serialize(async () => {
      await this.ensureRestored()
      await this.validateRequestBindings(snapshot)
      return { status: await this.enqueue(snapshot) }
    })
  }

  status = async (req: GetComfyBatchStatusReq): Promise<GetComfyBatchStatusResp> => {
    await this.ensureRestored()
    const jobId = req.jobId || this.latestJobId
    const record = jobId ? this.jobs.get(jobId) : undefined
    return { status: record ? this.liveStatus(record) : cloneJson(IDLE_STATUS) }
  }

  retryFailed = async (req: RetryFailedComfyBatchReq): Promise<RetryFailedComfyBatchResp> =>
    this.serialize(async () => {
      await this.ensureRestored()
      const previous = this.jobs.get(req.jobId)
      if (!previous) throw new Error(`Batch job not found: ${req.jobId}`)
      if (previous.invalid) throw new Error('Malformed persisted batch job cannot be retried')
      const status = this.liveStatus(previous)
      if (previous.runActive && previous.runner) {
        if (status.failed <= 0) throw new Error('No failed batch items to retry')
        const retryStatus = previous.runner.retryFailedItems()
        this.setRecordStatus(previous, retryStatus)
        await this.persistJobs()
        return { status: this.liveStatus(previous) }
      }
      if (previous.runActive || status.state === 'queued' || status.state === 'running') {
        throw new Error('Cannot retry a queued or running batch job')
      }
      const retryable =
        status.state === 'error' ||
        status.state === 'cancelled' ||
        (status.state === 'completed' && (status.failed > 0 || status.pending > 0))
      if (!retryable) throw new Error('No unfinished batch items to retry')
      if (this.hasActiveRetry(req.jobId)) {
        throw new Error('A retry for this batch job is already queued or running')
      }
      const snapshot = cloneJson(previous.request)
      await this.validateRequestBindings(snapshot)
      const retryStatus = await this.enqueue(snapshot, req.jobId, previous.runKey)

      // A retry is a continuation of the failed batch, not a second history
      // entry that should remain visible beside it. The new descriptor is
      // durable before we remove the previous terminal record, so a failure
      // during cleanup cannot lose the retry job itself.
      this.forgetJob(req.jobId)
      await this.persistJobs()
      return { status: retryStatus }
    })

  dismiss = async (req: DismissComfyBatchReq): Promise<DismissComfyBatchResp> =>
    this.serialize(async () => {
      await this.ensureRestored()
      const record = this.jobs.get(req.jobId)
      if (!record) throw new Error(`Batch job not found: ${req.jobId}`)
      const current = this.liveStatus(record)
      if (
        current.state === 'queued' ||
        current.state === 'running' ||
        (record.runActive && !isTerminalState(current.state))
      ) {
        throw new Error('Cannot dismiss a queued or running batch job')
      }

      this.forgetJob(req.jobId)
      await this.persistJobs()
      return { status: current }
    })

  cancel = async (req: CancelComfyBatchReq): Promise<CancelComfyBatchResp> =>
    this.serialize(async () => {
      await this.ensureRestored()
      const record = this.jobs.get(req.jobId)
      if (!record) throw new Error(`Batch job not found: ${req.jobId}`)
      const current = this.liveStatus(record)
      if (isTerminalState(current.state) && !record.runActive) {
        return { status: current }
      }

      const running = record.runActive || current.state === 'running' || Boolean(record.runner)
      record.cancelRequested = true
      record.cancelRequestedAt = Date.now()
      this.forceCancelled(record)

      // Persist the intent before asking ComfyUI to cancel. A crash after this
      // point must not turn the job back into a runnable queued descriptor.
      try {
        await this.persistJobs()
      } catch (error) {
        record.cancelRequested = false
        record.cancelRequestedAt = undefined
        if (running) {
          const runnerStatus = record.runner?.status
          if (runnerStatus) this.setRecordStatus(record, runnerStatus)
        } else {
          this.setRecordStatus(record, { ...current, state: 'queued', queuePosition: undefined })
          if (!this.jobQueue.includes(req.jobId)) this.jobQueue.unshift(req.jobId)
          this.updateQueuePositions()
        }
        throw error
      }
      if (running) {
        try {
          record.runner?.cancel()
        } catch (error) {
          // Cancellation is best effort after the intent is durable.
          this.reportPersistenceError(error)
        }
        this.forceCancelled(record)
        await this.persistBestEffort()
      } else {
        this.removeFromQueue(req.jobId)
        await this.persistJobs()
        this.schedulePump()
      }
      return { status: this.liveStatus(record) }
    })
}
