import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'
import { api } from '../../../utils/windowUtils'

type Scope = { route: AgentRouteLike; conversationId: string }
type ReadResult = Awaited<ReturnType<ReturnType<typeof api>['svcLLMProxy']['readAgentJob']>>
type JobsState = { scope: string; owner: string; revision: number; jobs: AgentThreadJob[]; error: boolean }

/** Scoped metadata and explicit IPC actions only; never samples a model. */
// The reusable hook intentionally shares this file with the compatibility panel.
// eslint-disable-next-line react-refresh/only-export-components
export function useAgentThreadJobs({ route, conversationId, active, ownerKey = '', isLive }: { route?: AgentRouteLike; conversationId?: string; active: boolean; ownerKey?: string; isLive?: () => boolean }) {
  const scope = active && conversationId && route?.channel === 'canvas' && route.scopeType === 'thread'
    ? JSON.stringify({ route, conversationId }) : ''
  const identity = JSON.stringify([scope, ownerKey])
  const [state, setState] = useState<JobsState>({ scope: '', owner: '', revision: 0, jobs: [], error: false })
  const generation = useRef(0)
  const currentScope = useRef(identity)
  const mounted = useRef(false)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const live = () => { try { return mounted.current && (isLive?.() ?? true) } catch { return false } }
  if (currentScope.current !== identity) { currentScope.current = identity; generation.current++ }
  const revision = generation.current
  const jobs = state.scope === scope && state.owner === ownerKey && state.revision === revision && scope && live() ? state.jobs.filter((job) => job.expiresAt > Date.now()) : []
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  useEffect(() => {
    if (!scope) return
    const service = api().svcLLMProxy
    if (typeof service?.listAgentJobs !== 'function') return
    const token = generation.current
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const valid = () => !closed && currentScope.current === identity && generation.current === token && live()
    setState({ scope, owner: ownerKey, revision: token, jobs: [], error: false })
    const expiry = setInterval(() => {
      if (valid()) setState((old) => old.scope === scope ? { ...old, jobs: old.jobs.filter((job) => job.expiresAt > Date.now()) } : old)
    }, 1000)
    const poll = async () => {
      if (!valid()) return
      try {
        const result = await service.listAgentJobs(JSON.parse(scope) as Scope)
        if (valid()) setState({ scope, owner: ownerKey, revision: token, jobs: result.jobs.filter((job) => job.expiresAt > Date.now()), error: false })
      } catch {
        if (valid()) setState((old) => old.scope === scope ? { ...old, error: true } : { scope, owner: ownerKey, revision: token, jobs: [], error: true })
      } finally { if (valid()) timer = setTimeout(() => void poll(), 1000) }
    }
    void poll()
    return () => { closed = true; clearTimeout(timer); clearInterval(expiry) }
  }, [scope, ownerKey])
  const stillValid = (token: number, id: string, status: AgentThreadJob['status']) =>
    currentScope.current === identity && live() && generation.current === token && jobsRef.current.some((job) => job.id === id && job.status === status && job.expiresAt > Date.now())
  const read = async (jobId: string, offset = 0): Promise<ReadResult | undefined> => {
    const job = jobsRef.current.find((item) => item.id === jobId)
    if (!scope || !job || !live() || generation.current !== revision || currentScope.current !== identity || job.expiresAt <= Date.now()) return undefined
    const token = generation.current
    try {
      const result = await api().svcLLMProxy.readAgentJob({ ...(JSON.parse(scope) as Scope), jobId, offset, limit: 16000 })
      return stillValid(token, jobId, job.status) && result.job.status === job.status ? result : undefined
    } catch (error) { if (stillValid(token, jobId, job.status)) throw error; return undefined }
  }
  const stop = async (jobId: string): Promise<boolean> => {
    const job = jobsRef.current.find((item) => item.id === jobId)
    if (!scope || !job || job.status !== 'running' || !live() || generation.current !== revision || currentScope.current !== identity || job.expiresAt <= Date.now()) return false
    const token = generation.current
    try {
      await api().svcLLMProxy.stopAgentJob({ ...(JSON.parse(scope) as Scope), jobId })
      return stillValid(token, jobId, job.status)
    } catch (error) { if (stillValid(token, jobId, job.status)) throw error; return false }
  }
  return { jobs, error: state.scope === scope && state.owner === ownerKey && state.revision === revision && !!scope && live() && state.error, read, stop, scopeKey: scope }
}

export type AgentThreadJobsController = ReturnType<typeof useAgentThreadJobs>
/** Explicit reads are isolated per row and never injected into chat. */
export function AgentThreadJobRow({ job, controller }: { job: AgentThreadJob; controller: AgentThreadJobsController }) {
  const { t } = useTranslation()
  const taskLabelId = useId()
  const statusLabelId = useId()
  const [text, setText] = useState('')
  const [nextOffset, setNextOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [readStatus, setReadStatus] = useState<AgentThreadJob['status']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const live = useRef(false)
  const status = useRef(job.status)
  status.current = job.status
  const pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (readStatus !== undefined && job.status !== readStatus) {
      setText(''); setNextOffset(0); setTotal(0); setReadStatus(undefined)
    }
  }, [job.status, readStatus])
  const action = async (stop: boolean, more = false) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(false)
    try {
      if (stop) await controller.stop(job.id)
      else {
        const result = await controller.read(job.id, more ? nextOffset : 0)
        if (live.current && result && result.job.status === status.current) {
          setText((previous) => more ? previous + result.text : result.text || t('chat.agent_jobs.no_result'))
          setNextOffset(result.nextOffset); setTotal(result.totalCharacters); setReadStatus(result.job.status)
        }
      }
    } catch { if (live.current) setError(true) }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  return <Box role="group" aria-labelledby={`${taskLabelId} ${statusLabelId}`} sx={{ borderTop: '1px solid', borderColor: 'divider', mt: 1, pt: 1 }}>
    <Typography id={taskLabelId} variant="body2" sx={{ overflowWrap: 'anywhere' }}>{job.kind}: {job.task}</Typography>
    <Typography id={statusLabelId} variant="caption">{t(`chat.agent_jobs.status_${job.status}`)} · {job.id}</Typography>
    <Box sx={{ display: 'flex', gap: 1 }}>
      <Button size="small" disabled={busy} onClick={() => void action(false)}>{t('chat.agent_jobs.read')}</Button>
      {nextOffset < total ? <Button size="small" disabled={busy} onClick={() => void action(false, true)}>{t('chat.agent_jobs.more')}</Button> : null}
      {job.status === 'running' ? <Button size="small" disabled={busy} onClick={() => void action(true)}>{t('chat.agent_jobs.stop')}</Button> : null}
    </Box>
    {job.resultTruncated ? <Typography variant="caption">{t('chat.agent_jobs.truncated')}</Typography> : null}
    {error ? <Alert severity="error">{t('chat.agent_jobs.failed')}</Alert> : null}
    {text ? <Typography component="pre" variant="caption" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto', m: 0 }}>{text}</Typography> : null}
  </Box>
}

/** Polls only main-owned metadata; no model sampling, no automatic result injection. */
export default function AgentThreadJobsPanel(props: { route?: AgentRouteLike; conversationId?: string; active: boolean }) {
  const { t } = useTranslation()
  const controller = useAgentThreadJobs(props)
  if (!controller.jobs.length) return null
  return <Box role="region" aria-label={t('chat.agent_jobs.title')} sx={{ mx: 2, mb: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, maxHeight: 300, overflow: 'auto', flexShrink: 0 }}>
    <Typography variant="subtitle2">{t('chat.agent_jobs.title')}</Typography>
    <Typography variant="caption" color="text.secondary">{t('chat.agent_jobs.notice')}</Typography>
    {controller.error ? <Alert severity="warning">{t('chat.agent_jobs.refresh_failed')}</Alert> : null}
    {controller.jobs.map((job) => <AgentThreadJobRow key={`${controller.scopeKey}:${job.id}`} job={job} controller={controller} />)}
  </Box>
}
