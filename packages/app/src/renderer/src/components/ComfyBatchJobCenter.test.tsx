import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { theme } from '@renderer/theme'
import ComfyBatchJobCenter from './ComfyBatchJobCenter'

const { cancelMock, removeMock, retryMock } = vi.hoisted(() => ({
  cancelMock: vi.fn(),
  removeMock: vi.fn(),
  retryMock: vi.fn()
}))
const state = {
  jobs: [] as ComfyBatchStatus[],
  selectedJobId: undefined as string | undefined,
  centerOpen: true,
  detailOpen: false,
  loading: false,
  error: undefined as string | undefined
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifyError: vi.fn(), notifyInfo: vi.fn() })
}))

vi.mock('../pages/QuickAppPage/QAppExecutePanel/comfyBatchJobState', () => ({
  cancelComfyBatchJob: cancelMock,
  closeComfyBatchCenter: vi.fn(),
  closeComfyBatchJobDetails: vi.fn(),
  removeComfyBatchJob: removeMock,
  openComfyBatchJob: vi.fn(),
  refreshComfyBatchJobs: vi.fn(),
  retryComfyBatchJob: retryMock,
  useComfyBatchJobs: () => state
}))

const renderCenter = (): void => {
  render(
    <ThemeProvider theme={theme}>
      <ComfyBatchJobCenter />
    </ThemeProvider>
  )
}

describe('ComfyBatchJobCenter', () => {
  beforeEach(() => {
    cancelMock.mockReset()
    cancelMock.mockResolvedValue({})
    removeMock.mockReset()
    removeMock.mockResolvedValue({})
    retryMock.mockReset()
    retryMock.mockResolvedValue({})
    state.jobs = [
      {
        jobId: 'job-1',
        state: 'completed',
        sourceDir: 'source',
        total: 1,
        success: 1,
        failed: 0,
        skipped: 0,
        running: 0,
        pending: 0,
        failedFiles: []
      }
    ]
  })

  it('cancels and removes a row without opening the job details', async () => {
    renderCenter()

    const removeButton = screen.getByRole('button', { name: 'qapp.batch.cancel_and_remove' })
    fireEvent.click(removeButton)

    expect(cancelMock).toHaveBeenCalledWith('job-1')
    await vi.waitFor(() => expect(removeMock).toHaveBeenCalledWith('job-1'))
    expect(screen.queryByText('qapp.batch.detail_title')).not.toBeInTheDocument()
  })

  it('allows retrying failed items while the batch is running', async () => {
    state.jobs = [
      {
        ...state.jobs[0],
        state: 'running',
        total: 3,
        failed: 1,
        running: 1,
        pending: 1,
        failedFiles: ['first.jpg']
      }
    ]
    state.selectedJobId = 'job-1'
    state.detailOpen = true
    renderCenter()

    fireEvent.click(screen.getByRole('button', { name: 'qapp.batch.retry' }))

    await vi.waitFor(() => expect(retryMock).toHaveBeenCalledWith('job-1'))
  })

  it('does not offer retry for a running batch with no failed items', () => {
    state.jobs = [
      {
        ...state.jobs[0],
        state: 'running',
        failed: 0,
        running: 1,
        pending: 1,
        failedFiles: []
      }
    ]
    state.selectedJobId = 'job-1'
    state.detailOpen = true
    renderCenter()

    expect(screen.queryByRole('button', { name: 'qapp.batch.retry' })).not.toBeInTheDocument()
  })
})
