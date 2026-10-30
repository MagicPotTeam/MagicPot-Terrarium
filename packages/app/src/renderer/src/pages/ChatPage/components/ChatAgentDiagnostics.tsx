import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import {
  normalizeAgentDiagnosticsRequest,
  normalizeAgentDiagnosticsResponse,
  type AgentDiagnosticsRequest,
  type AgentDiagnosticsResponse
} from '@shared/agentDiagnostics'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import type { ChatLoadingStatus } from '../chatLoadingStatus'
import { summarizeChatToolEvidence } from '../chatToolEvidence'

type Props = {
  request: AgentDiagnosticsRequest
  messages: readonly ChatMessage[]
  running: boolean
  loadingStatus?: ChatLoadingStatus
  enabled: boolean
}

export default function ChatAgentDiagnostics({
  request,
  messages,
  running,
  loadingStatus,
  enabled
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [snapshot, setSnapshot] = useState<{
    identity: string
    value: AgentDiagnosticsResponse
  } | null>(null)
  const generation = useRef(0)
  let identity: string | null = null
  try {
    identity = JSON.stringify(normalizeAgentDiagnosticsRequest({ ...request, checkDns: false }))
  } catch {
    /* Invalid saved configuration must not break the chat composer. */
  }
  const result = snapshot?.identity === identity ? snapshot.value : null
  const evidence = useMemo(() => summarizeChatToolEvidence(messages), [messages])
  const inspect = useCallback(
    async (checkDns: boolean) => {
      const attempt = ++generation.current
      if (!identity) {
        setError(true)
        setSnapshot(null)
        setBusy(false)
        return
      }
      setBusy(true)
      setError(false)
      try {
        const method = api().svcLLMProxy.inspectAgentCapabilities
        if (!method) throw new Error('Inspector unavailable')
        const value = normalizeAgentDiagnosticsResponse(
          await method({ ...JSON.parse(identity), checkDns })
        )
        if (attempt === generation.current) setSnapshot({ identity, value })
      } catch {
        if (attempt === generation.current) {
          setError(true)
          setSnapshot(null)
        }
      } finally {
        if (attempt === generation.current) setBusy(false)
      }
    },
    [identity]
  )
  useEffect(() => {
    if (open && enabled) {
      setSnapshot(null)
      void inspect(false)
    }
    return () => {
      generation.current += 1
    }
  }, [open, enabled, inspect])
  const close = () => {
    generation.current += 1
    setOpen(false)
  }
  const canCheckDns =
    result?.scope === 'local-catalog' &&
    result.tools.some((tool) => tool.registered && ['web_search', 'web_fetch'].includes(tool.name))

  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1 }}>
        <Button size="small" disabled={!enabled} onClick={() => setOpen(true)}>
          {t('chat.agent_diagnostics.open')}
        </Button>
      </Box>
      <Dialog
        open={open && enabled}
        onClose={close}
        fullWidth
        maxWidth="sm"
        aria-labelledby="agent-diagnostics-title"
      >
        <DialogTitle id="agent-diagnostics-title">{t('chat.agent_diagnostics.title')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Alert severity="info">{t('chat.agent_diagnostics.notice')}</Alert>
            <Typography variant="body2" role="status">
              {t('chat.agent_diagnostics.current')}:{' '}
              {running
                ? loadingStatus?.label || t('chat.agent_diagnostics.running')
                : t('chat.agent_diagnostics.idle')}
            </Typography>
            {busy && (
              <CircularProgress size={20} aria-label={t('chat.agent_diagnostics.checking')} />
            )}
            {error && <Alert severity="error">{t('chat.agent_diagnostics.error')}</Alert>}
            {result && (
              <>
                <Typography variant="caption">
                  {t('chat.agent_diagnostics.checked_at')}:{' '}
                  {new Date(result.checkedAt).toLocaleString()}
                </Typography>
                {result.scope === 'external-unverified' ? (
                  <Alert severity="warning">{t('chat.agent_diagnostics.external')}</Alert>
                ) : (
                  <>
                    <Typography variant="subtitle2">{t('chat.agent_diagnostics.tools')}</Typography>
                    {!result.tools.length && (
                      <Typography>{t('chat.agent_diagnostics.none')}</Typography>
                    )}
                    {result.tools.map((tool) => (
                      <Typography key={tool.name} variant="body2">
                        {tool.name} —{' '}
                        {t(
                          tool.registered
                            ? 'chat.agent_diagnostics.registered'
                            : 'chat.agent_diagnostics.missing'
                        )}
                      </Typography>
                    ))}
                  </>
                )}
                <Typography variant="subtitle2">{t('chat.agent_diagnostics.network')}</Typography>
                {!result.network.checked && (
                  <Typography variant="body2">{t('chat.agent_diagnostics.not_checked')}</Typography>
                )}
                {result.network.results.map((item) => (
                  <Box key={item.host}>
                    <Typography variant="body2">
                      {item.host} — {t(`chat.agent_diagnostics.dns_${item.status}`)}
                    </Typography>
                    {item.reason === 'reserved-benchmark' && (
                      <Alert severity="warning">{t('chat.agent_diagnostics.fake_ip')}</Alert>
                    )}
                  </Box>
                ))}
              </>
            )}
            <Typography variant="subtitle2">{t('chat.agent_diagnostics.receipts')}</Typography>
            {!evidence.entries.length && (
              <Typography variant="body2">{t('chat.agent_diagnostics.no_receipts')}</Typography>
            )}
            {evidence.entries.map((entry) => (
              <Typography key={entry.id} variant="body2">
                {entry.toolName} — {t(`chat.agent_diagnostics.receipt_${entry.status}`)}
              </Typography>
            ))}
            {(evidence.hasCompletedEffects || evidence.hasUncertainOutcome) && (
              <Alert severity="warning">{t('chat.agent_diagnostics.replay_warning')}</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void inspect(false)} disabled={busy}>
            {t('chat.agent_diagnostics.refresh')}
          </Button>
          <Button onClick={() => void inspect(true)} disabled={busy || !canCheckDns}>
            {t('chat.agent_diagnostics.check_dns')}
          </Button>
          <Button onClick={close}>{t('chat.agent_diagnostics.close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
