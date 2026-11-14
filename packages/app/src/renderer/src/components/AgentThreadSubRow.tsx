import React, { useContext, useLayoutEffect, useMemo } from 'react'
import { Box, ButtonBase } from '@mui/material'
import { useTheme } from '@mui/material/styles'

import { getAgentColumnTokens } from './agentColumnTokens'
import { AgentThreadSubRowPresenceContext } from './agentThreadSubRowPresence'

/** Text of a sub-row starts under the title of the thread row above it (past the status dot). */
export const AGENT_THREAD_SUB_ROW_INDENT = 29

interface AgentThreadSubRowProps {
  label: string
  /** The conversation this row stands for is the one shown in the pane. */
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}

/**
 * One indented row under a thread row of the Agent column's thread list: a conversation that
 * lives inside that thread (the main conversation or one of its side conversations). A chat
 * page renders these into the per-pane host that AgentWorkspace provides.
 */
const AgentThreadSubRow: React.FC<AgentThreadSubRowProps> = ({
  label,
  selected,
  disabled = false,
  onSelect
}) => {
  const theme = useTheme()
  const tokens = useMemo(() => getAgentColumnTokens(theme), [theme])
  const reportPresence = useContext(AgentThreadSubRowPresenceContext)
  useLayoutEffect(() => {
    if (!reportPresence) return undefined
    reportPresence(1)
    return () => reportPresence(-1)
  }, [reportPresence])

  return (
    <ButtonBase
      type="button"
      disableRipple
      disabled={disabled}
      aria-current={selected ? 'true' : undefined}
      data-agent-thread-sub-row=""
      onClick={onSelect}
      sx={{
        borderRadius: 0,
        boxShadow: 'none',
        fontFamily: 'inherit',
        fontSize: tokens.fontSize.base,
        lineHeight: '16px',
        textAlign: 'left',
        width: '100%',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: `7px 10px 7px ${AGENT_THREAD_SUB_ROW_INDENT}px`,
        borderBottom: `1px solid ${tokens.border}`,
        color: tokens.text,
        backgroundColor: selected ? tokens.selected : 'transparent',
        '&:hover': { backgroundColor: selected ? tokens.selected : tokens.hover },
        '&.Mui-focusVisible': tokens.focusRing,
        '&.Mui-disabled': { opacity: tokens.disabledOpacity }
      }}
    >
      <Box
        component="span"
        title={label}
        sx={{
          minWidth: 0,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {label}
      </Box>
    </ButtonBase>
  )
}

export default AgentThreadSubRow
