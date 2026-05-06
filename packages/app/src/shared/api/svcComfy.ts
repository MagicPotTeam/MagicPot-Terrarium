import { JsonDict } from '@shared/utils/utilTypes'
import { ServerStreaming } from './apiUtils/streaming'
import {
  ComfyHistoryResp,
  ComfyQueueResp,
  ObjectInfoMap,
  QueueItem,
  FileItem,
  Workflow
} from '@shared/comfy/types'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type GetInstalledReq = {}
export type CustomNodeInfo = {
  ver: string
  cnr_id: string
  aux_id: string | null
  enabled: boolean
}
export type GetInstalledResp = Record<string, CustomNodeInfo>

export type GetObjectInfoReq = {}
export type GetObjectInfoResp = ObjectInfoMap

export type GetQueueReq = {}
export type GetQueueResp = ComfyQueueResp

export type PostPromptReq = {
  prompt: Workflow
  client_id: string
  extra_data?: JsonDict
}
export type PostPromptResp = {
  prompt_id: string
}

export type GetHistoryReq = {
  prompt_id: string
}
// dict<prompt_id, { outputs: ComfyOutputMeta[] }>
export type GetHistoryResp = ComfyHistoryResp

export type UploadImageReq = {
  fileItem: FileItem
  // TODO: Content-Type
  image: Uint8Array
}
export type UploadImageResp = FileItem

export type UploadMaskReq = {
  fileItem: FileItem
  // TODO: Content-Type
  mask: Uint8Array
  original_ref: FileItem
}
export type UploadMaskResp = FileItem

export type GetViewReq = FileItem

export type GetViewResp = {
  result: Uint8Array
}

export type ConnectWsReq = {
  /**
   * `*` means subscribe to the unfiltered shared event stream.
   * Any other non-empty value is treated as a client-scoped stream key.
   */
  client_id: string
}
/**
 * 实际类型为 {@link ComfyEvent}
 */
export type ConnectWsResp = {
  type: string
  data: JsonDict
}

export const COMFY_EVENT_CLIENT_ID_ALL = '*'

////////////////////
// 以下为便利包装，底层调用 ComfyUI API
////////////////////

export type SubmitWorkflowReq = {
  prompt: Workflow
  /** Optional: which quick app submitted this workflow (for later retrieval) */
  qAppKey?: string
  /** Optional: stable session identity for the workflow owner */
  sessionKey?: string
  /** Optional: explicit client id override for ComfyUI queue/event correlation */
  clientId?: string
  extra_data?: JsonDict
}
export type SubmitWorkflowResp = {
  prompt_id: string
}

export type WaitPromptIdReq = {
  prompt_id: string
}
export type WaitPromptIdResp = ComfyHistoryResp

export type WatchQueueReq = {}
// 比 ComfyQueueResp 多一个 queue_error 字段
export type WatchQueueResp = ComfyQueueResp & {
  queue_error: QueueItem[]
}

export type CancelQueueItemReq = {
  prompt_id: string
}
export type CancelQueueItemResp = {}

/**
 * ComfyUI API 调用服务
 *
 * 只与 ComfyUI API 相关，
 * 因此读取 ComfyUI 文件、打开文件夹、启动关闭 ComfyUI 等操作不在此服务中
 */
export type ComfySvc = {
  //////////////////////
  // 以下为仿 ComfyUI API
  // 后端做了拦截与注入，走内部的排队逻辑
  // 注意这些接口中用的 prompt_id 不是真实的 prompt_id，而是后端生成的唯一标识
  //////////////////////

  getInstalled(req: GetInstalledReq): Promise<GetInstalledResp>
  /**
   * 获取 ComfyUI 对象信息
   * @param req
   */
  getObjectInfo(req: GetObjectInfoReq): Promise<GetObjectInfoResp>
  /**
   * 获取 ComfyUI 队列状态
   * @param req
   */
  getQueue(req: GetQueueReq): Promise<GetQueueResp>
  /**
   * ComfyUI prompt POST 调用
   * @param req
   */
  postPrompt(req: PostPromptReq): Promise<PostPromptResp>
  /**
   * ComfyUI history GET 调用
   * @param req
   */
  getHistory(req: GetHistoryReq): Promise<GetHistoryResp>
  /**
   * 上传图片
   * @param req
   */
  uploadImage(req: UploadImageReq): Promise<UploadImageResp>
  /**
   * 上传蒙版
   * @param req
   */
  uploadMask(req: UploadMaskReq): Promise<UploadMaskResp>
  /**
   * ComfyUI view GET 调用
   * @param req
   */
  getView(req: GetViewReq): Promise<GetViewResp>
  /**
   * 获取 ComfyUI WebSocket 连接
   */
  connectWs(req: ConnectWsReq, resp: ServerStreaming<ConnectWsResp>): Promise<void>

  /////////////////
  // 以下为便利包装，底层调用 ComfyUI API
  /////////////////

  /**
   * 提交工作流
   * 与 postPrompt 相比，不需要 client_id
   * @param req
   */
  submitWorkflow(req: SubmitWorkflowReq): Promise<SubmitWorkflowResp>
  /**
   * 等待 prompt_id 执行完成
   * @param req
   * @param resp
   */
  waitPromptId(req: WaitPromptIdReq, resp: ServerStreaming<WaitPromptIdResp>): Promise<void>
  /**
   * 监听队列状态
   * @param req
   * @param resp
   */
  watchQueue(req: WatchQueueReq, resp: ServerStreaming<WatchQueueResp>): Promise<void>
  /**
   * 取消队列中的任务
   * @param req
   */
  cancelQueueItem(req: CancelQueueItemReq): Promise<CancelQueueItemResp>
}

export const comfySvcDef: ServiceDefSheet<ComfySvc> = {
  getInstalled: {
    type: 'unary'
  },
  getObjectInfo: {
    type: 'unary'
  },
  getQueue: {
    type: 'unary'
  },
  postPrompt: {
    type: 'unary'
  },
  getHistory: {
    type: 'unary'
  },
  uploadImage: {
    type: 'unary'
  },
  uploadMask: {
    type: 'unary'
  },
  getView: {
    type: 'unary'
  },
  connectWs: {
    type: 'serverStreaming'
  },
  submitWorkflow: {
    type: 'unary'
  },
  waitPromptId: {
    type: 'serverStreaming'
  },
  watchQueue: {
    type: 'serverStreaming'
  },
  cancelQueueItem: {
    type: 'unary'
  }
}
