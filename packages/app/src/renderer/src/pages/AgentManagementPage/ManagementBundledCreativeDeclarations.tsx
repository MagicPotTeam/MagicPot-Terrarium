import { useId, useLayoutEffect, useState } from 'react'
import { Button, Paper, Stack, Typography } from '@mui/material'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'

/** Compile-time descriptive strings only, never a service read, live capability or execution grant. */
export default function ManagementBundledCreativeDeclarations() {
  const id = useId()
  const location = useLocation()
  const { t } = useTranslation()
  const [shown, setShown] = useState(false)
  // HashRouter can retain this instance when only its inner hash changes.
  useLayoutEffect(() => { setShown(false) }, [location])
  return <Paper component="section" aria-labelledby={id} variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Typography id={id} component="h2" variant="h6">{t('agent_management.bundled_declarations.heading')}</Typography>
      <Button aria-expanded={shown} aria-controls={`${id}-preview`} onClick={() => setShown(value => !value)} sx={{ alignSelf: 'flex-start' }}>
        {shown ? t('agent_management.bundled_declarations.hide') : t('agent_management.bundled_declarations.show')}
      </Button>
      <Stack id={`${id}-preview`} spacing={1.5}>
        {!shown ? <Typography>{t('agent_management.bundled_declarations.idle')}</Typography> : <>
          <Typography>{t('agent_management.bundled_declarations.count', { total: Object.keys(bundledCreativeDeclarations).length })}</Typography>
          <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>
            {Object.values(bundledCreativeDeclarations).map(row => <Stack component="li" key={row.name} sx={{ overflowWrap: 'anywhere' }}>
              <Typography>{row.name}</Typography>
              <Typography variant="body2">{t('agent_management.bundled_declarations.category')}: {row.category}</Typography>
              <Typography variant="body2">{row.description}</Typography>
            </Stack>)}
          </Stack>
        </>}
      </Stack>
    </Stack>
  </Paper>
}
