import React from 'react'
import { Box, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentColumnTokens } from '../../../components/agentColumnTokens'

/**
 * The Agent column's empty transcript: a 48px tile, "No messages yet" and a muted hint (left out
 * where no message can be sent).
 */
export const ChatTranscriptEmptyState: React.FC<{
  tokens: AgentColumnTokens
  showHint?: boolean
}> = ({ tokens: columnTokens, showHint = true }) => {
  const { t } = useTranslation()
  return (
    <Box data-testid="chat-empty-state" sx={{ px: '16px', py: '64px', textAlign: 'center' }}>
      <Box
        aria-hidden="true"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 48,
          height: 48,
          mx: 'auto',
          mb: '12px',
          borderRadius: '16px',
          bgcolor: columnTokens.surface
        }}
      >
        <Box
          sx={{
            width: 11,
            height: 11,
            boxSizing: 'border-box',
            border: '1.5px solid',
            borderColor: columnTokens.accent,
            transform: 'rotate(45deg)'
          }}
        />
      </Box>
      <Typography sx={{ m: 0, fontSize: 14, lineHeight: '20px', color: columnTokens.muted }}>
        {t('chat.transcript.empty_title')}
      </Typography>
      {showHint ? (
        <Typography
          sx={{
            m: 0,
            mt: '4px',
            fontSize: 12,
            lineHeight: '16px',
            color: columnTokens.muted,
            opacity: 0.75
          }}
        >
          {t('chat.transcript.empty_hint')}
        </Typography>
      ) : null}
    </Box>
  )
}

export default ChatTranscriptEmptyState
