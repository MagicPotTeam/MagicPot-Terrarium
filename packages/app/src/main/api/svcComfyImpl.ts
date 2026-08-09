import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import {
  CancelQueueItemReq,
  CancelQueueItemResp,
  COMFY_EVENT_CLIENT_ID_ALL,
  ComfySvc,
  ConnectWsReq,
  FreeMemoryReq,
  FreeMemoryResp,
  ConnectWsResp,
  GetHistoryReq,
  GetHistoryResp,
  GetInstalledReq,
  GetInstalledResp,
  GetObjectInfoReq,
  GetObjectInfoResp,
  GetQueueReq,
  GetQueueResp,
  GetViewReq,
  GetViewResp,
  ImportOutputImageReq,
  ImportOutputImageResp,
  PostPromptReq,
  PostPromptResp,
  SubmitWorkflowReq,
  SubmitWorkflowResp,
  UploadImageReq,
  UploadImageResp,
  UploadMaskReq,
  UploadMaskResp,
  WaitPromptIdReq,
  WaitPromptIdResp,
  WatchQueueReq,
  WatchQueueResp
} from '@shared/api/svcComfy'
import { ComfyEvent } from '@shared/comfy/events'
import { ComfyHttpCli } from '../comfy/http'
import { ComfyCliWrapper, waitPromptId } from '../comfy/logic'
import {
  addTask,
  cancelTask,
  cancelTaskByPromptId,
  getQueue,
  getTask,
  getTaskByPromptId,
  Task
} from '../queue/taskQueue'
import { listenComfyEvent } from '../comfy/state'
import { comfyEventToTaskEvent, extractPromptId, taskToComfyQueueItem } from '../queue/convert'
import { sleep } from '@shared/utils/utilFuncs'
import { ComfyQueueResp, Workflow } from '@shared/comfy/types'
import { processWorkflowLoras } from '../comfy/loraBypass'
import { normalizeExecutableWorkflow } from '@shared/comfy/funcs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'
import {
  DEFAULT_MANAGED_MEDIA_MAX_BYTES,
  importManagedMediaStream,
  ManagedMediaImportError
} from '../llmProxy/managedMediaStore'

const COMFY_OUTPUT_IMPORT_TIMEOUT_MS = 30_000

function isCanonicalUnencoded(value: string): boolean {
  try {
    return decodeURIComponent(value) === value
  } catch {
    return false
  }
}

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

function validateComfyOutputFilename(value: unknown): string {
  const filename = typeof value === 'string' ? value : ''
  if (!filename) {
    throw new Error('Invalid ComfyUI output filename: expected a non-empty basename')
  }
  if (!isCanonicalUnencoded(filename)) {
    throw new Error('Invalid ComfyUI output filename: percent-encoded aliases are not allowed')
  }
  if (
    path.posix.basename(filename) !== filename ||
    hasControlCharacter(filename) ||
    /[?#:\\]/u.test(filename)
  ) {
    throw new Error('Invalid ComfyUI output filename: unsafe path characters')
  }
  return filename
}

function validateComfyOutputSubfolder(value: unknown): string {
  const subfolder = value == null ? '' : typeof value === 'string' ? value : ''
  if (!subfolder) return ''
  const segments = subfolder.split('/')
  if (
    !isCanonicalUnencoded(subfolder) ||
    hasControlCharacter(subfolder) ||
    /[?#:\\]/u.test(subfolder) ||
    subfolder.startsWith('/') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    path.posix.normalize(subfolder) !== subfolder
  ) {
    throw new Error('Invalid ComfyUI output subfolder')
  }
  return subfolder
}

// Map to store qAppKey by task ID (for later retrieval when loading quick app)
const MAX_TASK_QAPP_KEYS = 200
const taskQAppKeyMap = new Map<string, string>()

function storeTaskQAppKey(taskId: string, qAppKey: string): void {
  taskQAppKeyMap.delete(taskId)
  taskQAppKeyMap.set(taskId, qAppKey)
  while (taskQAppKeyMap.size > MAX_TASK_QAPP_KEYS) {
    const oldestTaskId = taskQAppKeyMap.keys().next().value
    if (!oldestTaskId) break
    taskQAppKeyMap.delete(oldestTaskId)
  }
}

function normalizeComfyEventClientId(clientId: string | null | undefined): string {
  const normalized = String(clientId || '').trim()
  return normalized || COMFY_EVENT_CLIENT_ID_ALL
}

function shouldForwardComfyEventToClient(event: ComfyEvent, requestedClientId: string): boolean {
  if (requestedClientId === COMFY_EVENT_CLIENT_ID_ALL) {
    return true
  }

  const promptId = extractPromptId(event)
  if (!promptId) {
    return false
  }

  const [, task] = getTaskByPromptId(promptId)
  return task?.client_id === requestedClientId
}

function resolveWorkflowClientId(req: SubmitWorkflowReq): string {
  const explicitClientId = String(req.clientId || '').trim()
  if (explicitClientId) {
    return explicitClientId
  }

  const sessionScopedClientId = String(req.sessionKey || '').trim()
  if (sessionScopedClientId) {
    return sessionScopedClientId
  }

  return `magicpot-workflow-${crypto.randomUUID()}`
}

/**
 * 这个类大概率会被其他地方复用，
 * 要注意所有方法都用箭头函数的方式实现，
 * 否则在其他地方调用时，this 会指向错误
 */

export class ComfySvcImpl implements ComfySvc {
  private cli = () => new ComfyHttpCli()
  private watchQueueWarned = false

  //////////////////////
  // 以下为一比一仿真的 ComfyUI API
  //////////////////////

  getInstalled = async (req: GetInstalledReq): Promise<GetInstalledResp> => {
    const res = await this.cli().installed()
    return res
  }
  getObjectInfo = async (req: GetObjectInfoReq): Promise<GetObjectInfoResp> => {
    // 为了保证 getObjectInfo 的返回值与 ComfyUI 的返回值一致，这里直接调用 ComfyUI 的 getObjectInfo 接口
    const res = await this.cli().objectInfo()
    return res
  }
  getQueue = async (req: GetQueueReq): Promise<GetQueueResp> => {
    const queueState = getQueue()
    return {
      queue_running: queueState.running.map((task, index) => taskToComfyQueueItem(task, index)),
      queue_pending: queueState.pending.map((task, index) => taskToComfyQueueItem(task, index))
    }
  }
  postPrompt = async (req: PostPromptReq): Promise<PostPromptResp> => {
    const id = addTask({
      id: '', // 占位
      type: 'comfy_prompt',
      client_id: req.client_id,
      created_at: Date.now(),
      prompt_id: null,
      payload: req.prompt,
      extra_data: req.extra_data,
      cleanupAfterRun: req.cleanupAfterRun === true,
      result: null
    })
    return { prompt_id: id }
  }
  getHistory = async (req: GetHistoryReq): Promise<GetHistoryResp> => {
    const [status, task] = getTask(req.prompt_id)
    if (status === 'pending') {
      return {}
    }
    if (status === 'cancelled') {
      return {}
    }
    // taskQueue 中已保证无论成功失败， result 一定存在
    if ((status === 'completed' || status === 'error') && task.result) {
      // Inject qAppKey into the result workflow if stored
      // Note: We don't delete from map because getTask returns deep copies,
      // so each getHistory call needs to inject again
      const qAppKey = taskQAppKeyMap.get(task.id)
      if (qAppKey && task.result.prompt?.[2]) {
        // Inject __qAppKey__ into the workflow in the result
        ;(task.result.prompt[2] as Record<string, unknown>).__qAppKey__ = qAppKey
      }
      return {
        [task.id]: task.result
      }
    }

    // 兜个底，理论上 taskQueue 中已处理，不会走到这里
    if (status === 'completed' || status === 'error') {
      console.error(`[ComfySvcImpl] ${task.id} unknown error:`, task.result)
      return {
        [task.id]: {
          prompt: [0, task.prompt_id ?? '', task.payload, { client_id: task.client_id }, []],
          outputs: {},
          status: {
            status_str: 'error',
            completed: false,
            messages: []
          }
        }
      }
    }
    return {}
  }
  uploadImage = async (req: UploadImageReq): Promise<UploadImageResp> => {
    // 现在不另外保存输入图片，直接调用 ComfyUI 的 uploadImage 接口
    const res = await this.cli().uploadImage(req.fileItem, req.image)
    return res
  }
  uploadMask = async (req: UploadMaskReq): Promise<UploadMaskResp> => {
    // 现在不另外保存输入蒙版，直接调用 ComfyUI 的 uploadMask 接口
    const res = await this.cli().uploadMask(req.fileItem, req.mask, req.original_ref)
    return res
  }
  getView = async (req: GetViewReq): Promise<GetViewResp> => {
    // 现在不另外保存声称结果，这里直接访问 ComfyUI 的 view 接口
    const res = await this.cli().view(req)
    return { result: res }
  }
  importOutputImage = async (req: ImportOutputImageReq): Promise<ImportOutputImageResp> => {
    if (!req || req.type !== 'output') throw new Error('ComfyUI output type must be output')
    const filename = validateComfyOutputFilename(req.filename)
    const subfolder = validateComfyOutputSubfolder(req.subfolder)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), COMFY_OUTPUT_IMPORT_TIMEOUT_MS)
    try {
      const response = await this.cli().viewResponse(
        { filename, subfolder, type: 'output' },
        controller.signal
      )
      if (response.status >= 300 && response.status < 400) {
        throw new Error('ComfyUI view redirect rejected')
      }
      if (!response.ok) throw new Error(`ComfyUI view failed with HTTP ${response.status}`)
      const mimeType = String(response.headers.get('content-type') || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase()
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
        throw new ManagedMediaImportError(
          'MANAGED_MEDIA_UNSUPPORTED',
          'ComfyUI view returned an unsupported image type'
        )
      }
      const contentLengthHeader = response.headers.get('content-length')
      const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader)
      if (
        contentLengthHeader != null &&
        (!/^\d+$/u.test(contentLengthHeader) || !Number.isSafeInteger(contentLength))
      ) {
        throw new ManagedMediaImportError(
          'MANAGED_MEDIA_INVALID',
          'ComfyUI view returned an invalid content length'
        )
      }
      if (contentLength != null && contentLength > DEFAULT_MANAGED_MEDIA_MAX_BYTES) {
        controller.abort()
        throw new Error(`ComfyUI output exceeds the ${DEFAULT_MANAGED_MEDIA_MAX_BYTES} byte limit`)
      }
      if (!response.body) throw new Error('ComfyUI view returned an empty body')
      const authorizedRoot = getChatMediaDir()
      // Global content-addressed storage is intentional. Session/lifecycle ownership lives in
      // persisted references, not renderer-provided directory isolation.
      const imported = await importManagedMediaStream(
        {
          chatMediaRoot: path.join(authorizedRoot, 'comfy-outputs', 'global'),
          stream: Readable.fromWeb(
            response.body as import('node:stream/web').ReadableStream<Uint8Array>
          ),
          mimeType,
          originalFileName: filename,
          provenance: { source: 'comfy-output', filename, subfolder, type: 'output' },
          maxBytes: DEFAULT_MANAGED_MEDIA_MAX_BYTES,
          signal: controller.signal
        },
        { authorizedRoot }
      )
      const importedReference = imported.reference
      const importedMimeType = importedReference.mimeType
      const importedSizeBytes = importedReference.sizeBytes
      const importedFileName = importedReference.originalFileName
      if (
        typeof importedMimeType !== 'string' ||
        !importedMimeType ||
        !Number.isSafeInteger(importedSizeBytes) ||
        (importedSizeBytes ?? -1) < 0 ||
        typeof importedFileName !== 'string' ||
        !importedFileName
      ) {
        throw new ManagedMediaImportError(
          'MANAGED_MEDIA_INVALID',
          'Imported ComfyUI output metadata is invalid'
        )
      }
      return {
        reference: importedReference,
        localMediaUrl: imported.localMediaUrl,
        mimeType: importedMimeType,
        sizeBytes: importedSizeBytes as number,
        fileName: importedFileName
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }
  connectWs = async (req: ConnectWsReq, resp: ServerStreaming<ConnectWsResp>): Promise<void> => {
    const requestedClientId = normalizeComfyEventClientId(req.client_id)
    return new Promise((resolve, reject) => {
      listenComfyEvent({
        id: crypto.randomUUID(),
        abortReceiver: resp.abortReceiver,
        onEvent: (event) => {
          if (!shouldForwardComfyEventToClient(event, requestedClientId)) {
            return
          }
          const taskEvent = comfyEventToTaskEvent(event)
          resp.onData({
            type: taskEvent.type,
            data: taskEvent.data
          })
        },
        onEnd: () => {
          resolve()
        }
      })
    })
  }

  //////////////////////
  // 以下为便利包装，底层套用上面的 ComfyUI API
  //////////////////////

  submitWorkflow = async (req: SubmitWorkflowReq): Promise<SubmitWorkflowResp> => {
    const workflowClientId = resolveWorkflowClientId(req)

    // 处理缺失的 LoRA：获取可用 LoRA 列表，绕过不存在的 LoRA 节点
    let processedPrompt = normalizeExecutableWorkflow(req.prompt)
    try {
      const objectInfo = await this.cli().objectInfo()
      const result = processWorkflowLoras(processedPrompt, objectInfo)
      processedPrompt = result.workflow
    } catch (error) {
      console.warn('[submitWorkflow] Failed to process LoRA bypass:', error)
      // 如果获取 objectInfo 失败，继续使用原始 prompt
    }

    const res = await this.postPrompt({
      prompt: processedPrompt,
      client_id: workflowClientId,
      ...(req.cleanupAfterRun === true ? { cleanupAfterRun: true } : {}),
      extra_data: req.extra_data
    })
    // Store qAppKey separately (not in workflow) for later retrieval
    if (req.qAppKey) {
      storeTaskQAppKey(res.prompt_id, req.qAppKey)
    }
    return { prompt_id: res.prompt_id }
  }
  waitPromptId = async (
    req: WaitPromptIdReq,
    resp: ServerStreaming<WaitPromptIdResp>
  ): Promise<void> => {
    // 用内部的 Queue 逻辑接管 ComfyHttpCli 的请求
    const cli: ComfyCliWrapper = {
      history: (promptId) => this.getHistory({ prompt_id: promptId }),
      view: (meta) => this.getView(meta).then((res) => res.result)
    }

    const aborted = () => Boolean(resp?.abortReceiver?.isAborted())
    const history = await waitPromptId(cli, req.prompt_id, undefined, undefined, aborted)
    resp.onData({
      [req.prompt_id]: history
    })
    return
  }
  watchQueue = async (req: WatchQueueReq, resp: ServerStreaming<WatchQueueResp>): Promise<void> => {
    // 先简单轮询
    while (true) {
      if (resp.abortReceiver?.isAborted()) {
        return
      }

      // 获取内部队列状态
      const internalQueueState = getQueue()
      const errorLength = internalQueueState.error.length

      // 获取 ComfyUI 队列状态（用于显示实时绘画等直接提交到 ComfyUI 的任务）
      let comfyQueueState: ComfyQueueResp = {
        queue_running: [],
        queue_pending: []
      }
      try {
        comfyQueueState = await this.cli().getQueue()
      } catch (error) {
        // 如果获取 ComfyUI 队列失败，忽略错误，继续使用内部队列
        if (!this.watchQueueWarned) {
          console.warn('[watchQueue] 获取 ComfyUI 队列失败（ComfyUI 可能未启动），后续不再重复提示')
          this.watchQueueWarned = true
        }
      }

      // 合并内部队列和 ComfyUI 队列
      // 内部队列的任务使用内部 ID，ComfyUI 队列的任务使用 prompt_id
      const internalRunning = internalQueueState.running.map((task, index) =>
        taskToComfyQueueItem(task, index)
      )
      const internalPending = internalQueueState.pending.map((task, index) =>
        taskToComfyQueueItem(task, index)
      )

      // 过滤掉已经在内部队列中的任务（通过 prompt_id 匹配）
      const internalPromptIds = new Set(
        [...internalQueueState.running, ...internalQueueState.pending]
          .map((task) => task.prompt_id)
          .filter((id): id is string => id !== null)
      )

      const comfyRunning = comfyQueueState.queue_running.filter(
        (item) => !internalPromptIds.has(item[1]) // item[1] 是 prompt_id
      )
      const comfyPending = comfyQueueState.queue_pending.filter(
        (item) => !internalPromptIds.has(item[1]) // item[1] 是 prompt_id
      )

      resp.onData({
        queue_running: [...internalRunning, ...comfyRunning],
        queue_pending: [...internalPending, ...comfyPending],
        queue_error: internalQueueState.error
          .slice(errorLength > 3 ? errorLength - 3 : 0)
          .map((task, index) => taskToComfyQueueItem(task, index)) // 只显示最新的三个
      })
      await sleep(1000)
    }
  }
  freeMemory = async (req: FreeMemoryReq = {}): Promise<FreeMemoryResp> => {
    await this.cli().freeMemory(req)
    return {}
  }

  cancelQueueItem = async (req: CancelQueueItemReq): Promise<CancelQueueItemResp> => {
    // req.prompt_id 可能是内部 ID（格式为 task-xxx）或真实的 ComfyUI prompt_id
    // 先尝试作为内部 ID 取消
    const [status, task] = getTask(req.prompt_id)

    if (status && task) {
      // 找到了任务
      if (task.prompt_id) {
        // 如果任务已经有 prompt_id，使用 prompt_id 取消（包括 ComfyUI 中的任务）
        await cancelTaskByPromptId(task.prompt_id)
      } else {
        // 如果任务还没有 prompt_id（还在等待队列中），直接从内部队列移除
        await cancelTask(req.prompt_id)
      }
    } else {
      // 没找到任务，尝试作为 prompt_id 取消（可能是外部提交的任务）
      await cancelTaskByPromptId(req.prompt_id)
    }

    return {}
  }
}
