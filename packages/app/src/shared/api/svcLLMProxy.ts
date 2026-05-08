// LLM 代理服务 API 定义
// 用于 AIEngine 实例之间的 LLM 请求转发

import { ServerStreaming } from './apiUtils/streaming'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import type { AgentRouteLike } from '@shared/agent'
import {
  LLMDeployment,
  LLMModelUse,
  TaggerProviderOption,
  TaggerRuntimeCacheScopeOption
} from '@shared/config/config'
import type { OpenAIImageGenerationOptions } from '@shared/llm/types'
import type { LLMReasoningEffort } from '@shared/llm/profileCapabilities'
import type { ReportBundleRole } from '@shared/reportBundle'

// ==================== 聊天相关类型 ====================

export type ChatAttachment = {
  type: 'image' | 'video' | 'model3d' | 'file'
  url: string // data URL 或 base64
  mimeType?: string
  fileName?: string
  relativePath?: string
  hiddenFromChatView?: boolean
  sizeBytes?: number
  sourceWidth?: number
  sourceHeight?: number
  ocrResult?: OCRResult
  finishReason?: 'stop' | 'length' | 'tool_call' | 'cancelled' | 'error'
  metadata?: Record<string, unknown>
  reportBundleId?: string
  reportBundleRole?: ReportBundleRole
  reportBundleRefName?: string
  reportBundleManifestUrl?: string
  reportBundleLabel?: string
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  hiddenContext?: string
  /** 生成此消息的模型名称（仅 assistant 消息，用于 UI 显示） */
  preferredDownloadBaseName?: string
  modelName?: string
}

export type OCRBoundingBox = {
  id?: string
  x: number
  y: number
  width: number
  height: number
  page?: number
  label?: string
  confidence?: number
}

export type OCRTableCell = {
  id: string
  row: number
  col: number
  text: string
  confidence?: number
  bboxIds?: string[]
}

export type OCRTableSheet = {
  id: string
  name: string
  rows: number
  cols: number
  cells: OCRTableCell[]
}

export type OCRResult = {
  kind: 'text' | 'table' | 'document'
  text?: string
  sourceImageUrl?: string
  boxes?: OCRBoundingBox[]
  sheets?: OCRTableSheet[]
}

export type LLMChatSkillRuntimeBinding = {
  appId: string
  appName?: string
  transport?: string
  source?: string
  toolNames?: string[]
  resourceUris?: string[]
}

export type LLMChatSkillRuntime = {
  skillId?: string
  instructions?: {
    systemPrompt?: string
    userPrompt?: string
  }
  execution?: {
    mode?: string
    allowHistory?: boolean
    outputMode?: string
    fallbackStrategy?: string
    persistSessionUrl?: boolean
    contextMessageLimit?: number | 'all'
  }
  resources?: string[]
  scripts?: string[]
  bindings?: LLMChatSkillRuntimeBinding[]
  outputSchema?: Record<string, unknown>
}

export type LLMProfileScope = 'agent' | 'qapp'

// ==================== 请求/响应类型 ====================

/**
 * 聊天请求
 */
export type LLMChatReq = {
  messages: ChatMessage[]
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  imageGenerationOptions?: OpenAIImageGenerationOptions
  skillRuntime?: LLMChatSkillRuntime
  route?: AgentRouteLike
  /** 指定使用的模型配置 ID，如果不指定则使用服务端默认配置 */
  profileId?: string
  profileScope?: LLMProfileScope
  /** 会话续传 URL（可选） */
  sessionUrl?: string
  /** 前端会话ID，用于稳定地映射后端 Playwright 窗口（可选） */
  conversationId?: string
  /** 是否是编辑已有提示词 */
  isEdit?: boolean
  /** 是否由重试/重新生成触发 */
  isRegenerate?: boolean
}

export type LLMChatResp = {
  content: string
  /** 如果返回的是图片 URL */
  imageUrl?: string
  /** 会话续传 URL */
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  finishReason?: 'stop' | 'length' | 'tool_call' | 'cancelled' | 'error'
  metadata?: Record<string, unknown>
}

export type LLMChatOptions = {
  signal?: AbortSignal
}

/**
 * 流式聊天请求（用于实时显示生成内容）
 */
export type LLMChatStreamReq = LLMChatReq

export type LLMChatStreamResp = {
  type: 'text-delta' | 'attachment' | 'session' | 'done' | 'error'
  /** 增量内容 */
  delta: string
  /** 是否完成 */
  done: boolean
  /** 完整内容（仅在 done=true 时有值） */
  fullContent?: string
  content?: string
  imageUrl?: string
  attachment?: ChatAttachment
  attachments?: ChatAttachment[]
  sessionUrl?: string
  ocrResult?: OCRResult
  finishReason?: 'stop' | 'length' | 'tool_call' | 'cancelled' | 'error'
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * 获取可用的模型配置列表
 */
export type LLMListProfilesReq = {}

export type LLMListProfilesResp = {
  profiles: Array<{
    id: string
    model_name: string
    deployment?: LLMDeployment
    model_use?: LLMModelUse
    is_vision_model?: boolean
    is_ocr_model?: boolean
    tagger_provider?: TaggerProviderOption
    tagger_endpoint?: string
    tagger_runtime_cache_scope?: TaggerRuntimeCacheScopeOption
    tagger_runtime_key?: string
  }>
}

/**
 * 服务器状态检查
 */
export type LLMServerStatusReq = {}

export type LLMServerStatusResp = {
  online: boolean
  version: string
  availableProfiles: number
}

/**
 * 远程 HTTP 请求代理（通过 main 进程的 net.fetch 发起，正确处理系统代理和 SSL）
 */
export type LLMRemoteFetchReq = {
  url: string
  method: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
  conversationId?: string
}

export type LLMRemoteFetchResp = {
  status: number
  statusText: string
  body: string
}

export type LLMCancelConversationReq = {
  conversationId: string
}

export type LLMCancelConversationResp = {
  cancelled: boolean
}

export type LLMUploadHy3DModelReq = {
  filePath?: string
  fileName?: string
  fileDataBase64?: string
}

export type LLMUploadHy3DModelResp = {
  url: string
  key: string
  bucket: string
  region: string
  fileName: string
  expiresAt: string
}

export type LLMSignHy3DModelReq = {
  key: string
  bucket: string
  region: string
}

export type LLMSignHy3DModelResp = {
  url: string
  expiresAt: string
}

export type LLMClearHy3DCosPrefixReq = {
  profileId?: string
}

export type LLMClearHy3DCosPrefixResp = {
  bucket: string
  region: string
  keyPrefix: string
  matchedCount: number
  deletedCount: number
  errorCount: number
}

// ==================== 服务定义 ====================

/**
 * LLM 代理服务
 *
 * 用于在 AIEngine 实例之间转发 LLM 请求
 * - 服务端：配置了 API Key，可以调用三大家 API
 * - 客户端：通过服务端转发请求，不需要本地配置 API Key
 */
export type LLMProxySvc = {
  /**
   * 发送聊天请求（非流式）
   */
  chat(req: LLMChatReq, options?: LLMChatOptions): Promise<LLMChatResp>

  /**
   * 发送聊天请求（流式）
   */
  chatStream(req: LLMChatStreamReq, resp: ServerStreaming<LLMChatStreamResp>): Promise<void>

  /**
   * 获取可用的模型配置列表
   */
  listProfiles(req: LLMListProfilesReq): Promise<LLMListProfilesResp>

  /**
   * 检查服务器状态
   */
  serverStatus(req: LLMServerStatusReq): Promise<LLMServerStatusResp>

  /**
   * 远程 HTTP 请求代理（通过 main 进程发起，解决 renderer 跨域/SSL 问题）
   */
  remoteFetch(req: LLMRemoteFetchReq): Promise<LLMRemoteFetchResp>

  cancelConversation(req: LLMCancelConversationReq): Promise<LLMCancelConversationResp>

  uploadHy3DModel(req: LLMUploadHy3DModelReq): Promise<LLMUploadHy3DModelResp>

  signHy3DModel(req: LLMSignHy3DModelReq): Promise<LLMSignHy3DModelResp>

  clearHy3DCosPrefix(req: LLMClearHy3DCosPrefixReq): Promise<LLMClearHy3DCosPrefixResp>
}

export const llmProxySvcDef: ServiceDefSheet<LLMProxySvc> = {
  chat: {
    type: 'unary'
  },
  chatStream: {
    type: 'serverStreaming'
  },
  listProfiles: {
    type: 'unary'
  },
  serverStatus: {
    type: 'unary'
  },
  remoteFetch: {
    type: 'unary'
  },
  cancelConversation: {
    type: 'unary'
  },
  uploadHy3DModel: {
    type: 'unary'
  },
  signHy3DModel: {
    type: 'unary'
  },
  clearHy3DCosPrefix: {
    type: 'unary'
  }
}
