import React from 'react'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import TerminalIcon from '@mui/icons-material/Terminal'
import { getAgentColumnTokens, type AgentColumnTokens } from '../../../components/agentColumnTokens'

/** Bodies of a command result card scroll on their own above this height (16rem). */
export const COMMAND_CARD_BODY_MAX_HEIGHT = '16rem'

const useColumnTokens = (): AgentColumnTokens => {
  const theme = useTheme()
  return React.useMemo(() => getAgentColumnTokens(theme), [theme])
}

/**
 * The result of a slash command, shown as a row at the end of the transcript: a header line
 * (terminal icon, the command, an optional title at the right) above a body. The card has no
 * close button; it leaves with the conversation.
 */
export const ChatCommandResultCard: React.FC<{
  /** The command as typed, without arguments: "/status". */
  command: string
  title?: string
  /** Error look: the icon takes the error colour (the body is then a CommandCardText error). */
  error?: boolean
  testId?: string
  children?: React.ReactNode
}> = ({ command, title, error = false, testId = 'chat-command-card', children }) => {
  const tokens = useColumnTokens()
  return (
    <Box
      component="section"
      data-testid={testId}
      data-command={command}
      data-error={error ? 'true' : undefined}
      aria-live="polite"
      sx={{
        alignSelf: 'flex-start',
        boxSizing: 'border-box',
        maxWidth: '90%',
        minWidth: 0,
        overflow: 'hidden',
        borderRadius: `${tokens.radius.content}px`,
        bgcolor: tokens.surface,
        color: tokens.text
      }}
    >
      <Box
        component="header"
        sx={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, padding: '8px 12px' }}
      >
        <TerminalIcon
          aria-hidden="true"
          sx={{ fontSize: 12, flexShrink: 0, color: error ? tokens.danger : tokens.accent }}
        />
        <Box
          component="code"
          data-testid="chat-command-card-command"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: tokens.monoFont,
            fontSize: tokens.fontSize.small,
            lineHeight: '16px',
            fontWeight: 600
          }}
        >
          {command}
        </Box>
        {title ? (
          <Box
            component="span"
            data-testid="chat-command-card-title"
            sx={{
              ml: 'auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: tokens.fontSize.caption,
              lineHeight: '16px',
              color: tokens.muted
            }}
          >
            {title}
          </Box>
        ) : null}
      </Box>
      {children}
    </Box>
  )
}

/** Plain text body; `mono` for raw output, `error` for a failed command. */
export const CommandCardText: React.FC<{
  mono?: boolean
  error?: boolean
  muted?: boolean
  children: React.ReactNode
}> = ({ mono = false, error = false, muted = false, children }) => {
  const tokens = useColumnTokens()
  return (
    <Box
      data-testid="chat-command-card-text"
      role={error ? 'alert' : undefined}
      sx={{
        padding: '8px 12px',
        maxHeight: COMMAND_CARD_BODY_MAX_HEIGHT,
        overflowY: 'auto',
        overflowX: 'hidden',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: mono ? tokens.monoFont : 'inherit',
        fontSize: tokens.fontSize.small,
        lineHeight: '18px',
        color: error ? tokens.danger : muted ? tokens.muted : tokens.text
      }}
    >
      {children}
    </Box>
  )
}

/** One muted line under a body (a notice, a fact about the result). */
export const CommandCardNote: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tokens = useColumnTokens()
  return (
    <Box
      data-testid="chat-command-card-note"
      sx={{
        padding: '0 12px 8px',
        overflowWrap: 'anywhere',
        fontSize: tokens.fontSize.caption,
        lineHeight: '16px',
        color: tokens.muted
      }}
    >
      {children}
    </Box>
  )
}

export type CommandCardListItem = { key: string; label: string; description?: string }

/** List body: one row per item, a second muted line for its description. */
export const CommandCardList: React.FC<{ items: readonly CommandCardListItem[] }> = ({ items }) => {
  const tokens = useColumnTokens()
  return (
    <Box
      component="ul"
      data-testid="chat-command-card-list"
      sx={{
        m: 0,
        padding: '6px 12px',
        listStyle: 'none',
        maxHeight: COMMAND_CARD_BODY_MAX_HEIGHT,
        overflowY: 'auto',
        overflowX: 'hidden'
      }}
    >
      {items.map((item) => (
        <Box
          component="li"
          key={item.key}
          sx={{
            padding: '6px 0',
            borderBottom: `1px solid ${tokens.border}`,
            '&:last-of-type': { borderBottom: 0 }
          }}
        >
          <Box
            sx={{ overflowWrap: 'anywhere', fontSize: tokens.fontSize.small, lineHeight: '16px' }}
          >
            {item.label}
          </Box>
          {item.description ? (
            <Box
              sx={{
                overflowWrap: 'anywhere',
                fontSize: tokens.fontSize.caption,
                lineHeight: '16px',
                color: tokens.muted
              }}
            >
              {item.description}
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}

export type CommandCardAction = { key: string; label: string; onClick: () => void }

/** A wrapping row of text links: where a command hands over to another place of the app. */
export const CommandCardActions: React.FC<{ actions: readonly CommandCardAction[] }> = ({
  actions
}) => {
  const tokens = useColumnTokens()
  return (
    <Box
      data-testid="chat-command-card-actions"
      sx={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '0 12px 8px' }}
    >
      {actions.map((action) => (
        <Box
          component="button"
          type="button"
          key={action.key}
          onClick={action.onClick}
          sx={{
            m: 0,
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            color: tokens.accent,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: tokens.fontSize.small,
            lineHeight: '18px',
            textAlign: 'left',
            '&:hover': { textDecoration: 'underline' },
            '&:focus-visible': { ...tokens.focusRing, outlineOffset: '2px' }
          }}
        >
          {action.label}
        </Box>
      ))}
    </Box>
  )
}

/**
 * Body for an existing interactive view (goal records, thread skills) shown inside a command
 * card: the view keeps its own structure and takes the card's sizes — 12-13px text, notices as
 * plain lines, buttons in wrapping rows — and scrolls on its own above 16rem.
 */
export const CommandCardPanelBody = React.forwardRef<
  HTMLDivElement,
  { children?: React.ReactNode; testId?: string }
>(function CommandCardPanelBody({ children, testId = 'chat-command-card-panel' }, ref) {
  const tokens = useColumnTokens()
  return (
    <Box
      ref={ref}
      data-testid={testId}
      sx={{
        padding: '8px 12px',
        maxHeight: COMMAND_CARD_BODY_MAX_HEIGHT,
        overflowY: 'auto',
        overflowX: 'hidden',
        overflowWrap: 'anywhere',
        fontSize: tokens.fontSize.small,
        lineHeight: '18px',
        '& .MuiTypography-root': { fontSize: tokens.fontSize.small, lineHeight: '18px' },
        '& .MuiTypography-caption': {
          fontSize: tokens.fontSize.caption,
          lineHeight: '16px',
          color: tokens.muted
        },
        '& pre.MuiTypography-root': { m: 0, fontFamily: tokens.monoFont },
        '& .MuiAlert-root': {
          display: 'block',
          m: 0,
          p: 0,
          border: 0,
          borderRadius: 0,
          bgcolor: 'transparent',
          color: tokens.muted,
          fontSize: tokens.fontSize.caption,
          lineHeight: '16px'
        },
        '& .MuiAlert-icon': { display: 'none' },
        '& .MuiAlert-message': { p: 0, overflow: 'visible' },
        '& .MuiAlert-colorWarning': { color: tokens.attention },
        '& .MuiAlert-colorError': { color: tokens.danger },
        '& .MuiButton-root': {
          minWidth: 0,
          minHeight: 24,
          mr: '6px',
          padding: '2px 8px',
          borderRadius: `${tokens.radius.control}px`,
          fontSize: tokens.fontSize.small,
          lineHeight: '18px',
          textAlign: 'left',
          textTransform: 'none',
          whiteSpace: 'normal'
        },
        '& .MuiInputBase-root': { fontSize: tokens.fontSize.base },
        '& .MuiInputLabel-root': { fontSize: tokens.fontSize.base },
        '& ul': { m: 0, pl: '18px' }
      }}
    >
      {children}
    </Box>
  )
})
