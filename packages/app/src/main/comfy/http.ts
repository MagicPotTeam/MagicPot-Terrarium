import { Config } from '@shared/config/config'
import { ComfyHistoryResp, FileItem, ObjectInfoMap } from '@shared/comfy/types'
import { getConfig } from '../config/config'
import { WebSocket } from 'ws'
import { CustomNodeInfo, PostPromptReq, PostPromptResp } from '@shared/api/svcComfy'
import { NewComfyPostError } from './error'
import { JsonDict } from '@shared/utils/utilTypes'
import { BuildEnv } from '@shared/config/buildEnv'
import { getBuildEnv } from '../config/buildEnv'
import { ConfigUtils } from '@shared/config/configUtils'
import path from 'path'

export const COMFY_PROCESS_TRANSPORT_CLIENT_ID = `magicpot-main-${process.pid}`

type ComfyHttpCliOptions = {
  clientId?: string
}

function normalizeComfyHttpClientId(clientId: string | null | undefined): string {
  return String(clientId || '').trim()
}

/**
 * ComfyUI HTTP API 客户端
 */
export class ComfyHttpCli {
  private clientId: string
  private configUtils: ConfigUtils
  constructor(
    private config: Config = getConfig(),
    private buildEnv: BuildEnv = getBuildEnv(),
    options: ComfyHttpCliOptions = {}
  ) {
    this.clientId =
      normalizeComfyHttpClientId(options.clientId) || COMFY_PROCESS_TRANSPORT_CLIENT_ID
    this.configUtils = new ConfigUtils(this.config, this.buildEnv, path)
  }

  private host(): string {
    return this.configUtils.getComfyUIOrigin()
  }

  private async get<RESP>(path: string): Promise<RESP> {
    const url = new URL(path, this.host()).href
    const response = await fetch(url)
    return response.json() as Promise<RESP>
  }

  private async getBinary(path: string): Promise<Uint8Array> {
    const url = new URL(path, this.host()).href
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  private async post<REQ, RESP>(path: string, payload: REQ): Promise<RESP> {
    const url = new URL(path, this.host()).href
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    if (!response.ok) {
      let data: JsonDict
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(`HTTP error! status: ${response.status}, message: ${error}`)
      }
      throw NewComfyPostError(response.status, data)
    }
    return response.json() as Promise<RESP>
  }

  async installed(): Promise<Record<string, CustomNodeInfo>> {
    const response = await this.get('/customnode/installed')
    return response as Record<string, CustomNodeInfo>
  }

  async objectInfo(): Promise<ObjectInfoMap> {
    const response = await this.get('/object_info')
    return response as ObjectInfoMap
  }

  async prompt(req: PostPromptReq): Promise<PostPromptResp> {
    const response = await this.post('/prompt', {
      prompt: req.prompt,
      client_id: req.client_id,
      extra_data: req.extra_data
    })
    if (!response || typeof response !== 'object' || !('prompt_id' in response)) {
      throw new Error(`prompt_id is null: ${JSON.stringify(response)}`)
    }
    if (typeof response.prompt_id !== 'string') {
      throw new Error(`prompt_id is not a string: ${response.prompt_id}`)
    }
    return response as { prompt_id: string }
  }

  async history(promptId: string): Promise<ComfyHistoryResp> {
    const response = await this.get(`/history/${promptId}`)
    return response as ComfyHistoryResp
  }

  async uploadImage(fileItem: FileItem, image: Uint8Array): Promise<FileItem> {
    if (!fileItem.filename) {
      throw new Error('filename is required')
    }
    const formData = new FormData()
    const blob = new Blob([image as BlobPart])
    // FormData 会自动生成 multipart boundary，但每个文件的 Content-Type 需要正确设置
    formData.append('image', blob, fileItem.filename)
    fileItem.type && formData.append('type', fileItem.type)
    fileItem.subfolder && formData.append('subfolder', fileItem.subfolder)

    const url = new URL('/upload/image', this.host()).href
    const response = await fetch(url, {
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

  async uploadMask(
    fileItem: FileItem,
    mask: Uint8Array,
    original_ref: FileItem
  ): Promise<FileItem> {
    if (!fileItem.filename) {
      throw new Error('filename is required')
    }
    const formData = new FormData()
    const blob = new Blob([mask as BlobPart])
    formData.append('image', blob, fileItem.filename)
    formData.append('original_ref', JSON.stringify(original_ref))
    fileItem.type && formData.append('type', fileItem.type)
    fileItem.subfolder && formData.append('subfolder', fileItem.subfolder)

    const url = new URL('/upload/mask', this.host()).href
    const response = await fetch(url, {
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

  async view(meta: FileItem): Promise<Uint8Array> {
    const params = new URLSearchParams({
      filename: meta.filename ?? '',
      subfolder: meta.subfolder ?? '',
      type: meta.type ?? ''
    })
    return await this.getBinary(`/view?${params.toString()}`)
  }

  connect(): WebSocket {
    const host = this.host()
    const urlObj = new URL(`/ws?clientId=${this.clientId}`, host)
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
    const response = await this.get(`/pysssss/images/${type}`)
    return response as Record<string, string>
  }

  async viewImage(name: string): Promise<Uint8Array> {
    name = encodeURIComponent(name)
    return await this.getBinary(`/pysssss/view/${name}`)
  }

  /**
   * 获取 ComfyUI 队列状态
   */
  async getQueue(): Promise<import('@shared/comfy/types').ComfyQueueResp> {
    const response = await this.get('/queue')
    return response as import('@shared/comfy/types').ComfyQueueResp
  }

  /**
   * 取消队列中的任务（从等待队列中删除）
   * @param promptId 要取消的 prompt_id
   */
  async cancel(promptId: string): Promise<void> {
    await this.post('/queue', {
      delete: [promptId]
    })
  }

  /**
   * 中断当前正在执行的任务
   */
  async interrupt(): Promise<void> {
    await this.post('/interrupt', {})
  }
}
