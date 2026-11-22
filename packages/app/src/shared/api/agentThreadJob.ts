import type { AgentThreadInteractionScope } from './agentThreadInteraction'

export type AgentThreadJobStatus = 'running' | 'completed' | 'incomplete' | 'budget_exhausted' | 'cancelled' | 'timeout' | 'failed'
export type AgentThreadJob = {
  id: string
  kind: 'explore' | 'critic' | 'fork' | 'response' | 'summarize'
  task: string
  status: AgentThreadJobStatus
  createdAt: number
  finishedAt?: number
  expiresAt: number
  /** Advisory tool-result JSON, not instructions or an execution permit. */
  result?: string
  error?: string
  resultTruncated?: boolean
}
export type AgentThreadJobReq = AgentThreadInteractionScope & { jobId: string }
export type AgentThreadJobReadReq = AgentThreadJobReq & { offset?: number; limit?: number }
export const AGENT_THREAD_JOB_LIMITS = {
  activePerScope: 2, activeGlobal: 8, retainedPerScope: 12, retainedGlobal: 64,
  retentionMs: 15 * 60 * 1000, resultCharacters: 32000
} as const
