import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography
} from '@mui/material'
import { Close as CloseIcon } from '@mui/icons-material'
import type { ComfyBatchJobState, ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useComfyEventCallback } from '@renderer/hooks/useComfyEvent'
import { useMessage } from '@renderer/hooks/useMessage'
import {
  cancelComfyBatchJob,
  cancelComfyQueueTask,
  clearComfyTaskProgress,
  closeComfyBatchCenter,
  closeComfyBatchJobDetails,
  openComfyBatchJob,
  removeComfyBatchJob,
  refreshComfyBatchJobs,
  retryComfyBatchJob,
  updateComfyTaskProgress,
  useComfyBatchJobs
} from '../pages/QuickAppPage/QAppExecutePanel/comfyBatchJobState'
import {
  getComfySingleTaskEntries,
  type ComfySingleTaskEntry
} from '../pages/QuickAppPage/QAppExecutePanel/comfyTaskQueueUtils'
import { getQueueItemDisplayLabel } from './sidePanelQueueUtils'

const formatDuration = (value: number | undefined, calculating: string, _empty: string): string => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return calculating
  if (value < 1000) return `${Math.round(value)} ms`
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainder}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

const formatSecondsPerItem = (
  value: number | undefined,
  calculating: string,
  format: (rate: string) => string
): string => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return calculating
  return format(value.toFixed(2))
}

const useSmoothEta = (status: ComfyBatchStatus): number | undefined => {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const etaStartedAt = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (
      status.etaMs === undefined ||
      !Number.isFinite(status.etaMs) ||
      status.etaMs < 0 ||
      status.state === 'completed' ||
      status.state === 'cancelled'
    ) {
      etaStartedAt.current = undefined
      return
    }
    etaStartedAt.current = Date.now()
  }, [status.etaMs, status.state, status.pending, status.running, status.success, status.failed])

  useEffect(() => {
    if (status.state !== 'running') return
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [status.state])

  if (status.etaMs === undefined || etaStartedAt.current === undefined) return status.etaMs
  return Math.max(0, status.etaMs - (nowMs - etaStartedAt.current))
}

const getSecondsPerItem = (status: ComfyBatchStatus): number | undefined => {
  const remainingItems = status.pending + status.running
  return status.etaMs && status.etaMs > 0 && remainingItems > 0
    ? status.etaMs / remainingItems / 1_000
    : undefined
}

const stateColor = (
  state: ComfyBatchJobState
): 'default' | 'primary' | 'success' | 'error' | 'warning' => {
  switch (state) {
    case 'queued':
      return 'warning'
    case 'running':
      return 'primary'
    case 'completed':
      return 'success'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'default'
    default:
      return 'default'
  }
}

const stateLabelKey = (state: ComfyBatchJobState): string => {
  switch (state) {
    case 'queued':
      return 'qapp.batch.state_queued'
    case 'running':
      return 'qapp.batch.state_running'
    case 'completed':
      return 'qapp.batch.state_completed'
    case 'error':
      return 'qapp.batch.state_error'
    case 'cancelled':
      return 'qapp.batch.state_cancelled'
    default:
      return 'qapp.batch.state_idle'
  }
}

const getProgress = (status: ComfyBatchStatus): number => {
  const finished = status.success + status.skipped
  return status.total > 0 ? Math.min(100, (finished / status.total) * 100) : 0
}

type StatusMetricsProps = {
  status: ComfyBatchStatus
}

const StatusMetrics = ({ status }: StatusMetricsProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
      <Typography>{t('qapp.batch.total', { count: status.total })}</Typography>
      <Typography color="success.main">
        {t('qapp.batch.success', { count: status.success + status.skipped })}
      </Typography>
      <Typography>{t('qapp.batch.running', { count: status.running })}</Typography>
      <Typography>{t('qapp.batch.pending', { count: status.pending })}</Typography>
    </Stack>
  )
}

type ComfyBatchJobCenterProps = {
  open?: boolean
}

const ComfyBatchJobCenter = ({
  open = true
}: ComfyBatchJobCenterProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { notifyError, notifyInfo } = useMessage()
  const {
    jobs: allJobs,
    selectedJobId,
    centerOpen,
    detailOpen,
    loading,
    error,
    queue,
    progressByPromptId
  } = useComfyBatchJobs()
  const jobs = useMemo(() => allJobs.filter((job) => job.state !== 'cancelled'), [allJobs])
  const singleTasks = useMemo(
    () => getComfySingleTaskEntries(queue, progressByPromptId),
    [progressByPromptId, queue]
  )
  const selectedJob = useMemo(
    () => jobs.find((job) => job.jobId === selectedJobId),
    [jobs, selectedJobId]
  )

  const showDetails = useCallback((jobId: string) => openComfyBatchJob(jobId), [])

  const cancel = useCallback(
    async (jobId: string) => {
      try {
        await cancelComfyBatchJob(jobId)
        notifyInfo(t('qapp.batch.cancel_sent'))
      } catch (caught) {
        notifyError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [notifyError, notifyInfo, t]
  )

  const retry = useCallback(
    async (jobId: string) => {
      try {
        await retryComfyBatchJob(jobId)
      } catch (caught) {
        notifyError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [notifyError]
  )

  const remove = useCallback(
    async (jobId: string) => {
      try {
        await cancelComfyBatchJob(jobId)
        await removeComfyBatchJob(jobId)
      } catch (caught) {
        notifyError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [notifyError]
  )

  const closeCenter = useCallback(() => closeComfyBatchCenter(), [])
  const closeDetails = useCallback(() => closeComfyBatchJobDetails(), [])
  const refresh = useCallback(() => void refreshComfyBatchJobs(), [])

  const cancelSingleTask = useCallback(
    async (promptId: string) => {
      try {
        await cancelComfyQueueTask(promptId)
        notifyInfo(t('qapp.batch.single_cancel_sent'))
      } catch (caught) {
        notifyError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [notifyError, notifyInfo, t]
  )

  useComfyEventCallback((event) => {
    if (event.type === 'progress') {
      updateComfyTaskProgress(event.data.prompt_id, event.data.value, event.data.max)
      return
    }

    if (
      event.type === 'executed' ||
      event.type === 'execution_success' ||
      event.type === 'execution_error' ||
      event.type === 'execution_interrupted'
    ) {
      clearComfyTaskProgress(event.data.prompt_id)
    }
  }, [])

  if (!open || !centerOpen) return null

  return (
    <>
      <Dialog open fullWidth maxWidth="md" onClose={closeCenter}>
        <DialogTitle>{t('qapp.batch.center_title')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            {loading && jobs.length === 0 && <LinearProgress />}
            {error && (
              <Typography color="error.main" variant="body2">
                {error}
              </Typography>
            )}
            {jobs.length === 0 && singleTasks.length === 0 && !loading ? (
              <Typography color="text.secondary">{t('qapp.batch.no_jobs')}</Typography>
            ) : (
              <List disablePadding>
                {jobs.map((job) => {
                  const jobId = job.jobId || ''
                  const progress = getProgress(job)
                  return (
                    <ListItem key={jobId} disablePadding divider sx={{ position: 'relative' }}>
                      <ListItemButton
                        selected={jobId === selectedJobId}
                        onClick={() => showDetails(jobId)}
                        sx={{ pr: 6 }}
                      >
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center" useFlexGap>
                              <Typography variant="body2" noWrap sx={{ maxWidth: '55%' }}>
                                {job.sourceDir || jobId}
                              </Typography>
                              <Chip
                                size="small"
                                color={stateColor(job.state)}
                                label={t(stateLabelKey(job.state))}
                              />
                            </Stack>
                          }
                          secondary={
                            <Stack spacing={0.5} sx={{ mt: 0.75 }}>
                              <LinearProgress variant="determinate" value={progress} />
                              <Typography variant="caption" color="text.secondary">
                                {t(
                                  job.state === 'error' || job.failed > 0
                                    ? 'qapp.batch.processed_summary'
                                    : 'qapp.batch.progress_summary',
                                  {
                                    finished: job.success + job.skipped,
                                    total: job.total
                                  }
                                )}
                                {job.state === 'queued' && job.queuePosition
                                  ? ` · ${t('qapp.batch.queue_position', { position: job.queuePosition })}`
                                  : ''}
                              </Typography>
                            </Stack>
                          }
                        />
                      </ListItemButton>
                      <IconButton
                        size="small"
                        aria-label={t('qapp.batch.cancel_and_remove')}
                        onClick={(event) => {
                          event.stopPropagation()
                          void remove(jobId)
                        }}
                        sx={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          zIndex: 1,
                          color: 'text.secondary'
                        }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </ListItem>
                  )
                })}
                {singleTasks.map((task) => (
                  <ComfySingleTaskRow key={task.id} task={task} onCancel={cancelSingleTask} />
                ))}
              </List>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={refresh}>{t('qapp.batch.refresh')}</Button>
          <Button onClick={closeCenter}>{t('qapp.batch.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={detailOpen && Boolean(selectedJob)}
        onClose={closeDetails}
        fullWidth
        maxWidth="sm"
      >
        {selectedJob && (
          <ComfyBatchJobDetails status={selectedJob} onCancel={cancel} onRetry={retry} />
        )}
      </Dialog>
    </>
  )
}

type ComfySingleTaskRowProps = {
  task: ComfySingleTaskEntry
  onCancel: (promptId: string) => Promise<void>
}

const ComfySingleTaskRow = ({ task, onCancel }: ComfySingleTaskRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const hasProgress = task.progress !== null
  const progress = hasProgress ? task.progress! * 100 : 0
  const progressVariant = task.state === 'running' && !hasProgress ? 'indeterminate' : 'determinate'

  return (
    <ListItem disablePadding divider sx={{ position: 'relative' }}>
      <ListItemText
        sx={{ px: 2, py: 1, pr: 6 }}
        primary={
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap>
            <Typography variant="body2" noWrap sx={{ maxWidth: '55%' }}>
              {t('qapp.batch.single_task')} · {getQueueItemDisplayLabel(task.item)}
            </Typography>
            <Chip
              size="small"
              color={stateColor(task.state)}
              label={t(stateLabelKey(task.state))}
            />
          </Stack>
        }
        secondary={
          <Stack spacing={0.5} sx={{ mt: 0.75 }}>
            <LinearProgress
              variant={progressVariant}
              value={progress}
              aria-label={t('qapp.batch.single_task_progress')}
            />
            <Typography variant="caption" color="text.secondary">
              {hasProgress ? `${Math.round(progress)}%` : t(stateLabelKey(task.state))}
            </Typography>
          </Stack>
        }
      />
      <IconButton
        size="small"
        aria-label={t('qapp.batch.cancel_single_task')}
        onClick={(event) => {
          event.stopPropagation()
          void onCancel(task.id)
        }}
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 1,
          color: 'text.secondary'
        }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </ListItem>
  )
}

type ComfyBatchJobDetailsProps = {
  status: ComfyBatchStatus
  onCancel: (jobId: string) => Promise<void>
  onRetry: (jobId: string) => Promise<void>
}

const ComfyBatchJobDetails = ({
  status,
  onCancel,
  onRetry
}: ComfyBatchJobDetailsProps): React.JSX.Element => {
  const { t } = useTranslation()
  const smoothEtaMs = useSmoothEta(status)
  const jobId = status.jobId || ''
  const canRetry =
    status.state === 'error' ||
    status.failed > 0 ||
    (status.state !== 'running' && status.pending > 0)
  return (
    <>
      <DialogTitle>{t('qapp.batch.detail_title')}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip color={stateColor(status.state)} label={t(stateLabelKey(status.state))} />
            {status.queuePosition !== undefined && (
              <Typography variant="body2" color="text.secondary">
                {t('qapp.batch.queue_position', { position: status.queuePosition })}
              </Typography>
            )}
          </Stack>
          <StatusMetrics status={status} />
          <LinearProgress variant="determinate" value={getProgress(status)} />
          <Divider />
          <MetricRow
            label={t('qapp.batch.elapsed')}
            value={formatDuration(status.elapsedMs, t('qapp.batch.calculating'), '—')}
          />
          <MetricRow
            label={t('qapp.batch.average_item')}
            value={formatDuration(status.averageItemMs, t('qapp.batch.calculating'), '—')}
          />
          <MetricRow
            label={t('qapp.batch.throughput')}
            value={formatSecondsPerItem(
              getSecondsPerItem(status),
              t('qapp.batch.calculating'),
              (rate) => t('qapp.batch.throughput_value', { rate })
            )}
          />
          <MetricRow
            label={t('qapp.batch.eta')}
            value={
              status.state === 'completed' || status.state === 'cancelled'
                ? '—'
                : formatDuration(smoothEtaMs, t('qapp.batch.calculating'), '—')
            }
          />
          {status.sourceDir && (
            <MetricRow label={t('qapp.batch.source')} value={status.sourceDir} multiline />
          )}
          {status.outputDir && (
            <MetricRow label={t('qapp.batch.output')} value={status.outputDir} multiline />
          )}
          {status.error && <Typography color="error.main">{status.error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {(status.state === 'queued' || status.state === 'running') && (
          <Button color="error" onClick={() => void onCancel(jobId)}>
            {t('qapp.batch.cancel')}
          </Button>
        )}
        {canRetry && <Button onClick={() => void onRetry(jobId)}>{t('qapp.batch.retry')}</Button>}
        <Button onClick={closeComfyBatchJobDetails}>{t('qapp.batch.close')}</Button>
      </DialogActions>
    </>
  )
}

type MetricRowProps = {
  label: string
  value: string
  multiline?: boolean
}

const MetricRow = ({ label, value, multiline = false }: MetricRowProps): React.JSX.Element => (
  <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="flex-start">
    <Typography variant="body2" color="text.secondary">
      {label}
    </Typography>
    <Typography
      variant="body2"
      sx={{ maxWidth: '72%', textAlign: 'right', wordBreak: multiline ? 'break-all' : 'normal' }}
    >
      {value}
    </Typography>
  </Stack>
)

export default ComfyBatchJobCenter
