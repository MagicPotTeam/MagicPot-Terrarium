import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentProcessJob } from '@shared/api/agentThreadProcessJob'
import { useTranslation } from 'react-i18next'
import { api } from '../../../utils/windowUtils'

function ProcessRow({ job, scope }: { job: AgentProcessJob; scope: string }) {
  const { t } = useTranslation()
  const processNameId = useId(), processIdentityId = useId()
  const [text, setText] = useState(''), [stream, setStream] = useState<'stdout' | 'stderr'>('stdout'), [cursor, setCursor] = useState(0), [eof, setEof] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const live = useRef(false), generation = useRef(0), pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++ } }, [])
  const read = async (nextStream: 'stdout' | 'stderr', more = false) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(false)
    const id = ++generation.current
    try {
      const result = await api().svcLLMProxy.readAgentProcess({ ...JSON.parse(scope), jobId: job.id, stream: nextStream, cursor: more ? cursor : 0, maxBytes: 16384 })
      if (live.current && generation.current === id) { setText((previous) => more ? (previous + result.data).slice(-32768) : result.data); setStream(nextStream); setCursor(result.nextCursor); setEof(result.eof) }
    } catch { if (live.current) setError(true) }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  const stop = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(false)
    try { await api().svcLLMProxy.stopAgentProcess({ ...JSON.parse(scope), jobId: job.id }) }
    catch { if (live.current) setError(true) }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  return <Box role="group" aria-labelledby={`${processNameId} ${processIdentityId}`} sx={{ mt: 1, borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
    <Typography id={processNameId} variant="body2">{job.kind} · {t(`chat.agent_process.status_${job.status}`)}</Typography>
    <Typography id={processIdentityId} variant="caption" sx={{ overflowWrap: 'anywhere' }}>{job.id}{job.exitCode !== undefined && job.exitCode !== null ? ` · exit=${job.exitCode}` : ''}</Typography>
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      <Button size="small" disabled={busy} onClick={() => void read('stdout')}>{t('chat.agent_process.stdout')}</Button>
      <Button size="small" disabled={busy} onClick={() => void read('stderr')}>{t('chat.agent_process.stderr')}</Button>
      {!eof && <Button size="small" disabled={busy} onClick={() => void read(stream, true)}>{t('chat.agent_process.more')}</Button>}
      {(!job.operationSettled || job.status === 'unknown') && <Button size="small" disabled={busy} onClick={() => void stop()}>{t('chat.agent_process.stop')}</Button>}
    </Box>
    {job.status === 'unknown' && <Alert severity="warning">{t('chat.agent_process.unknown_notice')}</Alert>}
    {job.truncated && <Typography variant="caption">{t('chat.agent_process.truncated')}</Typography>}
    {error && <Alert severity="error">{t('chat.agent_process.failed')}</Alert>}
    {text && <Typography component="pre" variant="caption" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto', m: 0 }}>{text}</Typography>}
  </Box>
}
// A keyed inner row resets log cursors and invalidates pending replies when either identity changes.
export function AgentProcessDetails({ job, scope }: { job: AgentProcessJob; scope: string }) {
  return <ProcessRow key={JSON.stringify([scope, job.id])} job={job} scope={scope} />
}

/** Scoped metadata polling; pass null when inactive. No model requests are made. */
// Kept alongside its detail renderer so consumers share the same scoped contract.
// eslint-disable-next-line react-refresh/only-export-components
export function useAgentThreadProcesses(scope: string | null): { jobs: AgentProcessJob[]; error: boolean; stop: (job: AgentProcessJob) => Promise<void> } {
  const [state, setState] = useState<{ scope: string | null; revision: number; jobs: AgentProcessJob[]; error: boolean }>({ scope, revision: 0, jobs: [], error: false })
  const generation = useRef(0)
  const currentScope = useRef(scope)
  const revision = currentScope.current === scope ? generation.current : generation.current + 1
  const current = useRef({ scope, state })
  const mounted = useRef(false)
  useLayoutEffect(() => {
    if (currentScope.current !== scope) { currentScope.current = scope; generation.current++ }
    current.current = { scope, state }
  })
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const stop = async (job: AgentProcessJob): Promise<void> => {
    const snapshot = current.current
    if (!mounted.current || !scope || currentScope.current !== scope || generation.current !== revision || snapshot.scope !== scope || snapshot.state.scope !== scope || snapshot.state.revision !== revision ||
      !snapshot.state.jobs.includes(job) || job.expiresAt <= Date.now() ||
      (job.operationSettled && job.status !== 'unknown')) {
      throw new Error('Process is no longer stoppable in this scope')
    }
    await api().svcLLMProxy.stopAgentProcess({ ...JSON.parse(scope), jobId: job.id })
  }
  useEffect(() => {
    const token = generation.current
    setState({ scope, revision: token, jobs: [], error: false })
    if (!scope) return
    const service = api().svcLLMProxy
    if (typeof service?.listAgentProcesses !== 'function') return
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined
    const valid = () => !closed && mounted.current && currentScope.current === scope && generation.current === token
    const expire = setInterval(() => { if (valid()) setState((current) => current.scope === scope && current.revision === token ? { ...current, jobs: current.jobs.filter((job) => job.expiresAt > Date.now()) } : current) }, 1000)
    const poll = async () => {
      if (!valid()) return
      try { const result = await service.listAgentProcesses(JSON.parse(scope)); if (valid()) setState({ scope, revision: token, jobs: result.jobs.filter((job) => job.expiresAt > Date.now()), error: false }) }
      catch { if (valid()) setState((current) => current.scope === scope && current.revision === token ? { ...current, error: true } : current) }
      finally { if (valid()) timer = setTimeout(() => void poll(), 1000) }
    }
    void poll()
    return () => { closed = true; clearTimeout(timer); clearInterval(expire) }
  }, [scope])
  return state.scope === scope && state.revision === revision ? { jobs: state.jobs, error: state.error, stop } : { jobs: [], error: false, stop }
}

/** Null means this route is not eligible for scoped process access. */
// eslint-disable-next-line react-refresh/only-export-components
export function getAgentThreadProcessScope(route: AgentRouteLike | undefined, conversationId: string | undefined, active: boolean): string | null {
  return active && conversationId && route?.channel === 'canvas' && route.scopeType === 'thread' ? JSON.stringify({ route, conversationId }) : null
}

function Processes({ scope }: { scope: string }) {
  const { t } = useTranslation()
  const { jobs, error } = useAgentThreadProcesses(scope)
  if (!jobs.length) return null
  return <Box role="region" aria-label={t('chat.agent_process.title')} sx={{ mx: 2, mb: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, maxHeight: 320, overflow: 'auto', flexShrink: 0 }}>
    <Typography variant="subtitle2">{t('chat.agent_process.title')}</Typography>
    <Typography variant="caption">{t('chat.agent_process.notice')}</Typography>
    {error && <Alert severity="warning">{t('chat.agent_process.failed')}</Alert>}
    {jobs.map((job) => <AgentProcessDetails key={job.id} job={job} scope={scope} />)}
  </Box>
}
export default function AgentThreadProcessesPanel({ route, conversationId, active }: { route?: AgentRouteLike; conversationId?: string; active: boolean }) {
  const scope = getAgentThreadProcessScope(route, conversationId, active)
  if (!scope) return null
  return <Processes key={scope} scope={scope} />
}
