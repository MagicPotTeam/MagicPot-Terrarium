import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import {
  figPluginExecutionHistorySchema,
  type FigPluginExecutionHistory
} from '@shared/figplugin/executionAudit'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'

/** Read-only persisted evidence. Never used to restore a grant or replay a write. */
export default function PluginExecutionHistoryPanel({
  items
}: {
  items: FigPluginManagedSummary[]
}) {
  const { t } = useTranslation()
  const id = useId()
  const [pluginId, setPluginId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [limit, setLimit] = useState(50)
  const [history, setHistory] = useState<FigPluginExecutionHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pending = useRef<number | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])

  const invalidate = () => {
    pending.current = null
    generation.current++
    setHistory(null)
    setFailed(false)
    setLoading(false)
  }
  const load = async () => {
    if (pending.current !== null) return
    const current = ++generation.current
    pending.current = current
    const live = () => mounted.current && current === generation.current
    setLoading(true)
    setFailed(false)
    try {
      const result = await api().svcFigPluginCenter.executionHistory({
        ...(pluginId ? { pluginId } : {}),
        ...(projectId ? { projectId } : {}),
        limit
      })
      if (!live()) return
      const value = figPluginExecutionHistorySchema.parse(result)
      if (
        value.records.length > limit ||
        value.records.some(
          (record) =>
            (pluginId && record.pluginId !== pluginId) ||
            (projectId && record.projectId !== projectId)
        )
      )
        throw new Error('INVALID_HISTORY')
      setHistory(value)
    } catch {
      if (live()) {
        setHistory(null)
        setFailed(true)
      }
    } finally {
      if (live()) {
        pending.current = null
        setLoading(false)
      }
    }
  }

  const plugins = [...new Map(items.map((item) => [item.pluginId, item])).values()]
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={`${id}-title`}
      data-testid="figplugin-history"
      sx={{ p: 2, overflowWrap: 'anywhere' }}
    >
      <Stack spacing={2} aria-busy={loading}>
        <Typography id={`${id}-title`} variant="h6" component="h2">
          {t('figplugin.history.title')}
        </Typography>
        <Typography>{t('figplugin.history.description')}</Typography>
        <Typography variant="body2">{t('figplugin.history.boundary')}</Typography>
        <Stack direction="row" gap={2} flexWrap="wrap">
          <TextField
            id={`${id}-plugin`}
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            label={t('figplugin.history.plugin')}
            value={pluginId}
            onChange={(event) => {
              invalidate()
              setPluginId(event.target.value)
            }}
          >
            <option value="">{t('figplugin.history.allPlugins')}</option>
            {plugins.map((item) => (
              <option key={item.pluginId} value={item.pluginId}>
                {item.name} ({item.pluginId})
              </option>
            ))}
          </TextField>
          <TextField
            id={`${id}-project`}
            label={t('figplugin.history.project')}
            value={projectId}
            inputProps={{ maxLength: 160 }}
            onChange={(event) => {
              invalidate()
              setProjectId(event.target.value)
            }}
          />
          <TextField
            id={`${id}-limit`}
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            label={t('figplugin.history.limit')}
            value={limit}
            onChange={(event) => {
              invalidate()
              setLimit(Number(event.target.value))
            }}
          >
            {[50, 100, 256].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </TextField>
          <Button onClick={() => void load()} disabled={loading} variant="outlined">
            {t('figplugin.history.load')}
          </Button>
        </Stack>
        {failed && <Alert severity="error">{t('figplugin.history.error')}</Alert>}
        {history && (
          <>
            <Typography role="status">
              {t('figplugin.history.count', { count: history.records.length })}
            </Typography>
            {history.writeFailed && (
              <Alert severity="warning">{t('figplugin.history.writeFailed')}</Alert>
            )}
            {history.truncated && <Alert severity="info">{t('figplugin.history.truncated')}</Alert>}
            {!history.records.length && <Typography>{t('figplugin.history.empty')}</Typography>}
            {history.records.map((event, index) => (
              <Paper
                key={`${event.executionId}:${event.at}:${index}`}
                component="article"
                variant="outlined"
                sx={{ p: 1.5 }}
              >
                <Stack spacing={0.5}>
                  <Typography>
                    {event.pluginId} / {event.host} / {event.projectId}
                  </Typography>
                  <Typography>
                    {t(`figplugin.history.states.${event.state}`)} · {event.completed}/{event.total}{' '}
                    · {t(`figplugin.history.effects.${event.effect}`)}
                  </Typography>
                  <Typography variant="body2">
                    {new Date(event.at).toLocaleString()} · {event.durationMs} ms
                  </Typography>
                  {event.errorCode && (
                    <Typography>
                      {t('figplugin.history.errorCode', { code: event.errorCode })}
                    </Typography>
                  )}
                  {event.correctionAttempt && (
                    <Typography>
                      {t('figplugin.history.correction', {
                        round: event.correctionAttempt.round,
                        max: event.correctionAttempt.maxCorrectionRounds,
                        consumed: t(
                          event.correctionAttempt.consumed
                            ? 'figplugin.history.consumed'
                            : 'figplugin.history.unconsumed'
                        )
                      })}
                    </Typography>
                  )}
                  <Box component="details">
                    <Box component="summary" sx={{ cursor: 'pointer' }}>
                      {t('figplugin.history.identifiers')}
                    </Box>
                    <Typography variant="body2">Execution: {event.executionId}</Typography>
                    <Typography variant="body2">Call: {event.callId}</Typography>
                    <Typography variant="body2">Request: {event.requestId}</Typography>
                    <Typography variant="body2">Plan SHA-256: {event.planSha256}</Typography>
                    {event.correctionAttempt && (
                      <Typography variant="body2">
                        Source execution: {event.correctionAttempt.sourceExecutionId}
                      </Typography>
                    )}
                    {event.visualEvidenceSha256 && (
                      <Typography variant="body2">
                        Visual SHA-256: {event.visualEvidenceSha256}
                      </Typography>
                    )}
                    {event.visualComparisonChangedCount !== undefined && (
                      <Typography variant="body2">
                        {t('figplugin.history.comparison', {
                          changed: event.visualComparisonChangedCount,
                          count: event.visualComparisonTargetCount
                        })}
                      </Typography>
                    )}
                  </Box>
                </Stack>
              </Paper>
            ))}
          </>
        )}
      </Stack>
    </Paper>
  )
}
