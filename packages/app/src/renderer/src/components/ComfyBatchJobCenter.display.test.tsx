import { act, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { theme } from '@renderer/theme'
import ComfyBatchJobCenter from './ComfyBatchJobCenter'

const status = {
  jobId: 'job-1',
  state: 'running',
  sourceDir: 'source',
  total: 10,
  success: 2,
  failed: 0,
  skipped: 3,
  running: 1,
  pending: 4,
  failedFiles: [],
  etaMs: 5_000
} as ComfyBatchStatus

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; rate?: string }) =>
      `${key}:${options?.count ?? options?.rate ?? ''}`
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifyError: vi.fn(), notifyInfo: vi.fn() })
}))

vi.mock('@renderer/hooks/useComfyEvent', () => ({
  useComfyEventCallback: () => undefined
}))

vi.mock('../pages/QuickAppPage/QAppExecutePanel/comfyBatchJobState', () => ({
  cancelComfyBatchJob: vi.fn(),
  closeComfyBatchCenter: vi.fn(),
  closeComfyBatchJobDetails: vi.fn(),
  removeComfyBatchJob: vi.fn(),
  openComfyBatchJob: vi.fn(),
  refreshComfyBatchJobs: vi.fn(),
  retryComfyBatchJob: vi.fn(),
  updateComfyTaskProgress: vi.fn(),
  clearComfyTaskProgress: vi.fn(),
  cancelComfyQueueTask: vi.fn(),
  useComfyBatchJobs: () => ({
    jobs: [status],
    queue: { queue_running: [], queue_pending: [], queue_error: [] },
    progressByPromptId: {},
    selectedJobId: 'job-1',
    centerOpen: true,
    detailOpen: true,
    loading: false,
    error: undefined
  })
}))

afterEach(() => {
  vi.useRealTimers()
  Object.assign(status, {
    pending: 4,
    running: 1,
    etaMs: 5_000
  })
})

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

  it('shows throughput and ticks the remaining estimate down locally', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))

    render(
      <ThemeProvider theme={theme}>
        <ComfyBatchJobCenter />
      </ThemeProvider>
    )

    expect(screen.getByText('qapp.batch.throughput:')).toBeInTheDocument()
    expect(screen.getByText('qapp.batch.throughput_value:1.00')).toBeInTheDocument()
    expect(screen.getByText('qapp.batch.eta:')).toBeInTheDocument()
    expect(screen.getByText('5s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(screen.getByText('4s')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows seconds per item for a slow batch instead of rounding throughput to zero', () => {
    Object.assign(status, {
      pending: 31,
      running: 3,
      etaMs: 13_440_000
    })

    render(
      <ThemeProvider theme={theme}>
        <ComfyBatchJobCenter />
      </ThemeProvider>
    )

    expect(screen.getByText('qapp.batch.throughput_value:395.29')).toBeInTheDocument()
  })
})
