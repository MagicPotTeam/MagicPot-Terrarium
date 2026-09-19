import { act, render, screen, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GetQueueResp } from '@shared/api/svcComfy'
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

const state = {
  jobs: [status],
  queue: { queue_running: [], queue_pending: [], queue_error: [] } as GetQueueResp,
  progressByPromptId: {} as Record<string, { value?: number; max?: number }>,
  selectedJobId: 'job-1',
  centerOpen: true,
  detailOpen: true,
  loading: false,
  error: undefined as string | undefined
}

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
  reorderComfyBatchJob: vi.fn(),
  retryComfyBatchJob: vi.fn(),
  updateComfyTaskProgress: vi.fn(),
  clearComfyTaskProgress: vi.fn(),
  cancelComfyQueueTask: vi.fn(),
  useComfyBatchJobs: () => state
}))

afterEach(() => {
  vi.useRealTimers()
  Object.assign(status, {
    pending: 4,
    running: 1,
    etaMs: 5_000,
    sourceDir: 'source',
    yielding: undefined
  })
  Object.assign(state, {
    jobs: [status],
    queue: { queue_running: [], queue_pending: [], queue_error: [] },
    progressByPromptId: {},
    detailOpen: true,
    error: undefined
  })
})

const expectFlexible = (element: Element): void => {
  const style = getComputedStyle(element)
  expect(Number.parseFloat(style.minWidth)).toBe(0)
  expect(style.flexGrow).toBe('1')
}

const expectCompactPadding = (element: Element): void => {
  const style = getComputedStyle(element)
  expect(style.paddingLeft).toBe('12px')
  expect(style.paddingRight).toBe('12px')
  expect(style.paddingTop).toBe('8px')
  expect(style.paddingBottom).toBe('8px')
}

const expectSeparateCloseAction = (row: Element, content: Element, label: string): void => {
  const close = within(row as HTMLElement).getByLabelText(label)
  expect(getComputedStyle(row).display).toBe('flex')
  expect(Number.parseFloat(getComputedStyle(row).minWidth)).toBe(0)
  expect(close.parentElement).toBe(row)
  expect(content).not.toContainElement(close)
  expect(getComputedStyle(close).flexShrink).toBe('0')
  expect(getComputedStyle(close).position).not.toBe('absolute')
  expect(getComputedStyle(close).position).not.toBe('fixed')
}

describe('ComfyBatchJobCenter display', () => {
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

  it.each([undefined, false, true])(
    'shows the appropriate row and details labels with yielding=%s and keeps running behavior',
    (yielding) => {
      Object.assign(status, { yielding })

      render(
        <ThemeProvider theme={theme}>
          <ComfyBatchJobCenter />
        </ThemeProvider>
      )

      const label = yielding ? 'qapp.batch.state_yielding:' : 'qapp.batch.state_running:'
      const otherLabel = yielding ? 'qapp.batch.state_running:' : 'qapp.batch.state_yielding:'
      const labels = screen.getAllByText(label)
      expect(labels).toHaveLength(2)
      expect(screen.queryByText(otherLabel)).not.toBeInTheDocument()
      for (const item of labels) {
        expect(item.closest('.MuiChip-root')).toHaveClass('MuiChip-colorPrimary')
      }
      expect(labels[0].closest('[data-rfd-draggable-id]')).toHaveAttribute(
        'data-rfd-draggable-id',
        'job-1'
      )
      expect(screen.getByRole('button', { name: 'qapp.batch.cancel:' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'qapp.batch.retry:' })).not.toBeInTheDocument()
      expect(screen.getByText('qapp.batch.running:1')).toBeInTheDocument()
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    }
  )

  it('removes dialog side padding and lets long paths fill the space beside fixed-size actions', () => {
    const longPath = 'C:\\very\\long\\source\\directory\\with\\many\\nested\\folders'
    Object.assign(status, { sourceDir: longPath })

    render(
      <ThemeProvider theme={theme}>
        <ComfyBatchJobCenter />
      </ThemeProvider>
    )

    const dialogContents = document.querySelectorAll('.MuiDialogContent-root')
    expect(dialogContents).toHaveLength(2)
    for (const content of dialogContents) {
      expect(getComputedStyle(content).paddingLeft).toBe('0px')
      expect(getComputedStyle(content).paddingRight).toBe('0px')
    }

    const pathLabel = screen.getByText(longPath, { selector: '.MuiTypography-noWrap' })
    const row = pathLabel.closest('.MuiListItem-root')!
    const rowButton = pathLabel.closest('.MuiListItemButton-root')!
    const text = pathLabel.closest('.MuiListItemText-root')!
    expect(rowButton).toBeInTheDocument()
    expectCompactPadding(rowButton)
    expectFlexible(rowButton)
    expectFlexible(text)
    expectFlexible(pathLabel)
    expect(getComputedStyle(pathLabel).maxWidth).not.toBe('55%')
    expect(getComputedStyle(pathLabel).textOverflow).toBe('ellipsis')
    expect(getComputedStyle(row.querySelector('.MuiChip-root')!).flexShrink).toBe('0')
    expect(text.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '50')
    expectSeparateCloseAction(row, rowButton, 'qapp.batch.cancel_and_remove:')

    const detailPath = screen.getAllByText(longPath).find((item) => item !== pathLabel)!
    expectFlexible(detailPath)
    expect(getComputedStyle(detailPath).wordBreak).toBe('break-all')
  })

  it('uses compact flexible single-task rows with a separate close action', () => {
    state.jobs = []
    state.detailOpen = false
    state.queue = {
      queue_running: [[1, 'task-single', {}, { client_id: 'client', created_at: 1 }, []]],
      queue_pending: [],
      queue_error: []
    }
    state.progressByPromptId = { 'task-single': { value: 2, max: 5 } }

    render(
      <ThemeProvider theme={theme}>
        <ComfyBatchJobCenter />
      </ThemeProvider>
    )

    const progress = screen.getByRole('progressbar', { name: 'qapp.batch.single_task_progress:' })
    const text = progress.closest('.MuiListItemText-root')!
    const row = text.closest('.MuiListItem-root')!
    expectCompactPadding(text)
    expectFlexible(text)
    expectFlexible(text.querySelector('.MuiTypography-noWrap')!)
    expect(getComputedStyle(text.querySelector('.MuiChip-root')!).flexShrink).toBe('0')
    expect(progress).toHaveAttribute('aria-valuenow', '40')
    expectSeparateCloseAction(row, text, 'qapp.batch.cancel_single_task:')
  })

  it('retains independent horizontal padding for empty-state and error messages', () => {
    state.jobs = []
    state.detailOpen = false
    state.error = 'Unable to load the queue'

    render(
      <ThemeProvider theme={theme}>
        <ComfyBatchJobCenter />
      </ThemeProvider>
    )

    for (const text of ['qapp.batch.no_jobs:', state.error]) {
      const message = screen.getByText(text)
      expect(getComputedStyle(message).paddingLeft).toBe('16px')
      expect(getComputedStyle(message).paddingRight).toBe('16px')
      expect(getComputedStyle(message.closest('.MuiDialogContent-root')!).paddingLeft).toBe('0px')
    }
  })
})
