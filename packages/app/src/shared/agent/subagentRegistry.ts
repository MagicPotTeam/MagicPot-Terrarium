import { ChatMessage } from '../llm/types'

export type DeliveryContext = 'chat' | 'canvas' | 'background'

export interface SubagentQualityGateResult {
  status: 'pending' | 'passed' | 'failed'
  summary?: string
}

export interface SubagentRunOutcome {
  status: 'ok' | 'error' | 'timeout' | 'cancelled'
  error?: string
  resultText?: string
}

export interface SubagentTaskRecord {
  id: string
  task: string
  label?: string
  ownershipScopes: string[]
  dependsOn: string[]
  attempts: number
  maxAttempts: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: number
  startedAt?: number
  endedAt?: number
  resultText?: string
  error?: string
  checkpoint?: Record<string, unknown>
  qualityGate: SubagentQualityGateResult
  messages: ChatMessage[]
}

export interface SubagentRunRecord {
  runId: string
  childSessionId: string
  requesterSessionId: string
  requesterOrigin?: DeliveryContext
  task: string
  goal: string
  label?: string
  modelName?: string
  runTimeoutSeconds?: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  parallelism: number
  outcome?: SubagentRunOutcome
  cleanupHandled?: boolean
  messages: ChatMessage[]
  tasks: SubagentTaskRecord[]
  resumedFromRunId?: string
}

type RegisterOrchestratedRunParams = {
  runId: string
  childSessionId: string
  requesterSessionId: string
  requesterOrigin?: DeliveryContext
  task: string
  goal: string
  label?: string
  modelName?: string
  runTimeoutSeconds?: number
  parallelism?: number
  resumedFromRunId?: string
  tasks: Array<{
    id: string
    task: string
    label?: string
    ownershipScopes?: string[]
    dependsOn?: string[]
    maxAttempts?: number
    checkpoint?: Record<string, unknown>
  }>
}

class SubagentRegistry {
  private runs: Map<string, SubagentRunRecord> = new Map()

  public registerRun(params: {
    runId: string
    childSessionId: string
    requesterSessionId: string
    requesterOrigin?: DeliveryContext
    task: string
    label?: string
    modelName?: string
    runTimeoutSeconds?: number
  }) {
    this.registerOrchestratedRun({
      ...params,
      goal: params.task,
      tasks: [{ id: 'default-task', task: params.task, label: params.label, maxAttempts: 1 }]
    })
  }

  public registerOrchestratedRun(params: RegisterOrchestratedRunParams) {
    const now = Date.now()
    const taskRecords: SubagentTaskRecord[] = params.tasks.map((task, index) => ({
      id: task.id,
      task: task.task,
      label: task.label,
      ownershipScopes: task.ownershipScopes ?? [],
      dependsOn: task.dependsOn ?? [],
      attempts: 0,
      maxAttempts: Math.max(1, task.maxAttempts ?? 1),
      status: 'pending',
      createdAt: now + index,
      checkpoint: task.checkpoint,
      qualityGate: { status: 'pending' },
      messages: [
        { role: 'system', content: `You are a specialized subagent. Your task is: ${task.task}` }
      ]
    }))

    this.runs.set(params.runId, {
      runId: params.runId,
      childSessionId: params.childSessionId,
      requesterSessionId: params.requesterSessionId,
      requesterOrigin: params.requesterOrigin,
      task: params.task,
      goal: params.goal,
      label: params.label,
      modelName: params.modelName,
      runTimeoutSeconds: params.runTimeoutSeconds,
      createdAt: now,
      startedAt: now,
      parallelism: Math.max(1, params.parallelism ?? 1),
      cleanupHandled: false,
      messages: [
        {
          role: 'system',
          content: `You are a specialized subagent. Your overall goal is: ${params.goal}`
        }
      ],
      tasks: taskRecords,
      ...(params.resumedFromRunId ? { resumedFromRunId: params.resumedFromRunId } : {})
    })
  }

  public restoreRun(record: SubagentRunRecord) {
    this.runs.set(record.runId, {
      ...record,
      messages: [...record.messages],
      tasks: record.tasks.map((task) => ({
        ...task,
        ownershipScopes: [...task.ownershipScopes],
        dependsOn: [...task.dependsOn],
        checkpoint: task.checkpoint ? { ...task.checkpoint } : undefined,
        qualityGate: { ...task.qualityGate },
        messages: [...task.messages]
      }))
    })
  }

  public getRun(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId)
  }

  public updateRun(runId: string, updates: Partial<SubagentRunRecord>) {
    const run = this.runs.get(runId)
    if (run) {
      this.runs.set(runId, { ...run, ...updates })
    }
  }

  public appendMessage(runId: string, message: ChatMessage) {
    const run = this.runs.get(runId)
    if (run) {
      run.messages.push(message)
    }
  }

  public appendTaskMessage(runId: string, taskId: string, message: ChatMessage) {
    const task = this.getTask(runId, taskId)
    if (task) {
      task.messages.push(message)
    }
  }

  public getTask(runId: string, taskId: string): SubagentTaskRecord | undefined {
    return this.runs.get(runId)?.tasks.find((task) => task.id === taskId)
  }

  public startTask(runId: string, taskId: string) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.status = 'running'
    task.attempts += 1
    task.startedAt = Date.now()
    task.error = undefined
    task.qualityGate = { status: 'pending' }
  }

  public completeTask(runId: string, taskId: string, resultText: string) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.status = 'completed'
    task.resultText = resultText
    task.endedAt = Date.now()
    if (task.qualityGate.status === 'pending') {
      task.qualityGate = { status: 'passed' }
    }
  }

  public failTask(runId: string, taskId: string, error: string, exhausted: boolean) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.error = error
    task.endedAt = Date.now()
    task.status = exhausted ? 'failed' : 'pending'
  }

  public updateTaskCheckpoint(runId: string, taskId: string, checkpoint?: Record<string, unknown>) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.checkpoint = checkpoint ? { ...checkpoint } : undefined
  }

  public updateTaskQualityGate(runId: string, taskId: string, gate: SubagentQualityGateResult) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.qualityGate = { ...gate }
  }

  public getRunnableTasks(runId: string): SubagentTaskRecord[] {
    const run = this.runs.get(runId)
    if (!run) return []

    return run.tasks.filter((task) => {
      if (task.status !== 'pending') return false

      return task.dependsOn.every((dependencyId) => {
        const dependency = run.tasks.find((candidate) => candidate.id === dependencyId)
        return dependency?.status === 'completed'
      })
    })
  }

  public getRunsByRequester(requesterSessionId: string): SubagentRunRecord[] {
    return Array.from(this.runs.values()).filter(
      (run) => run.requesterSessionId === requesterSessionId
    )
  }

  public getActiveRunsByRequester(requesterSessionId: string): SubagentRunRecord[] {
    return this.getRunsByRequester(requesterSessionId).filter((run) => !run.endedAt)
  }

  public finishRun(runId: string, outcome: SubagentRunOutcome) {
    const run = this.runs.get(runId)
    if (run) {
      run.endedAt = Date.now()
      run.outcome = outcome
    }
  }

  public cancelRun(runId: string, error: string) {
    const run = this.runs.get(runId)
    if (!run) return

    const now = Date.now()
    for (const task of run.tasks) {
      if (task.status === 'running') {
        task.status = 'pending'
        task.error = error
        task.endedAt = now
        if (task.qualityGate.status !== 'passed') {
          task.qualityGate = { status: 'pending' }
        }
      }
    }

    run.endedAt = now
    run.outcome = {
      status: 'cancelled',
      error
    }
  }

  public cleanupRun(runId: string) {
    this.runs.delete(runId)
  }

  public getAllRuns(): SubagentRunRecord[] {
    return Array.from(this.runs.values())
  }
}

export const subagentRegistry = new SubagentRegistry()
