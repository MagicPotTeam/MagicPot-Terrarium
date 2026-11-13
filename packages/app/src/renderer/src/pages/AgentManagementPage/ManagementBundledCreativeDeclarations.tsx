import { useId, useLayoutEffect, useState } from 'react'
import { Button, Paper, Stack, Typography } from '@mui/material'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'

/** Compile-time descriptive strings only, never a service read, live capability or execution grant. */
export default function ManagementBundledCreativeDeclarations() {
  const id = useId()
  const location = useLocation()
  const { i18n } = useTranslation()
  const chinese = i18n.language?.toLowerCase().startsWith('zh')
  const text = (en: string, zh: string) => chinese ? zh : en
  const [shown, setShown] = useState(false)
  // HashRouter can retain this instance when only its inner hash changes.
  useLayoutEffect(() => { setShown(false) }, [location])
  return <Paper component="section" aria-labelledby={id} variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Typography id={id} component="h2" variant="h6">{text('Bundled creative-tool declarations', '随构建提供的创作工具声明')}</Typography>
      <Button aria-expanded={shown} aria-controls={`${id}-preview`} onClick={() => setShown(value => !value)} sx={{ alignSelf: 'flex-start' }}>
        {shown ? text('Hide bundled declarations', '隐藏内置声明') : text('Show bundled declarations', '显示内置声明')}
      </Button>
      <Stack id={`${id}-preview`} spacing={1.5}>
        {!shown ? <Typography>{text('Not shown — use Show bundled declarations', '尚未显示 — 请点击显示内置声明')}</Typography> : <>
          <Typography>{text(`${Object.keys(bundledCreativeDeclarations).length} bundled declarations`, `${Object.keys(bundledCreativeDeclarations).length} 条随构建提供的声明`)}</Typography>
          <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>
            {Object.values(bundledCreativeDeclarations).map(row => <Stack component="li" key={row.name} sx={{ overflowWrap: 'anywhere' }}>
              <Typography>{row.name}</Typography>
              <Typography variant="body2">{text('Category', '分类')}: {row.category}</Typography>
              <Typography variant="body2">{row.description}</Typography>
            </Stack>)}
          </Stack>
        </>}
      </Stack>
    </Stack>
  </Paper>
}
