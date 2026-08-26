import { describe, expect, it, vi } from 'vitest'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { filterDismissedComfyBatchJobs } from './comfyBatchJobState'

const { listJobsMock, getQueueMock } = vi.hoisted(() => ({
  listJobsMock: vi.fn(),
  getQueueMock: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfyBatch: { listJobs: listJobsMock },
    svcComfy: { getQueue: getQueueMock }
  })
}))

const status = (jobId: string): ComfyBatchStatus => ({
  jobId,
  state: 'error',
  total: 1,
  success: 0,
  failed: 1,
  skipped: 0,
  running: 0,
  pending: 0,
  failedFiles: []
})

describe('Comfy batch job visibility', () => {
  it('refreshes the normal Comfy queue alongside persisted batch jobs', async () => {
    const { refreshComfyBatchJobs, getComfyBatchJobSnapshot } = await import('./comfyBatchJobState')
    const queue = {
      queue_running: [],
      queue_pending: [
        [0, 'task-single', {}, { client_id: 'magicpot-main', created_at: 1_735_000_000_000 }, []]
      ],
      queue_error: []
    }
    listJobsMock.mockResolvedValueOnce({ jobs: [] })
    getQueueMock.mockResolvedValueOnce(queue)

    await refreshComfyBatchJobs()

    expect(getComfyBatchJobSnapshot().queue).toEqual(queue)
  })

  it('filters a dismissed row without changing the source job list', () => {
    const jobs = [status('keep'), status('dismiss')]
    const visible = filterDismissedComfyBatchJobs(jobs, new Set(['dismiss']))

    expect(visible.map((job) => job.jobId)).toEqual(['keep'])
    expect(jobs.map((job) => job.jobId)).toEqual(['keep', 'dismiss'])
  })
})
