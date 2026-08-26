import { useSyncExternalStore } from 'react'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { api } from '@renderer/utils/windowUtils'

const POLL_INTERVAL_MS = 850

type ComfyBatchJobStoreSnapshot = {
  jobs: ComfyBatchStatus[]
  selectedJobId?: string
  centerOpen: boolean
  detailOpen: boolean
  loading: boolean
  error?: string
}

const EMPTY_SNAPSHOT: ComfyBatchJobStoreSnapshot = {
  jobs: [],
  centerOpen: false,
  detailOpen: false,
  loading: false
}

let snapshot: ComfyBatchJobStoreSnapshot = EMPTY_SNAPSHOT
let initialized = false
let pollTimer: number | undefined
let requestInFlight: Promise<ComfyBatchStatus[]> | undefined
const listeners = new Set<() => void>()
const dismissedJobIds = new Set<string>()

const hasActiveJobs = (jobs: ComfyBatchStatus[]): boolean =>
  jobs.some((job) => job.state === 'queued' || job.state === 'running')

const sortJobs = (jobs: ComfyBatchStatus[]): ComfyBatchStatus[] =>
  [...jobs]
    .filter((job) => Boolean(job.jobId) && job.state !== 'cancelled')
    .sort((left, right) => (right.submittedAt || 0) - (left.submittedAt || 0))

export const filterDismissedComfyBatchJobs = (
  jobs: ComfyBatchStatus[],
  dismissedIds: ReadonlySet<string>
): ComfyBatchStatus[] => sortJobs(jobs).filter((job) => !dismissedIds.has(job.jobId || ''))

const clearPollTimer = (): void => {
  if (pollTimer === undefined || typeof window === 'undefined') return
  window.clearTimeout(pollTimer)
  pollTimer = undefined
}

const schedulePoll = (): void => {
  if (
    pollTimer !== undefined ||
    requestInFlight ||
    listeners.size === 0 ||
    typeof window === 'undefined' ||
    !hasActiveJobs(snapshot.jobs)
  ) {
    return
  }

  pollTimer = window.setTimeout(() => {
    pollTimer = undefined
    void refreshComfyBatchJobs()
  }, POLL_INTERVAL_MS)
}

const syncPolling = (): void => {
  if (hasActiveJobs(snapshot.jobs) && listeners.size > 0) {
    schedulePoll()
  } else {
    clearPollTimer()
  }
}

const emit = (): void => {
  for (const listener of listeners) listener()
}

const setSnapshot = (patch: Partial<ComfyBatchJobStoreSnapshot>): void => {
  snapshot = { ...snapshot, ...patch }
  emit()
  syncPolling()
}

const mergeJob = (job: ComfyBatchStatus): void => {
  if (!job.jobId) return
  const jobs = snapshot.jobs.filter((candidate) => candidate.jobId !== job.jobId)
  jobs.push(job)
  setSnapshot({ jobs: filterDismissedComfyBatchJobs(jobs, dismissedJobIds), error: undefined })
}

export const refreshComfyBatchJobs = async (): Promise<ComfyBatchStatus[]> => {
  initialized = true
  if (requestInFlight) return requestInFlight

  const currentRequest = (async () => {
    setSnapshot({
      loading: snapshot.jobs.length === 0,
      error: undefined
    })

    try {
      const result = await api().svcComfyBatch.listJobs({})
      const jobs = filterDismissedComfyBatchJobs(
        Array.isArray(result.jobs) ? result.jobs : [],
        dismissedJobIds
      )
      const selectedJobId = jobs.some((job) => job.jobId === snapshot.selectedJobId)
        ? snapshot.selectedJobId
        : undefined
      setSnapshot({
        jobs,
        selectedJobId,
        detailOpen: selectedJobId ? snapshot.detailOpen : false,
        loading: false,
        error: undefined
      })
      return jobs
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSnapshot({ loading: false, error: message })
      return snapshot.jobs
    } finally {
      requestInFlight = undefined
      syncPolling()
    }
  })()
  requestInFlight = currentRequest
  return currentRequest
}

export const ensureComfyBatchJobStore = (): void => {
  if (!initialized) {
    initialized = true
    void refreshComfyBatchJobs()
    return
  }
  syncPolling()
}

export const subscribeComfyBatchJobs = (listener: () => void): (() => void) => {
  listeners.add(listener)
  ensureComfyBatchJobStore()
  return () => {
    listeners.delete(listener)
    syncPolling()
  }
}

export const getComfyBatchJobSnapshot = (): ComfyBatchJobStoreSnapshot => snapshot

export const useComfyBatchJobs = (): ComfyBatchJobStoreSnapshot =>
  useSyncExternalStore(subscribeComfyBatchJobs, getComfyBatchJobSnapshot, getComfyBatchJobSnapshot)

export const upsertComfyBatchJob = (job: ComfyBatchStatus): void => {
  mergeJob(job)
  ensureComfyBatchJobStore()
}

export const openComfyBatchCenter = (): void => {
  ensureComfyBatchJobStore()
  setSnapshot({ centerOpen: true })
}

export const openComfyBatchJob = (jobId?: string): void => {
  if (!jobId) {
    openComfyBatchCenter()
    return
  }
  ensureComfyBatchJobStore()
  setSnapshot({ centerOpen: true, detailOpen: true, selectedJobId: jobId })
}

export const closeComfyBatchCenter = (): void => {
  setSnapshot({ centerOpen: false, detailOpen: false })
}

export const toggleComfyBatchCenter = (): void => {
  ensureComfyBatchJobStore()
  setSnapshot({ centerOpen: !snapshot.centerOpen })
}

export const closeComfyBatchJobDetails = (): void => {
  setSnapshot({ detailOpen: false })
}

export const dismissComfyBatchJob = (jobId: string): void => {
  if (!jobId) return
  dismissedJobIds.add(jobId)
  const selected = snapshot.selectedJobId === jobId
  setSnapshot({
    jobs: filterDismissedComfyBatchJobs(snapshot.jobs, dismissedJobIds),
    ...(selected ? { selectedJobId: undefined, detailOpen: false } : {})
  })
}

export const removeComfyBatchJob = async (jobId: string): Promise<ComfyBatchStatus> => {
  const result = await api().svcComfyBatch.dismiss({ jobId })
  dismissComfyBatchJob(jobId)
  return result.status
}

export const cancelComfyBatchJob = async (jobId: string): Promise<ComfyBatchStatus> => {
  const result = await api().svcComfyBatch.cancel({ jobId })
  await refreshComfyBatchJobs()
  mergeJob(result.status)
  return result.status
}

export const retryComfyBatchJob = async (jobId: string): Promise<ComfyBatchStatus> => {
  const result = await api().svcComfyBatch.retryFailed({ jobId })
  await refreshComfyBatchJobs()
  mergeJob(result.status)
  return result.status
}

export type { ComfyBatchJobStoreSnapshot }
