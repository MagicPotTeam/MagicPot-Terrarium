import React, { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import type { AgentColumnToastSeverity } from '@renderer/hooks/agentColumnToastContext'
import { getAgentColumnRaisedSurface, getAgentColumnTokens } from './agentColumnTokens'

export type Toast = {
  key: string
  severity: AgentColumnToastSeverity
  message: string
  /** null: stays until dismissed. */
  duration: number | null
  /** Bumped when the same message is raised again: its lifetime starts over. */
  revision: number
}

const AgentColumnToastItem: React.FC<{ toast: Toast; onDismiss: (key: string) => void }> = ({
  toast,
  onDismiss
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = getAgentColumnTokens(theme)
  // Hovering or focusing the toast pauses its timer; leaving restarts a full interval.
  const [paused, setPaused] = useState(false)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (paused || toast.duration === null) return
    const timer = window.setTimeout(() => onDismiss(toast.key), toast.duration)
    return () => window.clearTimeout(timer)
  }, [onDismiss, paused, toast.duration, toast.key, toast.revision])

  const stripe = {
    info: theme.palette.info.main,
    success: theme.palette.success.main,
    warning: theme.palette.warning.main,
    error: theme.palette.error.main
  }[toast.severity]
  const urgent = toast.severity === 'warning' || toast.severity === 'error'

  return (
    <Box
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      data-testid="agent-column-toast"
      data-severity={toast.severity}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={(event) => {
        if (!returnFocusRef.current && event.relatedTarget instanceof HTMLElement) {
          returnFocusRef.current = event.relatedTarget
        }
        setPaused(true)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        returnFocusRef.current = null
        setPaused(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        const target = returnFocusRef.current
        onDismiss(toast.key)
        if (target?.isConnected) target.focus()
      }}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        minWidth: 0,
        padding: '10px',
        border: `1px solid ${tokens.border}`,
        borderLeft: `3px solid ${stripe}`,
        borderRadius: '4px',
        backgroundColor: getAgentColumnRaisedSurface(theme),
        color: tokens.text,
        boxShadow: '0 2px 8px rgba(0,0,0,0.36)',
        pointerEvents: 'auto'
      }}
    >
      <Box
        component="span"
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: tokens.fontSize.base,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        }}
      >
        {t(`agent_workspace.toast.prefix_${toast.severity}`)}
        {toast.message}
      </Box>
      <Box
        component="button"
        type="button"
        aria-label={t('agent_workspace.toast.dismiss')}
        onClick={() => onDismiss(toast.key)}
        sx={{
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 24,
          minHeight: 24,
          m: '-3px 0',
          padding: 0,
          border: 0,
          borderRadius: '2px',
          backgroundColor: 'transparent',
          color: tokens.muted,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 16,
          lineHeight: 1,
          '&:hover': { color: tokens.text, backgroundColor: tokens.hover },
          '&:focus-visible': { outline: `2px solid ${tokens.accent}`, outlineOffset: '1px' }
        }}
      >
        ×
      </Box>
    </Box>
  )
}

export default AgentColumnToastItem
