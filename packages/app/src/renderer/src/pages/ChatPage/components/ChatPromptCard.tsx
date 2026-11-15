import React from 'react'
import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { getAgentColumnTokens } from '../../../components/agentColumnTokens'

export type ChatPromptCardOption = {
  key: string
  label: string
  /** The filled button; the others are outlined. */
  primary?: boolean
  /** Error colour. */
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type ChatPromptCardAccent = 'neutral' | 'warning' | 'danger' | 'info'

/** How an answered card reads: the state word in the header and the reply under the prompt. */
export type ChatPromptCardResolution = { state: string; reply?: string }

/**
 * A question to the person, shown as a row at the end of the transcript: a header (14px icon and
 * a title), the prompt, an optional detail, then the controls. Controls are a wrapping row of
 * option buttons and/or `children` (a text field, a form). Once answered the card stays, dimmed,
 * with the state word in the header and the reply instead of the controls.
 */
export const ChatPromptCard: React.FC<{
  /** A 14px icon element; it takes the accent colour. */
  icon?: React.ReactNode
  title: string
  prompt?: React.ReactNode
  detail?: React.ReactNode
  options?: readonly ChatPromptCardOption[]
  accent?: ChatPromptCardAccent
  resolution?: ChatPromptCardResolution | null
  testId?: string
  children?: React.ReactNode
}> = ({
  icon,
  title,
  prompt,
  detail,
  options,
  accent = 'neutral',
  resolution,
  testId = 'chat-prompt-card',
  children
}) => {
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const titleId = React.useId()
  const accentColor =
    accent === 'warning'
      ? tokens.attention
      : accent === 'danger'
        ? tokens.danger
        : accent === 'info'
          ? tokens.accent
          : null
  const resolved = Boolean(resolution)

  return (
    <Box
      component="section"
      role="group"
      aria-labelledby={titleId}
      data-testid={testId}
      data-resolved={resolved ? 'true' : undefined}
      sx={{
        boxSizing: 'border-box',
        minWidth: 0,
        margin: '8px 0',
        padding: '10px 12px',
        border: `1px solid ${accentColor ? alpha(accentColor, 0.4) : tokens.border}`,
        borderRadius: `${tokens.radius.content}px`,
        bgcolor: accentColor ? alpha(accentColor, 0.06) : 'transparent',
        color: tokens.text,
        opacity: resolved ? 0.55 : 1
      }}
    >
      <Box
        component="header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6.4px',
          minWidth: 0,
          mb: '4px',
          color: accentColor ?? tokens.text,
          '& > svg': { fontSize: 14, flexShrink: 0 }
        }}
      >
        {icon}
        <Box
          component="span"
          id={titleId}
          data-testid="chat-prompt-card-title"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: tokens.fontSize.small,
            lineHeight: '16px',
            fontWeight: 500
          }}
        >
          {title}
        </Box>
        {resolution ? (
          <Box
            component="span"
            data-testid="chat-prompt-card-state"
            sx={{
              ml: 'auto',
              flexShrink: 0,
              fontSize: tokens.fontSize.micro,
              lineHeight: '16px',
              color: tokens.muted
            }}
          >
            {resolution.state}
          </Box>
        ) : null}
      </Box>
      {prompt ? (
        <Box
          data-testid="chat-prompt-card-prompt"
          sx={{
            padding: '8px 4px',
            overflowWrap: 'anywhere',
            fontSize: 14,
            lineHeight: '20px',
            fontWeight: 500
          }}
        >
          {prompt}
        </Box>
      ) : null}
      {detail ? (
        <Box
          data-testid="chat-prompt-card-detail"
          sx={{
            padding: '0 4px 8px',
            maxHeight: '16rem',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontSize: tokens.fontSize.small,
            lineHeight: '18px',
            color: tokens.muted
          }}
        >
          {detail}
        </Box>
      ) : null}
      {resolution ? (
        resolution.reply ? (
          <Box
            data-testid="chat-prompt-card-reply"
            sx={{
              padding: '0 4px',
              overflowWrap: 'anywhere',
              fontSize: tokens.fontSize.small,
              lineHeight: '18px',
              fontStyle: 'italic',
              color: tokens.muted
            }}
          >
            {`→ ${resolution.reply}`}
          </Box>
        ) : null
      ) : (
        <>
          {children}
          {options?.length ? (
            <Box
              data-testid="chat-prompt-card-options"
              sx={{ display: 'flex', flexWrap: 'wrap', gap: '8px', minWidth: 0 }}
            >
              {options.map((option) => {
                const color = option.danger ? tokens.danger : tokens.accent
                return (
                  <Box
                    component="button"
                    type="button"
                    key={option.key}
                    data-option={option.key}
                    data-primary={option.primary ? 'true' : undefined}
                    disabled={option.disabled}
                    onClick={option.onSelect}
                    sx={{
                      boxSizing: 'border-box',
                      minWidth: 0,
                      minHeight: 32,
                      m: 0,
                      padding: '4px 15px',
                      border: `1px solid ${option.primary ? color : option.danger ? alpha(color, 0.5) : tokens.border}`,
                      borderRadius: `${tokens.radius.control}px`,
                      bgcolor: option.primary ? color : 'transparent',
                      color: option.primary
                        ? theme.palette.getContrastText(color)
                        : option.danger
                          ? color
                          : tokens.text,
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 14,
                      lineHeight: '20px',
                      overflowWrap: 'anywhere',
                      '&:hover:not(:disabled)': option.primary
                        ? { filter: 'brightness(1.1)' }
                        : { bgcolor: tokens.hover },
                      '&:focus-visible': { outline: `2px solid ${color}`, outlineOffset: '2px' },
                      '&:disabled': { opacity: tokens.disabledOpacity, cursor: 'default' }
                    }}
                  >
                    {option.label}
                  </Box>
                )
              })}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  )
}

export default ChatPromptCard
