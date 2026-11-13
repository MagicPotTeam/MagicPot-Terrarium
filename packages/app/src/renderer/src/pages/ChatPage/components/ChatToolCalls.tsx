import React from 'react'
import { Box, CircularProgress, Typography } from '@mui/material'
import AgentThreadCardBody from './AgentThreadCardBody'
import { Check, Close, ExpandMore, Remove } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { parseAgentThreadCardDisplay } from '@shared/api/agentThreadCardDisplay'
import type { ToolHistoryEntry } from '@shared/llm/types'
import { formatToolCallValue, formatToolCardField, getToolCardAccent, getToolCardIcon, toolCallSummary, visibleToolCalls } from '../chatToolCallDisplay'

const codeStyle = {
  m: 0,
  p: 1,
  maxHeight: 280,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.5,
  userSelect: 'text'
} as const

const ToolCallRow: React.FC<{ entry: ToolHistoryEntry; live: boolean }> = ({ entry, live }) => {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const status = entry.status === 'running' && !live ? 'unknown' : entry.status
  const label = t(`chat.tool_call.status_${status}`)
  const name = entry.toolName.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 128) || 'tool'
  const color =
    status === 'completed' ? 'success.main' : status === 'failed' ? 'error.main' : 'text.secondary'
  const summary = React.useMemo(() => toolCallSummary(entry.args), [entry.args])
  const display = React.useMemo(() => entry.toolName === 'show_card' && status === 'completed' && entry.error === undefined
    ? parseAgentThreadCardDisplay(entry.content) : undefined, [entry.toolName, status, entry.error, entry.content])
  const card = display?.card
  const cardAccent = getToolCardAccent(card?.accent)
  const cardIcon = getToolCardIcon(card?.icon)
  const details = open
    ? {
        args: formatToolCallValue(entry.args),
        output: entry.content === undefined ? undefined : formatToolCallValue(display ?? entry.content),
        error: entry.error === undefined ? undefined : formatToolCallValue(entry.error)
      }
    : undefined
  const section = (title: string, value: { text: string; truncated: boolean }) => (
    <Box>
      <Typography variant="caption" component="h4" sx={{ px: 1, pt: 1, fontWeight: 600 }}>
        {title}
      </Typography>
      <Box component="pre" sx={codeStyle}>
        {value.text}
      </Box>
      {value.truncated && (
        <Typography variant="caption" sx={{ px: 1, color: 'text.secondary' }}>
          {t('chat.tool_call.truncated')}
        </Typography>
      )}
    </Box>
  )
  return (
    <Box sx={{ borderRadius: 1.5, overflow: 'hidden', bgcolor: 'action.hover', minWidth: 0 }}>
      <Box
        component="button"
        type="button"
        aria-label={`${name} — ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          width: '100%',
          minWidth: 0,
          border: 0,
          background: 'transparent',
          color: 'text.primary',
          cursor: 'pointer',
          textAlign: 'left',
          px: 1,
          py: 0.65,
          font: 'inherit',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: -2
          }
        }}
      >
        {status === 'running' ? (
          <CircularProgress size={13} aria-label={label} />
        ) : status === 'completed' ? (
          <Check sx={{ fontSize: 15, color }} />
        ) : status === 'failed' ? (
          <Close sx={{ fontSize: 15, color }} />
        ) : (
          <Remove sx={{ fontSize: 15, color }} />
        )}
        <Typography
          component="span"
          sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, flexShrink: 0 }}
        >
          {name}
        </Typography>
        <Typography
          component="span"
          noWrap
          sx={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: 'text.secondary',
            flex: 1,
            minWidth: 0
          }}
        >
          {summary}
        </Typography>
        <Typography component="span" sx={{ fontSize: 11, color, flexShrink: 0 }}>
          {label}
        </Typography>
        <ExpandMore
          sx={{ fontSize: 16, flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined }}
        />
      </Box>
      {card && <Box sx={{ px: 1.5, py: 1, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...(cardAccent ? { border: '1px solid', borderColor: cardAccent.borderColor } : {}) }}>
        <Typography variant="caption" color="text.secondary">{t('chat.tool_call.card_display_notice')}</Typography>
        <Typography component="h4" variant="subtitle2" sx={{ color: cardAccent?.headerColor }}>{cardIcon !== undefined ? <Box component="span" aria-hidden="true" sx={{ mr: 0.5 }}>{cardIcon}</Box> : null}{formatToolCallValue(card.title).text}</Typography>
        {card.subtitle !== undefined && <Typography variant="body2" color="text.secondary">{formatToolCallValue(card.subtitle).text}</Typography>}
        {card.body !== undefined && <AgentThreadCardBody body={card.body} />}
        {card.fields && <Box sx={{ display: 'grid', gridTemplateColumns: card.fields.some(field => field.inline) ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)', columnGap: 1.5, rowGap: 0.5, mt: 1 }}>
          {card.fields.map((field, index) => <Typography key={index} variant="body2" sx={{ minWidth: 0, gridColumn: field.inline ? undefined : '1 / -1' }}>
            {formatToolCardField(field.label, field.value)}
          </Typography>)}
        </Box>}
        {card.footer !== undefined && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{formatToolCallValue(card.footer).text}</Typography>}
      </Box>}
      {open && details && (
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pb: 1 }}>
          {section(t('chat.tool_call.arguments'), details.args)}
          {details.output && section(t('chat.tool_call.result'), details.output)}
          {details.error && section(t('chat.tool_call.error'), details.error)}
          {!details.output && !details.error && (
            <Typography
              variant="caption"
              sx={{ display: 'block', px: 1, pt: 1, color: 'text.secondary' }}
            >
              {t(status === 'running' ? 'chat.tool_call.waiting' : 'chat.tool_call.no_result')}
            </Typography>
          )}
          {status === 'unknown' && (
            <Typography
              variant="caption"
              sx={{ display: 'block', px: 1, pt: 1, color: 'warning.main' }}
            >
              {t('chat.tool_call.unknown_notice')}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  )
}

/** Inline, read-only receipts. Opening a row never executes or retries a tool. */
export default function ChatToolCalls({
  history,
  live
}: {
  history?: readonly ToolHistoryEntry[]
  live: boolean
}) {
  const { t } = useTranslation()
  const entries = React.useMemo(() => visibleToolCalls(history), [history])
  if (!entries.length) return null
  return (
    <Box
      role="group"
      aria-label={t('chat.tool_call.title')}
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1, minWidth: 0 }}
    >
      {entries.map((entry) => (
        <ToolCallRow
          key={JSON.stringify([entry.runId, entry.toolCallId])}
          entry={entry}
          live={live}
        />
      ))}
    </Box>
  )
}
