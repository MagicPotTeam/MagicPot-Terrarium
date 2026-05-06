/**
 * Photoshop 服务接口
 * 用于与 Adobe Photoshop 进行交互
 */

import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type SendImageToPhotoshopReq = {
  /** 图片的 blob URL 或 data URL */
  imageUrl: string
  /** 可选的文件名 */
  fileName?: string
}

export type SendImageToPhotoshopResp = {
  /** 是否成功 */
  success: boolean
  /** 错误信息（如果失败） */
  error?: string
  /** 保存的临时文件路径（如果成功） */
  filePath?: string
}

export type LoadImageFromPhotoshopReq = {
  // 不需要参数，直接从剪贴板读取
}

export type LoadImageFromPhotoshopResp = {
  /** 图片数据（Uint8Array） */
  image: Uint8Array
  /** 文件名 */
  fileName: string
}

export type StartRealtimeGenerationReq = {
  /** 工作流模板（JSON 字符串） */
  workflowTemplate: string
  /** 图像输入节点的路径（JSON Path，例如 "$.12.inputs.image"） */
  imageInputSlot: string
  /** 输出节点 ID 列表 */
  outputNodeIds: string[]
  /** 轮询间隔（毫秒），默认 2000 */
  pollInterval?: number
}

export type StartRealtimeGenerationResp = {
  /** 是否成功启动 */
  success: boolean
  /** 错误信息（如果失败） */
  error?: string
}

export type StopRealtimeGenerationReq = {}

export type StopRealtimeGenerationResp = {
  /** 是否成功停止 */
  success: boolean
}

export type GetRealtimeGenerationStatusReq = {}

export type GetRealtimeGenerationStatusResp = {
  /** 是否正在运行 */
  isRunning: boolean
  /** 最新加载的图像信息（如果有） */
  latestLoadedImage?: {
    /** 图像值（用于更新输入框） */
    imageValue: string
    /** 图像输入节点路径 */
    imageInputSlot: string
  }
  /** 最新生成的结果（如果有） */
  latestGeneratedResult?: {
    /** prompt_id */
    promptId: string
    /** 工作流历史 */
    history: import('@shared/comfy/types').ComfyHistory
    /** 输出节点 ID 列表 */
    outputNodeIds: string[]
  }
}

export type PhotoshopSvc = {
  /**
   * 将图片发送到 Photoshop
   * 将图片保存到临时文件，然后使用 Photoshop 脚本将其作为新图层添加到当前文档
   */
  sendImageToPhotoshop(req: SendImageToPhotoshopReq): Promise<SendImageToPhotoshopResp>
  /**
   * 从 Photoshop 加载图片
   * 直接读取 Photoshop 当前活动文档，无需复制粘贴
   */
  loadImageFromPhotoshop(req: LoadImageFromPhotoshopReq): Promise<LoadImageFromPhotoshopResp>
  /**
   * 启动实时绘画
   * 当队列为空时，自动从 Photoshop 读取图像、生成、并发送回 Photoshop
   */
  startRealtimeGeneration(req: StartRealtimeGenerationReq): Promise<StartRealtimeGenerationResp>
  /**
   * 停止实时绘画
   */
  stopRealtimeGeneration(req: StopRealtimeGenerationReq): Promise<StopRealtimeGenerationResp>
  /**
   * 获取实时绘画状态
   */
  getRealtimeGenerationStatus(
    req: GetRealtimeGenerationStatusReq
  ): Promise<GetRealtimeGenerationStatusResp>
}

export const photoshopSvcDef: ServiceDefSheet<PhotoshopSvc> = {
  sendImageToPhotoshop: {
    type: 'unary'
  },
  loadImageFromPhotoshop: {
    type: 'unary'
  },
  startRealtimeGeneration: {
    type: 'unary'
  },
  stopRealtimeGeneration: {
    type: 'unary'
  },
  getRealtimeGenerationStatus: {
    type: 'unary'
  }
}
