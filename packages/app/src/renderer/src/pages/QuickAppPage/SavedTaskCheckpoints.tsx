import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import {
  savedTaskCheckpointsSchema,
  type SavedTaskCheckpoint
} from '@shared/figplugin/taskRecovery'

/** Explicit read-only lookup, never rehydrates runtime authority or starts host/model work. */
export default function SavedTaskCheckpoints() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SavedTaskCheckpoint[] | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const lifetime = useRef<object | null>(null)
  const inFlight = useRef<object | null>(null)
  useEffect(() => {
    const token = {}
    lifetime.current = token
    return () => {
      if (lifetime.current === token) lifetime.current = null
    }
  }, [])
  const load = async () => {
    if (inFlight.current || !lifetime.current) return
    const token = lifetime.current
    inFlight.current = token
    setPending(true)
    setFailed(false)
    setRows(null)
    try {
      const values = savedTaskCheckpointsSchema.parse(
        await api().svcFigPluginCenter.listSavedCheckpoints({})
      )
      if (lifetime.current === token)
        setRows(values.filter((value) => value.expiresAt > Date.now()))
    } catch {
      if (lifetime.current === token) setFailed(true)
    } finally {
      if (inFlight.current === token) inFlight.current = null
      if (lifetime.current === token) setPending(false)
    }
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="saved-task-checkpoints">
      <Stack spacing={1}>
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.checkpoints.title')}
        </Typography>
        <Typography>{t('figplugin.checkpoints.guidance')}</Typography>
        <Button onClick={() => void load()} disabled={pending}>
          {t('figplugin.checkpoints.load')}
        </Button>
        {failed && <Alert severity="error">{t('figplugin.checkpoints.failed')}</Alert>}
        {rows?.length === 0 && (
          <Typography role="status">{t('figplugin.checkpoints.empty')}</Typography>
        )}
        {rows?.map((row) => (
          <Paper key={row.baselineId} variant="outlined" sx={{ p: 1.5 }}>
            <Stack spacing={1}>
              <Typography>
                {row.pluginId} / {row.host} / {row.projectId}
              </Typography>
              <Typography>
                {t('figplugin.checkpoints.scope', {
                  document: row.documentId,
                  scope: row.scopeId,
                  targets: row.targetIds.join(', ')
                })}
              </Typography>
              <TextField
                size="small"
                fullWidth
                label={t('figplugin.checkpoints.code')}
                value={row.baselineId}
                slotProps={{ input: { readOnly: true } }}
                onFocus={(event) => event.target.select()}
              />
              <Typography>
                {t('figplugin.checkpoints.remaining', {
                  used: row.correctionRoundsUsed,
                  max: row.maxCorrectionRounds,
                  accepted: new Date(row.acceptedAt).toLocaleString(),
                  expiry: new Date(row.expiresAt).toLocaleString()
                })}
              </Typography>
            </Stack>
          </Paper>
        ))}
        <Alert severity="warning">{t('figplugin.checkpoints.boundary')}</Alert>
      </Stack>
    </Paper>
  )
}
