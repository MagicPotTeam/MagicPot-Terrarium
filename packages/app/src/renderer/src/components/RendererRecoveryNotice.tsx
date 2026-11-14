// packages/app/src/renderer/src/components/RendererRecoveryNotice.tsx
// One persistent notice after the main process reloaded this window because its renderer died.
// It only informs: nothing is resent, and it stays until the user dismisses it.
import React, { useEffect, useState } from 'react'
import { Alert, AlertTitle, Box, Snackbar, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { RendererRecoveredEvent } from '@shared/utils/rendererRecoveryEvent'

function formatTime(epochMs: number, language: string): string {
  try {
    return new Date(epochMs).toLocaleTimeString(language)
  } catch {
    return new Date(epochMs).toISOString()
  }
}

export default function RendererRecoveryNotice(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [recovery, setRecovery] = useState<RendererRecoveredEvent | null>(null)

  useEffect(() => window.appEvents?.onRendererRecovered?.((event) => setRecovery(event)), [])

  if (!recovery) return null

  return (
    // No autoHideDuration and no onClose: neither time nor a click elsewhere hides it.
    <Snackbar open anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
      <Alert
        severity="warning"
        variant="filled"
        data-testid="renderer-recovery-notice"
        closeText={t('app_shell.renderer_recovery.dismiss')}
        onClose={() => setRecovery(null)}
        sx={{ maxWidth: 560 }}
      >
        <AlertTitle>{t('app_shell.renderer_recovery.title')}</AlertTitle>
        <Box component="span" sx={{ display: 'block' }}>
          {t('app_shell.renderer_recovery.body')}
        </Box>
        <Typography component="span" variant="caption" sx={{ display: 'block', mt: 0.5, opacity: 0.85 }}>
          {t('app_shell.renderer_recovery.details', {
            reason: recovery.reason,
            exitCode: recovery.exitCode,
            time: formatTime(recovery.diedAt, i18n.language)
          })}
        </Typography>
      </Alert>
    </Snackbar>
  )
}
