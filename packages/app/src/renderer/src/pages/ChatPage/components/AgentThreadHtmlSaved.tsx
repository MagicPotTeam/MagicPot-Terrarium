import { htmlSnapshotOperation, acknowledgeHtmlRestore, canStartAnotherHtmlRestore, startAnotherHtmlRestore } from '../htmlSnapshotOperations'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHtmlSaved } from '@shared/api/agentThreadHtml'
import { api } from '../../../utils/windowUtils'
import { AgentAppLauncherActions, AgentAppLauncherCard, AgentAppLauncherLine } from './AgentAppLauncherCard'

/**
 * The thread's saved snapshots, each as an app launcher card (title + 恢复). Metadata only:
 * restoring creates a disconnected card; it never launches HTML. The list is read when saving is
 * available and again after each change (`revision`); with no snapshot nothing is drawn.
 */
export default function AgentThreadHtmlSaved({ scope, enabled, revision = 0, onChanged }: { scope: string; enabled: boolean; revision?: number; onChanged(): void }) {
  const { t } = useTranslation(), live = useRef(true), lock = useRef(false), generation = useRef(0)
  const [apps, setApps] = useState<AgentHtmlSaved[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | undefined>(), [confirmDelete, setConfirmDelete] = useState<string | undefined>(), [confirmAnother, setConfirmAnother] = useState<string | undefined>(), [, rerender] = useState(0)
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++ } }, [])
  useEffect(() => { if (!enabled) { generation.current++; setApps([]); setConfirmDelete(undefined); setConfirmAnother(undefined); setError(undefined) } }, [enabled])
  // `target`: the snapshot whose card shows a failure (a failed list read shows none).
  const run = async (operation: () => Promise<void>, target?: string) => {
    if (!enabled || lock.current) return
    const owned = ++generation.current
    lock.current = true; setBusy(true); setError(undefined)
    try { await operation() }
    catch { if (live.current && owned === generation.current) setError(target) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  const refresh = async () => {
    const owned = generation.current, result = await api().svcLLMProxy.listSavedAgentHtmlApps(JSON.parse(scope))
    if (live.current && owned === generation.current) setApps(result.apps)
  }
  // Read once when saving becomes available, and again after a save, restore or deletion.
  useEffect(() => { if (enabled) void run(refresh) }, [enabled, scope, revision]) // eslint-disable-line react-hooks/exhaustive-deps
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
  if (!enabled || !apps.length) return null
  return <>{apps.map(item => <AgentAppLauncherCard
    key={item.id}
    testId="agent-html-saved-item"
    title={item.title}
    state={`v${item.documentRevision}`}
    openLabel={t('chat.agent_html.restore')}
    openTitle={t('chat.agent_html.saved_notice')}
    openDisabled={busy}
    onOpen={() => void run(() => restore(item), item.id)}
  >
    <AgentAppLauncherActions actions={[
      canStartAnotherHtmlRestore(scope, [item.id, item.storageRevision]) && { key: 'another', label: t('chat.agent_html.restore_another'), disabled: busy, onClick: () => setConfirmAnother(item.id) },
      { key: 'delete', label: t('chat.agent_html.delete_saved'), danger: true, disabled: busy, onClick: () => setConfirmDelete(item.id) }
    ]} />
    {error === item.id && <AgentAppLauncherLine tone="error" detail={t('chat.agent_html.snapshot_failed')}>{t('chat.agent_html.snapshot_failed_short')}</AgentAppLauncherLine>}
    {confirmAnother === item.id && <>
      <AgentAppLauncherLine detail={t('chat.agent_html.restore_another_notice')}>{t('chat.agent_html.restore_another_notice_short')}</AgentAppLauncherLine>
      <AgentAppLauncherActions actions={[
        { key: 'confirm-another', label: t('chat.agent_html.confirm_restore_another'), disabled: busy, onClick: () => void run(() => another(item), item.id) },
        { key: 'cancel-another', label: t('chat.agent_html.cancel_delete'), disabled: busy, onClick: () => setConfirmAnother(undefined) }
      ]} />
    </>}
    {confirmDelete === item.id && <>
      <AgentAppLauncherLine detail={t('chat.agent_html.delete_notice')}>{t('chat.agent_html.delete_notice_short')}</AgentAppLauncherLine>
      <AgentAppLauncherActions actions={[
        { key: 'confirm-delete', label: t('chat.agent_html.confirm_delete'), danger: true, disabled: busy, onClick: () => void run(() => remove(item), item.id) },
        { key: 'cancel-delete', label: t('chat.agent_html.cancel_delete'), disabled: busy, onClick: () => setConfirmDelete(undefined) }
      ]} />
    </>}
  </AgentAppLauncherCard>)}</>
}
