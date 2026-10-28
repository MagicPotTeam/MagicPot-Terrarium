import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import {
  figPluginPlanningHistoryRequestSchema,
  figPluginPlanningHistorySchema,
  type FigPluginPlanningAuditEvent,
  type FigPluginPlanningHistory
} from '@shared/figplugin/planningAudit'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const compareEvents = (left: FigPluginPlanningAuditEvent, right: FigPluginPlanningAuditEvent) =>
  right.at - left.at ||
  right.sequence - left.sequence ||
  compareText(left.correlationId, right.correlationId) ||
  compareText(left.callId, right.callId) ||
  compareText(left.requestId, right.requestId) ||
  compareText(left.pluginId, right.pluginId) ||
  compareText(left.projectId, right.projectId) ||
  compareText(canonicalFigPluginJson(left), canonicalFigPluginJson(right))
const filterFieldSx = { width: 280, minWidth: 0, maxWidth: '100%', flexShrink: 0 }

/** Saved metadata only: reading never creates a bridge, dispatches a model, or resumes a task. */
export default function PluginPlanningHistoryPanel({
  items
}: {
  items: FigPluginManagedSummary[]
}) {
  const { t } = useTranslation()
  const id = useId()
  const [pluginId, setPluginId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [callId, setCallId] = useState('')
  const [correlationId, setCorrelationId] = useState('')
  const [limit, setLimit] = useState(50)
  const [history, setHistory] = useState<FigPluginPlanningHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pending = useRef<number | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
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
    setHistory(null)
    try {
      const request = figPluginPlanningHistoryRequestSchema.parse({
        ...(pluginId ? { pluginId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(callId ? { callId } : {}),
        ...(correlationId ? { correlationId } : {}),
        limit
      })
      const result = await api().svcFigPluginCenter.planningHistory(request)
      if (!live()) return
      const value = figPluginPlanningHistorySchema.parse(result)
      if (
        value.records.length > limit ||
        value.records.some(
          (record) =>
            (request.pluginId !== undefined && record.pluginId !== request.pluginId) ||
            (request.projectId !== undefined && record.projectId !== request.projectId) ||
            (request.callId !== undefined && record.callId !== request.callId) ||
            (request.correlationId !== undefined && record.correlationId !== request.correlationId)
        )
      )
        throw new Error('INVALID_HISTORY')
      setHistory({ ...value, records: [...value.records].sort(compareEvents) })
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
      data-testid="figplugin-planning-history"
      sx={{ p: 2, overflowWrap: 'anywhere' }}
    >
      <Stack spacing={2} aria-busy={loading}>
        <Typography id={`${id}-title`} variant="h6" component="h2">
          {t('figplugin.planningHistory.title')}
        </Typography>
        <Typography>{t('figplugin.planningHistory.description')}</Typography>
        <Typography variant="body2">{t('figplugin.planningHistory.boundary')}</Typography>
        <Typography variant="body2">{t('figplugin.planningHistory.dispatchBoundary')}</Typography>
        <Stack direction="row" gap={2} flexWrap="wrap" alignItems="flex-start">
          <TextField
            id={`${id}-plugin`}
            sx={filterFieldSx}
            label={t('figplugin.planningHistory.plugin')}
            helperText={t('figplugin.planningHistory.pluginHelp')}
            value={pluginId}
            inputProps={{ maxLength: 128, list: `${id}-plugins` }}
            onChange={(event) => {
              invalidate()
              setPluginId(event.target.value)
            }}
          />
          <datalist id={`${id}-plugins`}>
            {plugins.map((item) => (
              <option key={item.pluginId} value={item.pluginId} label={item.name} />
            ))}
          </datalist>
          <TextField
            id={`${id}-project`}
            sx={filterFieldSx}
            label={t('figplugin.planningHistory.project')}
            value={projectId}
            inputProps={{ maxLength: 160 }}
            onChange={(event) => {
              invalidate()
              setProjectId(event.target.value)
            }}
          />
          <TextField
            id={`${id}-call`}
            sx={{ ...filterFieldSx, width: 320 }}
            label={t('figplugin.planningHistory.call')}
            helperText={t('figplugin.planningHistory.hexIdHelp')}
            value={callId}
            inputProps={{ maxLength: 32, spellCheck: false }}
            onChange={(event) => {
              invalidate()
              setCallId(event.target.value)
            }}
          />
          <TextField
            id={`${id}-correlation`}
            sx={{ ...filterFieldSx, width: 320 }}
            label={t('figplugin.planningHistory.correlation')}
            helperText={t('figplugin.planningHistory.hexIdHelp')}
            value={correlationId}
            inputProps={{ maxLength: 32, spellCheck: false }}
            onChange={(event) => {
              invalidate()
              setCorrelationId(event.target.value)
            }}
          />
          <TextField
            id={`${id}-limit`}
            sx={{ ...filterFieldSx, width: 176 }}
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            label={t('figplugin.planningHistory.limit')}
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
          <Button
            onClick={() => void load()}
            disabled={loading}
            variant="outlined"
            sx={{ height: 56, flexShrink: 0 }}
          >
            {t('figplugin.planningHistory.load')}
          </Button>
        </Stack>
        {failed && <Alert severity="error">{t('figplugin.planningHistory.error')}</Alert>}
        {history && (
          <>
            <Typography role="status">
              {t('figplugin.planningHistory.count', { count: history.records.length })}
            </Typography>
            <Typography variant="body2">
              {t('figplugin.planningHistory.recordedAt', {
                time: new Date(history.recordedAt).toLocaleString()
              })}
            </Typography>
            {history.writeFailed && (
              <Alert severity="warning">{t('figplugin.planningHistory.writeFailed')}</Alert>
            )}
            {history.truncated && (
              <Alert severity="info">{t('figplugin.planningHistory.truncated')}</Alert>
            )}
            {!history.records.length && (
              <Typography>{t('figplugin.planningHistory.empty')}</Typography>
            )}
            {history.records.map((event, index) => (
              <Paper
                key={`${event.callId}:${event.sequence}:${event.at}:${index}`}
                component="article"
                variant="outlined"
                sx={{ p: 1.5 }}
              >
                <Stack spacing={0.5}>
                  <Typography>
                    {event.pluginId} / {event.host} / {event.projectId}
                  </Typography>
                  <Typography>{t(`figplugin.planningHistory.states.${event.state}`)}</Typography>
                  <Typography variant="body2">
                    {t(`figplugin.planningHistory.features.${event.featureId}`)}
                  </Typography>
                  <Typography variant="body2">
                    {t('figplugin.planningHistory.timing', {
                      time: new Date(event.at).toLocaleString(),
                      duration: event.durationMs
                    })}
                  </Typography>
                  <Typography variant="body2">
                    {t('figplugin.planningHistory.input', {
                      bytes: event.inputBytes,
                      tokens: event.estimatedInputTokens,
                      nodes: event.nodeCount,
                      images: event.imageCount,
                      imageBytes: event.imageBytes
                    })}
                  </Typography>
                  <Typography variant="body2">
                    {t('figplugin.planningHistory.binding', {
                      provider: event.provider ?? t('figplugin.planningHistory.notRecorded'),
                      model: event.modelName ?? t('figplugin.planningHistory.notRecorded')
                    })}
                  </Typography>
                  {event.resultBytes !== undefined && (
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.result', { bytes: event.resultBytes })}
                    </Typography>
                  )}
                  {event.reportedTotalTokens !== undefined && (
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.usage', { tokens: event.reportedTotalTokens })}
                    </Typography>
                  )}
                  {event.errorCode && (
                    <Typography>
                      {t('figplugin.planningHistory.errorCode', { code: event.errorCode })}
                    </Typography>
                  )}
                  <Box component="details">
                    <Box component="summary" sx={{ cursor: 'pointer' }}>
                      {t('figplugin.planningHistory.identifiers')}
                    </Box>
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.callId', { id: event.callId })}
                    </Typography>
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.correlationId', { id: event.correlationId })}
                    </Typography>
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.requestId', { id: event.requestId })}
                    </Typography>
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.sequence', { sequence: event.sequence })}
                    </Typography>
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.profile', { id: event.profileId })}
                    </Typography>
                    <Typography variant="body2">
                      {t('figplugin.planningHistory.revision', { revision: event.profileRevision })}
                    </Typography>
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
