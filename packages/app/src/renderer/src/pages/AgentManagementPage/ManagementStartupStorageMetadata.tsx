import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Paper, Stack, Typography } from '@mui/material'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { parseStartupStorageMetadataResponse, type StartupStorageMetadataResponse } from '@shared/api/startupStorageMetadata'
import { useConfig } from '@renderer/hooks/useConfig'
import { useConfigObservation } from '@renderer/hooks/configObservationContext'
import type { ConfigObservationSnapshot } from '@renderer/hooks/configObservation'
import { api } from '@renderer/utils/windowUtils'

type Available = Extract<StartupStorageMetadataResponse, { status: 'available' }>
type View = { status: 'idle' | 'loading' | 'unavailable' } | Available
type Lifetime = { active: boolean; pending: boolean; sequence: number }
type OwnedView = { owner: Lifetime; sequence: number; observation: ConfigObservationSnapshot; view: View }
const idle: View = Object.freeze({ status: 'idle' })
const exactRawRoute = () => window.location.hash === '#/agent-management' && !window.location.href.split('#', 1)[0].includes('?')

/** Manual display snapshot only. Neither renderer readiness nor an observation grants MAIN authority. */
export default function ManagementStartupStorageMetadata() {
  const id = useId(), location = useLocation(), { i18n } = useTranslation(), { isReady } = useConfig()
  const source = useConfigObservation(), observation = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const chinese = i18n.language?.toLowerCase().startsWith('zh')
  const text = (en: string, zh: string) => chinese ? zh : en
  const lifetime = useRef<Lifetime | null>(null), [ownedView, setOwnedView] = useState<OwnedView | null>(null)
  const routerExact = location.pathname === '/agent-management' && location.search === '' && location.hash === ''
  const allowed = (snapshot: ConfigObservationSnapshot) => isReady && snapshot.ready && source.getSnapshot() === snapshot && routerExact && exactRawRoute()
  useLayoutEffect(() => {
    const owner: Lifetime = { active: true, pending: false, sequence: 0 }
    lifetime.current = owner
    const invalidate = () => {
      if (!owner.active || lifetime.current !== owner) return
      owner.sequence++; owner.pending = false // Retire synchronously, before React can batch the notification.
      setOwnedView(previous => owner.active && lifetime.current === owner ? null : previous)
    }
    invalidate()
    const unsubscribe = source.subscribe(invalidate)
    // Latch every observed event, including departure→return ending at the original URL.
    window.addEventListener('hashchange', invalidate)
    window.addEventListener('popstate', invalidate)
    return () => {
      owner.active = false; owner.sequence++; owner.pending = false
      if (lifetime.current === owner) lifetime.current = null
      unsubscribe()
      window.removeEventListener('hashchange', invalidate)
      window.removeEventListener('popstate', invalidate)
    }
    // Router replacement also covers retained HashRouter pages with only an inner-hash change.
  }, [source, location, isReady])
  const read = async () => {
    const owner = lifetime.current, snapshot = source.getSnapshot()
    if (!owner?.active || owner.pending || !allowed(snapshot)) return
    owner.pending = true
    const sequence = ++owner.sequence
    const owns = () => owner.active && lifetime.current === owner && owner.sequence === sequence
    const publish = (view: View) => setOwnedView(previous => owns() && allowed(snapshot) ? { owner, sequence, observation: snapshot, view } : previous)
    const discard = () => {
      if (!owns()) return
      owner.sequence++; owner.pending = false
      setOwnedView(previous => owner.active && lifetime.current === owner ? null : previous)
    }
    publish({ status: 'loading' }) // Clear old DTO before the service call or any suspension.
    try {
      const raw = await api().svcState.readStartupStorageMetadata({})
      if (!owns()) return
      if (!allowed(snapshot)) { discard(); return }
      const response = parseStartupStorageMetadataResponse(raw) // Exact RAW DTO, never stripped or normalized.
      if (!owns()) return
      if (!allowed(snapshot)) { discard(); return }
      owner.pending = false
      publish(response.status === 'available' ? response : { status: 'unavailable' })
    } catch {
      if (!owns()) return
      if (!allowed(snapshot)) { discard(); return }
      owner.pending = false
      publish({ status: 'unavailable' }) // Do not inspect, render or log diagnostics or attempt another read.
    }
  }
  const view = ownedView && ownedView.owner.active && lifetime.current === ownedView.owner && ownedView.owner.sequence === ownedView.sequence && ownedView.observation === observation && allowed(observation) ? ownedView.view : idle
  const label = view.status === 'available' ? {
    default: text('Default startup source', '默认启动来源'),
    persisted: text('Persisted startup source', '已保存的启动来源'),
    env: text('Environment startup source', '环境变量启动来源')
  }[view.source] : ''
  return <Paper component="section" aria-labelledby={id} variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1.5}>
      <Typography id={id} component="h2" variant="h6">{text('Startup storage metadata', '启动存储元数据')}</Typography>
      <Button onClick={() => { void read() }} disabled={!allowed(observation) || view.status === 'loading'} sx={{ alignSelf: 'flex-start' }}>{text('Read startup storage metadata', '读取启动存储元数据')}</Button>
      {view.status === 'idle' && <Typography>{text('Not loaded — use Read startup storage metadata', '尚未读取 — 请点击读取启动存储元数据')}</Typography>}
      {view.status === 'loading' && <Typography role="status">{text('Reading startup storage metadata', '正在读取启动存储元数据')}</Typography>}
      {view.status === 'unavailable' && <Alert severity="warning">{text('Startup storage metadata unavailable', '启动存储元数据不可用')}</Alert>}
      {view.status === 'available' && <>
        <Typography>{text(`Source: ${label}`, `来源：${label}`)}</Typography>
        <Typography>{text(`Legacy layout: ${view.legacyLayout ? 'Yes' : 'No'}`, `旧版布局：${view.legacyLayout ? '是' : '否'}`)}</Typography>
      </>}
    </Stack>
  </Paper>
}
