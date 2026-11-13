import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Paper, Stack, Typography } from '@mui/material'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { parseInstalledCatalogReadResponse, type InstalledCatalogPublicEntry } from '@shared/api/installedCatalog'
import { api } from '@renderer/utils/windowUtils'

type View = { status: 'idle' | 'loading' | 'unavailable' } | { status: 'available'; entries: readonly InstalledCatalogPublicEntry[] }
type Lifetime = { active: boolean; pending: boolean; sequence: number }
const exactRoute = () => window.location.hash === '#/agent-management'

/** Manual metadata snapshot only. Renderer lifetime checks never grant MAIN read authority. */
export default function ManagementInstalledCatalog() {
  const id = useId(), location = useLocation(), { i18n } = useTranslation()
  const chinese = i18n.language?.toLowerCase().startsWith('zh')
  const text = (en: string, zh: string) => chinese ? zh : en
  const lifetime = useRef<Lifetime | null>(null)
  const [view, setView] = useState<View>({ status: 'idle' })
  useLayoutEffect(() => {
    const owner: Lifetime = { active: true, pending: false, sequence: 0 }
    lifetime.current = owner
    setView({ status: 'idle' })
    const invalidate = () => {
      if (!owner.active || lifetime.current !== owner) return
      owner.sequence++; owner.pending = false
      setView({ status: 'idle' })
    }
    // Latch even departure→return observations; do not wait for the final hash to differ.
    window.addEventListener('hashchange', invalidate)
    window.addEventListener('popstate', invalidate)
    return () => {
      owner.active = false; owner.sequence++; owner.pending = false
      if (lifetime.current === owner) lifetime.current = null
      window.removeEventListener('hashchange', invalidate)
      window.removeEventListener('popstate', invalidate)
    }
    // HashRouter pushState can change only its inner hash, keeping MainArea's page key.
  }, [location])
  const read = async () => {
    const owner = lifetime.current
    if (!owner?.active || owner.pending) return
    if (!exactRoute()) { owner.sequence++; setView({ status: 'unavailable' }); return }
    owner.pending = true
    const sequence = ++owner.sequence
    const owns = () => owner.active && lifetime.current === owner && owner.sequence === sequence
    setView({ status: 'loading' }) // Discard old data before any service call or suspension.
    try {
      const raw = await api().svcMagicAgentPlatform.readInstalledCatalog({})
      if (!owns()) return
      if (!exactRoute()) { owner.pending = false; owner.sequence++; setView({ status: 'unavailable' }); return }
      const response = parseInstalledCatalogReadResponse(raw)
      if (!owns()) return
      owner.pending = false
      if (!exactRoute() || response.status !== 'available') setView({ status: 'unavailable' })
      else setView({ status: 'available', entries: response.entries })
    } catch {
      if (!owns()) return
      owner.pending = false
      setView({ status: 'unavailable' })
    }
  }
  return <Paper component="section" aria-labelledby={id} variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Typography id={id} component="h2" variant="h6">{text('Installed catalogs', '已安装目录')}</Typography>
      <Button onClick={() => { void read() }} disabled={view.status === 'loading'} sx={{ alignSelf: 'flex-start' }}>{text('Read installed catalog', '读取已安装目录')}</Button>
      {view.status === 'idle' && <Typography>{text('Not loaded — use Read installed catalog', '尚未读取 — 请点击读取已安装目录')}</Typography>}
      {view.status === 'loading' && <Typography role="status">{text('Reading installed catalog', '正在读取已安装目录')}</Typography>}
      {view.status === 'unavailable' && <Alert severity="warning">{text('Installed catalog unavailable', '已安装目录不可用')}</Alert>}
      {view.status === 'available' && (view.entries.length === 0
        ? <Typography>{text('No installed packages in the validated catalog snapshot', '已验证的目录快照中没有已安装包')}</Typography>
        : <Stack component="ul" spacing={1.5} sx={{ pl: 3 }}>{view.entries.map(entry => <Stack component="li" key={entry.id} sx={{ overflowWrap: 'anywhere' }}>
          <Typography>{entry.name}</Typography>
          <Typography variant="body2">ID: {entry.id}</Typography>
          <Typography variant="body2">{text('Version', '版本')}: {entry.version}</Typography>
          <Typography variant="body2">{text('Installed at', '安装时间')}: {entry.installedAt}</Typography>
        </Stack>)}</Stack>)}
    </Stack>
  </Paper>
}
