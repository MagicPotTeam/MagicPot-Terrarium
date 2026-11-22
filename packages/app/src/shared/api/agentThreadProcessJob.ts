import type { AgentThreadInteractionScope } from './agentThreadInteraction'

export type AgentProcessKind = 'python' | 'shell'
export type AgentProcessStatus = 'preparing' | 'running' | 'stopping' | 'completed' | 'failed' | 'timed-out' | 'stopped' | 'unknown'
export type AgentProcessJob = {
  id: string; kind: AgentProcessKind; status: AgentProcessStatus
  createdAt: number; startedAt?: number; finishedAt?: number; expiresAt: number
  outcome: 'known' | 'unknown'; exitCode?: number | null
  stdoutBytes: number; stderrBytes: number; truncated: boolean
  termination?: { controllerExitCode: number | null; controllerTimedOut: boolean; controllerFailed: boolean; childClosed: boolean; childExited: boolean; stdoutEnded: boolean; stderrEnded: boolean }
  operationSettled: boolean; cancellationRequested: boolean
}
export type AgentProcessJobReq = AgentThreadInteractionScope & { jobId: string }
export type AgentProcessReadReq = AgentProcessJobReq & { stream: 'stdout' | 'stderr'; cursor?: number; maxBytes?: number }
export type AgentProcessReadResult = { job: AgentProcessJob; data: string; nextCursor: number; eof: boolean; truncated: boolean; untrustedData: true }
export const AGENT_PROCESS_JOB_LIMITS = { activeGlobal: 4, activePerScope: 1, retainedGlobal: 64, retainedPerScope: 12, retentionMs: 15 * 60 * 1000, readBytes: 16384 } as const
