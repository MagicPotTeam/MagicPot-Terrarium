import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import { api } from '../../../utils/windowUtils'
import { formatAgentScratchpad, type AgentScratchpadCommandHandle } from '../agentScratchpadCommand'

type Props = { route?: AgentRouteLike; conversationId?: string; storageScope: string; active: boolean; commandEnabled: boolean }
type Snapshot = ReturnType<typeof formatAgentScratchpad>
function SnapshotView({ scope, commandRef }: { scope: string; commandRef: React.ForwardedRef<AgentScratchpadCommandHandle> }) {
  const { t } = useTranslation(), [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<Snapshot>(), [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const live = useRef(false), generation = useRef(0), lock = useRef(false)
  useLayoutEffect(() => {
    const ownedGeneration = generation
    live.current = true
    return () => { live.current = false; ownedGeneration.current++ }
  }, [])
  useImperativeHandle(commandRef, () => ({ execute(command, expectedScope) {
    if (!live.current || command.action !== 'view' || expectedScope !== scope || lock.current) return false
    lock.current = true; setOpen(true); setBusy(true); setSnapshot(undefined); setError(false)
    const token = ++generation.current
    void (async () => {
      const service = api().svcLLMProxy
      if (typeof service.getAgentNotes !== 'function') throw new Error('Scratchpad read API unavailable.')
      const { route, conversationId } = JSON.parse(scope)
      const result = formatAgentScratchpad(await service.getAgentNotes({ route, conversationId }))
      if (live.current && token === generation.current) setSnapshot(result)
    })().catch(() => { if (live.current && token === generation.current) setError(true) })
      .finally(() => { if (live.current && token === generation.current) { lock.current = false; setBusy(false) } })
    return true
  } }), [scope])
  const close = () => { generation.current++; lock.current = false; setOpen(false); setSnapshot(undefined); setError(false); setBusy(false) }
  if (!open) return null
  return <Box sx={{ mx: 2, mb: 1 }} data-testid="agent-scratchpad-view">
    <Button size="small" onClick={close}>{t('general.close')}</Button>
    <Alert severity="info">{t('chat.agent_scratchpad.notice')}</Alert>
    {busy && <Typography variant="caption">{t('chat.agent_scratchpad.loading')}</Typography>}
    {error && <Alert severity="error">{t('chat.agent_scratchpad.failed')}</Alert>}
    {snapshot && <>
      <Typography variant="caption">{t('chat.agent_scratchpad.revision', { revision: snapshot.revision })}</Typography>
      {snapshot.truncated && <Alert severity="warning">{t('chat.agent_scratchpad.truncated')}</Alert>}
      <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280, overflow: 'auto' }}>{snapshot.text || t('chat.agent_scratchpad.empty')}</Typography>
    </>}
  </Box>
}
const AgentThreadScratchpadView = forwardRef<AgentScratchpadCommandHandle, Props>(function AgentThreadScratchpadView({ route, conversationId, storageScope, active, commandEnabled }, ref) {
  if (!active || !commandEnabled || !conversationId || route?.channel !== 'canvas' || route.scopeType !== 'thread') return null
  const scope = JSON.stringify({ route, conversationId, storageScope })
  return <SnapshotView key={scope} scope={scope} commandRef={ref} />
})
export default AgentThreadScratchpadView
