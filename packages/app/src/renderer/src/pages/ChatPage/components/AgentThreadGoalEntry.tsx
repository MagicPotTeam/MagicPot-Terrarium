import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Box, Button } from '@mui/material'
import type { AgentRouteLike } from '@shared/agent'
import AgentThreadGoalRecordsHost from './AgentThreadGoalRecordsHost'

/**
 * The goal records view that "/goal" opens. It belongs to the thread conversation it was opened
 * for: when that scope changes or stops being available the view closes, and showing it again
 * takes a new "/goal". The host owns the scope binding.
 *
 * In the Agent column the view is the body of a command card of the transcript: `cardHost` is
 * that body. The card has no close button; it leaves with the conversation.
 */
export default function AgentThreadGoalEntry({
  route,
  conversationId,
  active,
  remote,
  open,
  onClose,
  cardHost
}: {
  route?: AgentRouteLike
  conversationId?: string
  active: boolean
  remote: boolean
  open: boolean
  /** `dismissed` is true when the person closed the view (close button or Escape). */
  onClose: (dismissed?: boolean) => void
  /** Agent column: the card body to draw into (null until the card is there). */
  cardHost?: HTMLElement | null
}) {
  const { t } = useTranslation()
  const key =
    active && !remote && route?.channel === 'canvas' && route.scopeType === 'thread' && conversationId
      ? JSON.stringify([route.channel, route.scopeType, route.scopeId, route.threadId, conversationId])
      : ''
  const openedKey = useRef<string | null>(null)
  if (!open) openedKey.current = null
  else if (openedKey.current === null) openedKey.current = key
  const stale = open && (!key || openedKey.current !== key)
  useEffect(() => {
    if (stale) onClose()
  }, [stale, onClose])
  if (!open || stale) return null
  if (cardHost !== undefined) {
    return cardHost
      ? createPortal(
          <AgentThreadGoalRecordsHost
            key={key}
            route={route}
            conversationId={conversationId}
            active={active}
            remote={remote}
            embedded
          />,
          cardHost
        )
      : null
  }

  const closeLabel = t('chat.goal_close', { defaultValue: 'Close goals' })
  return (
    <Box
      data-testid="agent-goal-view"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
        event.stopPropagation()
        onClose(true)
      }}
      sx={{ px: 1, maxHeight: '50%', overflowY: 'auto', flexShrink: 0 }}
    >
      <Button size="small" onClick={() => onClose(true)}>
        {closeLabel === 'chat.goal_close' ? 'Close goals' : closeLabel}
      </Button>
      <AgentThreadGoalRecordsHost
        key={key}
        route={route}
        conversationId={conversationId}
        active={active}
        remote={remote}
      />
    </Box>
  )
}
