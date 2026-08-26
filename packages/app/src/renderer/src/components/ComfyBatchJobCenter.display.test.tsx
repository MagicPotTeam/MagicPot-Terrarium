import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { theme } from '@renderer/theme'
import ComfyBatchJobCenter from './ComfyBatchJobCenter'

const status: ComfyBatchStatus = {
  jobId: 'job-1',
  state: 'running',
  sourceDir: 'source',
  total: 10,
  success: 2,
  failed: 0,
  skipped: 3,
  running: 1,
  pending: 4,
  failedFiles: []
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      `${key}:${options?.count === undefined ? '' : options.count}`
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifyError: vi.fn(), notifyInfo: vi.fn() })
}))

vi.mock('../pages/QuickAppPage/QAppExecutePanel/comfyBatchJobState', () => ({
  cancelComfyBatchJob: vi.fn(),
  closeComfyBatchCenter: vi.fn(),
  closeComfyBatchJobDetails: vi.fn(),
  removeComfyBatchJob: vi.fn(),
  openComfyBatchJob: vi.fn(),
  refreshComfyBatchJobs: vi.fn(),
  retryComfyBatchJob: vi.fn(),
  useComfyBatchJobs: () => ({
    jobs: [status],
    selectedJobId: 'job-1',
    centerOpen: true,
    detailOpen: true,
    loading: false,
    error: undefined
  })
}))

describe('ComfyBatchJobCenter success display', () => {
  it('folds skipped items into success and hides skipped metrics', () => {
    render(
      <ThemeProvider theme={theme}>
        <ComfyBatchJobCenter />
      </ThemeProvider>
    )

    expect(screen.getByText('qapp.batch.success:5')).toBeInTheDocument()
    expect(screen.queryByText('qapp.batch.skipped:3')).not.toBeInTheDocument()
  })
})
