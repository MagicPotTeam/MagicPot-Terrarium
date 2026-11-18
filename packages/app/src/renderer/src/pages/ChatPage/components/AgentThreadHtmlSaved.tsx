import { htmlSnapshotOperation, acknowledgeHtmlRestore } from '../htmlSnapshotOperations'
import React, { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import type { AgentHtmlSaved } from '@shared/api/agentThreadHtml'
import { api } from '../../../utils/windowUtils'
import { getAgentColumnTokens } from '../../../components/agentColumnTokens'
import { AgentAppLauncherActions, AgentAppLauncherCard, AgentAppLauncherLine } from './AgentAppLauncherCard'

/**
 * The thread's saved snapshots. In the body of the last app card each is a short line (upstream's
 * launcher card lists its notes the same way): the title, 恢复 and 删除…. With no app card in the
 * thread (`cards`: an app leaves after 15 minutes and does not survive a restart) each snapshot is
 * a launcher card of its own, as before the lines: the title and 恢复, with 删除… under it. So a
 * saved snapshot can always be restored and deleted; deleting asks once more in the line below.
 * Metadata only: restoring creates a disconnected card; it never launches HTML. The list is read
 * when saving is available and again after each change (`revision`); with no snapshot nothing is
 * drawn.
 */
export default function AgentThreadHtmlSaved({ scope, enabled, revision = 0, onChanged, cards = false }: { scope: string; enabled: boolean; revision?: number; onChanged(): void; cards?: boolean }) {
  const { t } = useTranslation(), theme = useTheme(), tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const live = useRef(true), lock = useRef(false), generation = useRef(0)
  const [apps, setApps] = useState<AgentHtmlSaved[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | undefined>(), [confirmDelete, setConfirmDelete] = useState<string | undefined>()
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++ } }, [])
  useEffect(() => { if (!enabled) { generation.current++; setApps([]); setConfirmDelete(undefined); setError(undefined) } }, [enabled])
  // `target`: the snapshot whose line shows a failure (a failed list read shows none).
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
  // Read once when saving becomes available, and again after a save, a restore or a deletion.
  useEffect(() => { if (enabled) void run(refresh) }, [enabled, scope, revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (item: AgentHtmlSaved) => {
    // A new operation, unless an earlier restore of this snapshot was never answered: then it is
    // retried with its own operation, so a reply that got lost cannot leave a second card.
    const operationId = htmlSnapshotOperation(scope, 'restore', [item.id, item.storageRevision])
    const owned = generation.current
    await api().svcLLMProxy.restoreAgentHtmlApp({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: item.storageRevision, operationId })
    acknowledgeHtmlRestore(scope, [item.id, item.storageRevision], operationId)
    if (live.current && owned === generation.current) onChanged()
  }
  const remove = async (item: AgentHtmlSaved) => {
    const owned = generation.current
    await api().svcLLMProxy.deleteSavedAgentHtmlApp({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: item.storageRevision })
    if (live.current && owned === generation.current) { setConfirmDelete(undefined); onChanged(); await refresh() }
  }
  if (!enabled || !apps.length) return null
  // What went wrong with a snapshot, and the question before deleting it.
  const notes = (item: AgentHtmlSaved) => <>
    {error === item.id && <AgentAppLauncherLine tone="error" detail={t('chat.agent_html.snapshot_failed')}>{t('chat.agent_html.snapshot_failed_short')}</AgentAppLauncherLine>}
    {confirmDelete === item.id && <>
      <AgentAppLauncherLine detail={t('chat.agent_html.delete_notice')}>{t('chat.agent_html.delete_notice_short')}</AgentAppLauncherLine>
      <AgentAppLauncherActions actions={[
        { key: 'confirm-delete', label: t('chat.agent_html.confirm_delete'), danger: true, disabled: busy, onClick: () => void run(() => remove(item), item.id) },
        { key: 'cancel-delete', label: t('chat.agent_html.cancel_delete'), disabled: busy, onClick: () => setConfirmDelete(undefined) }
      ]} />
    </>}
  </>
  if (cards) return <>{apps.map(item => <AgentAppLauncherCard
    key={item.id}
    testId="agent-html-saved-item"
    title={item.title}
    openLabel={t('chat.agent_html.restore')}
    openTitle={t('chat.agent_html.saved_notice')}
    openDisabled={busy}
    onOpen={() => void run(() => restore(item), item.id)}
  >
    <AgentAppLauncherActions actions={[{ key: 'delete', label: t('chat.agent_html.delete_saved'), danger: true, disabled: busy, onClick: () => setConfirmDelete(item.id) }]} />
    {notes(item)}
  </AgentAppLauncherCard>)}</>
  const lineButtonSx = (danger = false) => ({
    flexShrink: 0, m: 0, p: 0, border: 0, bgcolor: 'transparent', color: danger ? tokens.danger : tokens.accent, cursor: 'pointer',
    font: 'inherit', fontSize: tokens.fontSize.small, lineHeight: '18px',
    '&:hover:not(:disabled)': { textDecoration: 'underline' },
    '&:focus-visible': { ...tokens.focusRing, outlineOffset: '2px' },
    '&:disabled': { opacity: tokens.disabledOpacity, cursor: 'default' }
  })
  return <>{apps.map(item => <React.Fragment key={item.id}>
    <Box data-testid="agent-html-saved-item" sx={{ display: 'flex', alignItems: 'center', gap: '8px', mt: '4px', minWidth: 0 }}>
      <Box component="span" data-testid="agent-html-saved-title" title={item.title} sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75 }}>
        {item.title}
      </Box>
      <Box component="button" type="button" disabled={busy} title={t('chat.agent_html.saved_notice')} onClick={() => void run(() => restore(item), item.id)} sx={lineButtonSx()}>
        {t('chat.agent_html.restore')}
      </Box>
      <Box component="button" type="button" disabled={busy} onClick={() => setConfirmDelete(item.id)} sx={lineButtonSx(true)}>
        {t('chat.agent_html.delete_saved')}
      </Box>
    </Box>
    {notes(item)}
  </React.Fragment>)}</>
}
