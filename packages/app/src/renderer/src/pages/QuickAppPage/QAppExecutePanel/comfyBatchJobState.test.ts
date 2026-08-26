import { describe, expect, it } from 'vitest'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { filterDismissedComfyBatchJobs } from './comfyBatchJobState'

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
  it('filters a dismissed row without changing the source job list', () => {
    const jobs = [status('keep'), status('dismiss')]
    const visible = filterDismissedComfyBatchJobs(jobs, new Set(['dismiss']))

    expect(visible.map((job) => job.jobId)).toEqual(['keep'])
    expect(jobs.map((job) => job.jobId)).toEqual(['keep', 'dismiss'])
  })
})
