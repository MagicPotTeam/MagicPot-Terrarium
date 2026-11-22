import React from 'react'
import { Box, CircularProgress, Typography, useTheme } from '@mui/material'
import { alpha, keyframes, type Theme } from '@mui/material/styles'
import AgentThreadCardBody from './AgentThreadCardBody'
import {
  Check,
  Close,
  ExpandMore,
  HourglassEmpty,
  RadioButtonUnchecked,
  Remove,
  Settings
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { parseAgentThreadCardDisplay } from '@shared/api/agentThreadCardDisplay'
import type { ToolHistoryEntry } from '@shared/llm/types'
import {
  getAgentColumnTokens,
  type AgentColumnTokens
} from '@renderer/components/agentColumnTokens'
import {
  formatToolCallValue,
  formatToolCardField,
  getToolCardAccent,
  getToolCardIcon,
  groupToolCalls,
  helperToolCallResult,
  isHelperToolCall,
  summarizeToolCallBatch,
  toolCallArgumentSummary,
  toolCallDisplayName,
  toolCallDisplayStatus,
  toolCallKey,
  toolCallSummary,
  visibleToolCalls,
  type ToolCallDisplayStatus
} from '../chatToolCallDisplay'

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

/** Height cap of one expanded section and of pinned card content in the Agent column. */
const COLUMN_SECTION_MAX_HEIGHT = '16rem'
/** Height cap of the result box of a delegated-agent line. */
const COLUMN_DELEGATED_MAX_HEIGHT = '12rem'
/** Height cap of the list inside an expanded batch. */
const COLUMN_BATCH_MAX_HEIGHT = '18rem'
/** How many tool names the batch line lists before it says how many more there are. */
const COLUMN_BATCH_NAME_LIMIT = 4

const runningPulse = keyframes({ '0%, 100%': { opacity: 0.4 }, '50%': { opacity: 1 } })

/** The completed display-only card of a show_card call; it stays visible under the line. */
const pinnedCardDisplay = (
  toolName: string,
  status: ToolCallDisplayStatus,
  error: string | undefined,
  content: string | undefined
) =>
  toolName === 'show_card' && status === 'completed' && error === undefined
    ? parseAgentThreadCardDisplay(content)
    : undefined

/** Card accents arrive as fixed theme token names; the column draws their border at 40%. */
const resolveCardAccentColor = (theme: Theme, token: string): string => {
  switch (token) {
    case 'primary.main':
      return theme.palette.primary.main
    case 'info.main':
      return theme.palette.info.main
    case 'success.main':
      return theme.palette.success.main
    case 'warning.main':
      return theme.palette.warning.main
    case 'error.main':
      return theme.palette.error.main
    default:
      return theme.palette.text.secondary
  }
}

/** The state of a delegated-agent line: a tool call state, or waiting for the person's approval. */
export type DelegatedRowStatus = ToolCallDisplayStatus | 'waiting'

/** Status changes the glyph, never the colour of the line. */
const ColumnStatusGlyph: React.FC<{
  status: DelegatedRowStatus
  tokens: AgentColumnTokens
  size?: number
}> = ({ status, tokens, size = 14 }) => {
  const sx = { fontSize: size, flexShrink: 0 }
  if (status === 'waiting') return <HourglassEmpty sx={{ ...sx, color: tokens.attention }} />
  if (status === 'running') {
    return (
      <Settings
        sx={{
          ...sx,
          color: tokens.attention,
          animation: `${runningPulse} 1.5s ease-in-out infinite`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
        }}
      />
    )
  }
  if (status === 'completed') return <Check sx={{ ...sx, color: tokens.live }} />
  if (status === 'failed') return <Close sx={{ ...sx, color: tokens.danger }} />
  if (status === 'cancelled') {
    return <RadioButtonUnchecked sx={{ ...sx, fontSize: size - 2, color: tokens.attention }} />
  }
  return <Remove sx={{ ...sx, color: tokens.muted }} />
}

/** The whole one-line header is the toggle. */
const columnHeaderSx = (tokens: AgentColumnTokens) =>
  ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    minWidth: 0,
    minHeight: 28,
    boxSizing: 'border-box',
    m: 0,
    border: 0,
    borderRadius: 0,
    padding: '6px 12px',
    bgcolor: tokens.toolTint.header,
    color: tokens.text,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    fontSize: tokens.fontSize.small,
    lineHeight: '16px',
    '&:focus-visible': tokens.focusRing
  }) as const

const columnNameSx = (tokens: AgentColumnTokens) =>
  ({
    fontFamily: tokens.monoFont,
    fontWeight: 600,
    color: tokens.toolName,
    flexShrink: 0,
    maxWidth: '60%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }) as const

const columnSummarySx = (tokens: AgentColumnTokens) =>
  ({
    fontFamily: tokens.monoFont,
    color: tokens.muted,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }) as const

const ColumnChevron: React.FC<{ open: boolean; tokens: AgentColumnTokens }> = ({
  open,
  tokens
}) => (
  <ExpandMore
    sx={{
      fontSize: 14,
      flexShrink: 0,
      color: tokens.muted,
      transition: 'transform 120ms',
      transform: open ? 'rotate(180deg)' : undefined,
      '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
    }}
  />
)

/**
 * One delegated-agent line of the Agent column ("[sub] explore", "[成员] 文案"): the same
 * one-line header as a tool line, in the delegated-agent tint, with the label in bold
 * monospace, the task in grey, the state glyph and a chevron. When the line has something to
 * show, the header opens it (`children`: the result box or a placeholder line).
 */
export const DelegatedAgentRow: React.FC<{
  label: string
  summary: string
  status: DelegatedRowStatus
  /** The state in words, for the accessible name of the header. */
  statusLabel: string
  /** False while there is nothing to show: no chevron, the header does not open. */
  expandable: boolean
  open: boolean
  onToggle: () => void
  testId?: string
  /** The body, drawn only while the line is open. */
  children?: React.ReactNode
}> = ({ label, summary, status, statusLabel, expandable, open, onToggle, testId, children }) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const content = (
    <>
      <ColumnStatusGlyph status={status} tokens={tokens} />
      <Box component="span" sx={{ ...columnNameSx(tokens), color: tokens.memberTint.label }}>
        {label}
      </Box>
      <Box component="span" sx={columnSummarySx(tokens)}>
        {summary}
      </Box>
      {expandable ? <ColumnChevron open={open} tokens={tokens} /> : null}
    </>
  )
  const headerSx = { ...columnHeaderSx(tokens), bgcolor: tokens.memberTint.header }
  const name = `${label} — ${statusLabel}`
  return (
    <Box
      data-testid={testId}
      data-chat-delegated-line={status}
      sx={{
        borderRadius: `${tokens.radius.content}px`,
        overflow: 'hidden',
        minWidth: 0,
        flexShrink: 0
      }}
    >
      {expandable ? (
        <Box
          component="button"
          type="button"
          aria-label={name}
          aria-expanded={open}
          onClick={onToggle}
          sx={headerSx}
        >
          {content}
        </Box>
      ) : (
        <Box role="group" aria-label={name} sx={{ ...headerSx, cursor: 'default' }}>
          {content}
        </Box>
      )}
      {open && expandable ? (
        <Box sx={{ borderTop: `1px solid ${tokens.memberTint.hairline}`, minWidth: 0 }}>
          {children}
        </Box>
      ) : null}
    </Box>
  )
}

/** The result of a delegated agent in the tinted box: formatting-only Markdown, or raw text. */
export const DelegatedResult: React.FC<{ text: string; raw?: boolean; error?: boolean }> = ({
  text,
  raw = false,
  error = false
}) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  return (
    <Box
      data-testid="chat-delegated-result"
      sx={{
        padding: '8px 12px',
        maxHeight: COLUMN_DELEGATED_MAX_HEIGHT,
        overflowY: 'auto',
        overflowX: 'hidden',
        bgcolor: tokens.memberTint.header,
        fontSize: tokens.fontSize.small,
        lineHeight: '18px',
        color: error ? tokens.danger : tokens.text,
        overflowWrap: 'anywhere',
        userSelect: 'text',
        // The shared formatting-only body brings its own sizes; the box keeps 12px text.
        '& > div': { fontSize: 'inherit', lineHeight: 'inherit', my: 0 },
        // Markdown keeps only the spacing of its blocks (plain text keeps its line breaks).
        '& > div:has(> p, > ul, > ol, > pre, > blockquote, > table)': { whiteSpace: 'normal' },
        '& > div p': { m: '0 0 0.5em' },
        '& > div p:last-child': { mb: 0 },
        '& > div ul, & > div ol': { m: '0.4em 0', pl: '1.5em' },
        '& > div ul': { listStyle: 'disc' },
        '& > div ol': { listStyle: 'decimal' },
        '& > div li + li': { mt: '0.2em' },
        '& > div pre': { whiteSpace: 'pre-wrap' },
        '& > div :not(pre) > code': {
          px: '0.35em',
          py: '0.15em',
          borderRadius: `${tokens.radius.control}px`,
          bgcolor: tokens.surface,
          fontFamily: tokens.monoFont,
          fontSize: '0.9em'
        }
      }}
    >
      {raw || error ? (
        <Box
          component="pre"
          sx={{
            m: 0,
            whiteSpace: 'pre-wrap',
            fontFamily: raw ? tokens.monoFont : 'inherit',
            fontSize: 'inherit',
            lineHeight: 'inherit'
          }}
        >
          {formatToolCallValue(text).text}
        </Box>
      ) : (
        <AgentThreadCardBody body={text} />
      )}
    </Box>
  )
}

/** A one-line placeholder in the body: "(running...)" in grey or "(interrupted)" in amber. */
export const DelegatedNote: React.FC<{ text: string; tone: 'running' | 'interrupted' }> = ({
  text,
  tone
}) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  return (
    <Box
      data-testid="chat-delegated-note"
      sx={{
        padding: '8px 12px',
        fontSize: tokens.fontSize.small,
        lineHeight: '16px',
        color: tone === 'running' ? tokens.muted : tokens.attention,
        bgcolor: tone === 'running' ? tokens.memberTint.body : alpha(tokens.attention, 0.08)
      }}
    >
      {text}
    </Box>
  )
}

/** A helper call (explore, critic, fork, response, summarize) as a delegated-agent line. */
const HelperCallRow: React.FC<{
  entry: ToolHistoryEntry
  live: boolean
  open: boolean
  onToggle: () => void
}> = ({ entry, live, open, onToggle }) => {
  const { t } = useTranslation()
  const status = toolCallDisplayStatus(entry, live)
  const name = toolCallDisplayName(entry)
  const summary = React.useMemo(() => toolCallArgumentSummary(entry.args), [entry.args])
  const result = React.useMemo(
    () => (open ? helperToolCallResult(entry) : undefined),
    [open, entry]
  )
  const error = entry.error !== undefined && entry.error !== '' ? entry.error : undefined
  const hasResult = entry.content !== undefined && entry.content !== ''
  return (
    <DelegatedAgentRow
      label={t('chat.delegated.helper_label', { name })}
      summary={summary}
      status={status}
      statusLabel={t(`chat.tool_call.status_${status}`)}
      // The result or the error, or a placeholder while it runs and after it was stopped.
      expandable={
        hasResult || error !== undefined || status === 'running' || status === 'cancelled'
      }
      open={open}
      onToggle={onToggle}
    >
      {result ? (
        <DelegatedResult text={result.text} raw={result.kind === 'raw'} />
      ) : error !== undefined ? (
        <DelegatedResult text={error} error />
      ) : status === 'running' ? (
        <DelegatedNote text={t('chat.delegated.running')} tone="running" />
      ) : status === 'cancelled' ? (
        <DelegatedNote text={t('chat.delegated.interrupted')} tone="interrupted" />
      ) : null}
    </DelegatedAgentRow>
  )
}

const ToolCallRow: React.FC<{
  entry: ToolHistoryEntry
  live: boolean
  open: boolean
  onToggle: () => void
  columnStyle: boolean
}> = ({ entry, live, open, onToggle, columnStyle }) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const status = toolCallDisplayStatus(entry, live)
  const label = t(`chat.tool_call.status_${status}`)
  const name = toolCallDisplayName(entry)
  const color =
    status === 'completed' ? 'success.main' : status === 'failed' ? 'error.main' : 'text.secondary'
  const summary = React.useMemo(
    () => (columnStyle ? toolCallArgumentSummary(entry.args) : toolCallSummary(entry.args)),
    [columnStyle, entry.args]
  )
  const display = React.useMemo(
    () => pinnedCardDisplay(entry.toolName, status, entry.error, entry.content),
    [entry.toolName, status, entry.error, entry.content]
  )
  const card = display?.card
  const cardAccent = getToolCardAccent(card?.accent)
  const cardIcon = getToolCardIcon(card?.icon)
  const details = open
    ? {
        args: formatToolCallValue(entry.args),
        output:
          entry.content === undefined ? undefined : formatToolCallValue(display ?? entry.content),
        error: entry.error === undefined ? undefined : formatToolCallValue(entry.error)
      }
    : undefined

  if (columnStyle) {
    const hairline = `1px solid ${tokens.toolTint.hairline}`
    const section = (title: string, value: { text: string; truncated: boolean }) => (
      <Box sx={{ px: '12px', pt: '8px', minWidth: 0 }}>
        <Typography
          component="h4"
          sx={{
            m: 0,
            fontSize: tokens.fontSize.micro,
            lineHeight: '14px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: tokens.muted
          }}
        >
          {title}
        </Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            mt: '2px',
            maxHeight: COLUMN_SECTION_MAX_HEIGHT,
            overflowY: 'auto',
            overflowX: 'hidden',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontFamily: tokens.monoFont,
            fontSize: tokens.fontSize.small,
            lineHeight: '16px',
            color: tokens.muted,
            userSelect: 'text'
          }}
        >
          {value.text}
        </Box>
        {value.truncated && (
          <Typography
            sx={{
              display: 'block',
              mt: '2px',
              fontSize: tokens.fontSize.micro,
              lineHeight: '14px',
              color: tokens.muted
            }}
          >
            {t('chat.tool_call.truncated')}
          </Typography>
        )}
      </Box>
    )
    const note = (text: string, noteColor: string, fontSize: number) => (
      <Typography
        sx={{
          display: 'block',
          px: '12px',
          pt: '8px',
          fontSize,
          lineHeight: '16px',
          color: noteColor
        }}
      >
        {text}
      </Typography>
    )
    return (
      <Box
        data-chat-tool-line={status}
        sx={{
          borderRadius: `${tokens.radius.content}px`,
          overflow: 'hidden',
          minWidth: 0,
          flexShrink: 0
        }}
      >
        <Box
          component="button"
          type="button"
          aria-label={`${name} — ${label}`}
          aria-expanded={open}
          onClick={onToggle}
          sx={columnHeaderSx(tokens)}
        >
          <ColumnStatusGlyph status={status} tokens={tokens} />
          <Box component="span" sx={columnNameSx(tokens)}>
            {name}
          </Box>
          <Box component="span" sx={columnSummarySx(tokens)}>
            {summary}
          </Box>
          <ColumnChevron open={open} tokens={tokens} />
        </Box>
        {card && (
          <Box
            sx={{
              padding: '10px 12px',
              maxHeight: COLUMN_SECTION_MAX_HEIGHT,
              overflowY: 'auto',
              overflowX: 'hidden',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              bgcolor: tokens.toolTint.body,
              fontSize: tokens.fontSize.small,
              ...(cardAccent
                ? {
                    border: '1px solid',
                    borderColor:
                      cardAccent.borderColor === 'divider'
                        ? tokens.border
                        : alpha(resolveCardAccentColor(theme, cardAccent.borderColor), 0.4),
                    borderRadius: open
                      ? 0
                      : `0 0 ${tokens.radius.content}px ${tokens.radius.content}px`
                  }
                : { borderTop: hairline })
            }}
          >
            <Typography
              component="h4"
              sx={{
                m: 0,
                fontSize: 14,
                lineHeight: '20px',
                fontWeight: 600,
                color: cardAccent?.headerColor
              }}
            >
              {cardIcon !== undefined ? (
                <Box component="span" aria-hidden="true" sx={{ mr: 0.5 }}>
                  {cardIcon}
                </Box>
              ) : null}
              {formatToolCallValue(card.title).text}
            </Typography>
            {card.subtitle !== undefined && (
              <Typography
                sx={{ fontSize: tokens.fontSize.small, lineHeight: '16px', color: tokens.muted }}
              >
                {formatToolCallValue(card.subtitle).text}
              </Typography>
            )}
            {card.body !== undefined && <AgentThreadCardBody body={card.body} />}
            {card.fields && (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: card.fields.some((field) => field.inline)
                    ? 'minmax(0, 1fr) minmax(0, 1fr)'
                    : 'minmax(0, 1fr)',
                  columnGap: '12px',
                  rowGap: '4px',
                  mt: '8px'
                }}
              >
                {card.fields.map((field, index) => (
                  <Typography
                    key={index}
                    sx={{
                      minWidth: 0,
                      fontSize: tokens.fontSize.small,
                      lineHeight: '16px',
                      gridColumn: field.inline ? undefined : '1 / -1'
                    }}
                  >
                    {formatToolCardField(field.label, field.value)}
                  </Typography>
                ))}
              </Box>
            )}
            {card.footer !== undefined && (
              <Typography
                sx={{
                  display: 'block',
                  mt: '4px',
                  fontSize: tokens.fontSize.micro,
                  lineHeight: '14px',
                  fontStyle: 'italic',
                  color: tokens.muted
                }}
              >
                {formatToolCallValue(card.footer).text}
              </Typography>
            )}
          </Box>
        )}
        {open && details && (
          <Box sx={{ borderTop: hairline, bgcolor: tokens.toolTint.body, pb: '8px', minWidth: 0 }}>
            {section(t('chat.tool_call.arguments'), details.args)}
            {details.output && section(t('chat.tool_call.result'), details.output)}
            {details.error && section(t('chat.tool_call.error'), details.error)}
            {!details.output &&
              !details.error &&
              note(
                t(status === 'running' ? 'chat.tool_call.waiting' : 'chat.tool_call.no_result'),
                tokens.muted,
                tokens.fontSize.small
              )}
            {status === 'unknown' &&
              note(t('chat.tool_call.unknown_notice'), tokens.attention, tokens.fontSize.micro)}
          </Box>
        )}
      </Box>
    )
  }

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
        onClick={onToggle}
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
      {card && (
        <Box
          sx={{
            px: 1.5,
            py: 1,
            maxHeight: 280,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            ...(cardAccent ? { border: '1px solid', borderColor: cardAccent.borderColor } : {})
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {t('chat.tool_call.card_display_notice')}
          </Typography>
          <Typography component="h4" variant="subtitle2" sx={{ color: cardAccent?.headerColor }}>
            {cardIcon !== undefined ? (
              <Box component="span" aria-hidden="true" sx={{ mr: 0.5 }}>
                {cardIcon}
              </Box>
            ) : null}
            {formatToolCallValue(card.title).text}
          </Typography>
          {card.subtitle !== undefined && (
            <Typography variant="body2" color="text.secondary">
              {formatToolCallValue(card.subtitle).text}
            </Typography>
          )}
          {card.body !== undefined && <AgentThreadCardBody body={card.body} />}
          {card.fields && (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: card.fields.some((field) => field.inline)
                  ? 'minmax(0, 1fr) minmax(0, 1fr)'
                  : 'minmax(0, 1fr)',
                columnGap: 1.5,
                rowGap: 0.5,
                mt: 1
              }}
            >
              {card.fields.map((field, index) => (
                <Typography
                  key={index}
                  variant="body2"
                  sx={{ minWidth: 0, gridColumn: field.inline ? undefined : '1 / -1' }}
                >
                  {formatToolCardField(field.label, field.value)}
                </Typography>
              ))}
            </Box>
          )}
          {card.footer !== undefined && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              {formatToolCallValue(card.footer).text}
            </Typography>
          )}
        </Box>
      )}
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

/** Three or more consecutive plain calls folded into one line (Agent column only). */
const ToolCallBatch: React.FC<{
  entries: readonly ToolHistoryEntry[]
  live: boolean
  open: boolean
  onToggle: () => void
  openKeys: ReadonlySet<string>
  onToggleRow: (key: string) => void
}> = ({ entries, live, open, onToggle, openKeys, onToggleRow }) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const summary = React.useMemo(() => summarizeToolCallBatch(entries, live), [entries, live])
  const count = entries.length
  const listed = summary.names.slice(0, COLUMN_BATCH_NAME_LIMIT)
  const names = listed.map(([name, calls]) => (calls > 1 ? `${name} ×${calls}` : name))
  const rest = summary.names.length - listed.length
  if (rest > 0) names.push(t('chat.tool_call.batch_more', { count: rest }))
  const badge = (status: ToolCallDisplayStatus, badgeColor: string) =>
    summary.counts[status] > 0 ? (
      <Box
        component="span"
        data-tool-batch-badge={status}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2px',
          flexShrink: 0,
          padding: '1px 6px',
          borderRadius: `${tokens.radius.control}px`,
          fontFamily: tokens.monoFont,
          fontSize: tokens.fontSize.micro,
          lineHeight: '14px',
          bgcolor: alpha(badgeColor, 0.15),
          color: badgeColor
        }}
      >
        {summary.counts[status]}
        <ColumnStatusGlyph status={status} tokens={tokens} size={11} />
      </Box>
    ) : null

  return (
    <Box
      data-chat-tool-batch={summary.status}
      sx={{
        borderRadius: `${tokens.radius.content}px`,
        overflow: 'hidden',
        minWidth: 0,
        flexShrink: 0
      }}
    >
      <Box
        component="button"
        type="button"
        aria-label={t(open ? 'chat.tool_call.batch_collapse' : 'chat.tool_call.batch_expand', {
          count
        })}
        aria-expanded={open}
        onClick={onToggle}
        sx={columnHeaderSx(tokens)}
      >
        <ColumnStatusGlyph status={summary.status} tokens={tokens} />
        <Box component="span" sx={columnNameSx(tokens)}>
          {t('chat.tool_call.batch_title', { count })}
        </Box>
        <Box component="span" sx={columnSummarySx(tokens)}>
          {names.join(', ')}
        </Box>
        {badge('running', tokens.attention)}
        {badge('failed', tokens.danger)}
        {badge('cancelled', tokens.attention)}
        <ColumnChevron open={open} tokens={tokens} />
      </Box>
      {open && (
        <Box
          data-chat-tool-batch-list
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '6px 8px',
            maxHeight: COLUMN_BATCH_MAX_HEIGHT,
            overflowY: 'auto',
            overflowX: 'hidden',
            minWidth: 0,
            borderTop: `1px solid ${tokens.toolTint.hairline}`,
            bgcolor: tokens.surface
          }}
        >
          {entries.map((entry) => {
            const key = toolCallKey(entry)
            return (
              <ToolCallRow
                key={key}
                entry={entry}
                live={live}
                open={openKeys.has(key)}
                onToggle={() => onToggleRow(key)}
                columnStyle
              />
            )
          })}
        </Box>
      )}
    </Box>
  )
}

/** Inline, read-only receipts. Opening a row never executes or retries a tool. */
export default function ChatToolCalls({
  history,
  live,
  columnStyle: columnStyleProp = false,
  grouped = false
}: {
  grouped?: boolean
  history?: readonly ToolHistoryEntry[]
  live: boolean
  /** Agent column look: one tinted line per call, one line for three or more calls in a row. */
  columnStyle?: boolean
}) {
  const { t } = useTranslation()
  const entries = React.useMemo(() => visibleToolCalls(history), [history])
  // The workbench asks for grouped rows: the same compact column presentation.
  const columnStyle = columnStyleProp || grouped
  // Expanded state lives here, keyed by receipt, so a line keeps it when it moves into a batch.
  const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set())
  const toggle = React.useCallback((key: string) => {
    setOpenKeys((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  const groups = React.useMemo(
    () =>
      columnStyle
        ? groupToolCalls(
            entries,
            // A helper call is a delegated-agent line of its own and ends a run of calls.
            (entry) =>
              !isHelperToolCall(entry) &&
              pinnedCardDisplay(
                entry.toolName,
                toolCallDisplayStatus(entry, live),
                entry.error,
                entry.content
              )?.card === undefined
          )
        : entries.map((entry) => ({ kind: 'single' as const, key: toolCallKey(entry), entry })),
    [columnStyle, entries, live]
  )
  if (!entries.length) return null
  return (
    <Box
      role="group"
      aria-label={t('chat.tool_call.title')}
      sx={
        columnStyle
          ? { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }
          : { display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1, minWidth: 0 }
      }
    >
      {groups.map((group) =>
        group.kind === 'batch' ? (
          <ToolCallBatch
            key={group.key}
            entries={group.entries}
            live={live}
            open={openKeys.has(group.key)}
            onToggle={() => toggle(group.key)}
            openKeys={openKeys}
            onToggleRow={toggle}
          />
        ) : columnStyle && isHelperToolCall(group.entry) ? (
          <HelperCallRow
            key={group.key}
            entry={group.entry}
            live={live}
            open={openKeys.has(group.key)}
            onToggle={() => toggle(group.key)}
          />
        ) : (
          <ToolCallRow
            key={group.key}
            entry={group.entry}
            live={live}
            open={openKeys.has(group.key)}
            onToggle={() => toggle(group.key)}
            columnStyle={columnStyle}
          />
        )
      )}
    </Box>
  )
}
