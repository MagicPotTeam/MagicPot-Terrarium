import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ComfyHistory, FileItem, Workflow, WorkflowInputValue } from '@shared/comfy/types'
import type {
  ComfyDispatchTarget,
  ComfyInstanceKind,
  ComfyInstanceState,
  ComfyJobRequirements,
  ComfyJobState
} from '@shared/comfy/dispatch'
import { QueueManager, QueueSource } from '../utils/queueManager'
import { COMFY_PROCESS_TRANSPORT_CLIENT_ID, ComfyHttpCli } from '../comfy/http'
import { waitPromptId } from '../comfy/logic'
import { deepCopy, JsonDict, JsonValue } from '@shared/utils/utilTypes'
import { isComfyPostError } from '../comfy/error'
import { isTaskResultError, TaskResultError } from './taskError'
import { isPromptError } from '@shared/comfy/error'
import {
  parseDeferredComfyFileInputValue,
  parseDeferredComfyMaskInputValue
} from '@shared/comfy/deferredImages'
import {
  fileItemToComfyInputValue,
  isMagicPotFileItemValue,
  normalizeExecutableWorkflow,
  valueToFileItem
} from '@shared/comfy/funcs'
import { readTestUiEnv, resolveTestArtifactPath, resolveTestUiPolicy } from '../testUiPolicy'
import { processWorkflowLoras } from '../comfy/loraBypass'
import { acquireComfyInstance, retainRestoredComfyInstanceCapacity } from '../comfy/instancePool'
import { getComfyOutputRouteStore, type ComfyOutputRoute } from '../comfy/outputRouteStore'
import { ComfyJobStore } from '../comfy/jobStore'
import { readPersistedDeferredFile } from '../comfy/deferredFileAuthority'
import type {
  MagicAgentEventStore,
  StoredResource
} from '../magicAgentPlatform2/persistence/eventStore'

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
  target?: ComfyDispatchTarget
  requirements?: ComfyJobRequirements
  instanceId?: string
  instanceRouteId?: string
  instanceOrigin?: string
  instanceKind?: ComfyInstanceKind
  legacyDefaultEndpoint?: boolean
  submissionStarted?: boolean
  submissionState?: 'prepared' | 'submitted' | 'unknown'
  submissionToken?: string
  submissionUnknown?: boolean
  requiresManualIntervention?: boolean
  cancelRequested?: boolean
  resumeKnownPrompt?: boolean
  historyPayload?: Workflow
  /** Revision of the durable ComfyJobStore resource represented by this task. */
  jobRevision?: number
  result: ComfyHistory | null
}

const deepCopyTask = (task: Task): Task => {
  return deepCopy(task as unknown as JsonValue) as unknown as Task
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
  if (commaIndex < 0) throw new Error('Invalid deferred Comfy file data.')
  const metadata = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  return metadata.includes(';base64')
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
}

const readDeferredComfyFileBytes = async (
  deferredFile: { dataUrl?: string; filePath?: string; sizeBytes: number },
  signal?: AbortSignal
): Promise<Uint8Array> => {
  if (deferredFile.filePath) {
    return await readPersistedDeferredFile({
      filePath: deferredFile.filePath,
      expectedSizeBytes: deferredFile.sizeBytes,
      ...(deferredFileAuthorizedRoot ? { authorizedRoot: deferredFileAuthorizedRoot } : {}),
      signal
    })
  }
  if (deferredFile.dataUrl) {
    const bytes = dataUrlToUint8Array(deferredFile.dataUrl)
    if (bytes.byteLength !== deferredFile.sizeBytes) {
      throw new Error('Deferred Comfy inline data size does not match its declaration.')
    }
    return bytes
  }
  throw new Error('Invalid deferred Comfy file data.')
}

type DeferredComfyUploadResult = {
  /** Workflow submitted to ComfyUI. Deferred/routed values are materialized on the leased host. */
  promptWorkflow: Workflow
  /** Workflow retained by MagicPot. Original durable values remain available for later reruns. */
  historyWorkflow: Workflow
}

const getWorkflowNodeInputs = (node: unknown): Record<string, WorkflowInputValue> | null => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const inputs = (node as { inputs?: unknown }).inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null
  return inputs as Record<string, WorkflowInputValue>
}

const fileItemWithoutRoute = (fileItem: FileItem): FileItem => ({
  filename: fileItem.filename,
  ...(fileItem.subfolder === undefined ? {} : { subfolder: fileItem.subfolder }),
  ...(fileItem.type === undefined ? {} : { type: fileItem.type }),
  ...(fileItem.format === undefined ? {} : { format: fileItem.format })
})

const capturedOutputClient = (
  fileItem: FileItem
): { cli: ComfyHttpCli; route: ComfyOutputRoute } => {
  if (!fileItem.instanceRouteId) {
    throw new Error('A routed Comfy file is missing its opaque route id.')
  }
  const route = getComfyOutputRouteStore().get(fileItem.instanceRouteId)
  if (!route) throw new Error(`Comfy output route is unavailable: ${fileItem.instanceRouteId}`)
  if (fileItem.instanceId !== undefined && fileItem.instanceId !== route.instanceId) {
    throw new Error('Comfy output route does not match its instance id.')
  }
  return {
    route,
    cli: new ComfyHttpCli(undefined, undefined, {
      origin: route.origin,
      remote: route.kind === 'remote',
      networkRetries: 3
    })
  }
}

const uploadDeferredComfyFilesInWorkflow = async (
  workflow: Workflow,
  cli: ComfyHttpCli,
  destination:
    (Pick<ComfyInstanceState, 'id' | 'origin' | 'kind'> & { instanceRouteId: string }) | null,
  signal?: AbortSignal
): Promise<DeferredComfyUploadResult> => {
  const materializedByValue = new Map<string, string>()
  const materializing = new Set<string>()
  const needsMaterialization = Object.values(workflow).some((node) => {
    const inputs = getWorkflowNodeInputs(node)
    return Object.values(inputs ?? {}).some(
      (value) =>
        typeof value === 'string' &&
        (parseDeferredComfyFileInputValue(value) !== null ||
          parseDeferredComfyMaskInputValue(value) !== null ||
          isMagicPotFileItemValue(value))
    )
  })
  if (!needsMaterialization) return { promptWorkflow: workflow, historyWorkflow: workflow }

  const materialize = async (value: string): Promise<string> => {
    const cached = materializedByValue.get(value)
    if (cached) return cached
    if (materializing.has(value)) throw new Error('Cyclic deferred Comfy input value.')
    materializing.add(value)
    try {
      const deferredMask = parseDeferredComfyMaskInputValue(value)
      if (deferredMask) {
        if (deferredMask.originalValue === value)
          throw new Error('A deferred mask cannot reference itself.')
        const originalValue = await materialize(deferredMask.originalValue)
        const originalRef = valueToFileItem(originalValue)
        const uploaded = await cli.uploadMask(
          {
            filename: deferredMask.fileName,
            type: 'input',
            subfolder: 'clipspace'
          },
          await readDeferredComfyFileBytes(deferredMask, signal),
          fileItemWithoutRoute(originalRef),
          signal
        )
        const result = fileItemToComfyInputValue(uploaded)
        materializedByValue.set(value, result)
        return result
      }

      const deferredFile = parseDeferredComfyFileInputValue(value)
      if (deferredFile) {
        const uploaded = await cli.uploadImage(
          { filename: deferredFile.fileName, type: 'input' },
          await readDeferredComfyFileBytes(deferredFile, signal),
          signal
        )
        const result = fileItemToComfyInputValue(uploaded)
        materializedByValue.set(value, result)
        return result
      }

      if (isMagicPotFileItemValue(value)) {
        const sourceFile = valueToFileItem(value)
        const { cli: sourceCli } = capturedOutputClient(sourceFile)
        if (destination && destination.instanceRouteId === sourceFile.instanceRouteId) {
          const result = fileItemToComfyInputValue(fileItemWithoutRoute(sourceFile))
          materializedByValue.set(value, result)
          return result
        }
        const uploaded = await cli.uploadImage(
          { filename: sourceFile.filename, type: 'input' },
          await sourceCli.view(fileItemWithoutRoute(sourceFile), signal),
          signal
        )
        const result = fileItemToComfyInputValue(uploaded)
        materializedByValue.set(value, result)
        return result
      }

      materializedByValue.set(value, value)
      return value
    } finally {
      materializing.delete(value)
    }
  }

  const promptWorkflow = deepCopy(workflow as JsonValue) as Workflow
  for (const node of Object.values(promptWorkflow)) {
    const inputs = getWorkflowNodeInputs(node)
    if (!inputs) continue
    for (const [inputName, inputValue] of Object.entries(inputs)) {
      if (typeof inputValue === 'string') {
        inputs[inputName] = (await materialize(inputValue)) as WorkflowInputValue
      }
    }
  }
  return {
    promptWorkflow,
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
  cancelling: readonly Task[]
  unknown: readonly Task[]
  completed: readonly Task[]
  cancelled: readonly Task[]
  error: readonly Task[]
}

export type TaskSubmissionResolution = 'not-submitted' | 'submitted' | 'cancelled'

export type TaskStatus =
  'pending' | 'running' | 'cancelling' | 'unknown' | 'completed' | 'cancelled' | 'error'

class TaskCancelledError extends Error {
  constructor(message = 'Task was cancelled.') {
    super(message)
    this.name = 'AbortError'
  }
}

class TaskQueueShutdownError extends Error {
  constructor() {
    super('Task queue is shutting down.')
    this.name = 'TaskQueueShutdownError'
  }
}

const isTaskCancelledError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || /cancelled/i.test(error.message))

const raceTaskAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason ?? new TaskCancelledError()
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason ?? new TaskCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

const withBoundedTaskOperation = async <T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      Object.assign(new Error(`Task operation exceeded ${timeoutMs}ms.`), { name: 'AbortError' })
    )
  }, timeoutMs)
  try {
    return await raceTaskAbort(operation(controller.signal), controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

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

const annotateTaskOutputRoute = (task: Task, result: ComfyHistory): ComfyHistory => {
  if (!task.instanceId) return result
  for (const output of Object.values(result.outputs || {})) {
    for (const key of ['images', 'video', 'videos', 'gifs', 'animated'] as const) {
      const files = output[key]
      if (!Array.isArray(files)) continue
      for (const file of files) {
        file.instanceId = task.instanceId
        file.instanceRouteId = task.instanceRouteId
        file.instanceOrigin = task.instanceOrigin
        file.instanceKind = task.instanceKind
      }
    }
  }
  return result
}

class TaskMemorySource implements QueueSource<Task> {
  private pendingTasks: Task[] = []
  private runningTask: Task | null = null
  private unknownTasks: Task[] = []
  private completedTasks: Task[] = []
  private cancelledTasks: Task[] = []
  private errorTasks: Task[] = []

  private retainRecent(tasks: Task[]): void {
    if (tasks.length > MAX_RETAINED_TASKS_PER_STATUS) {
      tasks.splice(0, tasks.length - MAX_RETAINED_TASKS_PER_STATUS)
    }
  }

  private removeTerminalTask(id: string): void {
    for (const tasks of [
      this.unknownTasks,
      this.completedTasks,
      this.cancelledTasks,
      this.errorTasks
    ]) {
      const index = tasks.findIndex((task) => task.id === id)
      if (index !== -1) tasks.splice(index, 1)
    }
  }

  private retainTerminalTask(tasks: Task[], item: Task): void {
    this.removeTerminalTask(item.id)
    tasks.push(deepCopyTask(item))
    this.retainRecent(tasks)
  }

  add(item: Task): string {
    const id = item.id.trim() || 'task-' + crypto.randomUUID().replace(/-/g, '')
    this.pendingTasks.push({ ...item, id })
    return id
  }

  restorePending(item: Task): void {
    this.removeTerminalTask(item.id)
    if (!this.pendingTasks.some((candidate) => candidate.id === item.id)) {
      this.pendingTasks.push(deepCopyTask(item))
    }
  }

  restoreUnknown(item: Task): void {
    this.retainTerminalTask(this.unknownTasks, item)
  }

  restoreTerminal(status: 'completed' | 'cancelled' | 'error', item: Task): void {
    this.pendingTasks = this.pendingTasks.filter((task) => task.id !== item.id)
    if (this.runningTask?.id === item.id) this.runningTask = null
    this.removeTerminalTask(item.id)
    if (status === 'completed') this.retainTerminalTask(this.completedTasks, item)
    else if (status === 'cancelled') this.retainTerminalTask(this.cancelledTasks, item)
    else this.retainTerminalTask(this.errorTasks, item)
  }

  reset(): void {
    this.pendingTasks = []
    this.runningTask = null
    this.unknownTasks = []
    this.completedTasks = []
    this.cancelledTasks = []
    this.errorTasks = []
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
    if (!this.runningTask || this.runningTask.id !== item.id) return
    this.runningTask = null
    this.retainTerminalTask(this.completedTasks, item)
  }
  error(item: Task, error: unknown) {
    if (!this.runningTask || this.runningTask.id !== item.id) return
    const authoritativeItem = this.runningTask
    this.runningTask = null

    if (
      authoritativeItem.submissionState === 'unknown' ||
      authoritativeItem.submissionUnknown === true
    ) {
      authoritativeItem.submissionState = 'unknown'
      authoritativeItem.submissionUnknown = true
      authoritativeItem.requiresManualIntervention = true
      this.retainTerminalTask(this.unknownTasks, authoritativeItem)
      return
    }

    const cancelled = authoritativeItem.cancelRequested === true || isTaskCancelledError(error)
    if (cancelled) {
      if (authoritativeItem.submissionStarted && !authoritativeItem.prompt_id) {
        authoritativeItem.submissionState = 'unknown'
        authoritativeItem.submissionUnknown = true
        authoritativeItem.requiresManualIntervention = true
        this.retainTerminalTask(this.unknownTasks, authoritativeItem)
      } else {
        this.retainTerminalTask(this.cancelledTasks, authoritativeItem)
      }
      return
    }

    item = authoritativeItem

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

  getTask(id: string): [TaskStatus, Task] | [null, null] {
    const unknownTask = this.unknownTasks.find((task) => task.id === id)
    if (unknownTask) {
      return ['unknown', deepCopyTask(unknownTask)]
    }
    const completedTask = this.completedTasks.find((task) => task.id === id)
    if (completedTask) {
      return ['completed', deepCopyTask(completedTask)]
    }
    const cancelledTask = this.cancelledTasks.find((task) => task.id === id)
    if (cancelledTask) {
      return ['cancelled', deepCopyTask(cancelledTask)]
    }
    if (this.runningTask && this.runningTask.id === id) {
      return [
        this.runningTask.cancelRequested ? 'cancelling' : 'running',
        deepCopyTask(this.runningTask)
      ]
    }
    const pendingTask = this.pendingTasks.find((task) => task.id === id)
    if (pendingTask) {
      return ['pending', deepCopyTask(pendingTask)]
    }
    const errorTask = this.errorTasks.find((task) => task.id === id)
    if (errorTask) {
      return ['error', deepCopyTask(errorTask)]
    }
    return [null, null]
  }

  getTaskByPromptId(promptId: string): [TaskStatus, Task] | [null, null] {
    const unknownTask = this.unknownTasks.find((task) => task.prompt_id === promptId)
    if (unknownTask) {
      return ['unknown', deepCopyTask(unknownTask)]
    }
    const completedTask = this.completedTasks.find((task) => task.prompt_id === promptId)
    if (completedTask) {
      return ['completed', deepCopyTask(completedTask)]
    }
    const cancelledTask = this.cancelledTasks.find((task) => task.prompt_id === promptId)
    if (cancelledTask) {
      return ['cancelled', deepCopyTask(cancelledTask)]
    }
    const runningTask = this.runningTask?.prompt_id === promptId ? this.runningTask : null
    if (runningTask) {
      return [runningTask.cancelRequested ? 'cancelling' : 'running', deepCopyTask(runningTask)]
    }
    const pendingTask = this.pendingTasks.find((task) => task.prompt_id === promptId)
    if (pendingTask) {
      return ['pending', deepCopyTask(pendingTask)]
    }
    const errorTask = this.errorTasks.find((task) => task.prompt_id === promptId)
    if (errorTask) {
      return ['error', deepCopyTask(errorTask)]
    }
    return [null, null]
  }

  getQueue(): TaskQueueState {
    const cancelling = this.runningTask?.cancelRequested ? [this.runningTask] : []
    return {
      running: this.runningTask && !this.runningTask.cancelRequested ? [this.runningTask] : [],
      pending: this.pendingTasks,
      cancelling,
      unknown: this.unknownTasks,
      completed: this.completedTasks,
      cancelled: this.cancelledTasks,
      error: this.errorTasks
    }
  }

  updateTaskInstance(
    task: Task,
    instance: ComfyInstanceState | null,
    instanceRouteId?: string
  ): Task {
    if (this.runningTask && this.runningTask.id === task.id) {
      if (instance) {
        this.runningTask.instanceId = instance.id
        this.runningTask.instanceRouteId = instanceRouteId
        this.runningTask.instanceOrigin = instance.origin
        this.runningTask.instanceKind = instance.kind
        this.runningTask.legacyDefaultEndpoint = false
      } else {
        delete this.runningTask.instanceId
        delete this.runningTask.instanceRouteId
        delete this.runningTask.instanceOrigin
        delete this.runningTask.instanceKind
        this.runningTask.legacyDefaultEndpoint = true
      }
      return this.runningTask
    }
    return task
  }

  isCancellationRequested(id: string): boolean {
    return this.runningTask?.id === id && this.runningTask.cancelRequested === true
  }

  markTaskCancelled(task: Task): Task {
    if (this.runningTask?.id !== task.id) return task
    const authoritativeTask = this.runningTask
    this.runningTask = null
    this.retainTerminalTask(this.cancelledTasks, authoritativeTask)
    return deepCopyTask(authoritativeTask)
  }

  markCancellationUnconfirmed(task: Task): Task {
    let authoritativeTask = task
    if (this.runningTask?.id === task.id) {
      authoritativeTask = this.runningTask
      this.runningTask = null
    } else {
      const pendingIndex = this.pendingTasks.findIndex((candidate) => candidate.id === task.id)
      if (pendingIndex !== -1) authoritativeTask = this.pendingTasks.splice(pendingIndex, 1)[0]!
      else {
        const cancelledIndex = this.cancelledTasks.findIndex(
          (candidate) => candidate.id === task.id
        )
        if (cancelledIndex !== -1)
          authoritativeTask = this.cancelledTasks.splice(cancelledIndex, 1)[0]!
      }
    }
    authoritativeTask.submissionState = 'unknown'
    authoritativeTask.submissionUnknown = true
    authoritativeTask.requiresManualIntervention = true
    authoritativeTask.cancelRequested = true
    this.retainTerminalTask(this.unknownTasks, authoritativeTask)
    return deepCopyTask(authoritativeTask)
  }

  markTaskSubmissionStarted(task: Task): Task {
    if (this.runningTask && this.runningTask.id === task.id) {
      this.runningTask.submissionStarted = true
      this.runningTask.submissionState = 'prepared'
      this.runningTask.submissionUnknown = false
      this.runningTask.requiresManualIntervention = false
      return this.runningTask
    }
    return task
  }

  markTaskSubmissionUnknown(task: Task): Task {
    if (this.runningTask && this.runningTask.id === task.id) {
      this.runningTask.submissionState = 'unknown'
      this.runningTask.submissionUnknown = true
      this.runningTask.requiresManualIntervention = true
      return this.runningTask
    }
    const unknownTask = this.unknownTasks.find((candidate) => candidate.id === task.id)
    if (unknownTask) {
      unknownTask.submissionState = 'unknown'
      unknownTask.submissionUnknown = true
      unknownTask.requiresManualIntervention = true
      return unknownTask
    }
    return task
  }

  updateTaskPromptId(task: Task, promptId: string): Task {
    if (this.runningTask && this.runningTask.id === task.id) {
      this.runningTask.prompt_id = promptId
      this.runningTask.submissionState = 'submitted'
      this.runningTask.submissionUnknown = false
      this.runningTask.requiresManualIntervention = false
      return this.runningTask
    }

    const pendingTask = this.pendingTasks.find((t) => t.id === task.id)
    if (pendingTask) {
      pendingTask.prompt_id = promptId
      return pendingTask
    }

    const unknownTask = this.unknownTasks.find((t) => t.id === task.id)
    if (unknownTask) {
      unknownTask.prompt_id = promptId
      return unknownTask
    }

    const completedTask = this.completedTasks.find((t) => t.id === task.id)
    if (completedTask) {
      completedTask.prompt_id = promptId
      return completedTask
    }

    const errorTask = this.errorTasks.find((t) => t.id === task.id)
    if (errorTask) {
      errorTask.prompt_id = promptId
      return errorTask
    }

    const cancelledTask = this.cancelledTasks.find((t) => t.id === task.id)
    if (cancelledTask) {
      cancelledTask.prompt_id = promptId
      return cancelledTask
    }

    return task
  }

  cancelTask(id: string): boolean {
    const pendingIndex = this.pendingTasks.findIndex((task) => task.id === id)
    if (pendingIndex !== -1) {
      const [task] = this.pendingTasks.splice(pendingIndex, 1)
      if (task) {
        this.retainTerminalTask(this.cancelledTasks, task)
      }
      return true
    }

    const errorIndex = this.errorTasks.findIndex((task) => task.id === id)
    if (errorIndex !== -1) {
      const [task] = this.errorTasks.splice(errorIndex, 1)
      if (task) {
        this.retainTerminalTask(this.cancelledTasks, task)
      }
      return true
    }

    if (this.runningTask && this.runningTask.id === id) {
      this.runningTask.cancelRequested = true
      return true
    }

    const unknownTask = this.unknownTasks.find((task) => task.id === id)
    if (unknownTask) {
      unknownTask.cancelRequested = true
      return true
    }

    return false
  }

  cancelTaskByPromptId(promptId: string): boolean {
    const pendingIndex = this.pendingTasks.findIndex((task) => task.prompt_id === promptId)
    if (pendingIndex !== -1) {
      const [task] = this.pendingTasks.splice(pendingIndex, 1)
      if (task) {
        this.retainTerminalTask(this.cancelledTasks, task)
      }
      return true
    }

    const errorIndex = this.errorTasks.findIndex((task) => task.prompt_id === promptId)
    if (errorIndex !== -1) {
      const [task] = this.errorTasks.splice(errorIndex, 1)
      if (task) {
        this.retainTerminalTask(this.cancelledTasks, task)
      }
      return true
    }

    if (this.runningTask && this.runningTask.prompt_id === promptId) {
      this.runningTask.cancelRequested = true
      return true
    }

    const unknownTask = this.unknownTasks.find((task) => task.prompt_id === promptId)
    if (unknownTask) {
      unknownTask.cancelRequested = true
      return true
    }

    return false
  }

  resolveUnknownTask(id: string, outcome: TaskSubmissionResolution, promptId?: string): Task {
    const index = this.unknownTasks.findIndex((task) => task.id === id)
    if (index === -1) throw new Error(`Unknown ComfyUI task was not found: ${id}`)
    const task = this.unknownTasks[index]!
    if (outcome === 'submitted') {
      if (!promptId?.trim()) throw new Error('A prompt id is required for submitted resolution.')
      task.prompt_id = promptId.trim()
      task.submissionState = 'submitted'
      task.submissionUnknown = false
      task.requiresManualIntervention = false
      if (task.cancelRequested) return deepCopyTask(task)
      task.resumeKnownPrompt = true
      this.unknownTasks.splice(index, 1)
      this.pendingTasks.push(task)
      return deepCopyTask(task)
    }
    task.submissionUnknown = false
    task.requiresManualIntervention = false
    if (outcome === 'not-submitted') {
      task.submissionStarted = false
      delete task.submissionState
      task.prompt_id = null
      task.cancelRequested = false
      this.unknownTasks.splice(index, 1)
      this.pendingTasks.push(task)
      return deepCopyTask(task)
    }
    task.cancelRequested = true
    this.unknownTasks.splice(index, 1)
    this.retainTerminalTask(this.cancelledTasks, task)
    return deepCopyTask(task)
  }

  finalizeUnknownCancellation(id: string): Task {
    const index = this.unknownTasks.findIndex((task) => task.id === id)
    if (index === -1) throw new Error(`Unknown ComfyUI task was not found: ${id}`)
    const task = this.unknownTasks[index]!
    task.cancelRequested = true
    task.submissionUnknown = false
    task.requiresManualIntervention = false
    this.unknownTasks.splice(index, 1)
    this.retainTerminalTask(this.cancelledTasks, task)
    return deepCopyTask(task)
  }
}

const TASK_SUBMISSION_TOKEN_FIELD = 'magicpot_task_id'
const AMBIGUOUS_RECONCILIATION_ATTEMPTS = 5
const AMBIGUOUS_RECONCILIATION_DELAY_MS = 100
const AMBIGUOUS_RECONCILIATION_TIMEOUT_MS = 2_000
const CANCELLATION_CONFIRMATION_ATTEMPTS = 20
const CANCELLATION_CONFIRMATION_DELAY_MS = 100
const CANCELLATION_CONFIRMATION_TIMEOUT_MS = 5_000
const CLEANUP_TIMEOUT_MS = 5_000
const activeTaskAbortControllers = new Map<string, AbortController>()
const activeTaskClients = new Map<string, ComfyHttpCli>()
const taskOperationTails = new Map<string, Promise<void>>()
const manualResolutionTails = new Map<string, Promise<void>>()

const serializeTaskOperation = async <T>(
  taskId: string,
  operation: () => Promise<T>
): Promise<T> => {
  const previous = taskOperationTails.get(taskId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  taskOperationTails.set(taskId, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (taskOperationTails.get(taskId) === tail) taskOperationTails.delete(taskId)
  }
}
const serializeManualResolution = async <T>(
  taskId: string,
  operation: () => Promise<T>
): Promise<T> => {
  const previous = manualResolutionTails.get(taskId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  manualResolutionTails.set(taskId, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (manualResolutionTails.get(taskId) === tail) manualResolutionTails.delete(taskId)
  }
}

const retainedUnknownLeases = new Map<string, () => void>()
const activePostExecutionPromises = new Set<Promise<void>>()

const capturedTaskClient = (task: Task): ComfyHttpCli => {
  if (!task.instanceRouteId) throw new Error(`ComfyUI task has no captured route: ${task.id}`)
  const route = getComfyOutputRouteStore().get(task.instanceRouteId)
  if (!route) throw new Error(`ComfyUI task route is unavailable: ${task.instanceRouteId}`)
  if (
    route.instanceId !== task.instanceId ||
    route.origin !== task.instanceOrigin ||
    route.kind !== task.instanceKind
  ) {
    throw new Error(`ComfyUI task captured authority does not match its route: ${task.id}`)
  }
  return new ComfyHttpCli(undefined, undefined, {
    origin: route.origin,
    remote: route.kind === 'remote',
    networkRetries: 3
  })
}

const taskCapturedDestination = (
  task: Task
): Pick<ComfyInstanceState, 'id' | 'origin' | 'kind'> & { instanceRouteId: string } => {
  if (!task.instanceId || !task.instanceOrigin || !task.instanceKind || !task.instanceRouteId) {
    throw new Error(`ComfyUI task has incomplete captured authority: ${task.id}`)
  }
  return {
    id: task.instanceId,
    origin: task.instanceOrigin,
    kind: task.instanceKind,
    instanceRouteId: task.instanceRouteId
  }
}

const captureLegacyDefaultEndpoint = (): never => {
  // Empty-registry legacy dispatch has no immutable endpoint snapshot. Fail before objectInfo,
  // upload, or prompt rather than creating an uncaptured default client that could drift on restart.
  throw new Error('No captured ComfyUI endpoint is available for this task.')
}

const releaseRetainedUnknownLease = (taskId: string): void => {
  const release = retainedUnknownLeases.get(taskId)
  if (!release) return
  retainedUnknownLeases.delete(taskId)
  try {
    release()
  } catch (error) {
    console.warn(`[TaskQueue] ${taskId} failed to release its retained ComfyUI lease:`, error)
  }
}

const promptHasTaskToken = (prompt: ComfyHistory['prompt'], taskId: string): boolean => {
  const metadata = prompt[3] as Record<string, unknown> | undefined
  const extraData = metadata?.extra_data as Record<string, unknown> | undefined
  return (
    metadata?.[TASK_SUBMISSION_TOKEN_FIELD] === taskId ||
    extraData?.[TASK_SUBMISSION_TOKEN_FIELD] === taskId
  )
}

const delayTaskOperation = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return
  }
  await raceTaskAbort(new Promise((resolve) => setTimeout(resolve, delayMs)), signal)
}

async function reconcileTaskPromptId(
  cli: ComfyHttpCli,
  taskId: string,
  signal?: AbortSignal
): Promise<string | null> {
  for (let attempt = 0; attempt < AMBIGUOUS_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const queuePromise = cli.getQueue(signal)
    const historyPromise = cli.historyAll(signal)
    const [queueResult, historyResult] = await Promise.allSettled(
      signal
        ? [raceTaskAbort(queuePromise, signal), raceTaskAbort(historyPromise, signal)]
        : [queuePromise, historyPromise]
    )
    const matches = new Set<string>()
    if (queueResult.status === 'fulfilled') {
      for (const entry of [
        ...queueResult.value.queue_running,
        ...queueResult.value.queue_pending
      ]) {
        if (promptHasTaskToken(entry, taskId)) matches.add(entry[1])
      }
    }
    if (historyResult.status === 'fulfilled') {
      for (const [promptId, result] of Object.entries(historyResult.value)) {
        if (promptHasTaskToken(result.prompt, taskId)) matches.add(promptId)
      }
    }
    if (matches.size > 1)
      throw new Error('Multiple Comfy prompts carry the same task submission token.')
    if (matches.size === 1) return [...matches][0]!
    if (attempt + 1 < AMBIGUOUS_RECONCILIATION_ATTEMPTS) {
      await delayTaskOperation(AMBIGUOUS_RECONCILIATION_DELAY_MS, signal)
    }
  }
  return null
}

type PromptCancellationOutcome =
  | { kind: 'cancelled'; history: ComfyHistory }
  | { kind: 'succeeded'; history: ComfyHistory }
  | { kind: 'failed'; history: ComfyHistory }
  | { kind: 'unconfirmed'; error?: unknown }

const classifyCancelledPromptHistory = (history: ComfyHistory): PromptCancellationOutcome => {
  if (history.status.status_str === 'success') return { kind: 'succeeded', history }
  const messageTypes = history.status.messages.map(([type]) => type as string)
  if (messageTypes.includes('execution_interrupted')) return { kind: 'cancelled', history }
  if (messageTypes.includes('execution_error') || history.status.status_str === 'error') {
    return { kind: 'failed', history }
  }
  return { kind: 'unconfirmed' }
}

async function cancelTaskPromptOnClient(
  cli: ComfyHttpCli,
  promptId: string,
  logId: string
): Promise<PromptCancellationOutcome> {
  return await withBoundedTaskOperation(CANCELLATION_CONFIRMATION_TIMEOUT_MS, async (signal) => {
    let cancelError: unknown
    try {
      await raceTaskAbort(cli.cancel(promptId, signal), signal)
    } catch (error) {
      cancelError = error
    }
    let interrupted = false
    for (let attempt = 0; attempt < CANCELLATION_CONFIRMATION_ATTEMPTS; attempt += 1) {
      const [queueResult, historyResult] = await Promise.allSettled([
        raceTaskAbort(cli.getQueue(signal), signal),
        raceTaskAbort(cli.history(promptId, signal), signal)
      ])
      if (historyResult.status === 'fulfilled') {
        const history = historyResult.value[promptId]
        if (history) return classifyCancelledPromptHistory(history)
      }
      if (queueResult.status === 'fulfilled') {
        const isRunning = queueResult.value.queue_running.some((entry) => entry[1] === promptId)
        if (isRunning && !interrupted) {
          try {
            await raceTaskAbort(cli.interrupt(signal), signal)
          } catch (error) {
            cancelError ??= error
          }
          interrupted = true
        }
      }
      if (attempt + 1 < CANCELLATION_CONFIRMATION_ATTEMPTS) {
        await delayTaskOperation(CANCELLATION_CONFIRMATION_DELAY_MS, signal)
      }
    }
    console.warn(`ComfyUI cancellation could not be confirmed: ${logId}`, cancelError)
    return { kind: 'unconfirmed', error: cancelError }
  })
}

async function cleanupComfyMemoryAfterRun(task: Task, cli: ComfyHttpCli): Promise<void> {
  if (!task.cleanupAfterRun) {
    return
  }
  if (cli.isRemoteComfyUI()) {
    console.log(`[TaskQueue] ${task.id} skipped ComfyUI memory cleanup for remote ComfyUI`)
    return
  }

  try {
    await withBoundedTaskOperation(CLEANUP_TIMEOUT_MS, (signal) =>
      raceTaskAbort(cli.freeMemory({}, signal), signal)
    )
    console.log(`[TaskQueue] ${task.id} requested ComfyUI memory cleanup`)
  } catch (error) {
    console.warn(`[TaskQueue] ${task.id} failed to request ComfyUI memory cleanup:`, error)
  }
}

async function executeTask(task: Task): Promise<Task> {
  const executionGeneration = taskRuntimeGeneration
  const abortController = new AbortController()
  activeTaskAbortControllers.set(task.id, abortController)
  let lease: Awaited<ReturnType<typeof acquireComfyInstance>> = null
  let cli: ComfyHttpCli | null = null
  let executionFailed = false
  try {
    const assertRunning = (): void => {
      const [status] = taskSource.getTask(task.id)
      if (status !== 'running') throw new TaskCancelledError(`Task ${task.id} was cancelled`)
    }

    if (task.resumeKnownPrompt && task.prompt_id) {
      cli = capturedTaskClient(task)
      activeTaskClients.set(task.id, cli)
      await durableMarkRunning(task)
      assertRunning()
      const resumedResult = await waitPromptId(
        cli,
        task.prompt_id,
        undefined,
        undefined,
        () => taskSource.getTask(task.id)[0] !== 'running',
        abortController.signal
      )
      assertRunning()
      const normalizedResult = annotateTaskOutputRoute(
        task,
        rewriteTaskResultPromptMeta(task, resumedResult, task.historyPayload ?? task.payload)
      )
      if (isTaskResultError(normalizedResult)) throw normalizedResult
      delete task.resumeKnownPrompt
      task.result = normalizedResult
      await durableComplete(task, normalizedResult)
      releaseLogicalCapacity(task.id)
      return task
    }

    if (task.instanceRouteId) {
      // Restored leased/manual-not-submitted work keeps immutable captured authority.
      cli = capturedTaskClient(task)
      if (durableJob(task.id)?.state.status === 'queued') await durableAssign(task)
    } else {
      lease = await acquireComfyInstance(task.payload, {
        target: task.target,
        requirements: task.requirements,
        signal: abortController.signal
      })
      if (lease) {
        cli = lease.cli
        const capturedRoute = getComfyOutputRouteStore().capture(lease.state)
        task = taskSource.updateTaskInstance(task, lease.state, capturedRoute.routeId)
      } else {
        captureLegacyDefaultEndpoint()
      }
      await durableAssign(task)
    }
    if (!cli) throw new Error(`ComfyUI task client is unavailable: ${task.id}`)
    const taskCli = cli
    activeTaskClients.set(task.id, taskCli)

    assertRunning()
    console.log(`[TaskQueue] ${task.id} processing task:`, summarizeTaskForLog(task))
    const durableState = durableJob(task.id)?.state
    let promptWorkflow: Workflow
    let historyWorkflow: Workflow
    if (
      durableState?.status === 'prepared' &&
      durableState.promptWorkflow &&
      durableState.historyWorkflow &&
      durableState.submissionToken
    ) {
      // Explicit not-submitted resolution reuses the exact committed payload. No reupload,
      // rematerialization, or mutation of write-once prepared data is allowed.
      promptWorkflow = durableState.promptWorkflow
      historyWorkflow = durableState.historyWorkflow
      task.payload = promptWorkflow
      task.historyPayload = historyWorkflow
      task.submissionToken = durableState.submissionToken
      task = taskSource.markTaskSubmissionStarted(task)
    } else {
      let processedWorkflow = task.historyPayload ?? task.payload
      try {
        const objectInfo = await raceTaskAbort(
          taskCli.objectInfo(abortController.signal),
          abortController.signal
        )
        processedWorkflow = processWorkflowLoras(processedWorkflow, objectInfo).workflow
      } catch (error) {
        if (abortController.signal.aborted) throw error
        console.warn(`[TaskQueue] ${task.id} failed to process LoRA bypass:`, error)
      }
      assertRunning()

      const materialized = await uploadDeferredComfyFilesInWorkflow(
        processedWorkflow,
        taskCli,
        taskCapturedDestination(task),
        abortController.signal
      )
      promptWorkflow = normalizeExecutableWorkflow(materialized.promptWorkflow)
      historyWorkflow = materialized.historyWorkflow
      assertRunning()
      task.payload = promptWorkflow
      task.historyPayload = historyWorkflow
      task.submissionToken = task.id
      task = taskSource.markTaskSubmissionStarted(task)
      await durablePrepare(task, promptWorkflow, historyWorkflow)
      if (durableJob(task.id)?.state.status !== 'prepared') {
        throw new TaskCancelledError(`Task ${task.id} was cancelled before submission`)
      }
    }

    let promptId: string
    const cancellationByPromptId = new Map<string, Promise<PromptCancellationOutcome>>()
    const cancelKnownPrompt = (knownPromptId: string): Promise<PromptCancellationOutcome> => {
      task = taskSource.updateTaskPromptId(task, knownPromptId)
      const existing = cancellationByPromptId.get(knownPromptId)
      if (existing) return existing
      const cancelling = cancelTaskPromptOnClient(taskCli, knownPromptId, task.id)
      cancellationByPromptId.set(knownPromptId, cancelling)
      return cancelling
    }

    // Durable point of no return: after this commit a lost response is reconciled, never reposted.
    await durableMarkSubmitting(task)
    if (durableJob(task.id)?.state.status !== 'submitting') {
      throw new TaskCancelledError(`Task ${task.id} was cancelled before POST`)
    }
    const promptPromise = taskCli.prompt(
      {
        prompt: promptWorkflow,
        client_id: COMFY_PROCESS_TRANSPORT_CLIENT_ID,
        extra_data: {
          ...(task.extra_data ?? {}),
          [TASK_SUBMISSION_TOKEN_FIELD]: task.id
        }
      },
      abortController.signal
    )
    const latePromptObserver = withBoundedTaskOperation(
      AMBIGUOUS_RECONCILIATION_TIMEOUT_MS,
      (signal) => raceTaskAbort(promptPromise, signal)
    ).then(
      async (lateResult) => {
        if (task.cancelRequested) {
          if (executionGeneration === taskRuntimeGeneration) {
            task = taskSource.updateTaskPromptId(task, lateResult.prompt_id)
            await durableBindPrompt(task, lateResult.prompt_id, true)
            await cancelKnownPrompt(lateResult.prompt_id)
          } else {
            await cancelTaskPromptOnClient(taskCli, lateResult.prompt_id, task.id)
          }
        }
      },
      () => undefined
    )
    activePostExecutionPromises.add(latePromptObserver)
    void latePromptObserver.finally(() => activePostExecutionPromises.delete(latePromptObserver))
    try {
      const res = await raceTaskAbort(promptPromise, abortController.signal)
      console.log(`[TaskQueue] ${task.id} prompt result:`, summarizePromptResultForLog(res))
      promptId = res.prompt_id
    } catch (error) {
      if (isComfyPostError(error) && isPromptError(error.payload)) throw error
      let reconciledPromptId: string | null = null
      try {
        reconciledPromptId = await withBoundedTaskOperation(
          AMBIGUOUS_RECONCILIATION_TIMEOUT_MS,
          (signal) => reconcileTaskPromptId(taskCli, task.id, signal)
        )
      } catch (reconciliationError) {
        console.warn(
          `[TaskQueue] ${task.id} submission reconciliation failed:`,
          reconciliationError
        )
      }
      if (!reconciledPromptId) {
        task = taskSource.markTaskSubmissionUnknown(task)
        await durableMarkUnknown(
          task,
          'SUBMISSION_OUTCOME_UNKNOWN',
          'ComfyUI may have accepted the prompt, but its prompt id could not be reconciled.'
        )
        throw new Error(`Task ${task.id} submission outcome is unknown`, { cause: error })
      }
      promptId = reconciledPromptId
    }
    task = taskSource.updateTaskPromptId(task, promptId)
    await durableBindPrompt(task, promptId)

    const [currentStatus] = taskSource.getTask(task.id)
    if (currentStatus !== 'running') {
      const outcome = await cancelKnownPrompt(promptId)
      await applyCancellationOutcome(task, outcome)
      throw new TaskCancelledError(`Task ${task.id} cancellation was reconciled`)
    }

    await durableMarkRunning(task)
    const result = await waitPromptId(
      taskCli,
      promptId,
      undefined,
      undefined,
      () => taskSource.getTask(task.id)[0] !== 'running',
      abortController.signal
    )
    const [finalStatus] = taskSource.getTask(task.id)
    if (finalStatus !== 'running') {
      throw new TaskCancelledError(`Task ${task.id} was cancelled during execution`)
    }

    const normalizedResult = annotateTaskOutputRoute(
      task,
      rewriteTaskResultPromptMeta(task, result, historyWorkflow)
    )
    console.log(`[TaskQueue] ${task.id} result:`, summarizeTaskResultForLog(normalizedResult))
    if (isTaskResultError(normalizedResult)) throw normalizedResult
    task.result = normalizedResult
    await durableComplete(task, normalizedResult)
    releaseLogicalCapacity(task.id)
    return task
  } catch (caught) {
    executionFailed = true
    let error = caught
    if (
      abortController.signal.aborted &&
      !(abortController.signal.reason instanceof TaskQueueShutdownError) &&
      !isTaskCancelledError(error)
    ) {
      error = new TaskCancelledError(`Task ${task.id} was cancelled`)
    }
    const current = durableJob(task.id)?.state
    if (error instanceof TaskQueueShutdownError) {
      if (
        current &&
        ['submitting', 'submitted', 'running', 'cancel_requested'].includes(current.status)
      ) {
        await durableMarkUnknown(
          task,
          'SHUTDOWN_SUBMISSION_UNCONFIRMED',
          'The application stopped while the remote submission state required reconciliation.'
        )
        task.submissionState = 'unknown'
        task.submissionUnknown = true
      }
      throw error
    }
    if (current && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(current.status)) {
      if (task.cancelRequested || isTaskCancelledError(error)) {
        if (['queued', 'leased', 'prepared'].includes(current.status)) {
          await durableCancel(task)
          task = taskSource.markTaskCancelled(task)
          releaseLogicalCapacity(task.id)
        } else {
          await durableMarkUnknown(
            task,
            task.prompt_id ? 'CANCELLATION_UNCONFIRMED' : 'PROMPT_UNKNOWN_AFTER_CANCEL',
            task.prompt_id
              ? 'Cancellation was requested but could not be confirmed on the captured endpoint.'
              : 'Cancellation was requested after submission began, but no prompt id could be confirmed.'
          )
          task = taskSource.markTaskSubmissionUnknown(task)
        }
      } else if (!(task.submissionUnknown || task.submissionState === 'unknown')) {
        const message = error instanceof Error ? error.message : String(error)
        if (
          ['submitting', 'submitted', 'running', 'cancel_requested'].includes(current.status) &&
          !isTaskResultError(error) &&
          !(isComfyPostError(error) && isPromptError(error.payload))
        ) {
          await durableMarkUnknown(task, 'REMOTE_STATE_UNCONFIRMED', message)
          task.submissionState = 'unknown'
          task.submissionUnknown = true
          task.requiresManualIntervention = true
          // The finally block transfers the live lease into retainedUnknownLeases.
          // Restored logical reservations already remain in jobRuntime.restoredReleases.
        } else {
          await durableFail(
            task,
            isTaskResultError(error) ? 'COMFY_TASK_FAILED' : 'COMFY_TASK_ERROR',
            message
          )
          releaseLogicalCapacity(task.id)
        }
      }
    }

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
    throw error
  } finally {
    if (activeTaskAbortControllers.get(task.id) === abortController) {
      activeTaskAbortControllers.delete(task.id)
    }
    if (activeTaskClients.get(task.id) === cli) activeTaskClients.delete(task.id)
    const preserveLeaseForUnknownSubmission =
      task.submissionState === 'unknown' || task.submissionUnknown === true
    const cleanup = (async () => {
      if (preserveLeaseForUnknownSubmission) {
        if (lease) retainedUnknownLeases.set(task.id, lease.release)
        return
      }
      try {
        if (cli && !executionFailed) await cleanupComfyMemoryAfterRun(task, cli)
      } finally {
        try {
          lease?.release()
        } catch (error) {
          console.warn(`[TaskQueue] ${task.id} failed to release its ComfyUI lease:`, error)
        }
        releaseRetainedUnknownLease(task.id)
      }
    })()
    activePostExecutionPromises.add(cleanup)
    void cleanup.finally(() => activePostExecutionPromises.delete(cleanup))
  }
}

type TaskJobRuntime = {
  store: ComfyJobStore
  resources: Map<string, StoredResource<ComfyJobState>>
  restoredReleases: Map<string, () => void>
}

let jobRuntime: TaskJobRuntime | null = null
let taskReady: Promise<void> | null = null
let taskRuntimeGeneration = 0
let taskQueueStopping = false
let deferredFileAuthorizedRoot: string | undefined
const activeExternalOperations = new Set<Promise<unknown>>()

const trackExternalOperation = <T>(operation: Promise<T>): Promise<T> => {
  activeExternalOperations.add(operation)
  void operation.then(
    () => activeExternalOperations.delete(operation),
    () => activeExternalOperations.delete(operation)
  )
  return operation
}

const taskToJobInput = (task: Task) => ({
  jobId: task.id,
  workflow: task.historyPayload ?? task.payload,
  clientId: task.client_id,
  extraData: task.extra_data,
  cleanupAfterRun: task.cleanupAfterRun,
  target: task.target,
  requirements: task.requirements,
  createdAt: task.created_at,
  idempotencyKey: `task-create:${task.id}`
})

const taskFromJob = (resource: StoredResource<ComfyJobState>): Task => {
  const state = resource.state
  return {
    id: state.jobId,
    type: 'comfy_prompt',
    client_id: state.clientId,
    created_at: state.createdAt,
    prompt_id: state.promptId ?? null,
    payload: state.workflow,
    ...(state.extraData === undefined ? {} : { extra_data: state.extraData }),
    cleanupAfterRun: state.cleanupAfterRun,
    target: state.target,
    ...(state.requirements === undefined ? {} : { requirements: state.requirements }),
    ...(state.instanceId === undefined ? {} : { instanceId: state.instanceId }),
    ...(state.instanceRouteId === undefined ? {} : { instanceRouteId: state.instanceRouteId }),
    ...(state.instanceOrigin === undefined ? {} : { instanceOrigin: state.instanceOrigin }),
    ...(state.instanceKind === undefined ? {} : { instanceKind: state.instanceKind }),
    ...(state.legacyDefaultEndpoint === undefined
      ? {}
      : { legacyDefaultEndpoint: state.legacyDefaultEndpoint }),
    ...(state.submissionToken === undefined ? {} : { submissionToken: state.submissionToken }),
    ...(state.cancelRequested === undefined ? {} : { cancelRequested: state.cancelRequested }),
    ...(state.submissionUnknown === undefined
      ? {}
      : { submissionUnknown: state.submissionUnknown }),
    ...(state.requiresManualIntervention === undefined
      ? {}
      : { requiresManualIntervention: state.requiresManualIntervention }),
    ...(state.promptWorkflow === undefined ? {} : { payload: state.promptWorkflow }),
    ...(state.historyWorkflow === undefined ? {} : { historyPayload: state.historyWorkflow }),
    ...(state.status === 'unknown' ? { submissionState: 'unknown' as const } : {}),
    ...(state.status === 'prepared' || state.status === 'submitting'
      ? { submissionState: 'prepared' as const, submissionStarted: true }
      : {}),
    ...(state.status === 'submitted' || state.status === 'running'
      ? { submissionState: 'submitted' as const, submissionStarted: true }
      : {}),
    ...(state.status === 'cancel_requested' ? { submissionStarted: true } : {}),
    result: state.result ?? null,
    jobRevision: resource.revision
  }
}

const rememberJob = (resource: StoredResource<ComfyJobState>): void => {
  if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
  jobRuntime.resources.set(resource.id, resource)
}

const durableJob = (taskId: string): StoredResource<ComfyJobState> | undefined =>
  jobRuntime?.resources.get(taskId) ?? jobRuntime?.store.get(taskId)

const rememberTaskJob = (task: Task, resource: StoredResource<ComfyJobState>): void => {
  rememberJob(resource)
  task.jobRevision = resource.revision
}

const jobMutationInput = (task: Task, boundary: string) => {
  const current = durableJob(task.id)
  if (!current) throw new Error(`Durable Comfy task is missing: ${task.id}`)
  return {
    jobId: task.id,
    expectedRevision: current.revision,
    at: Date.now(),
    idempotencyKey: `task:${task.id}:${boundary}:${current.revision}`
  }
}

const durableAssign = async (task: Task): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const destination = taskCapturedDestination(task)
    if (!task.instanceRouteId) throw new Error(`ComfyUI task has no captured route: ${task.id}`)
    rememberTaskJob(
      task,
      jobRuntime.store.assign({
        ...jobMutationInput(task, 'assign'),
        instanceId: destination.id,
        instanceRouteId: task.instanceRouteId,
        instanceOrigin: destination.origin,
        instanceKind: destination.kind,
        leaseOwner: `task-queue:${process.pid}`,
        leaseExpiresAt: Date.now() + 24 * 60 * 60_000
      })
    )
  })
}

const durablePrepare = async (
  task: Task,
  promptWorkflow: Workflow,
  historyWorkflow: Workflow
): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current || current.state.status !== 'leased') return
    rememberTaskJob(
      task,
      jobRuntime.store.prepare({
        ...jobMutationInput(task, 'prepare'),
        submissionToken: task.id,
        promptWorkflow,
        historyWorkflow
      })
    )
  })
}

const durableMarkSubmitting = async (task: Task): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current || current.state.status !== 'prepared') return
    rememberTaskJob(task, jobRuntime.store.markSubmitting(jobMutationInput(task, 'submitting')))
  })
}

const durableBindPrompt = async (
  task: Task,
  promptId: string,
  reconciled = false
): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current) return
    const input = {
      ...jobMutationInput(task, reconciled ? 'reconcile-prompt' : 'bind-prompt'),
      promptId
    }
    rememberTaskJob(
      task,
      current.state.status === 'cancel_requested'
        ? jobRuntime.store.bindPromptForCancellation(input)
        : reconciled
          ? jobRuntime.store.reconcilePrompt(input)
          : jobRuntime.store.bindPrompt(input)
    )
  })
}

const durableMarkRunning = async (task: Task): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (
      !current ||
      ['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(current.state.status)
    )
      return
    rememberTaskJob(task, jobRuntime.store.markRunning(jobMutationInput(task, 'running')))
  })
}

const durableComplete = async (
  task: Task,
  result: ComfyHistory,
  allowUnknown = false
): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.state.status)) return
    if (current.state.status === 'unknown' && !allowUnknown) return
    rememberTaskJob(
      task,
      jobRuntime.store.complete({ ...jobMutationInput(task, 'complete'), result })
    )
  })
}

const durableFail = async (
  task: Task,
  code: string,
  message: string,
  allowUnknown = false
): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.state.status)) return
    if (current.state.status === 'unknown' && !allowUnknown) return
    rememberTaskJob(
      task,
      jobRuntime.store.fail({
        ...jobMutationInput(task, 'fail'),
        code,
        message: message.trim().slice(0, 4000) || 'Comfy task failed.'
      })
    )
  })
}

const durableCancel = async (task: Task, allowUnknown = false): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.state.status)) return
    if (current.state.status === 'unknown' && !allowUnknown) return
    rememberTaskJob(task, jobRuntime.store.cancel(jobMutationInput(task, 'cancel')))
  })
}

const durableRequestCancel = async (task: Task): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (
      !current ||
      ['cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(
        current.state.status
      )
    )
      return
    rememberTaskJob(task, jobRuntime.store.requestCancel(jobMutationInput(task, 'request-cancel')))
  })
}

const durableMarkUnknown = async (task: Task, code: string, message: string): Promise<void> => {
  await serializeTaskOperation(task.id, async () => {
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    const current = durableJob(task.id)
    if (!current || ['unknown', 'succeeded', 'failed', 'cancelled'].includes(current.state.status))
      return
    rememberTaskJob(
      task,
      jobRuntime.store.markUnknown({
        ...jobMutationInput(task, 'unknown'),
        code,
        message: message.trim().slice(0, 4000)
      })
    )
  })
}

const releaseLogicalCapacity = (taskId: string): void => {
  releaseRetainedUnknownLease(taskId)
  const restored = jobRuntime?.restoredReleases.get(taskId)
  if (restored) {
    jobRuntime?.restoredReleases.delete(taskId)
    restored()
  }
}

const hydrateTaskQueue = async (): Promise<void> => {
  if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
  for (const resource of jobRuntime.store.list()) {
    rememberJob(resource)
    const state = resource.state
    const task = taskFromJob(resource)
    if (state.status === 'succeeded') {
      taskSource.restoreTerminal('completed', task)
      continue
    }
    if (state.status === 'failed') {
      taskSource.restoreTerminal('error', task)
      continue
    }
    if (state.status === 'cancelled') {
      taskSource.restoreTerminal('cancelled', task)
      continue
    }
    if (
      state.instanceId &&
      [
        'leased',
        'unknown',
        'cancel_requested',
        'prepared',
        'submitting',
        'submitted',
        'running'
      ].includes(state.status)
    ) {
      const release = retainRestoredComfyInstanceCapacity(task.id, state.instanceId)
      jobRuntime.restoredReleases.set(task.id, release)
    }
    if (state.status === 'queued' || state.status === 'leased') {
      taskSource.restorePending(task)
      continue
    }
    if (state.status === 'prepared') {
      // Prepared is durably before POST. Reuse the immutable payload and submit exactly once.
      taskSource.restorePending(task)
      continue
    }
    if ((state.status === 'submitted' || state.status === 'running') && !state.cancelRequested) {
      task.resumeKnownPrompt = true
      taskSource.restorePending(task)
      continue
    }

    // Submitting/unknown/cancel-requested states crossed a potentially ambiguous POST boundary. Reconcile
    // only against the immutable captured route before exposing IPC, and never repeat POST /prompt.
    let promptId = state.promptId ?? null
    if (!promptId && state.submissionToken) {
      try {
        promptId = await withBoundedTaskOperation(AMBIGUOUS_RECONCILIATION_TIMEOUT_MS, (signal) =>
          reconcileTaskPromptId(capturedTaskClient(task), state.submissionToken!, signal)
        )
      } catch (error) {
        console.warn(`[TaskQueue] ${task.id} startup reconciliation failed:`, error)
      }
    }
    if (!promptId) {
      task.submissionState = 'unknown'
      task.submissionUnknown = true
      task.requiresManualIntervention = true
      await durableMarkUnknown(
        task,
        'RESTART_PROMPT_UNKNOWN',
        'The durable submission token could not be reconciled on the captured endpoint after restart.'
      )
      taskSource.restoreUnknown(task)
      continue
    }

    task.prompt_id = promptId
    task.submissionState = 'submitted'
    task.submissionUnknown = false
    task.requiresManualIntervention = false
    if (
      state.status !== 'submitted' &&
      state.status !== 'running' &&
      state.status !== 'cancel_requested'
    ) {
      await durableBindPrompt(task, promptId, true)
    }
    if (state.status === 'cancel_requested' || state.cancelRequested) {
      task.cancelRequested = true
      taskSource.restoreUnknown(task)
      const confirmed = await cancelRunningComfyTask(task, promptId, task.id)
      await applyCancellationOutcome(task, confirmed)
      continue
    }
    task.resumeKnownPrompt = true
    taskSource.restorePending(task)
  }
}

const taskSource: TaskMemorySource = new TaskMemorySource()
const taskQueue: QueueManager<Task> = new QueueManager<Task>(taskSource, executeTask)

export async function initTaskQueue(
  options: {
    eventStore?: MagicAgentEventStore
    deferredFileAuthorizedRoot?: string
    /** Test-only lifecycle barrier used to deterministically exercise init/stop ordering. */
    beforeStart?: () => Promise<void>
  } = {}
) {
  if (taskReady) return taskReady
  taskQueueStopping = false
  const generation = ++taskRuntimeGeneration
  taskReady = (async () => {
    if (!options.eventStore) throw new Error('TaskQueue initialization requires an EventStore.')
    deferredFileAuthorizedRoot = options.deferredFileAuthorizedRoot
    const store = new ComfyJobStore(options.eventStore)
    jobRuntime = { store, resources: new Map(), restoredReleases: new Map() }
    await hydrateTaskQueue()
    await options.beforeStart?.()
    if (taskQueueStopping || generation !== taskRuntimeGeneration || jobRuntime?.store !== store)
      return
    taskQueue.start()
  })()
  try {
    await taskReady
  } catch (error) {
    for (const release of jobRuntime?.restoredReleases.values() ?? []) release()
    jobRuntime?.restoredReleases.clear()
    taskSource.reset()
    taskReady = null
    jobRuntime = null
    throw error
  }
}

export async function stopTaskQueue() {
  taskQueueStopping = true
  taskRuntimeGeneration += 1
  taskQueue.stop()
  for (const controller of activeTaskAbortControllers.values()) {
    controller.abort(new TaskQueueShutdownError())
  }
  await taskQueue.drain()
  if (activeExternalOperations.size > 0) {
    await Promise.allSettled([...activeExternalOperations])
  }
  if (activePostExecutionPromises.size > 0) {
    await Promise.allSettled([...activePostExecutionPromises])
  }
  for (const release of retainedUnknownLeases.values()) release()
  retainedUnknownLeases.clear()
  for (const release of jobRuntime?.restoredReleases.values() ?? []) release()
  jobRuntime?.restoredReleases.clear()
  taskSource.reset()
  deferredFileAuthorizedRoot = undefined
  jobRuntime = null
  taskReady = null
}

export function addTask(task: Task): string {
  if (!jobRuntime) throw new Error('TaskQueue is not ready.')
  const id = 'task-' + crypto.randomUUID().replace(/-/g, '')
  const created = jobRuntime.store.create({
    ...taskToJobInput({ ...task, id }),
    jobId: id,
    extraData: task.extra_data,
    maxAttempts: 1
  })
  rememberJob(created)
  return taskSource.add({ ...task, id, jobRevision: created.revision })
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

async function resolveTaskSubmissionUnlocked(
  id: string,
  outcome: TaskSubmissionResolution,
  promptId?: string
): Promise<Task> {
  const [publicStatus, existing] = taskSource.getTask(id)
  if (!existing) throw new Error(`Unknown ComfyUI task was not found: ${id}`)
  const currentDurable = durableJob(id)
  if (publicStatus !== 'unknown' || currentDurable?.state.status !== 'unknown') {
    if (outcome === 'cancelled' && currentDurable?.state.status === 'cancelled') return existing
    if (
      outcome === 'submitted' &&
      promptId?.trim() &&
      currentDurable?.state.promptId === promptId.trim() &&
      ['submitted', 'running', 'succeeded', 'failed', 'cancelled'].includes(
        currentDurable.state.status
      )
    )
      return existing
    if (
      outcome === 'not-submitted' &&
      currentDurable &&
      [
        'prepared',
        'submitting',
        'submitted',
        'running',
        'succeeded',
        'failed',
        'cancelled'
      ].includes(currentDurable.state.status)
    )
      return existing
    throw new Error(
      `Durable ComfyUI task has already been resolved with a conflicting outcome: ${id}`
    )
  }
  if (outcome === 'not-submitted') {
    const current = durableJob(id)
    if (!current || current.state.status !== 'unknown') {
      throw new Error(`Durable ComfyUI task is not manually resolvable: ${id}`)
    }
    if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
    rememberTaskJob(
      existing,
      jobRuntime.store.resolveNotSubmitted({
        ...jobMutationInput(existing, 'manual-not-submitted')
      })
    )
    const task = taskSource.resolveUnknownTask(id, outcome)
    return task
  }
  if (outcome === 'cancelled') {
    await durableCancel(existing, true)
    const task = taskSource.resolveUnknownTask(id, outcome)
    releaseLogicalCapacity(id)
    return task
  }

  if (!promptId?.trim()) throw new Error('A prompt id is required for submitted resolution.')
  if (!jobRuntime) throw new Error('Task job runtime is not initialized.')
  const verifiedPromptId = await withBoundedTaskOperation(
    AMBIGUOUS_RECONCILIATION_TIMEOUT_MS,
    (signal) =>
      reconcileTaskPromptId(capturedTaskClient(existing), existing.submissionToken ?? id, signal)
  )
  if (verifiedPromptId !== promptId.trim()) {
    throw new Error('The supplied prompt id does not carry this task submission token.')
  }
  await durableBindPrompt(existing, verifiedPromptId, true)
  const task = taskSource.resolveUnknownTask(id, outcome, promptId)
  if (task.cancelRequested && task.prompt_id) {
    await durableRequestCancel(task)
    const confirmed = await cancelRunningComfyTask(task, task.prompt_id, task.id)
    await applyCancellationOutcome(task, confirmed)
    return taskSource.getTask(id)[1] ?? task
  }
  return task
}

export const resolveTaskSubmission = (
  id: string,
  outcome: TaskSubmissionResolution,
  promptId?: string
): Promise<Task> => {
  if (taskQueueStopping) return Promise.reject(new TaskQueueShutdownError())
  return trackExternalOperation(
    serializeManualResolution(id, () => resolveTaskSubmissionUnlocked(id, outcome, promptId))
  )
}

function resolveTaskCancellationClient(task: Task): ComfyHttpCli | null {
  const activeClient = activeTaskClients.get(task.id)
  if (activeClient) return activeClient
  return task.instanceRouteId ? capturedTaskClient(task) : null
}

const projectAuthoritativeDurableTask = (taskId: string): ComfyJobState['status'] | undefined => {
  const resource = durableJob(taskId)
  if (!resource) return undefined
  const projected = taskFromJob(resource)
  if (resource.state.status === 'succeeded') taskSource.restoreTerminal('completed', projected)
  else if (resource.state.status === 'failed') taskSource.restoreTerminal('error', projected)
  else if (resource.state.status === 'cancelled') taskSource.restoreTerminal('cancelled', projected)
  else if (resource.state.status === 'unknown') taskSource.restoreUnknown(projected)
  return resource.state.status
}

const applyCancellationOutcome = async (
  task: Task,
  outcome: PromptCancellationOutcome
): Promise<'cancelled' | 'succeeded' | 'failed' | 'unconfirmed'> => {
  if (outcome.kind === 'cancelled') {
    const wasUnknown = taskSource.getTask(task.id)[0] === 'unknown'
    await durableCancel(task, wasUnknown)
    const authoritative = projectAuthoritativeDurableTask(task.id)
    if (authoritative && ['succeeded', 'failed', 'cancelled'].includes(authoritative)) {
      releaseLogicalCapacity(task.id)
      return authoritative === 'succeeded'
        ? 'succeeded'
        : authoritative === 'failed'
          ? 'failed'
          : 'cancelled'
    }
    return 'unconfirmed'
  }
  if (outcome.kind === 'succeeded') {
    task.result = outcome.history
    await durableComplete(task, outcome.history, true)
    const authoritative = projectAuthoritativeDurableTask(task.id)
    if (authoritative && ['succeeded', 'failed', 'cancelled'].includes(authoritative)) {
      releaseLogicalCapacity(task.id)
      return authoritative === 'succeeded'
        ? 'succeeded'
        : authoritative === 'failed'
          ? 'failed'
          : 'cancelled'
    }
    return 'unconfirmed'
  }
  if (outcome.kind === 'failed') {
    task.result = outcome.history
    await durableFail(
      task,
      'REMOTE_EXECUTION_FAILED',
      'ComfyUI execution failed while cancellation was being reconciled.',
      true
    )
    const authoritative = projectAuthoritativeDurableTask(task.id)
    if (authoritative && ['succeeded', 'failed', 'cancelled'].includes(authoritative)) {
      releaseLogicalCapacity(task.id)
      return authoritative === 'succeeded'
        ? 'succeeded'
        : authoritative === 'failed'
          ? 'failed'
          : 'cancelled'
    }
    return 'unconfirmed'
  }
  await durableMarkUnknown(
    task,
    'CANCELLATION_UNCONFIRMED',
    'Cancellation could not be confirmed on the captured endpoint.'
  )
  taskSource.markCancellationUnconfirmed(task)
  return 'unconfirmed'
}

async function cancelRunningComfyTask(
  task: Task,
  promptId: string | null,
  logId: string
): Promise<PromptCancellationOutcome> {
  try {
    const cli = resolveTaskCancellationClient(task)
    if (!cli || !promptId) return { kind: 'unconfirmed' }
    return await cancelTaskPromptOnClient(cli, promptId, logId)
  } catch (error) {
    console.error(`[TaskQueue] 无法取消绑定的 ComfyUI 任务: ${logId}`, error)
    return { kind: 'unconfirmed', error }
  }
}

async function cancelTaskUnlocked(id: string): Promise<boolean> {
  const [status, task] = taskSource.getTask(id)
  if (!status || !task) return false
  const promptId = task.prompt_id || null
  const durableStatus = durableJob(id)?.state.status

  if (
    status === 'pending' &&
    durableStatus !== undefined &&
    ['queued', 'leased', 'prepared'].includes(durableStatus)
  ) {
    await durableCancel(task)
    const found = taskSource.cancelTask(id)
    releaseLogicalCapacity(id)
    return found
  }
  if (status === 'pending' && promptId) {
    await durableRequestCancel(task)
    taskSource.cancelTask(id)
    const confirmed = await cancelRunningComfyTask(task, promptId, id)
    await applyCancellationOutcome(task, confirmed)
    return true
  }
  if (status === 'pending') return false
  if (status === 'unknown') {
    if (!promptId && !task.submissionToken) {
      await durableCancel(task, true)
      taskSource.finalizeUnknownCancellation(id)
      releaseLogicalCapacity(id)
      return true
    }
    if (promptId || task.submissionToken) await durableRequestCancel(task)
    taskSource.cancelTask(id)
    if (!promptId) return true
    const confirmed = await cancelRunningComfyTask(task, promptId, id)
    await applyCancellationOutcome(task, confirmed)
    return true
  }
  if (status !== 'running' && status !== 'cancelling') return false

  activeTaskAbortControllers.get(id)?.abort(new TaskCancelledError(`Task ${id} was cancelled`))
  const latestDurableStatus = durableJob(id)?.state.status
  if (latestDurableStatus && ['queued', 'leased', 'prepared'].includes(latestDurableStatus)) {
    await durableCancel(task)
    taskSource.markTaskCancelled(task)
    releaseLogicalCapacity(id)
    return true
  }
  await durableRequestCancel(task)
  const found = taskSource.cancelTask(id)
  if (promptId) {
    const confirmed = await cancelRunningComfyTask(task, promptId, id)
    await applyCancellationOutcome(task, confirmed)
  }
  return found
}

export const cancelTask = (id: string): Promise<boolean> => {
  if (taskQueueStopping) return Promise.resolve(false)
  return trackExternalOperation(cancelTaskUnlocked(id))
}

export async function cancelTaskByPromptId(promptId: string): Promise<boolean> {
  const [, task] = taskSource.getTaskByPromptId(promptId)
  return task ? cancelTask(task.id) : false
}
