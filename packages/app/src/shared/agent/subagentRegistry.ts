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
  failureKind?: 'error' | 'timeout'
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

type SubagentTaskDefinition = {
  id: string
  task: string
  label?: string
  ownershipScopes?: string[]
  dependsOn?: string[]
  maxAttempts?: number
  checkpoint?: Record<string, unknown>
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
  tasks: SubagentTaskDefinition[]
}

const validateTaskDefinitions = (tasks: SubagentTaskDefinition[]): void => {
  if (tasks.length === 0) {
    throw new Error('An orchestrated subagent run must contain at least one task.')
  }

  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (!task.id.trim()) {
      throw new Error('Subagent task ids must not be empty.')
    }
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate subagent task id: ${task.id}.`)
    }
    taskIds.add(task.id)
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (dependencyId === task.id) {
        throw new Error(`Subagent task ${task.id} cannot depend on itself.`)
      }
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Subagent task ${task.id} depends on unknown task ${dependencyId}.`)
      }
    }
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      throw new Error('Subagent task dependencies must form a DAG.')
    }
    if (visited.has(taskId)) return

    visiting.add(taskId)
    for (const dependencyId of tasksById.get(taskId)?.dependsOn ?? []) {
      visit(dependencyId)
    }
    visiting.delete(taskId)
    visited.add(taskId)
  }

  for (const task of tasks) {
    visit(task.id)
  }
}

const arraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const MAX_TASK_ATTEMPTS = 100
const MAX_PARALLELISM = 32

const normalizeBoundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

const normalizeAttempts = (value: number | undefined): number =>
  normalizeBoundedInteger(value, 0, 0, MAX_TASK_ATTEMPTS)

const normalizeMaxAttempts = (value: number | undefined): number =>
  normalizeBoundedInteger(value, 1, 1, MAX_TASK_ATTEMPTS)

const normalizeParallelism = (value: number | undefined): number =>
  normalizeBoundedInteger(value, 1, 1, MAX_PARALLELISM)

const ensureRetryRemaining = (task: SubagentTaskRecord): void => {
  task.attempts = Math.min(task.attempts, MAX_TASK_ATTEMPTS - 1)
  task.maxAttempts = Math.max(task.maxAttempts, task.attempts + 1)
}

const cloneValue = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
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
    if (this.runs.has(params.runId)) {
      throw new Error(`Subagent run ${params.runId} already exists.`)
    }
    validateTaskDefinitions(params.tasks)

    const now = Date.now()
    const taskRecords: SubagentTaskRecord[] = params.tasks.map((task, index) => ({
      id: task.id,
      task: task.task,
      label: task.label,
      ownershipScopes: task.ownershipScopes ?? [],
      dependsOn: task.dependsOn ?? [],
      attempts: 0,
      maxAttempts: normalizeMaxAttempts(task.maxAttempts),
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
      parallelism: normalizeParallelism(params.parallelism),
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
    if (this.runs.has(record.runId)) {
      throw new Error(`Subagent run ${record.runId} already exists.`)
    }

    validateTaskDefinitions(
      record.tasks.map((task) => ({
        id: task.id,
        task: task.task,
        dependsOn: task.dependsOn
      }))
    )

    const restored = cloneValue(record)
    restored.parallelism = normalizeParallelism(restored.parallelism)
    for (const task of restored.tasks) {
      task.attempts = normalizeAttempts(task.attempts)
      task.maxAttempts = normalizeMaxAttempts(task.maxAttempts)
      if (task.status === 'running') {
        task.status = 'pending'
        ensureRetryRemaining(task)
      }
    }
    this.runs.set(restored.runId, restored)
  }

  public getRun(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId)
  }

  public resumeRun(runId: string, tasks: SubagentTaskDefinition[]): SubagentRunRecord {
    const run = this.runs.get(runId)
    if (!run) {
      throw new Error(`Subagent run ${runId} does not exist.`)
    }

    validateTaskDefinitions(tasks)
    const definitionsById = new Map(tasks.map((task) => [task.id, task]))
    if (definitionsById.size !== run.tasks.length) {
      throw new Error(`Task definitions for subagent run ${runId} do not match the registered run.`)
    }

    for (const taskRecord of run.tasks) {
      const definition = definitionsById.get(taskRecord.id)
      if (
        !definition ||
        definition.task !== taskRecord.task ||
        (definition.label ?? undefined) !== taskRecord.label ||
        !arraysEqual(definition.ownershipScopes ?? [], taskRecord.ownershipScopes) ||
        !arraysEqual(definition.dependsOn ?? [], taskRecord.dependsOn)
      ) {
        throw new Error(`Task definition ${taskRecord.id} does not match the registered run.`)
      }
    }

    for (const taskRecord of run.tasks) {
      if (taskRecord.status === 'failed') {
        taskRecord.status = 'pending'
        taskRecord.error = undefined
        taskRecord.failureKind = undefined
        ensureRetryRemaining(taskRecord)
      } else if (taskRecord.status === 'pending' && taskRecord.attempts >= taskRecord.maxAttempts) {
        // Cancellation resets in-flight tasks to pending after startTask consumed an attempt.
        ensureRetryRemaining(taskRecord)
      }
    }
    run.outcome = undefined
    run.endedAt = undefined
    return run
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
    task.failureKind = undefined
    task.qualityGate = { status: 'pending' }
  }

  public completeTask(runId: string, taskId: string, resultText: string) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.status = 'completed'
    task.resultText = resultText
    task.error = undefined
    task.failureKind = undefined
    task.endedAt = Date.now()
    if (task.qualityGate.status === 'pending') {
      task.qualityGate = { status: 'passed' }
    }
  }

  public failTask(
    runId: string,
    taskId: string,
    error: string,
    exhausted: boolean,
    failureKind: 'error' | 'timeout' = 'error'
  ) {
    const task = this.getTask(runId, taskId)
    if (!task) return
    task.error = error
    task.failureKind = failureKind
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
      if (task.status !== 'pending' || task.attempts >= task.maxAttempts) return false

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
