import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography
} from '@mui/material'
import type { ComfyBatchJobState, ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMessage } from '@renderer/hooks/useMessage'
import {
  cancelComfyBatchJob,
  closeComfyBatchCenter,
  closeComfyBatchJobDetails,
  openComfyBatchJob,
  refreshComfyBatchJobs,
  retryComfyBatchJob,
  useComfyBatchJobs
} from '../pages/QuickAppPage/QAppExecutePanel/comfyBatchJobState'

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
  const finished = status.success + status.failed + status.skipped
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
        {t('qapp.batch.success', { count: status.success })}
      </Typography>
      <Typography color="error.main">{t('qapp.batch.failed', { count: status.failed })}</Typography>
      <Typography>{t('qapp.batch.skipped', { count: status.skipped })}</Typography>
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
    error
  } = useComfyBatchJobs()
  const jobs = useMemo(() => allJobs.filter((job) => job.state !== 'cancelled'), [allJobs])
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

  const closeCenter = useCallback(() => closeComfyBatchCenter(), [])
  const closeDetails = useCallback(() => closeComfyBatchJobDetails(), [])
  const refresh = useCallback(() => void refreshComfyBatchJobs(), [])

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
            {jobs.length === 0 && !loading ? (
              <Typography color="text.secondary">{t('qapp.batch.no_jobs')}</Typography>
            ) : (
              <List disablePadding>
                {jobs.map((job) => {
                  const jobId = job.jobId || ''
                  const progress = getProgress(job)
                  return (
                    <ListItem key={jobId} disablePadding divider>
                      <ListItemButton
                        selected={jobId === selectedJobId}
                        onClick={() => showDetails(jobId)}
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
                                {t('qapp.batch.progress_summary', {
                                  finished: job.success + job.failed + job.skipped,
                                  total: job.total
                                })}
                                {job.state === 'queued' && job.queuePosition
                                  ? ` · ${t('qapp.batch.queue_position', { position: job.queuePosition })}`
                                  : ''}
                              </Typography>
                            </Stack>
                          }
                        />
                      </ListItemButton>
                    </ListItem>
                  )
                })}
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
  const jobId = status.jobId || ''
  const canRetry =
    status.state === 'error' || status.failed > 0 || status.pending > 0 || status.running > 0
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
            label={t('qapp.batch.eta')}
            value={
              status.state === 'completed' || status.state === 'cancelled'
                ? '—'
                : formatDuration(status.etaMs, t('qapp.batch.calculating'), '—')
            }
          />
          {status.sourceDir && (
            <MetricRow label={t('qapp.batch.source')} value={status.sourceDir} multiline />
          )}
          {status.outputDir && (
            <MetricRow label={t('qapp.batch.output')} value={status.outputDir} multiline />
          )}
          {status.error && <Typography color="error.main">{status.error}</Typography>}
          {status.failedFiles.length > 0 && (
            <Box sx={{ maxHeight: 140, overflow: 'auto' }}>
              {status.failedFiles.map((filename) => (
                <Typography key={filename} variant="caption" display="block" color="error.main">
                  {filename}
                </Typography>
              ))}
            </Box>
          )}
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
