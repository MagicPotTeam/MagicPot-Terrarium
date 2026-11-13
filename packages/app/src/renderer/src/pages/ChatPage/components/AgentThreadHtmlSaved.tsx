import { htmlSnapshotOperation, acknowledgeHtmlRestore, canStartAnotherHtmlRestore, startAnotherHtmlRestore } from '../htmlSnapshotOperations'
import React, { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentHtmlSaved } from '@shared/api/agentThreadHtml'
import { api } from '../../../utils/windowUtils'

/** Metadata only. Restoring creates a disconnected card; it never launches HTML. */
export default function AgentThreadHtmlSaved({ scope, enabled, onChanged }: { scope: string; enabled: boolean; onChanged(): void }) {
  const { t } = useTranslation(), live = useRef(true), lock = useRef(false), generation = useRef(0)
  const [apps, setApps] = useState<AgentHtmlSaved[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(false), [confirmDelete, setConfirmDelete] = useState<string | undefined>(), [confirmAnother, setConfirmAnother] = useState<string | undefined>(), [, rerender] = useState(0)
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++ } }, [])
  useEffect(() => { if (!enabled) { generation.current++; setApps([]); setConfirmDelete(undefined); setConfirmAnother(undefined); setError(false) } }, [enabled])
  const run = async (operation: () => Promise<void>) => {
    if (!enabled || lock.current) return
    const owned = ++generation.current
    lock.current = true; setBusy(true); setError(false)
    try { await operation() }
    catch { if (live.current && owned === generation.current) setError(true) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  const refresh = async () => {
    const owned = generation.current, result = await api().svcLLMProxy.listSavedAgentHtmlApps(JSON.parse(scope))
    if (live.current && owned === generation.current) setApps(result.apps)
  }
  const restore = async (item: AgentHtmlSaved) => {
    const operationId = htmlSnapshotOperation(scope, 'restore', [item.id, item.storageRevision])
    const owned = generation.current
    await api().svcLLMProxy.restoreAgentHtmlApp({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: item.storageRevision, operationId })
    // Retain operation ID even after success: stale/double clicks cannot make
    // duplicate restored cards before the metadata refresh arrives.
    acknowledgeHtmlRestore(scope, [item.id, item.storageRevision], operationId)
    if (live.current && owned === generation.current) { rerender(value => value + 1); onChanged() }
  }
  const another = async (item: AgentHtmlSaved) => {
    startAnotherHtmlRestore(scope, [item.id, item.storageRevision]); setConfirmAnother(undefined)
    await restore(item)
  }
  const remove = async (item: AgentHtmlSaved) => {
    const owned = generation.current
    await api().svcLLMProxy.deleteSavedAgentHtmlApp({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: item.storageRevision })
    if (live.current && owned === generation.current) { setConfirmDelete(undefined); onChanged(); await refresh() }
  }
  if (!enabled) return null
  return <Box sx={{ mt: 1 }}>
    <Button size="small" disabled={busy} onClick={() => void run(refresh)}>{t('chat.agent_html.saved_refresh')}</Button>
    <Typography variant="caption" display="block">{t('chat.agent_html.saved_notice')}</Typography>
    {error && <Alert severity="error">{t('chat.agent_html.snapshot_failed')}</Alert>}
    {apps.map(item => <Box key={item.id} sx={{ mt: 1 }}>
      <Typography variant="body2">{item.title} · v{item.documentRevision} / {item.storageRevision}</Typography>
      <Typography variant="caption">{item.id} · {item.htmlBytes} B</Typography>
      <Button size="small" disabled={busy} onClick={() => void run(() => restore(item))}>{t('chat.agent_html.restore')}</Button>
      {canStartAnotherHtmlRestore(scope, [item.id, item.storageRevision]) && <Button size="small" disabled={busy} onClick={() => setConfirmAnother(item.id)}>{t('chat.agent_html.restore_another')}</Button>}
      {confirmAnother === item.id && <Box><Typography variant="caption">{t('chat.agent_html.restore_another_notice')}</Typography><Button size="small" disabled={busy} onClick={() => void run(() => another(item))}>{t('chat.agent_html.confirm_restore_another')}</Button><Button size="small" disabled={busy} onClick={() => setConfirmAnother(undefined)}>{t('chat.agent_html.cancel_delete')}</Button></Box>}
      <Button size="small" disabled={busy} onClick={() => setConfirmDelete(item.id)}>{t('chat.agent_html.delete_saved')}</Button>
      {confirmDelete === item.id && <Box><Typography variant="caption">{t('chat.agent_html.delete_notice')}</Typography><Button size="small" color="error" disabled={busy} onClick={() => void run(() => remove(item))}>{t('chat.agent_html.confirm_delete')}</Button><Button size="small" disabled={busy} onClick={() => setConfirmDelete(undefined)}>{t('chat.agent_html.cancel_delete')}</Button></Box>}
    </Box>)}
  </Box>
}
