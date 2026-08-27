import { Config } from '@shared/config/config'
import { ComfyHistoryResp, FileItem, ObjectInfoMap } from '@shared/comfy/types'
import { getConfig } from '../config/config'
import { WebSocket } from 'ws'
import { CustomNodeInfo, FreeMemoryReq, PostPromptReq, PostPromptResp } from '@shared/api/svcComfy'
import { NewComfyPostError } from './error'
import { JsonDict } from '@shared/utils/utilTypes'
import { BuildEnv } from '@shared/config/buildEnv'
import { getBuildEnv } from '../config/buildEnv'
import { ConfigUtils } from '@shared/config/configUtils'
import path from 'path'
import {
  createComfyJsonPostInit,
  resolvePromptAdmission,
  waitForPromptAdmission
} from './batchHttp'
import type { ComfyPromptQueue } from './batchHttp'

export const COMFY_PROCESS_TRANSPORT_CLIENT_ID = `magicpot-main-${process.pid}`

type ComfyHttpCliOptions = {
  clientId?: string
  /** Override the configured origin when a task is assigned to an instance pool member. */
  baseUrl?: string
}

function normalizeComfyHttpClientId(clientId: string | null | undefined): string {
  return String(clientId || '').trim()
}

/**
 * ComfyUI HTTP API 客户端
 */
export class ComfyHttpCli {
  private clientId: string
  private baseUrlOverride?: string
  private configUtils: ConfigUtils
  constructor(
    private config: Config = getConfig(),
    private buildEnv: BuildEnv = getBuildEnv(),
    options: ComfyHttpCliOptions = {}
  ) {
    this.clientId =
      normalizeComfyHttpClientId(options.clientId) || COMFY_PROCESS_TRANSPORT_CLIENT_ID
    this.baseUrlOverride = options.baseUrl?.trim() || undefined
    this.configUtils = new ConfigUtils(this.config, this.buildEnv, path)
  }

  private host(): string {
    const configuredOrigin = this.baseUrlOverride || this.configUtils.getComfyUIOrigin()
    let origin: URL
    try {
      origin = new URL(configuredOrigin)
    } catch {
      throw new Error('Invalid ComfyUI base URL')
    }
    if (
      (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
      origin.username ||
      origin.password
    ) {
      throw new Error('Invalid ComfyUI base URL')
    }
    return origin.href
  }

  private url(pathname: string): string {
    return new URL(pathname.replace(/^\/+/, ''), this.host()).href
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    return init ? fetch(this.url(path), init) : fetch(this.url(path))
  }

  /** @deprecated ComfyUI endpoints are no longer selected by a mode flag. */
  isRemoteComfyUI(): boolean {
    return false
  }

  private async get<RESP>(path: string, signal?: AbortSignal): Promise<RESP> {
    const response = await this.request(path, signal ? { signal } : undefined)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return response.json() as Promise<RESP>
  }

  private async getBinary(path: string): Promise<Uint8Array> {
    const response = await this.request(path)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  private async throwPostError(response: Response): Promise<never> {
    let data: JsonDict
    try {
      data = await response.json()
    } catch (error) {
      throw new Error(`HTTP error! status: ${response.status}, message: ${error}`)
    }
    throw NewComfyPostError(response.status, data)
  }

  private async post<REQ, RESP>(path: string, payload: REQ, parseResponse = true): Promise<RESP> {
    const response = await this.request(path, createComfyJsonPostInit(payload))
    if (!response.ok) {
      await this.throwPostError(response)
    }
    return (parseResponse ? await response.json() : undefined) as RESP
  }

  private async postNoContent<REQ>(path: string, payload: REQ): Promise<void> {
    await this.post<REQ, void>(path, payload, false)
  }

  async installed(): Promise<Record<string, CustomNodeInfo>> {
    return this.get<Record<string, CustomNodeInfo>>('/customnode/installed')
  }

  async objectInfo(signal?: AbortSignal): Promise<ObjectInfoMap> {
    return this.get<ObjectInfoMap>('/object_info', signal)
  }

  async prompt(req: PostPromptReq): Promise<PostPromptResp> {
    const response = await this.post('/prompt', {
      prompt: req.prompt,
      client_id: req.client_id,
      extra_data: req.extra_data,
      ...(req.prompt_id ? { prompt_id: req.prompt_id } : {})
    })
    if (!response || typeof response !== 'object' || !('prompt_id' in response)) {
      throw new Error(`prompt_id is null: ${JSON.stringify(response)}`)
    }
    if (typeof response.prompt_id !== 'string') {
      throw new Error(`prompt_id is not a string: ${response.prompt_id}`)
    }
    return response as { prompt_id: string }
  }

  async history(promptId: string, signal?: AbortSignal): Promise<ComfyHistoryResp> {
    return this.get<ComfyHistoryResp>(`/history/${promptId}`, signal)
  }

  async promptAdmission(
    promptId: string,
    signal?: AbortSignal,
    clientId?: string
  ): Promise<{ admitted: boolean; promptId: string }> {
    const history = await this.history(promptId, signal)
    const queue = await this.get<ComfyPromptQueue>('/queue', signal)
    return resolvePromptAdmission(promptId, history, queue, clientId)
  }

  async waitForPromptAdmission(
    promptId: string,
    signal?: AbortSignal,
    timeoutMs = 5_000,
    clientId?: string
  ): Promise<{ admitted: boolean; promptId: string }> {
    return waitForPromptAdmission(
      () => this.promptAdmission(promptId, signal, clientId),
      promptId,
      signal,
      timeoutMs,
      'ComfyUI request cancelled'
    )
  }

  private async upload(
    path: '/upload/image' | '/upload/mask',
    fileItem: FileItem,
    image: Uint8Array,
    originalRef?: FileItem
  ): Promise<FileItem> {
    if (!fileItem.filename) {
      throw new Error('filename is required')
    }
    const formData = new FormData()
    // FormData 会自动生成 multipart boundary，但每个文件的 Content-Type 需要正确设置
    formData.append('image', new Blob([image as BlobPart]), fileItem.filename)
    originalRef && formData.append('original_ref', JSON.stringify(originalRef))
    fileItem.type && formData.append('type', fileItem.type)
    fileItem.subfolder && formData.append('subfolder', fileItem.subfolder)

    const response = await this.request(path, {
      method: 'POST',
      body: formData
    })
    if (!response.ok) {
      try {
        const data = await response.text()
        throw new Error(`HTTP error! status: ${response.status}, message: ${data}`)
      } catch (error) {
        throw new Error(`HTTP error! status: ${response.status}, message: ${error}`)
      }
    }
    const data = (await response.json()) as { name?: string; subfolder?: string; type?: string }
    return {
      filename: data.name,
      subfolder: data.subfolder,
      type: data.type
    }
  }

  async uploadImage(fileItem: FileItem, image: Uint8Array): Promise<FileItem> {
    return this.upload('/upload/image', fileItem, image)
  }

  async uploadMask(
    fileItem: FileItem,
    mask: Uint8Array,
    original_ref: FileItem
  ): Promise<FileItem> {
    return this.upload('/upload/mask', fileItem, mask, original_ref)
  }

  async view(meta: FileItem): Promise<Uint8Array> {
    const params = new URLSearchParams({
      filename: meta.filename ?? '',
      subfolder: meta.subfolder ?? '',
      type: meta.type ?? ''
    })
    return this.getBinary(`/view?${params.toString()}`)
  }

  async viewResponse(meta: FileItem, signal?: AbortSignal): Promise<Response> {
    const params = new URLSearchParams({
      filename: meta.filename ?? '',
      subfolder: meta.subfolder ?? '',
      type: meta.type ?? ''
    })
    return fetch(this.url(`/view?${params.toString()}`), {
      signal,
      redirect: 'manual'
    })
  }

  connect(): WebSocket {
    const host = this.host()
    const urlObj = new URL(`ws?clientId=${this.clientId}`, host)
    const schema = urlObj.protocol === 'https:' ? 'wss:' : 'ws:'
    urlObj.protocol = schema
    const url = urlObj.href
    return new WebSocket(url, {
      perMessageDeflate: true
    })
  }

  /////////////////
  // 以下为 pysssss 相关接口
  // 可能作为付费，需拆分
  /////////////////
  async listImages(type: 'loras' | 'checkpoints'): Promise<Record<string, string>> {
    return this.get<Record<string, string>>(`/pysssss/images/${type}`)
  }

  async viewImage(name: string): Promise<Uint8Array> {
    name = encodeURIComponent(name)
    return this.getBinary(`/pysssss/view/${name}`)
  }

  /**
   * 获取 ComfyUI 队列状态
   */
  async getQueue(): Promise<import('@shared/comfy/types').ComfyQueueResp> {
    return this.get<import('@shared/comfy/types').ComfyQueueResp>('/queue')
  }

  /**
   * 取消队列中的任务（从等待队列中删除）
   * @param promptId 要取消的 prompt_id
   */
  async cancel(promptId: string): Promise<void> {
    await this.postNoContent('/queue', {
      delete: [promptId]
    })
  }

  /**
   * 中断当前正在执行的任务
   */
  async interrupt(): Promise<void> {
    await this.postNoContent('/interrupt', {})
  }

  /**
   * Ask ComfyUI to unload cached models and release execution memory.
   */
  async freeMemory(req: FreeMemoryReq = {}): Promise<void> {
    await this.postNoContent('/free', {
      unload_models: req.unload_models ?? true,
      free_memory: req.free_memory ?? true
    })
  }
}
