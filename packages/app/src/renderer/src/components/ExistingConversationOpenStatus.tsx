import { useState } from 'react'
import { Button, Paper, Stack, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { existingConversationOpenStore as coordinator, useExistingConversationOpenSnapshot } from '../utils/existingConversationOpenStore'
import type { OpenFailure, OpenRequestHandle } from '../utils/existingConversationOpen'

/** Layout-owned feedback survives the management source page. It grants no Open authority. */
export default function ExistingConversationOpenStatus() {
  const snapshot = useExistingConversationOpenSnapshot()
  const [dismissed, setDismissed] = useState<OpenRequestHandle | null>(null)
  const { t } = useTranslation()
  const request = snapshot.request
  const result = snapshot.result
  if (!request && (!result || result.handle === dismissed)) return null
  const target = (request?.handle ?? result!.handle).target
  const failure = (reason?: OpenFailure) => {
    switch (reason) {
      case 'cancelled': return t('app_shell.existing_conversation_open.failure_cancelled')
      case 'expired': return t('app_shell.existing_conversation_open.failure_expired')
      case 'membership-unavailable': return t('app_shell.existing_conversation_open.failure_membership_unavailable')
      case 'load-failed': return t('app_shell.existing_conversation_open.failure_load_failed')
      case 'destination-lost': return t('app_shell.existing_conversation_open.failure_destination_lost')
      case 'superseded': return t('app_shell.existing_conversation_open.failure_superseded')
      default: return t('app_shell.existing_conversation_open.failure_unavailable')
    }
  }
  return (
    <Paper component="section" role="region" aria-label={t('app_shell.existing_conversation_open.region')} variant="outlined" sx={{ px: 2, py: 1, flexShrink: 0 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography role="status" aria-live="polite">
            {request ? t('app_shell.existing_conversation_open.opening') : result!.status === 'succeeded' ? t('app_shell.existing_conversation_open.opened') : t('app_shell.existing_conversation_open.open_failed')}
          </Typography>
          {!request && result!.status === 'rejected' && <Typography variant="body2">{failure(result!.reason)}</Typography>}
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {t('app_shell.existing_conversation_open.target', { projectId: target.projectId, paneId: target.paneId, sessionId: target.sessionId })}
          </Typography>
        </Stack>
        {request ? (
          <Button onClick={() => {
            // A stale rendered cancel control cannot cancel a synchronous replacement.
            if (coordinator.getSnapshot().request?.handle === request.handle) coordinator.cancel(request.handle)
          }}>{t('app_shell.existing_conversation_open.cancel')}</Button>
        ) : (
          <Button onClick={() => setDismissed(result!.handle)}>{t('app_shell.existing_conversation_open.dismiss')}</Button>
        )}
      </Stack>
    </Paper>
  )
}
