import { FolderOpen } from '@mui/icons-material'
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
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { ComfyBatchStatus } from '@shared/api/svcComfyBatch'
import type { Workflow } from '@shared/comfy/types'
import { useCallback, useEffect, useSyncExternalStore, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQAppContext } from '../components/QAppContext'
import ComfyBatchProfileEditor from './ComfyBatchProfileEditor'
import {
  getComfyBatchProfileSnapshot,
  isComfyBatchProfileSnapshotLoaded,
  setComfyBatchProfileSnapshot,
  subscribeComfyBatchProfiles
} from './comfyBatchProfileState'

type BatchProcessButtonProps = {
  imageInputSlot: string
  outputNodeIds?: string[]
  buildWorkflow: () => Promise<Workflow> | Workflow
  validate: () => Promise<boolean> | boolean
}

const EMPTY_STATUS: ComfyBatchStatus = {
  state: 'idle',
  total: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  running: 0,
  pending: 0,
  failedFiles: []
}

const BatchProcessButton = ({
  imageInputSlot,
  outputNodeIds,
  buildWorkflow,
  validate
}: BatchProcessButtonProps) => {
  const { currentQAppKey } = useQAppContext()
  const { t } = useTranslation()
  const { notifyError, notifyInfo } = useMessage()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ComfyBatchStatus>(EMPTY_STATUS)
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [profilesEditing, setProfilesEditing] = useState(false)
  const profiles = useSyncExternalStore(
    subscribeComfyBatchProfiles,
    getComfyBatchProfileSnapshot,
    getComfyBatchProfileSnapshot
  )

  const loadProfiles = useCallback(async () => {
    try {
      setProfilesLoading(true)
      const result = await api().svcComfyBatch.listProfiles({})
      setComfyBatchProfileSnapshot(result.profiles)
      setProfilesEditing(false)
    } catch (error) {
      setProfilesEditing(true)
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilesLoading(false)
    }
  }, [notifyError])

  useEffect(() => {
    if (open) void loadProfiles()
  }, [loadProfiles, open])

  useEffect(() => {
    if (!open || status.state !== 'running' || !status.jobId) return
    const timer = window.setInterval(async () => {
      try {
        const result = await api().svcComfyBatch.status({ jobId: status.jobId })
        setStatus(result.status)
      } catch (error) {
        console.warn('[ComfyBatch] status poll failed:', error)
      }
    }, 700)
    return () => window.clearInterval(timer)
  }, [open, status.jobId, status.state])

  const start = useCallback(async () => {
    try {
      if (!(await validate())) return
      if (!currentQAppKey) throw new Error('Quick App key is missing')
      if (!outputNodeIds?.length) throw new Error('Quick App outputNodeIds must not be empty')
      const saved = await api().svcComfyBatch.replaceProfiles({ profiles })
      setComfyBatchProfileSnapshot(saved.profiles)
      const selection = await api().svcDialog.showOpenDialog({
        title: t('qapp.batch.select_source'),
        properties: ['openDirectory']
      })
      const sourceDir = selection.filePaths[0]
      if (selection.canceled || !sourceDir) return
      const result = await api().svcComfyBatch.start({
        sourceDir,
        qAppKey: currentQAppKey,
        workflow: await buildWorkflow(),
        imageInputSlot,
        outputNodeIds
      })
      setStatus(result.status)
      setOpen(true)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }, [
    buildWorkflow,
    currentQAppKey,
    imageInputSlot,
    notifyError,
    outputNodeIds,
    profiles,
    t,
    validate
  ])

  const cancel = useCallback(async () => {
    if (!status.jobId) return
    try {
      const result = await api().svcComfyBatch.cancel({ jobId: status.jobId })
      setStatus(result.status)
      notifyInfo(t('qapp.batch.cancel_sent'))
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }, [notifyError, notifyInfo, status.jobId, t])

  const retryFailed = useCallback(async () => {
    if (!status.jobId) return
    try {
      const result = await api().svcComfyBatch.retryFailed({ jobId: status.jobId })
      setStatus(result.status)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }, [notifyError, status.jobId])

  const finished = status.success + status.failed + status.skipped
  const progress = status.total > 0 ? Math.min(100, (finished / status.total) * 100) : 0

  return (
    <>
      <Button variant="outlined" startIcon={<FolderOpen />} onClick={() => setOpen(true)}>
        {t('qapp.batch.button')}
      </Button>
      <Dialog
        open={open}
        onClose={() => status.state !== 'running' && setOpen(false)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{t('qapp.batch.title')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {status.state !== 'running' && !status.sourceDir && (
              <Stack spacing={1.5}>
                <Typography variant="subtitle2">{t('qapp.batch.instances')}</Typography>
                <ComfyBatchProfileEditor
                  profiles={profiles}
                  onProfilesChange={setComfyBatchProfileSnapshot}
                  onEditingChange={setProfilesEditing}
                />
                <Button
                  variant="contained"
                  disabled={
                    profilesLoading ||
                    profilesEditing ||
                    !isComfyBatchProfileSnapshotLoaded() ||
                    profiles.every((profile) => !profile.enabled)
                  }
                  onClick={() => void start()}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {t('qapp.batch.start')}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  {t('qapp.batch.output_hint')}
                </Typography>
              </Stack>
            )}

            {status.sourceDir && (
              <>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {t('qapp.batch.source')}
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                    {status.sourceDir}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    {t('qapp.batch.output')}
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                    {status.outputDir || '-'}
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={progress} />
                <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
                  <Typography>{t('qapp.batch.total', { count: status.total })}</Typography>
                  <Typography color="success.main">
                    {t('qapp.batch.success', { count: status.success })}
                  </Typography>
                  <Typography color="error.main">
                    {t('qapp.batch.failed', { count: status.failed })}
                  </Typography>
                  <Typography>{t('qapp.batch.skipped', { count: status.skipped })}</Typography>
                  <Typography>{t('qapp.batch.running', { count: status.running })}</Typography>
                  <Typography>{t('qapp.batch.pending', { count: status.pending })}</Typography>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t('qapp.batch.state', { state: status.state })}
                </Typography>
                {status.error && <Typography color="error.main">{status.error}</Typography>}
                {status.failedFiles.length > 0 && (
                  <Box sx={{ maxHeight: 120, overflow: 'auto' }}>
                    {status.failedFiles.map((filename) => (
                      <Typography
                        key={filename}
                        variant="caption"
                        display="block"
                        color="error.main"
                      >
                        {filename}
                      </Typography>
                    ))}
                  </Box>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {status.state === 'running' && (
            <Button color="error" onClick={() => void cancel()}>
              {t('qapp.batch.cancel')}
            </Button>
          )}
          {status.state !== 'running' &&
            (status.failed > 0 || status.pending > 0 || status.state === 'error') && (
              <Button onClick={() => void retryFailed()}>{t('qapp.batch.retry')}</Button>
            )}
          {status.state !== 'running' && status.sourceDir && (
            <Button onClick={() => setStatus(EMPTY_STATUS)}>{t('qapp.batch.new')}</Button>
          )}
          {status.state !== 'running' && (
            <Button onClick={() => setOpen(false)}>{t('qapp.batch.close')}</Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  )
}

export default BatchProcessButton
