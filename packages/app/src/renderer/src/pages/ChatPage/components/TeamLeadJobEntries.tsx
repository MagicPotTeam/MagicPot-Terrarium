import { useRef, type ReactNode } from 'react'
import type { AgentRouteLike } from '@shared/agent'
import { AgentThreadJobRow, useAgentThreadJobs } from './AgentThreadJobsPanel'

export type TeamLeadJobEntriesProps = {
  route?: AgentRouteLike
  currentId?: string | null
  leadId?: string | null
  /** Opaque renderer-validated team/generation identity, not MAIN authorization. */
  activeTeamKey: string | null
  /** IDs already displayed from the current conversation; they win on collision. */
  currentIds: ReadonlySet<string>
  /** Synchronous parent-owned lifecycle guard; false/throw fails closed. */
  isLive?: () => boolean
  children: (value: TeamLeadJobEntriesValue) => ReactNode
}

type LeadController = ReturnType<typeof useAgentThreadJobs>
export type TeamLeadJobEntriesValue = {
  entries: Array<{ key: string; name: string; job: LeadController['jobs'][number]; detail: ReactNode; stop: () => Promise<boolean> }>
  error: boolean
}

/** The caller must validate team identity and membership; this is not an authorization boundary. */
export default function TeamLeadJobEntries({ route, currentId, leadId, activeTeamKey, currentIds, isLive, children }: TeamLeadJobEntriesProps) {
  const valid = !!activeTeamKey && !!currentId && !!leadId && currentId !== leadId && route?.channel === 'canvas' && route.scopeType === 'thread'
  const key = valid ? JSON.stringify([activeTeamKey, route, currentId, leadId]) : ''
  const guard = useRef({ key, revision: 0, currentIds })
  if (guard.current.key !== key) guard.current = { key, revision: guard.current.revision + 1, currentIds }
  else guard.current.currentIds = currentIds
  const revision = guard.current.revision
  const live = () => {
    try { return !!key && guard.current.key === key && guard.current.revision === revision && (isLive?.() ?? true) } catch { return false }
  }
  const isValid = (id: string) => live() && !guard.current.currentIds.has(id)
  const controller = useAgentThreadJobs({ route, conversationId: leadId || undefined, active: valid, ownerKey: JSON.stringify([key, revision]), isLive: live })
  const guarded: LeadController = {
    ...controller,
    read: async (id, offset) => {
      if (!isValid(id)) return undefined
      try { const result = await controller.read(id, offset); return isValid(id) ? result : undefined }
      catch (error) { if (isValid(id)) throw error; return undefined }
    },
    stop: async (id) => {
      if (!isValid(id)) return false
      try { const result = await controller.stop(id); return isValid(id) ? result : false }
      catch (error) { if (isValid(id)) throw error; return false }
    }
  }
  return <>{children({
    entries: controller.jobs.filter((job) => !currentIds.has(job.id)).map((job) => ({
      key: JSON.stringify([key, revision, controller.scopeKey, job.id]),
      name: `组长 · ${job.kind}`,
      job,
      detail: <AgentThreadJobRow key={JSON.stringify([key, revision, controller.scopeKey, job.id])} job={job} controller={guarded} />,
      stop: () => guarded.stop(job.id)
    })),
    error: controller.error
  })}</>
}
