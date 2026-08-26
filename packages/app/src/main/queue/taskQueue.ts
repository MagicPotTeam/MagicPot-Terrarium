import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ComfyHistory, Workflow, WorkflowInputValue } from '@shared/comfy/types'
import { QueueManager, QueueSource } from '../utils/queueManager'
import { COMFY_PROCESS_TRANSPORT_CLIENT_ID, ComfyHttpCli } from '../comfy/http'
import { getComfyInstancePool, type ComfyPoolInstance } from '../comfy/comfyInstancePool'
import { waitPromptId } from '../comfy/logic'
import { deepCopy, JsonDict, JsonValue } from '@shared/utils/utilTypes'
import { isComfyPostError } from '../comfy/error'
import { isTaskResultError, TaskResultError } from './taskError'
import { isPromptError } from '@shared/comfy/error'
import { parseDeferredComfyImageInputValue } from '@shared/comfy/deferredImages'
import { fileItemToValue } from '@shared/comfy/funcs'
import { readTestUiEnv, resolveTestArtifactPath, resolveTestUiPolicy } from '../testUiPolicy'
import { findTaskInBuckets } from './taskMemorySourceUtils'

const MAX_RETAINED_TASKS_PER_STATUS = 200

export type Task = {
  id: string
  type: 'comfy_prompt'
  client_id: string
  created_at: number
  prompt_id: string | null
  payload: Workflow
  extra_data?: JsonDict
  cleanupAfterRun?: boolean
  /** Base URL selected by the instance pool while the task is running. */
  comfyInstanceBaseUrl?: string
  result: ComfyHistory | null
}

const deepCopyTask = (task: Task): Task => {
  return deepCopy(task as JsonValue) as Task
}

const summarizeTaskForLog = (task: Task) => ({
  id: task.id,
  type: task.type,
  client_id: task.client_id,
  created_at: task.created_at,
  prompt_id: task.prompt_id,
  payloadNodeCount: task.payload ? Object.keys(task.payload).length : 0,
  hasExtraData: !!task.extra_data,
  resultStatus: task.result?.status?.status_str ?? null,
  resultOutputCount: task.result ? Object.keys(task.result.outputs || {}).length : 0,
  cleanupAfterRun: task.cleanupAfterRun === true
})

const summarizePromptResultForLog = (result: { prompt_id?: string | null }) => ({
  prompt_id: result.prompt_id ?? null
})

const summarizeTaskResultForLog = (result: ComfyHistory) => ({
  status: result.status.status_str,
  completed: result.status.completed,
  outputCount: Object.keys(result.outputs || {}).length,
  messageCount: Array.isArray(result.status.messages) ? result.status.messages.length : 0
})

const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())

const sanitizeComfyFailureId = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80) || 'unknown'

const resolveComfyFailureArchiveDir = (runId: string): string =>
  resolveTestArtifactPath({
    desktopPath: path.join(os.homedir(), 'Desktop'),
    tempPath: os.tmpdir(),
    policy: testUiPolicy,
    segments: ['comfyui', 'failures', sanitizeComfyFailureId(runId)]
  })

const dataUrlToUint8Array = (dataUrl: string): Uint8Array => {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) {
    throw new Error('invalid deferred Comfy image data')
  }

  const metadata = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  return metadata.includes(';base64')
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
}

const readDeferredComfyImageBytes = async (deferredImage: {
  dataUrl?: string
  filePath?: string
}): Promise<Uint8Array> => {
  if (deferredImage.filePath) {
    return new Uint8Array(await fs.readFile(deferredImage.filePath))
  }

  if (deferredImage.dataUrl) {
    return dataUrlToUint8Array(deferredImage.dataUrl)
  }

  throw new Error('invalid deferred Comfy image data')
}

type DeferredComfyImageUploadResult = {
  /** Workflow submitted to ComfyUI. Deferred image values are replaced by uploaded file names. */
  promptWorkflow: Workflow
  /** Workflow kept in MagicPot history. Deferred values preserve the original dropped/loaded images. */
  historyWorkflow: Workflow
}

const getWorkflowNodeInputs = (node: unknown): Record<string, WorkflowInputValue> | null => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null
  }

  const inputs = (node as { inputs?: unknown }).inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return null
  }

  return inputs as Record<string, WorkflowInputValue>
}

const uploadDeferredComfyImagesInWorkflow = async (
  workflow: Workflow,
  cli: ComfyHttpCli
): Promise<DeferredComfyImageUploadResult> => {
  const uploadedValueByDeferredValue = new Map<string, string>()
  let hasDeferredImages = false

  for (const node of Object.values(workflow)) {
    const inputs = getWorkflowNodeInputs(node)
    if (!inputs) continue

    for (const value of Object.values(inputs)) {
      if (parseDeferredComfyImageInputValue(value)) {
        hasDeferredImages = true
        break
      }
    }
    if (hasDeferredImages) break
  }

  if (!hasDeferredImages) {
    return {
      promptWorkflow: workflow,
      historyWorkflow: workflow
    }
  }

  const nextWorkflow = deepCopy(workflow as JsonValue) as Workflow
  for (const node of Object.values(nextWorkflow)) {
    const inputs = getWorkflowNodeInputs(node)
    if (!inputs) continue

    for (const [inputName, inputValue] of Object.entries(inputs)) {
      if (typeof inputValue !== 'string') {
        continue
      }

      const deferredImage = parseDeferredComfyImageInputValue(inputValue)
      if (!deferredImage) {
        continue
      }

      let uploadedValue = uploadedValueByDeferredValue.get(inputValue)
      if (!uploadedValue) {
        const uploadedFile = await cli.uploadImage(
          { filename: deferredImage.fileName, type: 'input' },
          await readDeferredComfyImageBytes(deferredImage)
        )
        uploadedValue = fileItemToValue(uploadedFile)
        uploadedValueByDeferredValue.set(inputValue, uploadedValue)
      }
      inputs[inputName] = uploadedValue as WorkflowInputValue
    }
  }

  return {
    promptWorkflow: nextWorkflow,
    historyWorkflow: deepCopy(workflow as JsonValue) as Workflow
  }
}

const serializeErrorForArchive = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }
  return error
}

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return JSON.stringify(
      {
        message: 'Failed to serialize value.',
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  }
}

async function persistComfyTaskFailureArchive(task: Task, error: unknown): Promise<void> {
  const runId = task.prompt_id || task.id
  if (!runId) return
  const outputPath = resolveComfyFailureArchiveDir(runId)
  const payload = {
    runId,
    taskId: task.id,
    promptId: task.prompt_id ?? null,
    clientId: task.client_id,
    createdAt: new Date(task.created_at).toISOString(),
    error: serializeErrorForArchive(error),
    result: task.result,
    extraData: task.extra_data ?? null
  }

  await fs.mkdir(outputPath, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(outputPath, 'workflow.json'), safeJsonStringify(task.payload), 'utf8'),
    fs.writeFile(path.join(outputPath, 'error.json'), safeJsonStringify(payload), 'utf8')
  ])
}

export type TaskQueueState = {
  running: readonly Task[]
  pending: readonly Task[]
  completed: readonly Task[]
  cancelled: readonly Task[]
  error: readonly Task[]
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error'

class TaskCancelledError extends Error {
  constructor(message = 'Task was cancelled.') {
    super(message)
    this.name = 'AbortError'
  }
}

const isTaskCancelledError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || /cancelled/i.test(error.message))

function rewriteTaskResultPromptMeta(
  task: Task,
  result: ComfyHistory,
  historyWorkflow: Workflow = result.prompt[2]
): ComfyHistory {
  return {
    ...result,
    prompt: [
      result.prompt[0],
      result.prompt[1],
      historyWorkflow,
      {
        ...(result.prompt[3] || {}),
        client_id: task.client_id,
        created_at: task.created_at
      },
      result.prompt[4] || []
    ]
  }
}

class TaskMemorySource implements QueueSource<Task> {
  private pendingTasks: Task[] = []
  private runningTask: Task | null = null
  private completedTasks: Task[] = []
  private cancelledTasks: Task[] = []
  private errorTasks: Task[] = []

  private retainRecent(tasks: Task[]): void {
    if (tasks.length > MAX_RETAINED_TASKS_PER_STATUS) {
      tasks.splice(0, tasks.length - MAX_RETAINED_TASKS_PER_STATUS)
    }
  }

  private retainTerminalTask(tasks: Task[], item: Task): void {
    tasks.push(item)
    this.retainRecent(tasks)
  }

  add(item: Task): string {
    const id = 'task-' + crypto.randomUUID().replace(/-/g, '')
    this.pendingTasks.push({ ...item, id })
    return id
  }
  next() {
    if (this.runningTask) {
      return this.runningTask
    }
    const task = this.pendingTasks.shift()
    if (task) {
      this.runningTask = task
    }
    return task
  }
  done(item: Task) {
    if (this.runningTask && this.runningTask.id === item.id) {
      this.runningTask = null
    }
    this.retainTerminalTask(this.completedTasks, item)
  }
  error(item: Task, error: unknown) {
    if (this.runningTask && this.runningTask.id === item.id) {
      this.runningTask = null
    }

    if (isTaskCancelledError(error)) {
      this.retainTerminalTask(this.cancelledTasks, item)
      return
    }

    if (isTaskResultError(error)) {
      item.result = error
    } else {
      console.error(`[TaskQueue] ${item.id} unknown error:`, error)
      item.result = {
        prompt: [0, item.prompt_id ?? '', item.payload, { client_id: item.client_id }, []],
        outputs: {},
        status: {
          status_str: 'error',
          completed: false,
          messages: []
        }
      }
    }
    void persistComfyTaskFailureArchive(item, error).catch((archiveError) => {
      console.warn(`[TaskQueue] Failed to archive ComfyUI failure for ${item.id}:`, archiveError)
    })
    this.retainTerminalTask(this.errorTasks, item)
  }
  queueLength() {
    return this.pendingTasks.length
  }

  private findTask(predicate: (task: Task) => boolean): [TaskStatus, Task] | [null, null] {
    const [status, task] = findTaskInBuckets<Task, TaskStatus>(
      [
        ['completed', this.completedTasks],
        ['cancelled', this.cancelledTasks],
        ['running', this.runningTask ? [this.runningTask] : []],
        ['pending', this.pendingTasks],
        ['error', this.errorTasks]
      ],
      predicate
    )
    return status === null || task === null ? [null, null] : [status, deepCopyTask(task)]
  }

  getTask(id: string): [TaskStatus, Task] | [null, null] {
    return this.findTask((task) => task.id === id)
  }

  getTaskByPromptId(promptId: string): [TaskStatus, Task] | [null, null] {
    return this.findTask((task) => task.prompt_id === promptId)
  }

  getQueue(): TaskQueueState {
    return {
      running: this.runningTask ? [this.runningTask] : [],
      pending: this.pendingTasks,
      completed: this.completedTasks,
      cancelled: this.cancelledTasks,
      error: this.errorTasks
    }
  }

  updateTaskPromptId(task: Task, promptId: string): Task {
    const [, target] = findTaskInBuckets<Task, TaskStatus>(
      [
        ['running', this.runningTask ? [this.runningTask] : []],
        ['pending', this.pendingTasks],
        ['completed', this.completedTasks],
        ['error', this.errorTasks]
      ],
      (candidate) => candidate.id === task.id
    )
    if (!target) return task
    target.prompt_id = promptId
    return target
  }

  private cancelTaskWhere(predicate: (task: Task) => boolean): boolean {
    for (const tasks of [this.pendingTasks, this.errorTasks]) {
      const index = tasks.findIndex(predicate)
      if (index === -1) continue
      const [task] = tasks.splice(index, 1)
      if (task) this.retainTerminalTask(this.cancelledTasks, task)
      return true
    }

    if (this.runningTask && predicate(this.runningTask)) {
      this.retainTerminalTask(this.cancelledTasks, this.runningTask)
      this.runningTask = null
      return true
    }
    return false
  }

  cancelTask(id: string): boolean {
    return this.cancelTaskWhere((task) => task.id === id)
  }

  cancelTaskByPromptId(promptId: string): boolean {
    return this.cancelTaskWhere((task) => task.prompt_id === promptId)
  }
}

async function cleanupComfyMemoryAfterRun(task: Task, cli: ComfyHttpCli): Promise<void> {
  if (!task.cleanupAfterRun) {
    return
  }
  try {
    await cli.freeMemory()
    console.log(`[TaskQueue] ${task.id} requested ComfyUI memory cleanup`)
  } catch (error) {
    console.warn(`[TaskQueue] ${task.id} failed to request ComfyUI memory cleanup:`, error)
  }
}

class RetryableComfyInstanceError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RetryableComfyInstanceError'
  }
}

const isRetryableComfyEndpointError = (error: unknown): boolean => {
  if (isComfyPostError(error)) {
    return (
      error.status === 404 ||
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    )
  }
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false
  return /(?:fetch failed|network|econn|etimedout|socket|timed? ?out|http(?: error)?!?(?: status)?\s*[:=]?\s*(?:404|408|425|429|5\d\d))/iu.test(
    error.message
  )
}

const isDefinitivelyUnreachableComfyInstance = (error: unknown): boolean => {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error || typeof current === 'object') {
      const record = current as { code?: unknown; message?: unknown; cause?: unknown }
      const code = String(record.code || '')
      const message = String(record.message || '')
      if (
        /(?:ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|ERR_CONNECTION_REFUSED)/iu.test(
          `${code} ${message}`
        )
      ) {
        return true
      }
      current = record.cause
      continue
    }
    break
  }
  return false
}

const waitForAdmissionAfterSubmitFailure = async (
  cli: ComfyHttpCli,
  promptId: string
): Promise<{ admitted: boolean; promptId: string }> => {
  if (typeof cli.waitForPromptAdmission !== 'function') {
    return { admitted: false, promptId }
  }
  return cli.waitForPromptAdmission(promptId, undefined, 5_000, COMFY_PROCESS_TRANSPORT_CLIENT_ID)
}

async function executeTaskOnInstance(
  task: Task,
  instance: ComfyPoolInstance,
  requestedPromptId: string
): Promise<{ task: Task; cli: ComfyHttpCli }> {
  const cli = instance.client
  task.comfyInstanceBaseUrl = instance.profile.baseUrl
  let promptWorkflow: Workflow
  let historyWorkflow: Workflow
  try {
    const uploaded = await uploadDeferredComfyImagesInWorkflow(task.payload, cli)
    promptWorkflow = uploaded.promptWorkflow
    historyWorkflow = uploaded.historyWorkflow
  } catch (error) {
    if (isRetryableComfyEndpointError(error)) {
      throw new RetryableComfyInstanceError(error)
    }
    throw error
  }

  let promptId: string
  try {
    const res = await cli.prompt({
      prompt: promptWorkflow,
      // Keep a single ComfyUI transport client so the shared main-process
      // WebSocket listener continues to receive task progress events.
      client_id: COMFY_PROCESS_TRANSPORT_CLIENT_ID,
      prompt_id: requestedPromptId,
      extra_data: task.extra_data
    })
    promptId = res.prompt_id
  } catch (error) {
    if (!isRetryableComfyEndpointError(error)) throw error
    if (isDefinitivelyUnreachableComfyInstance(error)) {
      throw new RetryableComfyInstanceError(error)
    }
    const admission = await waitForAdmissionAfterSubmitFailure(cli, requestedPromptId)
    if (admission.admitted) {
      promptId = admission.promptId
    } else {
      throw new RetryableComfyInstanceError(error)
    }
  }

  console.log(
    `[TaskQueue] ${task.id} prompt result:`,
    summarizePromptResultForLog({ prompt_id: promptId })
  )
  task.payload = promptWorkflow
  task = taskSource.updateTaskPromptId(task, promptId)

  const [currentStatus] = taskSource.getTask(task.id)
  if (currentStatus !== 'running') {
    throw new TaskCancelledError(`Task ${task.id} was cancelled`)
  }

  const result = await waitPromptId(cli, promptId, undefined, undefined, () => {
    const [status] = taskSource.getTask(task.id)
    return status !== 'running'
  })

  const [finalStatus] = taskSource.getTask(task.id)
  if (finalStatus !== 'running') {
    throw new TaskCancelledError(`Task ${task.id} was cancelled during execution`)
  }

  const normalizedResult = rewriteTaskResultPromptMeta(task, result, historyWorkflow)
  console.log(`[TaskQueue] ${task.id} result:`, summarizeTaskResultForLog(normalizedResult))
  if (isTaskResultError(normalizedResult)) {
    throw normalizedResult
  }
  task.result = normalizedResult
  return { task, cli }
}

async function executeTask(task: Task): Promise<Task> {
  const pool = getComfyInstancePool()
  let selectedCli: ComfyHttpCli | null = null
  try {
    console.log(`[TaskQueue] ${task.id} processing task:`, summarizeTaskForLog(task))
    const instances = await pool.orderedAvailableInstances(false, task.payload)
    if (instances.length === 0) {
      throw new Error('No compatible ComfyUI instance is available')
    }
    const requestedPromptId = task.prompt_id || crypto.randomUUID()
    let lastRetryableError: unknown = null
    for (const instance of instances) {
      selectedCli = instance.client
      try {
        const result = await executeTaskOnInstance(task, instance, requestedPromptId)
        pool.preferBaseUrl?.(instance.profile.baseUrl)
        return result.task
      } catch (error) {
        if (!(error instanceof RetryableComfyInstanceError)) throw error
        lastRetryableError = error.cause
        task.comfyInstanceBaseUrl = undefined
        pool.invalidate()
      }
    }
    throw lastRetryableError || new Error('No compatible ComfyUI instance is available')
  } catch (error) {
    if (isComfyPostError(error) && isPromptError(error.payload)) {
      const err: TaskResultError = {
        prompt: [
          0,
          task.prompt_id ?? '',
          task.payload,
          { client_id: task.client_id, created_at: task.created_at },
          []
        ],
        outputs: {},
        status: {
          status_str: 'error',
          completed: false,
          messages: [
            [
              'prompt_error',
              {
                prompt_id: task.prompt_id ?? '',
                timestamp: Date.now(),
                ...error.payload
              }
            ]
          ]
        }
      }
      throw err
    }
    if (isTaskResultError(error) || isTaskCancelledError(error)) {
      throw error
    }

    console.error(`[TaskQueue] ${task.id} unknown error:`, error)
    throw error
  } finally {
    if (selectedCli) {
      await cleanupComfyMemoryAfterRun(task, selectedCli)
    }
  }
}

const taskSource: TaskMemorySource = new TaskMemorySource()
const taskQueue: QueueManager<Task> = new QueueManager<Task>(taskSource, executeTask)

const createTaskCli = (task?: Task): ComfyHttpCli =>
  new ComfyHttpCli(
    undefined,
    undefined,
    task?.comfyInstanceBaseUrl ? { baseUrl: task.comfyInstanceBaseUrl } : undefined
  )

export async function initTaskQueue() {
  taskQueue.start()
}

export async function stopTaskQueue() {
  taskQueue.stop()
}

export function addTask(task: Task): string {
  return taskSource.add(task)
}

export function getTask(id: string) {
  return taskSource.getTask(id)
}

export function getTaskByPromptId(promptId: string) {
  return taskSource.getTaskByPromptId(promptId)
}

export function getQueue() {
  return taskSource.getQueue()
}

export async function cancelTask(id: string): Promise<boolean> {
  const [status, task] = taskSource.getTask(id)
  const promptId = task?.prompt_id || null

  const found = taskSource.cancelTask(id)

  if (found && status === 'running') {
    void (async () => {
      try {
        const cli = createTaskCli(task)
        const cancelTasks = [cli.interrupt()]

        if (promptId) {
          cancelTasks.push(
            cli.cancel(promptId).catch((error) => {
              console.error(`[TaskQueue] 取消 ComfyUI 任务失败: ${promptId}`, error)
            })
          )
        }

        await Promise.allSettled(cancelTasks)
      } catch (error) {
        console.error(`[TaskQueue] 中断任务失败: ${id}`, error)
      }
    })()
  }

  return found
}

export async function cancelTaskByPromptId(promptId: string): Promise<boolean> {
  const [status, task] = taskSource.getTaskByPromptId(promptId)

  const found = taskSource.cancelTaskByPromptId(promptId)

  if (found && status === 'running') {
    void (async () => {
      try {
        const cli = createTaskCli(task)
        const cancelTasks = [
          cli.interrupt().catch((error) => {
            console.error(`[TaskQueue] 中断任务失败: ${promptId}`, error)
          }),
          cli.cancel(promptId).catch((error) => {
            console.error(`[TaskQueue] 取消 ComfyUI 任务失败: ${promptId}`, error)
          })
        ]

        await Promise.allSettled(cancelTasks)
      } catch (error) {
        console.error(`[TaskQueue] 取消任务失败: ${promptId}`, error)
      }
    })()
  }

  return found
}
