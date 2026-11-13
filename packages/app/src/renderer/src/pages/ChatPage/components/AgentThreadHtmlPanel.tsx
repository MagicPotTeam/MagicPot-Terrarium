import { htmlSnapshotOperation } from '../htmlSnapshotOperations'
import AgentThreadHtmlSaved from './AgentThreadHtmlSaved'
import React, { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentHtmlApp, AgentHtmlStorageStatus } from '@shared/api/agentThreadHtml'
import { api } from '../../../utils/windowUtils'
function HtmlAppRow({ item, scope, canOpen, canSave, onChanged }: { item: AgentHtmlApp; scope: string; canOpen: boolean; canSave: boolean; onChanged(): void }) {
  const { t } = useTranslation(), live = useRef(true), locks = useRef({ open: false, close: false, save: false }), generation = useRef(0), saveGeneration = useRef(0)
  const [busy, setBusy] = useState({ open: false, close: false, save: false }), [error, setError] = useState(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { saveGeneration.current++; if (!canSave) setError(false) }, [canSave])
  const act = async (open: boolean) => {
    const action = open ? 'open' : 'close'
    if (locks.current[action] || open && locks.current.close) return
    const owned = ++generation.current
    locks.current[action] = true; setBusy({ ...locks.current }); setError(false)
    const req = { ...JSON.parse(scope), appId: item.id, expectedRevision: item.revision }
    delete req.documentToken
    try { if (open) await api().svcLLMProxy.openAgentHtmlApp(req); else await api().svcLLMProxy.closeAgentHtmlApp(req) }
    catch { if (live.current && owned === generation.current) setError(true) }
    finally { locks.current[action] = false; if (live.current) setBusy({ ...locks.current }) }
  }
  const save = async () => {
    if (!canSave || Object.values(locks.current).some(Boolean)) return
    const owned = ++generation.current, saveOwned = saveGeneration.current
    locks.current.save = true; setBusy({ ...locks.current }); setError(false)
    try {
      const operationId = htmlSnapshotOperation(scope, 'save', [item.id, item.revision, item.savedRevision ?? 0])
      await api().svcLLMProxy.saveAgentHtmlApp({ ...JSON.parse(scope), appId: item.id, expectedRevision: item.revision, expectedStorageRevision: item.savedRevision ?? 0, operationId })
      if (live.current && owned === generation.current && saveOwned === saveGeneration.current) onChanged()
    } catch { if (live.current && owned === generation.current && saveOwned === saveGeneration.current) setError(true) }
    finally { locks.current.save = false; if (live.current) setBusy({ ...locks.current }) }
  }
  return <Box sx={{ mt: 1 }}>
    <Typography variant="body2">{item.title} · {t(`chat.agent_html.status_${item.status}`)}</Typography>
    <Typography variant="caption">{item.id} · v{item.revision}</Typography>
    {item.status === 'ready' && <Button size="small" disabled={!canOpen || busy.open || busy.close || busy.save} onClick={() => void act(true)}>{t('chat.agent_html.open')}</Button>}
    {['ready', 'opening', 'open'].includes(item.status) && <Button size="small" disabled={busy.close} onClick={() => void act(false)}>{t('chat.agent_html.close')}</Button>}
    {canSave && item.snapshotReady !== false && ['ready', 'closed'].includes(item.status) && <Button size="small" disabled={busy.open || busy.close || busy.save} onClick={() => void save()}>{t('chat.agent_html.save_snapshot')}</Button>}
    {error && <Alert severity="error">{t('chat.agent_html.error')}</Alert>}
    {item.status === 'unknown' && <Alert severity="warning">{t('chat.agent_html.unknown')}</Alert>}
  </Box>
}
let lifecycleRevision = 0
function HtmlApps({ scope }: { scope: string }) {
  const { t } = useTranslation(), [apps, setApps] = useState<AgentHtmlApp[]>([]), [storage, setStorage] = useState<AgentHtmlStorageStatus | undefined>()
  const [revision, setRevision] = useState(0)
  const [initializing, setInitializing] = useState(false), [storageError, setStorageError] = useState(false), live = useRef(true), initLock = useRef(false), storageGeneration = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const [boundScope, setBoundScope] = useState<string | undefined>()
  useEffect(() => {
    const service = api().svcLLMProxy, revision = ++lifecycleRevision
    let current = true; setBoundScope(undefined)
    try {
      const activation = service.setAgentHtmlScope({ ...JSON.parse(scope), active: true, lifecycleRevision: revision })
      void Promise.resolve(activation).then(result => { if (current && result.documentToken) setBoundScope(JSON.stringify({ ...JSON.parse(scope), documentToken: result.documentToken })) }).catch(() => { if (current) setStorageError(true) })
    } catch { setStorageError(true) }
    return () => { current = false; try { void service.setAgentHtmlScope({ ...JSON.parse(scope), active: false, lifecycleRevision: revision }).catch(() => undefined) } catch { /* Capability already unavailable. */ } }
  }, [scope])
  const initialize = async () => {
    if (!boundScope || initLock.current) return
    const generation = ++storageGeneration.current
    initLock.current = true; setInitializing(true); setStorageError(false)
    try { await api().svcLLMProxy.initializeAgentHtmlStorage(JSON.parse(boundScope)); if (live.current) { const status = await api().svcLLMProxy.agentHtmlStorageStatus(JSON.parse(boundScope)); if (live.current && generation === storageGeneration.current) setStorage(status) } }
    catch { if (live.current && generation === storageGeneration.current) setStorageError(true) }
    finally { initLock.current = false; if (live.current) setInitializing(false) }
  }
  useEffect(() => {
    const service = api().svcLLMProxy
    if (!boundScope || typeof service.listAgentHtmlApps !== 'function') return
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const generation = storageGeneration.current
      try {
        const result = await service.listAgentHtmlApps(JSON.parse(scope))
        if (!closed) setApps(result.apps.filter(item => item.expiresAt > Date.now() || ['opening', 'open', 'stopping', 'unknown'].includes(item.status)))
        if (typeof service.agentHtmlStorageStatus === 'function') { const status = await service.agentHtmlStorageStatus(JSON.parse(boundScope)); if (!closed && generation === storageGeneration.current && !initLock.current) setStorage(status) }
      }
      catch { if (!closed) { setApps(previous => previous.filter(item => item.expiresAt > Date.now() || ['opening', 'open', 'stopping', 'unknown'].includes(item.status))); if (generation === storageGeneration.current && !initLock.current) setStorage(undefined) } }
      finally { if (!closed) timer = setTimeout(() => void poll(), 1000) }
    }
    void poll(); return () => { closed = true; clearTimeout(timer) }
  }, [scope, boundScope, revision])
  if (!apps.length && !storage?.enabled) return null
  return <Box role="region" aria-label={t('chat.agent_html.title')} sx={{ mx: 2, mb: 1, p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
    <Typography variant="subtitle2">{t('chat.agent_html.title')}</Typography>
    <Typography variant="caption">{t('chat.agent_html.notice')}</Typography>
    {storage?.enabled && <Box>
      {!storage.initialized && storage.canInitialize && <><Alert severity="info">{t('chat.agent_html.initialize_notice')}</Alert><Button size="small" disabled={initializing || !storage.available} onClick={() => void initialize()}>{t('chat.agent_html.initialize')}</Button></>}
      {(!storage.available || !storage.initialized && !storage.canInitialize) && <Alert severity="warning">{t('chat.agent_html.storage_unavailable')}</Alert>}
      {storage.initialized && storage.unconfirmedRuns !== null && storage.unconfirmedRuns > 0 && <Alert severity="info">{t('chat.agent_html.run_slots', { count: storage.unconfirmedRuns })}</Alert>}
      {storageError && <Alert severity="error">{t('chat.agent_html.initialize_failed')}</Alert>}
    </Box>}
    {boundScope && <AgentThreadHtmlSaved scope={boundScope} enabled={storage?.initialized === true && storage.available && storage.saveEnabled} onChanged={() => setRevision(value => value + 1)} />}
    {apps.map(item => <HtmlAppRow key={item.id} item={item} scope={boundScope ?? scope} canOpen={storage?.enabled === true && storage.initialized && storage.available} canSave={storage?.initialized === true && storage.available && storage.saveEnabled} onChanged={() => setRevision(value => value + 1)} />)}
  </Box>
}
export default function AgentThreadHtmlPanel({ route, conversationId, active }: { route?: AgentRouteLike; conversationId?: string; active: boolean }) {
  if (!active || !conversationId || route?.channel !== 'canvas' || route.scopeType !== 'thread') return null
  const scope = JSON.stringify({ route, conversationId })
  return <HtmlApps key={scope} scope={scope} />
}
