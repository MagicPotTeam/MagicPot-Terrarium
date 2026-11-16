import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'
import { api } from '../../../utils/windowUtils'

type Scope = { route: AgentRouteLike; conversationId: string }
type ReadResult = Awaited<ReturnType<ReturnType<typeof api>['svcLLMProxy']['readAgentJob']>>
type JobsState = { scope: string; owner: string; revision: number; jobs: AgentThreadJob[]; error: boolean }

/** Scoped metadata and explicit IPC actions only; never samples a model. */
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
  /** The whole result of a finished job, page by page; undefined once the job left this scope or changed. */
  const readAll = async (jobId: string): Promise<{ text: string; job: AgentThreadJob } | undefined> => {
    let text = ''
    let offset = 0
    for (let page = 0; page < 8; page++) {
      const result = await read(jobId, offset)
      if (!result) return undefined
      text += result.text
      if (result.nextOffset >= result.totalCharacters || result.nextOffset <= offset || page === 7) return { text, job: result.job }
      offset = result.nextOffset
    }
    return undefined
  }
  return { jobs, error: state.scope === scope && state.owner === ownerKey && state.revision === revision && !!scope && live() && state.error, read, readAll, stop, scopeKey: scope }
}

export type AgentThreadJobsController = ReturnType<typeof useAgentThreadJobs>
