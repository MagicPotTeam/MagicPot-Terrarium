import React from 'react'
import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import WebAssetOutlinedIcon from '@mui/icons-material/WebAssetOutlined'
import { getAgentColumnTokens } from '../../../components/agentColumnTokens'

/**
 * An app the agent made, as a row of the transcript: one line with an app icon, the title and a
 * small filled "打开" button; the app itself runs elsewhere (a dialog or its own window). The body
 * holds what the app needs beyond that line: an error line, saved copies, a second action.
 */
export const AgentAppLauncherCard: React.FC<{
  title: string
  /** The open button; left out when the app cannot be opened from here. */
  openLabel?: string
  onOpen?: () => void
  openDisabled?: boolean
  /** Shown when the pointer rests on the open button: what opening does. */
  openTitle?: string
  /** A muted word at the right of the title: the state of the app. */
  state?: string
  testId?: string
  children?: React.ReactNode
}> = ({
  title,
  openLabel,
  onOpen,
  openDisabled = false,
  openTitle,
  state,
  testId = 'agent-app-launcher',
  children
}) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const titleId = React.useId()
  return (
    <Box
      component="section"
      role="group"
      aria-labelledby={titleId}
      data-testid={testId}
      sx={{
        boxSizing: 'border-box',
        minWidth: 0,
        padding: '8px 10px',
        border: `1px solid ${tokens.border}`,
        borderRadius: `${tokens.radius.content}px`,
        color: tokens.text,
        fontSize: tokens.fontSize.small,
        lineHeight: '18px'
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, fontWeight: 600 }}>
        <WebAssetOutlinedIcon
          aria-hidden="true"
          sx={{ fontSize: 14, flexShrink: 0, color: tokens.muted }}
        />
        <Box
          component="span"
          id={titleId}
          data-testid="agent-app-launcher-title"
          title={title}
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {title}
        </Box>
        {state ? (
          <Box
            component="span"
            data-testid="agent-app-launcher-state"
            sx={{
              flexShrink: 0,
              fontSize: tokens.fontSize.micro,
              fontWeight: 400,
              color: tokens.muted
            }}
          >
            {state}
          </Box>
        ) : null}
        {openLabel ? (
          <Box
            component="button"
            type="button"
            disabled={openDisabled}
            title={openTitle}
            onClick={onOpen}
            sx={{
              flexShrink: 0,
              boxSizing: 'border-box',
              minHeight: 24,
              m: 0,
              padding: '2px 10px',
              border: `1px solid ${tokens.accent}`,
              borderRadius: `${tokens.radius.control}px`,
              bgcolor: tokens.accent,
              color: theme.palette.getContrastText(tokens.accent),
              cursor: 'pointer',
              font: 'inherit',
              fontSize: tokens.fontSize.small,
              fontWeight: 500,
              lineHeight: '18px',
              '&:hover:not(:disabled)': { filter: 'brightness(1.1)' },
              '&:focus-visible': {
                outline: `2px solid ${alpha(tokens.accent, 0.8)}`,
                outlineOffset: '2px'
              },
              '&:disabled': { opacity: tokens.disabledOpacity, cursor: 'default' }
            }}
          >
            {openLabel}
          </Box>
        ) : null}
      </Box>
      {children}
    </Box>
  )
}

/**
 * A line of a launcher card's body: a muted note, a warning, or an error (announced). Notes are
 * upstream's launcher note: 12px at 75% opacity.
 */
export const AgentAppLauncherLine: React.FC<{
  tone?: 'note' | 'warning' | 'error'
  children: React.ReactNode
}> = ({ tone = 'note', children }) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  return (
    <Box
      role={tone === 'error' ? 'alert' : undefined}
      sx={{
        mt: '4px',
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-line',
        color: tone === 'error' ? tokens.danger : tone === 'warning' ? tokens.attention : 'inherit',
        opacity: tone === 'note' ? 0.75 : 1
      }}
    >
      {children}
    </Box>
  )
}

export type AgentAppLauncherAction = {
  key: string
  label: string
  onClick: () => void
  disabled?: boolean
  /** Shown when the pointer rests on it: what the action does. */
  title?: string
  danger?: boolean
}

/** A wrapping row of text buttons under a launcher card's title: what else can be done with the app. */
export const AgentAppLauncherActions: React.FC<{ actions: readonly (AgentAppLauncherAction | false | null | undefined)[] }> = ({
  actions
}) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const shown = actions.filter((action): action is AgentAppLauncherAction => Boolean(action))
  if (!shown.length) return null
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', mt: '4px', minWidth: 0 }}>
      {shown.map((action) => (
        <Box
          component="button"
          type="button"
          key={action.key}
          disabled={action.disabled}
          title={action.title}
          onClick={action.onClick}
          sx={{
            m: 0,
            p: 0,
            border: 0,
            bgcolor: 'transparent',
            color: action.danger ? tokens.danger : tokens.accent,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: tokens.fontSize.small,
            lineHeight: '18px',
            textAlign: 'left',
            overflowWrap: 'anywhere',
            '&:hover:not(:disabled)': { textDecoration: 'underline' },
            '&:focus-visible': { ...tokens.focusRing, outlineOffset: '2px' },
            '&:disabled': { opacity: tokens.disabledOpacity, cursor: 'default' }
          }}
        >
          {action.label}
        </Box>
      ))}
    </Box>
  )
}

export default AgentAppLauncherCard
