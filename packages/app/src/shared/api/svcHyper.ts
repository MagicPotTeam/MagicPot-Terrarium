import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import { ServerStreaming } from './apiUtils/streaming'

export type ListFastSettingTemplatesReq = {}
export type FastSettingTemplate = {
  key: string
  name: string
  description: string
  errorDescription: string
}
export type ListFastSettingTemplatesResp = {
  templates: FastSettingTemplate[]
}

export type GetFastSettingValueReq = {
  key: string
  inputPath: string
}
export type GetFastSettingValueResp = {
  pythonCmd: string
  comfyuiDir: string
  errorMessage?: string
}

export type GetExtraModelPathsReq = {}
export type GetExtraModelPathsResp = {
  checkpoints_dir?: string
  vae_dir?: string
  lora_dir?: string
  controlnet_dir?: string
}

export type StartComfyUIReq = {}
export type StartComfyUIResp = {
  pid: number // pid 为 0 代表还未启动
  command: string
  status: string
  logLine: string
}

export type ComfyPortDetectReq = {}
export type ComfyPortDetectResp = {
  pid: number // pid 为 0 代表未被占用
}

export type ListComfyFilesReq = {
  dir: string // 绝对路径或相对于 comfyui 的相对路径
  exts?: string[] // 文件扩展名，如 ['.safetensors', '.ckpt']
}
export type FileInfo = {
  name: string
  path?: string // 绝对路径
  size?: number // bytes
  lastModified?: number // ms
}
// 流式返回，一个响应代表一个文件或目录
export type ListComfyFilesResp = {
  file: FileInfo
}

// 浅层目录列表（非递归，只列一层）
export type ListDirShallowReq = {
  dir: string // 绝对路径
}
export type DirEntry = {
  name: string
  path: string // 绝对路径
  isDirectory: boolean
  size?: number // bytes (仅文件)
}
export type ListDirShallowResp = {
  entries: DirEntry[]
}

export type StartProcessReq = {
  name: string // 进程名称，用于标识进程
  command: string
  args: string[]
}
export type StartProcessResp = {
  pid: number // pid 为 0 代表还未启动
  name: string
  command: string
  status: string
  logLine: string
}

export type KillSubProcessReq = {
  pid: number
}
export type KillSubProcessResp = {}

export type ConnectSubProcessReq = {
  pid: number
}
export type ConnectSubProcessResp = {
  pid: number
  command: string
  status: string
  logLine: string
}

export type RunCommandSyncReq = {
  command: string
  args: string[]
}
export type RunCommandSyncResp = {
  stdOut: string
  stdErr: string
}

export type GetGPUInfoReq = {}
export type GetGPUInfoResp = {
  gpuInfo: string
}

export type EnvironmentDetectReq = {}
export type EnvironmentDetectResp = {
  pythonVersion?: string
  pytorchVersion?: string
  cudaVersion?: string
  gpuInfo?: string
}

export type SaveImageToDirReq = {
  data: Uint8Array // 图片二进制数据
  fileName: string // 文件名
  dir?: string // 目标目录，默认为桌面/AIEngine_Downloads
}
export type SaveImageToDirResp = {
  savedPath: string // 保存后的完整路径
}

export type MigrateLegacyAssistantImageReq = {
  fileName: string
}
export type MigrateLegacyAssistantImageResp = {
  savedPath: string
}

const validateMigrateLegacyAssistantImageReq = (value: unknown): MigrateLegacyAssistantImageReq => {
  const fileName =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).fileName === 'string'
      ? ((value as Record<string, unknown>).fileName as string)
      : ''
  if (/^agent_auto_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:_\d+)?\.png$/.test(fileName)) {
    return { fileName }
  }

  throw new ServiceValidationError('svcHyper.migrateLegacyAssistantImage fileName', [
    {
      path: ['fileName'],
      message: 'Expected a legacy assistant image basename',
      code: 'invalid_string'
    }
  ])
}

export type WriteImageToClipboardReq = {
  data: Uint8Array // 图片二进制数据
}
export type WriteImageToClipboardResp = {
  success: boolean
}

export type ReadClipboardTextReq = {}
export type ReadClipboardTextResp = {
  text: string
}

export type ReadClipboardHtmlReq = {}
export type ReadClipboardHtmlResp = {
  html: string
}

export type ReadClipboardImageReq = {}
export type ReadClipboardImageResp = {
  success: boolean
  data?: Uint8Array
  mimeType?: string
}

export type WriteSvgToClipboardReq = {
  svg: string
}
export type WriteSvgToClipboardResp = {
  success: boolean
}

/**
 * 超级服务
 *
 * 包含所有不应被任何人随意操作的服务（考虑到服务端部署的情况）。
 * 包含 ComfyUI 本地操作、进程管理等。
 *
 * 包含：
 * - 进程管理
 * - 本地 ComfyUI 相关操作
 * - 环境检测
 */
export type HyperSvc = {
  //////////////////////
  // 本地 ComfyUI 相关操作
  //////////////////////

  /**
   * 列出所有快速设置模板
   */
  listFastSettingTemplates(req: ListFastSettingTemplatesReq): Promise<ListFastSettingTemplatesResp>
  /**
   * 获得 ComfyUI 快速设置的结果值
   */
  getFastSettingValue(req: GetFastSettingValueReq): Promise<GetFastSettingValueResp>
  /**
   * 读取 ComfyUI 的 extra_model_paths.yaml 中的文件夹路径
   */
  getExtraModelPaths(req: GetExtraModelPathsReq): Promise<GetExtraModelPathsResp>

  /**
   * 启动 ComfyUI，流式返回子进程的日志信息
   */
  startComfyUI(req: StartComfyUIReq, resp: ServerStreaming<StartComfyUIResp>): Promise<void>
  /**
   * 检测 ComfyUI 端口是否已被占用
   */
  comfyPortDetect(req: ComfyPortDetectReq): Promise<ComfyPortDetectResp>
  /**
   * 列出 ComfyUI 文件夹下的文件
   */
  listComfyFiles(req: ListComfyFilesReq, resp: ServerStreaming<ListComfyFilesResp>): Promise<void>
  /**
   * 浅层列出目录内容（不递归，只列一层）
   */
  listDirShallow(req: ListDirShallowReq): Promise<ListDirShallowResp>

  //////////////////////
  // 进程管理
  //////////////////////

  /**
   * 启动进程，流式返回子进程的日志信息
   */
  startProcess(req: StartProcessReq, resp: ServerStreaming<StartProcessResp>): Promise<void>
  /**
   * 终止进程
   */
  killSubProcess(req: KillSubProcessReq): Promise<KillSubProcessResp>
  /**
   * 连接进程，流式返回子进程的日志信息
   */
  connectSubProcess(
    req: ConnectSubProcessReq,
    resp: ServerStreaming<ConnectSubProcessResp>
  ): Promise<void>
  /**
   * 同步执行命令, 能立即获得输出的快捷方式，不能用于长执行的命令
   */
  runCommandSync(req: RunCommandSyncReq): Promise<RunCommandSyncResp>
  /**
   * 获取 GPU 信息
   */
  getGPUInfo(req: GetGPUInfoReq): Promise<GetGPUInfoResp>
  /**
   * 检测环境
   */
  environmentDetect(
    req: EnvironmentDetectReq,
    resp: ServerStreaming<EnvironmentDetectResp>
  ): Promise<void>
  /**
   * 保存图片到指定目录（默认桌面/AIEngine_Downloads）
   */
  saveImageToDir(req: SaveImageToDirReq): Promise<SaveImageToDirResp>
  /**
   * Copies a narrowly validated legacy assistant PNG from the historical desktop export folder
   * into the app-owned media library.
   */
  migrateLegacyAssistantImage(
    req: MigrateLegacyAssistantImageReq
  ): Promise<MigrateLegacyAssistantImageResp>
  /**
   * 将图片写入系统剪贴板
   */
  writeImageToClipboard(req: WriteImageToClipboardReq): Promise<WriteImageToClipboardResp>
  readClipboardText(req: ReadClipboardTextReq): Promise<ReadClipboardTextResp>
  readClipboardHtml(req: ReadClipboardHtmlReq): Promise<ReadClipboardHtmlResp>
  readClipboardImage(req: ReadClipboardImageReq): Promise<ReadClipboardImageResp>
  writeSvgToClipboard(req: WriteSvgToClipboardReq): Promise<WriteSvgToClipboardResp>
}

export const hyperSvcDef: ServiceDefSheet<HyperSvc> = {
  listFastSettingTemplates: {
    type: 'unary'
  },
  getFastSettingValue: {
    type: 'unary'
  },
  getExtraModelPaths: {
    type: 'unary'
  },
  startComfyUI: {
    type: 'serverStreaming'
  },
  comfyPortDetect: {
    type: 'unary'
  },
  listComfyFiles: {
    type: 'serverStreaming'
  },
  listDirShallow: {
    type: 'unary'
  },
  startProcess: {
    type: 'serverStreaming'
  },
  killSubProcess: {
    type: 'unary'
  },
  connectSubProcess: {
    type: 'serverStreaming'
  },
  runCommandSync: {
    type: 'unary'
  },
  getGPUInfo: {
    type: 'unary'
  },
  environmentDetect: {
    type: 'serverStreaming'
  },
  saveImageToDir: {
    type: 'unary'
  },
  migrateLegacyAssistantImage: {
    type: 'unary',
    request: validateMigrateLegacyAssistantImageReq
  },
  writeImageToClipboard: {
    type: 'unary'
  },
  readClipboardText: {
    type: 'unary'
  },
  readClipboardHtml: {
    type: 'unary'
  },
  readClipboardImage: {
    type: 'unary'
  },
  writeSvgToClipboard: {
    type: 'unary'
  }
}
