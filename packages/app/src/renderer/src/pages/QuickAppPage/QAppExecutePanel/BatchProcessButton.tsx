import { Add, Delete, FolderOpen, Science } from '@mui/icons-material'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type {
  ComfyBatchProfile,
  ComfyBatchStatus,
  ComfyBatchProbeResult
} from '@shared/api/svcComfyBatch'
import type { Workflow } from '@shared/comfy/types'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQAppContext } from '../components/QAppContext'

type BatchProcessButtonProps = {
  isConnected: boolean
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

const newProfile = (): ComfyBatchProfile => ({
  id: globalThis.crypto?.randomUUID?.() || `comfy-${Date.now()}`,
  name: 'ComfyUI',
  baseUrl: 'http://127.0.0.1:8188',
  enabled: true,
  maxConcurrency: 1
})

const BatchProcessButton = ({
  isConnected,
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
  const [profiles, setProfiles] = useState<ComfyBatchProfile[]>([])
  const [probeResults, setProbeResults] = useState<Record<string, ComfyBatchProbeResult>>({})

  const loadProfiles = useCallback(async () => {
    try {
      const result = await api().svcComfyBatch.listProfiles({})
      setProfiles(result.profiles)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }, [notifyError])

  useEffect(() => {
    if (open && profiles.length === 0) void loadProfiles()
  }, [loadProfiles, open, profiles.length])

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

  const probeProfile = useCallback(async (profile: ComfyBatchProfile) => {
    try {
      const result = await api().svcComfyBatch.probeProfile({ baseUrl: profile.baseUrl })
      setProbeResults((current) => ({ ...current, [profile.id]: result.result }))
    } catch (error) {
      setProbeResults((current) => ({
        ...current,
        [profile.id]: {
          ok: false,
          baseUrl: profile.baseUrl,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  }, [])

  const updateProfile = useCallback((id: string, patch: Partial<ComfyBatchProfile>) => {
    setProfiles((current) =>
      current.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile))
    )
  }, [])

  const start = useCallback(async () => {
    try {
      if (!isConnected) throw new Error(t('qapp.batch.comfy_not_ready'))
      if (!(await validate())) return
      if (!currentQAppKey) throw new Error('Quick App key is missing')
      if (!outputNodeIds?.length) throw new Error('Quick App outputNodeIds must not be empty')
      await api().svcComfyBatch.replaceProfiles({ profiles })
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
    isConnected,
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
      <Button
        variant="outlined"
        startIcon={<FolderOpen />}
        disabled={!isConnected}
        onClick={() => setOpen(true)}
      >
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
                {profiles.map((profile) => {
                  const probe = probeResults[profile.id]
                  return (
                    <Stack
                      key={profile.id}
                      direction={{ xs: 'column', md: 'row' }}
                      spacing={1}
                      alignItems={{ md: 'center' }}
                    >
                      <FormControlLabel
                        control={
                          <Switch
                            checked={profile.enabled}
                            onChange={(_, enabled) => updateProfile(profile.id, { enabled })}
                          />
                        }
                        label={t('qapp.batch.enabled')}
                      />
                      <TextField
                        size="small"
                        label={t('qapp.batch.name')}
                        value={profile.name}
                        onChange={(event) =>
                          updateProfile(profile.id, { name: event.target.value })
                        }
                        sx={{ minWidth: 130 }}
                      />
                      <TextField
                        size="small"
                        label={t('qapp.batch.url')}
                        value={profile.baseUrl}
                        onChange={(event) =>
                          updateProfile(profile.id, { baseUrl: event.target.value })
                        }
                        sx={{ flex: 1, minWidth: 240 }}
                      />
                      <TextField
                        size="small"
                        type="number"
                        label={t('qapp.batch.concurrency')}
                        value={profile.maxConcurrency}
                        slotProps={{ htmlInput: { min: 1, max: 32 } }}
                        onChange={(event) =>
                          updateProfile(profile.id, {
                            maxConcurrency: Math.max(1, Number(event.target.value) || 1)
                          })
                        }
                        sx={{ width: 90 }}
                      />
                      <Button startIcon={<Science />} onClick={() => void probeProfile(profile)}>
                        {t('qapp.batch.test')}
                      </Button>
                      <Button
                        color="error"
                        onClick={() =>
                          setProfiles((current) => current.filter((item) => item.id !== profile.id))
                        }
                      >
                        <Delete />
                      </Button>
                      {probe && (
                        <Typography
                          variant="caption"
                          color={probe.ok ? 'success.main' : 'error.main'}
                        >
                          {probe.ok ? `${probe.latencyMs} ms` : probe.error}
                        </Typography>
                      )}
                    </Stack>
                  )
                })}
                <Stack direction="row" spacing={1}>
                  <Button
                    startIcon={<Add />}
                    onClick={() => setProfiles((items) => [...items, newProfile()])}
                  >
                    {t('qapp.batch.add_instance')}
                  </Button>
                  <Button
                    variant="contained"
                    disabled={profiles.every((profile) => !profile.enabled)}
                    onClick={() => void start()}
                  >
                    {t('qapp.batch.start')}
                  </Button>
                </Stack>
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
          {status.state !== 'running' && status.failed > 0 && (
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
