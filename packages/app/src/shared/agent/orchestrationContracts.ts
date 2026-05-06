import type { AgentSessionIdentity } from './sessionIdentity'

export type AgentRunKind = 'master' | 'subagent'
export type AgentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type AgentOrchestrationStep = {
  stepId: string
  label: string
  dependsOn: string[]
  status: AgentRunStatus
  attempts: number
  maxAttempts: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  resultText?: string
  error?: string
  metadata?: Record<string, unknown>
}

export type AgentOrchestrationRun = {
  runId: string
  kind: AgentRunKind
  session: AgentSessionIdentity
  goal: string
  status: AgentRunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  endedAt?: number
  masterRunId?: string
  parentRunId?: string
  label?: string
  modelName?: string
  requestedBy?: string
  parallelism: number
  steps: AgentOrchestrationStep[]
  metadata?: Record<string, unknown>
}

export type AgentOrchestrationEventType =
  | 'run.created'
  | 'run.started'
  | 'run.updated'
  | 'run.completed'
  | 'run.failed'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'capability.registered'
  | 'tool.invoked'

export type AgentOrchestrationEvent = {
  eventId: string
  runId: string
  sessionKey: string
  type: AgentOrchestrationEventType
  message: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export type AgentOrchestrationObserver = {
  onRunCreated?: (run: AgentOrchestrationRun) => void | Promise<void>
  onRunStarted?: (run: AgentOrchestrationRun) => void | Promise<void>
  onRunCompleted?: (run: AgentOrchestrationRun) => void | Promise<void>
  onRunFailed?: (run: AgentOrchestrationRun, error: string) => void | Promise<void>
}

export type AgentMasterRunSpec = {
  session: AgentSessionIdentity
  goal: string
  label?: string
  modelName?: string
  requestedBy?: string
  parallelism?: number
  metadata?: Record<string, unknown>
}

export type AgentSubagentRunSpec = AgentMasterRunSpec & {
  masterRunId: string
  parentRunId?: string
}
