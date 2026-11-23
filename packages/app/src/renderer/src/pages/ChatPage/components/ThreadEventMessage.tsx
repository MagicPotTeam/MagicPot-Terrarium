import React from 'react'
import { Box, Typography } from '@mui/material'
import type { TFunction } from 'i18next'
import { threadEventDisplayText, type AgentThreadEventOrigin } from '@shared/api/agentThreadInbox'

/**
 * An injected thread event turn, shown like KohakuTerrarium's trigger transcript row (VS Code
 * extension 0.1.3: kt-conversation-banner is-compact): a compact banner with the bold title
 * "Triggered by {source}" and the event content below it. Never the user's bubble: no "You"
 * author, no edit action, and the content is plain text.
 */
const ThreadEventMessage: React.FC<{
  origin: AgentThreadEventOrigin
  content: string
  isLight: boolean
  t: TFunction<'translation'>
}> = ({ origin, content, isLight, t }) => (
  <Box
    data-testid="chat-thread-event-message"
    data-thread-event-type={origin.type}
    sx={{ mb: 2, px: 2, minWidth: 0 }}
  >
    <Box
      sx={{
        border: '1px solid',
        borderColor: isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.14)',
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        minWidth: 0
      }}
    >
      <Typography
        variant="body2"
        component="div"
        data-testid="chat-thread-event-title"
        sx={{ fontWeight: 700, wordBreak: 'break-word' }}
      >
        {t('chat.thread_event_triggered_by', {
          source: origin.source,
          defaultValue: 'Triggered by {{source}}',
          interpolation: { escapeValue: false }
        })}
      </Typography>
      <Typography
        variant="body2"
        component="div"
        sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.5 }}
      >
        {threadEventDisplayText(content)}
      </Typography>
    </Box>
  </Box>
)

export default ThreadEventMessage
