import { Alert, Stack, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { ProjectTraceEventSummary } from '@shared/projectTrace'
import type { ProjectHistoryRange } from './projectHistoryRange'

export default function ProjectHistoryRangeControls({
  events,
  value,
  selectedCount,
  valid,
  disabled,
  onChange
}: {
  events: readonly ProjectTraceEventSummary[]
  value: ProjectHistoryRange
  selectedCount: number
  valid: boolean
  disabled: boolean
  onChange: (value: ProjectHistoryRange) => void
}) {
  const { t } = useTranslation()
  const options = events.filter((event) => typeof event.id === 'string' && event.id)
  const optionLabel = (event: ProjectTraceEventSummary, index: number) =>
    `${index + 1} · ${event.at || ''} · ${event.label || event.action}`
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">
        {t('project.once.historyRangeTitle', { defaultValue: 'History to analyze' })}
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField
          select
          fullWidth
          size="small"
          label={t('project.once.historyStart', { defaultValue: 'History start' })}
          value={value.startId || ''}
          disabled={disabled}
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          onChange={(event) => onChange({ ...value, startId: event.target.value || null })}
        >
          <option value="">
            {t('project.once.historyBeginning', { defaultValue: 'From the beginning' })}
          </option>
          {value.startId && !options.some((event) => event.id === value.startId) && (
            <option value={value.startId} disabled>
              {t('project.once.historyMissingNode', {
                defaultValue: 'Selected event is unavailable'
              })}
            </option>
          )}
          {options.map((event, index) => (
            <option key={event.id} value={event.id}>
              {optionLabel(event, index)}
            </option>
          ))}
        </TextField>
        <TextField
          select
          fullWidth
          size="small"
          label={t('project.once.historyEnd', { defaultValue: 'History end' })}
          value={value.endId || ''}
          disabled={disabled}
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          onChange={(event) => onChange({ ...value, endId: event.target.value || null })}
        >
          <option value="">
            {t('project.once.historyLatest', { defaultValue: 'Through the latest event' })}
          </option>
          {value.endId && !options.some((event) => event.id === value.endId) && (
            <option value={value.endId} disabled>
              {t('project.once.historyMissingNode', {
                defaultValue: 'Selected event is unavailable'
              })}
            </option>
          )}
          {options.map((event, index) => (
            <option key={event.id} value={event.id}>
              {optionLabel(event, index)}
            </option>
          ))}
        </TextField>
      </Stack>
      <Typography variant="caption">
        {t('project.once.historySelection', {
          defaultValue:
            'Selected {{selected}} of {{total}} available events. This does not delete or rewrite the original history.',
          selected: selectedCount,
          total: events.length
        })}
      </Typography>
      {!valid && (
        <Alert severity="warning">
          {t('project.once.historyRangeInvalid', {
            defaultValue:
              'The range is reversed or a selected endpoint is no longer available. Select a valid range and review again; nothing will be sent.'
          })}
        </Alert>
      )}
    </Stack>
  )
}
