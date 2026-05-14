import { ChatMessage } from '../llm/types'
import {
  DeliveryContext,
  SubagentRunRecord,
  subagentRegistry,
  type SubagentTaskRecord
} from './subagentRegistry'

type OrchestratedSubagentChatParams = {
  messages: ChatMessage[]
  systemPrompt?: string
  signal?: AbortSignal
}

export interface SpawnSubagentParams {
  runId?: string
  requesterSessionId: string
  requesterOrigin?: DeliveryContext
  task: string
  label?: string
  modelName: string
  runTimeoutSeconds?: number
  context?: {
    files?: string[]
    htmlContent?: string
    [key: string]: unknown
  }
  signal?: AbortSignal
}

export interface OrchestratedSubagentTask {
  id: string
  task: string
  label?: string
  ownershipScopes?: string[]
  dependsOn?: string[]
  maxAttempts?: number
  context?: {
    files?: string[]
    htmlContent?: string
    [key: string]: unknown
  }
  qualityGate?: {
    label?: string
    validate: (
      resultText: string,
      task: SubagentTaskRecord,
      run: SubagentRunRecord,
      signal?: AbortSignal
    ) =>
      | Promise<
          | boolean
          | {
              ok: boolean
              summary?: string
            }
        >
      | boolean
      | {
          ok: boolean
          summary?: string
        }
  }
}

export interface OrchestratedSubagentObserver {
  onTaskStarted?: (task: SubagentTaskRecord, run: SubagentRunRecord) => void | Promise<void>
  onTaskCompleted?: (task: SubagentTaskRecord, run: SubagentRunRecord) => void | Promise<void>
  onTaskFailed?: (
    task: SubagentTaskRecord,
    run: SubagentRunRecord,
    error: string,
    exhausted: boolean
  ) => void | Promise<void>
  onRunFinished?: (run: SubagentRunRecord) => void | Promise<void>
}

export interface OrchestratedSubagentParams {
  runId?: string
  requesterSessionId: string
  requesterOrigin?: DeliveryContext
  goal: string
  modelName: string
  tasks: OrchestratedSubagentTask[]
  label?: string
  parallelism?: number
  runTimeoutSeconds?: number
  observer?: OrchestratedSubagentObserver
  signal?: AbortSignal
}

const buildContextString = (context?: {
  files?: string[]
  htmlContent?: string
  [key: string]: unknown
}): string => {
  if (!context) return ''

  const parts: string[] = []
  if (context.files?.length) {
    parts.push(`Files in context:\n${context.files.join('\n')}`)
  }
  if (typeof context.htmlContent === 'string' && context.htmlContent.trim()) {
    parts.push(`HTML/UI Context:\n${context.htmlContent}`)
  }
  const additionalEntries = Object.entries(context).filter(([key, value]) => {
    if (key === 'files' || key === 'htmlContent') return false
    if (value === null || value === undefined) return false
    return typeof value !== 'string' || value.trim().length > 0
  })
  if (additionalEntries.length > 0) {
    parts.push(
      `Additional context:\n${additionalEntries
        .map(([key, value]) => {
          if (typeof value === 'string') {
            return `${key}: ${value}`
          }
          return `${key}: ${JSON.stringify(value, null, 2)}`
        })
        .join('\n')}`
    )
  }

  return parts.join('\n\n')
}

const notifyObserver = async (
  observer: OrchestratedSubagentObserver | undefined,
  callback: ((observer: OrchestratedSubagentObserver) => void | Promise<void>) | undefined
): Promise<void> => {
  if (!observer || !callback) return
  await callback(observer)
}

const createAbortError = (reason?: unknown): Error => {
  const error = new Error(
    typeof reason === 'string' && reason.trim() ? reason.trim() : 'Subagent run cancelled.'
  )
  error.name = 'AbortError'
  return error
}

const isAbortError = (error: unknown): error is Error => {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || /aborted|cancelled/i.test(error.message)
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }
}

const withTimeout = async <T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  message: string,
  signal?: AbortSignal
): Promise<T> => {
  if ((!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) && !signal) {
    return work
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    const finalize = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      signal?.removeEventListener('abort', onAbort)
      callback()
    }

    const onAbort = () => {
      finalize(() => reject(createAbortError(signal?.reason)))
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (Number.isFinite(timeoutMs) && timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        finalize(() => reject(new Error(message)))
      }, timeoutMs)
    }

    work.then(
      (value) => finalize(() => resolve(value)),
      (error) => finalize(() => reject(error))
    )
  })
}

const buildDependencyContext = (task: OrchestratedSubagentTask, run: SubagentRunRecord): string => {
  if (!task.dependsOn?.length) return ''

  const resolvedOutputs = task.dependsOn
    .map((dependencyId) => {
      const dependency = run.tasks.find((candidate) => candidate.id === dependencyId)
      if (!dependency?.resultText) return null
      return `${dependency.label || dependency.id}:\n${dependency.resultText}`
    })
    .filter((entry): entry is string => Boolean(entry))

  return resolvedOutputs.length > 0 ? `Dependency outputs:\n${resolvedOutputs.join('\n\n')}` : ''
}

const buildOwnershipContext = (task: OrchestratedSubagentTask): string => {
  if (!task.ownershipScopes?.length) return ''
  return `Ownership scope:\n${task.ownershipScopes.join('\n')}`
}

const normalizeOwnershipScope = (scope: string): string => scope.trim().toLowerCase()

const scopesConflict = (left: string[], right: string[]): boolean => {
  if (!left.length || !right.length) return false

  const leftScopes = new Set(left.map(normalizeOwnershipScope).filter(Boolean))
  const rightScopes = right.map(normalizeOwnershipScope).filter(Boolean)

  if (leftScopes.has('*') || rightScopes.includes('*')) {
    return true
  }

  return rightScopes.some((scope) => leftScopes.has(scope))
}

const selectRunnableTaskBatch = (
  runnableTasks: SubagentTaskRecord[],
  limit: number
): SubagentTaskRecord[] => {
  const batch: SubagentTaskRecord[] = []

  for (const taskRecord of runnableTasks) {
    if (batch.length >= Math.max(1, limit)) {
      break
    }

    const conflicts = batch.some((selectedTask) =>
      scopesConflict(selectedTask.ownershipScopes, taskRecord.ownershipScopes)
    )

    if (conflicts) {
      continue
    }

    batch.push(taskRecord)
  }

  return batch
}

const executeSingleTask = async (
  chatFn: (params: OrchestratedSubagentChatParams) => Promise<string>,
  runId: string,
  task: OrchestratedSubagentTask,
  observer?: OrchestratedSubagentObserver,
  signal?: AbortSignal
): Promise<void> => {
  const run = subagentRegistry.getRun(runId)
  const taskRecord = subagentRegistry.getTask(runId, task.id)
  if (!run || !taskRecord) {
    throw new Error(`Subagent task ${task.id} is not registered.`)
  }

  while (taskRecord.attempts < taskRecord.maxAttempts && taskRecord.status !== 'completed') {
    throwIfAborted(signal)
    subagentRegistry.startTask(runId, task.id)
    await notifyObserver(observer, (callbacks) => callbacks.onTaskStarted?.(taskRecord, run))

    const contextParts = [
      buildDependencyContext(task, run),
      buildOwnershipContext(task),
      buildContextString(task.context)
    ].filter(Boolean)
    const systemPrompt = `You are a specialized subagent orchestrated by a main agent.
Goal: ${run.goal}
Task: ${task.task}
${contextParts.length > 0 ? `\nContext provided:\n${contextParts.join('\n\n')}` : ''}`

    const message: ChatMessage = {
      role: 'user',
      content: `Please execute task "${task.label || task.id}": ${task.task}`
    }
    const taskTimeoutMs =
      Number.isFinite(run.runTimeoutSeconds) && Number(run.runTimeoutSeconds) > 0
        ? Math.max(1, Math.trunc(Number(run.runTimeoutSeconds) * 1000))
        : undefined
    subagentRegistry.appendTaskMessage(runId, task.id, message)
    subagentRegistry.appendMessage(runId, message)

    try {
      const response = await withTimeout(
        chatFn({
          messages: [message],
          systemPrompt,
          signal
        }),
        taskTimeoutMs,
        `Task ${task.label || task.id} timed out waiting for a subagent response.`,
        signal
      )

      const aiMessage: ChatMessage = { role: 'assistant', content: response }
      subagentRegistry.appendTaskMessage(runId, task.id, aiMessage)
      subagentRegistry.appendMessage(runId, aiMessage)
      subagentRegistry.updateTaskCheckpoint(runId, task.id, {
        lastResponse: response,
        lastAttemptAt: new Date().toISOString()
      })

      if (task.qualityGate) {
        const gateResult = await withTimeout(
          Promise.resolve(task.qualityGate.validate(response, taskRecord, run, signal)),
          taskTimeoutMs,
          `Task ${task.label || task.id} timed out during quality-gate validation.`,
          signal
        )
        const normalized =
          typeof gateResult === 'boolean'
            ? { ok: gateResult }
            : { ok: gateResult.ok, summary: gateResult.summary }

        subagentRegistry.updateTaskQualityGate(runId, task.id, {
          status: normalized.ok ? 'passed' : 'failed',
          ...(normalized.summary ? { summary: normalized.summary } : {})
        })

        if (!normalized.ok) {
          const messageText = normalized.summary || `Quality gate failed for ${task.id}`
          const exhausted = taskRecord.attempts >= taskRecord.maxAttempts
          subagentRegistry.failTask(runId, task.id, messageText, exhausted)
          if (exhausted) {
            throw new Error(messageText)
          }
          await notifyObserver(observer, (callbacks) =>
            callbacks.onTaskFailed?.(taskRecord, run, messageText, exhausted)
          )
          continue
        }
      }

      subagentRegistry.completeTask(runId, task.id, response)
      await notifyObserver(observer, (callbacks) => callbacks.onTaskCompleted?.(taskRecord, run))
      return
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      const messageText = error instanceof Error ? error.message : String(error)
      const exhausted = taskRecord.attempts >= taskRecord.maxAttempts
      subagentRegistry.failTask(runId, task.id, messageText, exhausted)
      await notifyObserver(observer, (callbacks) =>
        callbacks.onTaskFailed?.(taskRecord, run, messageText, exhausted)
      )
      if (exhausted) {
        throw new Error(messageText)
      }
    }
  }
}

const finalizeRunOutcome = (runId: string): SubagentRunRecord => {
  const run = subagentRegistry.getRun(runId)
  if (!run) {
    throw new Error(`Subagent run ${runId} no longer exists.`)
  }

  const failedTask = run.tasks.find((task) => task.status === 'failed')
  if (failedTask) {
    subagentRegistry.finishRun(runId, {
      status: 'error',
      error: failedTask.error || `Task ${failedTask.id} failed`
    })
  } else {
    const resultText = run.tasks
      .filter((task) => task.status === 'completed' && task.resultText)
      .map((task) => `${task.label || task.id}: ${task.resultText}`)
      .join('\n\n')

    subagentRegistry.finishRun(runId, { status: 'ok', resultText })
  }

  return subagentRegistry.getRun(runId) as SubagentRunRecord
}

const runOrchestratedLoop = async (
  chatFn: (params: OrchestratedSubagentChatParams) => Promise<string>,
  runId: string,
  taskMap: Map<string, OrchestratedSubagentTask>,
  observer?: OrchestratedSubagentObserver,
  signal?: AbortSignal
): Promise<SubagentRunRecord> => {
  try {
    while (true) {
      throwIfAborted(signal)
      const run = subagentRegistry.getRun(runId)
      if (!run) {
        throw new Error(`Subagent run ${runId} is unavailable.`)
      }

      const pendingFailure = run.tasks.find(
        (task) => task.status === 'failed' && task.attempts >= task.maxAttempts
      )
      if (pendingFailure) {
        break
      }

      const runnableTasks = subagentRegistry.getRunnableTasks(runId)
      if (runnableTasks.length === 0) {
        const hasIncompleteTasks = run.tasks.some((task) => task.status !== 'completed')
        if (!hasIncompleteTasks) {
          break
        }
        break
      }

      const batch = selectRunnableTaskBatch(runnableTasks, run.parallelism)
      const batchErrors = await Promise.all(
        batch.map(async (taskRecord) => {
          const task = taskMap.get(taskRecord.id)
          if (!task) {
            throw new Error(`Task definition ${taskRecord.id} is missing.`)
          }
          try {
            await executeSingleTask(chatFn, runId, task, observer, signal)
            return null
          } catch (error) {
            return error
          }
        })
      )

      const abortError = batchErrors.find((error) => isAbortError(error))
      if (abortError) {
        throw abortError
      }
      if (batchErrors.some((error) => error !== null)) {
        break
      }
    }

    const finalizedRun = finalizeRunOutcome(runId)
    await notifyObserver(observer, (callbacks) => callbacks.onRunFinished?.(finalizedRun))
    return finalizedRun
  } catch (error) {
    if (!isAbortError(error)) {
      throw error
    }
    const messageText = error.message
    subagentRegistry.cancelRun(runId, messageText || 'Subagent run cancelled.')
    const cancelledRun = subagentRegistry.getRun(runId)
    if (!cancelledRun) {
      throw error
    }
    await notifyObserver(observer, (callbacks) => callbacks.onRunFinished?.(cancelledRun))
    return cancelledRun
  }
}

export async function runOrchestratedSubagents(
  chatFn: (params: OrchestratedSubagentChatParams) => Promise<string>,
  params: OrchestratedSubagentParams
): Promise<SubagentRunRecord> {
  const runId = params.runId || crypto.randomUUID()
  const childSessionId = `subagent-${runId}`
  const taskMap = new Map(params.tasks.map((task) => [task.id, task]))

  subagentRegistry.registerOrchestratedRun({
    runId,
    childSessionId,
    requesterSessionId: params.requesterSessionId,
    requesterOrigin: params.requesterOrigin,
    task: params.goal,
    goal: params.goal,
    label: params.label,
    modelName: params.modelName,
    runTimeoutSeconds: params.runTimeoutSeconds,
    parallelism: params.parallelism,
    tasks: params.tasks.map((task) => ({
      id: task.id,
      task: task.task,
      label: task.label,
      ownershipScopes: task.ownershipScopes,
      dependsOn: task.dependsOn,
      maxAttempts: task.maxAttempts
    }))
  })

  return runOrchestratedLoop(chatFn, runId, taskMap, params.observer, params.signal)
}

export async function resumeOrchestratedSubagents(
  chatFn: (params: OrchestratedSubagentChatParams) => Promise<string>,
  runId: string,
  tasks: OrchestratedSubagentTask[],
  observer?: OrchestratedSubagentObserver,
  signal?: AbortSignal
): Promise<SubagentRunRecord> {
  const run = subagentRegistry.getRun(runId)
  if (!run) {
    throw new Error(`Subagent run ${runId} does not exist.`)
  }

  for (const taskRecord of run.tasks) {
    if (taskRecord.status === 'failed') {
      taskRecord.status = 'pending'
      taskRecord.error = undefined
      taskRecord.maxAttempts = Math.max(taskRecord.maxAttempts, taskRecord.attempts + 1)
    }
  }
  run.outcome = undefined
  run.endedAt = undefined

  const taskMap = new Map(tasks.map((task) => [task.id, task]))
  return runOrchestratedLoop(chatFn, runId, taskMap, observer, signal)
}

/**
 * Backward-compatible single-shot API.
 *
 * The implementation now routes through the shared task orchestration runtime with a single task.
 */
export async function spawnSubagent(
  chatFn: (params: OrchestratedSubagentChatParams) => Promise<string>,
  params: SpawnSubagentParams
): Promise<string> {
  const run = await runOrchestratedSubagents(chatFn, {
    runId: params.runId,
    requesterSessionId: params.requesterSessionId,
    requesterOrigin: params.requesterOrigin,
    goal: params.task,
    label: params.label,
    modelName: params.modelName,
    runTimeoutSeconds: params.runTimeoutSeconds,
    signal: params.signal,
    tasks: [
      {
        id: 'default-task',
        task: params.task,
        label: params.label,
        ownershipScopes: [],
        maxAttempts: 1,
        context: params.context
      }
    ]
  })

  const defaultTask = run.tasks.find((task) => task.id === 'default-task')
  if (!defaultTask?.resultText) {
    throw new Error(defaultTask?.error || 'Subagent failed without a result.')
  }
  return defaultTask.resultText
}
