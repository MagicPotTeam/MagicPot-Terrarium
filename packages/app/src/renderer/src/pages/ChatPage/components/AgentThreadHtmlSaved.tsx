import { htmlSnapshotOperation, acknowledgeHtmlRestore } from '../htmlSnapshotOperations'
import React, { useEffect, useRef, useState } from 'react'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import type { AgentHtmlSaved } from '@shared/api/agentThreadHtml'
import { api } from '../../../utils/windowUtils'
import { getAgentColumnTokens } from '../../../components/agentColumnTokens'
import { AgentAppLauncherLine } from './AgentAppLauncherCard'

/**
 * The thread's saved snapshots, listed as short lines in the body of the app card that holds
 * them (upstream's launcher card lists its notes the same way): the title and 恢复. Metadata
 * only: restoring creates a disconnected card; it never launches HTML. The list is read when
 * saving is available and again after each change (`revision`); with no snapshot nothing is drawn.
 */
export default function AgentThreadHtmlSaved({ scope, enabled, revision = 0, onChanged }: { scope: string; enabled: boolean; revision?: number; onChanged(): void }) {
  const { t } = useTranslation(), theme = useTheme(), tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const live = useRef(true), lock = useRef(false), generation = useRef(0)
  const [apps, setApps] = useState<AgentHtmlSaved[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | undefined>()
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++ } }, [])
  useEffect(() => { if (!enabled) { generation.current++; setApps([]); setError(undefined) } }, [enabled])
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
  // Read once when saving becomes available, and again after a save or a restore.
  useEffect(() => { if (enabled) void run(refresh) }, [enabled, scope, revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (item: AgentHtmlSaved) => {
    const operationId = htmlSnapshotOperation(scope, 'restore', [item.id, item.storageRevision])
    const owned = generation.current
    await api().svcLLMProxy.restoreAgentHtmlApp({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: item.storageRevision, operationId })
    // Retain operation ID even after success: stale/double clicks cannot make
    // duplicate restored cards before the metadata refresh arrives.
    acknowledgeHtmlRestore(scope, [item.id, item.storageRevision], operationId)
    if (live.current && owned === generation.current) onChanged()
  }
  if (!enabled || !apps.length) return null
  return <>{apps.map(item => <React.Fragment key={item.id}>
    <Box data-testid="agent-html-saved-item" sx={{ display: 'flex', alignItems: 'center', gap: '8px', mt: '4px', minWidth: 0 }}>
      <Box component="span" data-testid="agent-html-saved-title" title={item.title} sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75 }}>
        {item.title}
      </Box>
      <Box
        component="button"
        type="button"
        disabled={busy}
        title={t('chat.agent_html.saved_notice')}
        onClick={() => void run(() => restore(item), item.id)}
        sx={{
          flexShrink: 0, m: 0, p: 0, border: 0, bgcolor: 'transparent', color: tokens.accent, cursor: 'pointer',
          font: 'inherit', fontSize: tokens.fontSize.small, lineHeight: '18px',
          '&:hover:not(:disabled)': { textDecoration: 'underline' },
          '&:focus-visible': { ...tokens.focusRing, outlineOffset: '2px' },
          '&:disabled': { opacity: tokens.disabledOpacity, cursor: 'default' }
        }}
      >
        {t('chat.agent_html.restore')}
      </Box>
    </Box>
    {error === item.id && <AgentAppLauncherLine tone="error" detail={t('chat.agent_html.snapshot_failed')}>{t('chat.agent_html.snapshot_failed_short')}</AgentAppLauncherLine>}
  </React.Fragment>)}</>
}
