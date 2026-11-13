import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Button } from '@mui/material'
import type { AgentRouteLike } from '@shared/agent'
import AgentThreadGoalRecordsHost from './AgentThreadGoalRecordsHost'

/** Local, explicitly opened manual-records surface; the host owns its scope lifecycle. */
export default function AgentThreadGoalEntry({ route, conversationId, active, remote }: {
  route?: AgentRouteLike
  conversationId?: string
  active: boolean
  remote: boolean
}) {
  const key = active && !remote && route?.channel === 'canvas' && route.scopeType === 'thread' && conversationId
    ? JSON.stringify([route.channel, route.scopeType, route.scopeId, route.threadId, conversationId])
    : ''
  if (!key) return null
  return <GoalEntryScope key={key} route={route} conversationId={conversationId} active={active} remote={remote} />
}

function GoalEntryScope({ route, conversationId, active, remote }: {
  route?: AgentRouteLike
  conversationId?: string
  active: boolean
  remote: boolean
}) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const translate = (key: string, fallback: string) => {
    const value = t(key, { defaultValue: fallback })
    return value === key ? fallback : value
  }
  return <Box sx={{ px: 1, maxHeight: '50%', overflowY: 'auto', flexShrink: 0 }}>
    <Button size="small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? translate('chat.goal_close', 'Close goals') : translate('chat.goal_open', 'Goals')}</Button>
    {open ? <AgentThreadGoalRecordsHost route={route} conversationId={conversationId} active={active} remote={remote} /> : null}
  </Box>
}
