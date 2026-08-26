import { useSyncExternalStore } from 'react'
import type { GetQueueResp } from '@shared/api/svcComfy'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import type { QueueAnimationStates } from '@renderer/components/sidePanelQueueUtils'
import { api } from '@renderer/utils/windowUtils'

const POLL_INTERVAL_MS = 850
const IDLE_POLL_INTERVAL_MS = 2_000

const EMPTY_QUEUE: GetQueueResp = {
  queue_running: [],
  queue_pending: [],
  queue_error: []
}

type ComfyBatchJobStoreSnapshot = {
  jobs: ComfyBatchStatus[]
  queue: GetQueueResp
  progressByPromptId: QueueAnimationStates
  selectedJobId?: string
  centerOpen: boolean
  detailOpen: boolean
  loading: boolean
  error?: string
}

const EMPTY_SNAPSHOT: ComfyBatchJobStoreSnapshot = {
  jobs: [],
  queue: EMPTY_QUEUE,
  progressByPromptId: {},
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

const hasActiveQueue = (queue: GetQueueResp): boolean =>
  queue.queue_running.length > 0 || queue.queue_pending.length > 0

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const getPollInterval = (): number =>
  hasActiveJobs(snapshot.jobs) || hasActiveQueue(snapshot.queue)
    ? POLL_INTERVAL_MS
    : IDLE_POLL_INTERVAL_MS

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
    typeof window === 'undefined'
  ) {
    return
  }

  pollTimer = window.setTimeout(() => {
    pollTimer = undefined
    void refreshComfyBatchJobs()
  }, getPollInterval())
}

const syncPolling = (): void => {
  if (listeners.size > 0) {
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

    const [batchResult, queueResult] = await Promise.allSettled([
      Promise.resolve().then(() => api().svcComfyBatch.listJobs({})),
      Promise.resolve().then(() => api().svcComfy.getQueue({}))
    ])

    let jobs = snapshot.jobs
    let queue = snapshot.queue
    const errors: string[] = []

    if (batchResult.status === 'fulfilled') {
      jobs = filterDismissedComfyBatchJobs(
        Array.isArray(batchResult.value.jobs) ? batchResult.value.jobs : [],
        dismissedJobIds
      )
    } else {
      errors.push(errorMessage(batchResult.reason))
    }

    if (queueResult.status === 'fulfilled') {
      queue = {
        queue_running: Array.isArray(queueResult.value.queue_running)
          ? queueResult.value.queue_running
          : [],
        queue_pending: Array.isArray(queueResult.value.queue_pending)
          ? queueResult.value.queue_pending
          : [],
        queue_error: Array.isArray(queueResult.value.queue_error)
          ? queueResult.value.queue_error
          : []
      }
    } else {
      errors.push(errorMessage(queueResult.reason))
    }

    const selectedJobId = jobs.some((job) => job.jobId === snapshot.selectedJobId)
      ? snapshot.selectedJobId
      : undefined
    const queueIds = new Set(
      [...queue.queue_running, ...queue.queue_pending, ...(queue.queue_error || [])].map((item) =>
        String(item[1] || '')
      )
    )
    const progressByPromptId = Object.fromEntries(
      Object.entries(snapshot.progressByPromptId).filter(([promptId]) => queueIds.has(promptId))
    )
    setSnapshot({
      jobs,
      queue,
      progressByPromptId,
      selectedJobId,
      detailOpen: selectedJobId ? snapshot.detailOpen : false,
      loading: false,
      error: errors.length === 2 ? errors.join(' · ') : undefined
    })
    return jobs
  })().finally(() => {
    requestInFlight = undefined
    syncPolling()
  })
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

export const updateComfyTaskProgress = (promptId: string, value?: number, max?: number): void => {
  const id = String(promptId || '').trim()
  if (!id) return
  setSnapshot({
    progressByPromptId: {
      ...snapshot.progressByPromptId,
      [id]: { value, max }
    }
  })
}

export const clearComfyTaskProgress = (promptId: string): void => {
  const id = String(promptId || '').trim()
  if (!id || !(id in snapshot.progressByPromptId)) return
  const next = { ...snapshot.progressByPromptId }
  delete next[id]
  setSnapshot({ progressByPromptId: next })
}

export const cancelComfyQueueTask = async (promptId: string): Promise<void> => {
  await api().svcComfy.cancelQueueItem({ prompt_id: promptId })
  await refreshComfyBatchJobs()
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
  // Seed the local store before refreshing so a transient refresh failure does
  // not lose the newly-created retry descriptor.
  mergeJob(result.status)
  await refreshComfyBatchJobs()
  // The backend replaces the terminal source record with the retry job. Keep
  // the details view attached to that new descriptor instead of leaving the
  // UI pointing at the deleted failed job.
  setSnapshot({
    centerOpen: true,
    detailOpen: true,
    selectedJobId: result.status.jobId
  })
  return result.status
}

export type { ComfyBatchJobStoreSnapshot }
