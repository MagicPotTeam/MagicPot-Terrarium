import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentRouteLike } from '@shared/agent'
import { AGENT_PROCESS_JOB_LIMITS, type AgentProcessJob } from '@shared/api/agentThreadProcessJob'
import { api } from '../../../utils/windowUtils'

/** How much of a log a read keeps: the end of the output. */
const LOG_PREVIEW_CHARACTERS = 32768
export type AgentProcessLog = { text: string; truncated: boolean }
type ProcessesController = {
  jobs: AgentProcessJob[]
  error: boolean
  stop: (job: AgentProcessJob) => Promise<void>
  /** Reads one log of a process of this scope; undefined once the scope changed or the process left it. */
  readLog: (jobId: string, stream: 'stdout' | 'stderr') => Promise<AgentProcessLog | undefined>
}

/** Scoped metadata polling; pass null when inactive. No model requests are made. */
export function useAgentThreadProcesses(scope: string | null): ProcessesController {
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
  const readLog = async (jobId: string, stream: 'stdout' | 'stderr'): Promise<AgentProcessLog | undefined> => {
    const snapshot = current.current
    if (!mounted.current || !scope || currentScope.current !== scope || generation.current !== revision || snapshot.scope !== scope || snapshot.state.scope !== scope || snapshot.state.revision !== revision) return undefined
    const job = snapshot.state.jobs.find((item) => item.id === jobId && item.expiresAt > Date.now())
    if (!job) return undefined
    const token = generation.current
    const still = () => mounted.current && currentScope.current === scope && generation.current === token
    let text = ''
    let cursor = 0
    let truncated = job.truncated
    try {
      for (let page = 0; page < 8; page++) {
        const result = await api().svcLLMProxy.readAgentProcess({ ...JSON.parse(scope), jobId, stream, cursor, maxBytes: AGENT_PROCESS_JOB_LIMITS.readBytes })
        if (!still()) return undefined
        text += result.data
        if (text.length > LOG_PREVIEW_CHARACTERS) { text = text.slice(-LOG_PREVIEW_CHARACTERS); truncated = true }
        if (result.truncated) truncated = true
        if (result.eof || result.nextCursor <= cursor) break
        cursor = result.nextCursor
      }
    } catch (error) { if (still()) throw error; return undefined }
    return { text, truncated }
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
  return state.scope === scope && state.revision === revision ? { jobs: state.jobs, error: state.error, stop, readLog } : { jobs: [], error: false, stop, readLog }
}

/** Null means this route is not eligible for scoped process access. */
export function getAgentThreadProcessScope(route: AgentRouteLike | undefined, conversationId: string | undefined, active: boolean): string | null {
  return active && conversationId && route?.channel === 'canvas' && route.scopeType === 'thread' ? JSON.stringify({ route, conversationId }) : null
}
