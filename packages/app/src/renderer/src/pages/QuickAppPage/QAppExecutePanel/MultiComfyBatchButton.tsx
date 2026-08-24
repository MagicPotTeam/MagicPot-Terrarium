import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography
} from '@mui/material'
import { FolderOpen, Pause, PlayArrow, Refresh, Stop } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import { parseJsonPath } from '@shared/utils/jsonPath'
import type { Workflow } from '@shared/comfy/types'
import type { ComfyBatchState } from '@shared/api/svcComfyBatch'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

type MultiComfyBatchButtonProps = {
  currentQAppKey?: string
  imageInputSlot: string
  outputNodeIds?: string[]
  buildWorkflow: () => Workflow
  validateBatch?: (imageInputSlot: string) => boolean
  batchWorkflow?: string
  batchImageInputSlot?: string
}

const terminalStatuses = new Set(['cancelled', 'succeeded', 'failed'])

const formatDuration = (durationMs: number, t: TFunction): string => {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  return [
    days ? t('qapp.batch.duration.days', { count: days }) : '',
    hours ? t('qapp.batch.duration.hours', { count: hours }) : '',
    minutes ? t('qapp.batch.duration.minutes', { count: minutes }) : ''
  ]
    .filter(Boolean)
    .join(' ')
}

const getTrimmedMean = (values: readonly number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const trim = sorted.length >= 5 ? Math.floor(sorted.length * 0.2) : 0
  const samples = sorted.slice(trim, sorted.length - trim)
  return samples.reduce((sum, value) => sum + value, 0) / samples.length
}

const estimateBatchCompletion = (
  batch: ComfyBatchState,
  now: number,
  configuredConcurrency: number
): { remainingMs: number; completedAt: Date; sampleCount: number } | null => {
  if (batch.status !== 'running' && batch.status !== 'queued') return null
  const durations = batch.manifest.items.flatMap((item) =>
    item.status === 'succeeded'
      ? item.attempts.flatMap((attempt) => {
          if (!attempt.finishedAt || attempt.error) return []
          const duration = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
          return Number.isFinite(duration) && duration > 0 ? [duration] : []
        })
      : []
  )
  const incompleteItems = batch.manifest.items.filter(
    (item) => item.status !== 'succeeded' && item.status !== 'failed'
  )
  if (!incompleteItems.length) return null
  const meanDuration = getTrimmedMean(durations)
  if (meanDuration === null) return null

  const remainingWorkMs = batch.manifest.items.reduce((sum, item) => {
    if (item.status === 'succeeded' || item.status === 'failed') return sum
    if (item.status !== 'running') return sum + meanDuration
    const attempt = item.attempts[item.attempts.length - 1]
    const elapsed = attempt ? Math.max(0, now - Date.parse(attempt.startedAt)) : 0
    return sum + Math.max(0, meanDuration - elapsed)
  }, 0)
  const concurrency = Math.max(1, configuredConcurrency)
  const remainingMs = remainingWorkMs / concurrency
  return { remainingMs, completedAt: new Date(now + remainingMs), sampleCount: durations.length }
}

export default function MultiComfyBatchButton({
  currentQAppKey,
  imageInputSlot,
  outputNodeIds,
  buildWorkflow,
  validateBatch,
  batchWorkflow,
  batchImageInputSlot
}: MultiComfyBatchButtonProps) {
  const { t } = useTranslation()
  const { notifyError, notifyInfo } = useMessage()
  const [open, setOpen] = useState(false)
  const [batch, setBatch] = useState<ComfyBatchState | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [configuredConcurrency, setConfiguredConcurrency] = useState(1)

  useEffect(() => {
    if (!batch || terminalStatuses.has(batch.status)) return
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [batch])

  useEffect(() => {
    if (!batch || terminalStatuses.has(batch.status)) return
    const timer = window.setInterval(() => {
      void api()
        .svcComfyBatch.getBatch({ batchId: batch.batchId })
        .then(setBatch)
        .catch((error) => notifyError(String(error)))
    }, 750)
    return () => window.clearInterval(timer)
  }, [batch, notifyError])

  const counts = useMemo(() => {
    const items = batch?.items ?? []
    return {
      total: items.length,
      succeeded: items.filter((item) => item.status === 'succeeded').length,
      failed: items.filter((item) => item.status === 'failed').length,
      running: items.filter((item) => item.status === 'running').length
    }
  }, [batch])
  const estimate = useMemo(
    () => (batch ? estimateBatchCompletion(batch, now, configuredConcurrency) : null),
    [batch, configuredConcurrency, now]
  )

  const startBatch = useCallback(async () => {
    if (validateBatch && !validateBatch(imageInputSlot)) return
    const instances = await api().svcComfyBatch.listInstances({})
    const enabledInstances = instances.filter((profile) => profile.state.enabled)
    if (!enabledInstances.length) {
      notifyError(t('qapp.batch.errors.no_enabled_instance'))
      return
    }
    setConfiguredConcurrency(
      Math.max(
        1,
        enabledInstances.reduce((sum, profile) => sum + profile.state.maxConcurrency, 0)
      )
    )
    if (!outputNodeIds || outputNodeIds.length !== 1) {
      notifyError(t('qapp.batch.errors.single_output_required'))
      return
    }
    let workflow: Workflow
    const effectiveImageInputSlot = batchImageInputSlot ?? imageInputSlot
    if (batchWorkflow) {
      if (!currentQAppKey) {
        notifyError(t('qapp.batch.errors.batch_workflow_load_failed'))
        return
      }
      try {
        const directory = currentQAppKey.slice(0, currentQAppKey.lastIndexOf('/') + 1)
        const key = `${directory}${batchWorkflow.replace(/\.prompt\.json$/i, '')}`
        workflow = (await api().svcQApp.getQAppCfg({ key })).workflow
      } catch (error) {
        console.error('[MultiComfyBatchButton] Failed to load configured batch workflow:', error)
        notifyError(t('qapp.batch.errors.batch_workflow_load_failed'))
        return
      }
    } else {
      workflow = buildWorkflow()
    }
    const pathFields = parseJsonPath(effectiveImageInputSlot)
    const inputNodeId = pathFields[0]
    const inputField = pathFields[pathFields.length - 1]
    if (!inputNodeId || !inputField) {
      notifyError(t('qapp.batch.errors.invalid_image_binding'))
      return
    }
    const selected = await api().svcDialog.showOpenDialog({
      title: t('qapp.batch.select_directory_title'),
      properties: ['openDirectory']
    })
    const sourceRoot = selected.filePaths[0]
    if (selected.canceled || !sourceRoot) return
    setBatch(null)
    setBusy(true)
    setOpen(true)
    try {
      const next = await api().svcComfyBatch.startBatch({
        sourceRoot,
        userAuthorized: true,
        workflow,
        binding: { inputNodeId, inputField, outputNodeId: outputNodeIds[0], outputIndex: 0 }
      })
      setBatch(next)
      notifyInfo(t('qapp.batch.notifications.created', { count: next.items.length }))
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [
    batchImageInputSlot,
    batchWorkflow,
    buildWorkflow,
    currentQAppKey,
    imageInputSlot,
    notifyError,
    notifyInfo,
    outputNodeIds,
    t,
    validateBatch
  ])

  const mutateBatch = useCallback(
    async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
      if (!batch) return
      const request = { batchId: batch.batchId }
      const next =
        action === 'pause'
          ? await api().svcComfyBatch.pauseBatch(request)
          : action === 'resume'
            ? await api().svcComfyBatch.resumeBatch(request)
            : action === 'retry'
              ? await api().svcComfyBatch.retryFailed(request)
              : await api().svcComfyBatch.cancelBatch(request)
      setBatch(next)
    },
    [batch]
  )

  return (
    <>
      <Button
        startIcon={<FolderOpen />}
        variant="outlined"
        onClick={() => void startBatch()}
        disabled={busy}
      >
        {t('qapp.batch.action.open')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{t('qapp.batch.title')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {busy && !batch && (
              <Box>
                <Typography gutterBottom>{t('qapp.batch.preparing')}</Typography>
                <LinearProgress />
                <Typography variant="caption" color="text.secondary">
                  {t('qapp.batch.preparing_hint')}
                </Typography>
              </Box>
            )}
            {batch && (
              <Box>
                <Typography gutterBottom>
                  {t('qapp.batch.summary', {
                    batchId: batch.batchId.slice(0, 8),
                    status: t(`qapp.batch.status.${batch.status}`),
                    succeeded: counts.succeeded,
                    failed: counts.failed,
                    running: counts.running
                  })}
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={
                    counts.total ? ((counts.succeeded + counts.failed) / counts.total) * 100 : 0
                  }
                />
                {(batch.status === 'running' || batch.status === 'queued') && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {estimate
                      ? t('qapp.batch.eta', {
                          duration: formatDuration(estimate.remainingMs, t),
                          completedAt: estimate.completedAt.toLocaleString([], {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                          }),
                          preliminary:
                            estimate.sampleCount < 3 ? t('qapp.batch.eta_preliminary') : ''
                        })
                      : t('qapp.batch.eta_estimating')}
                  </Typography>
                )}
                {batch.status === 'paused' && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {t('qapp.batch.eta_paused')}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" display="block">
                  {t('qapp.batch.output_path', { path: batch.workspace.outputRoot })}
                </Typography>
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {batch?.status === 'running' && (
            <Button startIcon={<Pause />} onClick={() => void mutateBatch('pause')}>
              {t('qapp.batch.action.pause')}
            </Button>
          )}
          {batch?.status === 'paused' && (
            <Button startIcon={<PlayArrow />} onClick={() => void mutateBatch('resume')}>
              {t('qapp.batch.action.resume')}
            </Button>
          )}
          {batch?.status === 'failed' && (
            <Button startIcon={<Refresh />} onClick={() => void mutateBatch('retry')}>
              {t('qapp.batch.action.retry_failed')}
            </Button>
          )}
          {batch && !terminalStatuses.has(batch.status) && (
            <Button color="error" startIcon={<Stop />} onClick={() => void mutateBatch('cancel')}>
              {t('qapp.batch.action.cancel')}
            </Button>
          )}
          <Button disabled={busy && !batch} onClick={() => setOpen(false)}>
            {t('qapp.batch.action.close')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
