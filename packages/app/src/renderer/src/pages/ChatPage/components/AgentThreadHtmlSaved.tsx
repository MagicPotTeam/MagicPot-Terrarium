import { htmlSnapshotOperation, acknowledgeHtmlRestore, canStartAnotherHtmlRestore, startAnotherHtmlRestore } from '../htmlSnapshotOperations'
import React, { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentHtmlSaved } from '@shared/api/agentThreadHtml'
import { api } from '../../../utils/windowUtils'
import { AgentAppLauncherActions, AgentAppLauncherLine } from './AgentAppLauncherCard'

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
  // Saved copies in an app card's body: a text button to list them, then one entry per copy.
  return <Box data-testid="agent-html-saved" sx={{ mt: '4px', minWidth: 0 }}>
    <AgentAppLauncherActions actions={[{ key: 'refresh', label: t('chat.agent_html.saved_refresh'), title: t('chat.agent_html.saved_notice'), disabled: busy, onClick: () => void run(refresh) }]} />
    {error && <AgentAppLauncherLine tone="error">{t('chat.agent_html.snapshot_failed')}</AgentAppLauncherLine>}
    {apps.map(item => <Box key={item.id} data-testid="agent-html-saved-item" sx={{ mt: '6px', minWidth: 0 }}>
      <Box sx={{ overflowWrap: 'anywhere' }}>{item.title} · v{item.documentRevision} / {item.storageRevision}</Box>
      <AgentAppLauncherLine>{item.id} · {item.htmlBytes} B</AgentAppLauncherLine>
      <AgentAppLauncherActions actions={[
        { key: 'restore', label: t('chat.agent_html.restore'), disabled: busy, onClick: () => void run(() => restore(item)) },
        canStartAnotherHtmlRestore(scope, [item.id, item.storageRevision]) && { key: 'another', label: t('chat.agent_html.restore_another'), disabled: busy, onClick: () => setConfirmAnother(item.id) },
        { key: 'delete', label: t('chat.agent_html.delete_saved'), danger: true, disabled: busy, onClick: () => setConfirmDelete(item.id) }
      ]} />
      {confirmAnother === item.id && <>
        <AgentAppLauncherLine>{t('chat.agent_html.restore_another_notice')}</AgentAppLauncherLine>
        <AgentAppLauncherActions actions={[
          { key: 'confirm-another', label: t('chat.agent_html.confirm_restore_another'), disabled: busy, onClick: () => void run(() => another(item)) },
          { key: 'cancel-another', label: t('chat.agent_html.cancel_delete'), disabled: busy, onClick: () => setConfirmAnother(undefined) }
        ]} />
      </>}
      {confirmDelete === item.id && <>
        <AgentAppLauncherLine>{t('chat.agent_html.delete_notice')}</AgentAppLauncherLine>
        <AgentAppLauncherActions actions={[
          { key: 'confirm-delete', label: t('chat.agent_html.confirm_delete'), danger: true, disabled: busy, onClick: () => void run(() => remove(item)) },
          { key: 'cancel-delete', label: t('chat.agent_html.cancel_delete'), disabled: busy, onClick: () => setConfirmDelete(undefined) }
        ]} />
      </>}
    </Box>)}
  </Box>
}
