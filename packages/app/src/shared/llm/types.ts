import type { OCRResult } from '@shared/api/svcLLMProxy'
import type { ReportBundleRole } from '@shared/reportBundle'
import type { LLMReasoningEffort } from './profileCapabilities'

/**
 * Shared LLM types used by both main process and renderer process.
 */

/** Attachment in a chat message (image, video, 3D model, generic file, etc.) */
export interface ChatAttachment {
  type: 'image' | 'video' | 'model3d' | 'file'
  url: string
  mimeType?: string
  fileName?: string
  relativePath?: string
  hiddenFromChatView?: boolean
  metadata?: Record<string, unknown>
  sizeBytes?: number
  sourceWidth?: number
  sourceHeight?: number
  ocrResult?: OCRResult
  reportBundleId?: string
  reportBundleRole?: ReportBundleRole
  reportBundleRefName?: string
  reportBundleManifestUrl?: string
  reportBundleLabel?: string
}

/** A single chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  hiddenContext?: string
  preferredDownloadBaseName?: string
  modelName?: string
}

/** Parameters for prompt generation (renderer-only feature) */
export interface GeneratePromptParams {
  prompt: string
  systemPrompt?: string
  imageObjUrl?: string
}

export type LLMChatFinishReason = 'stop' | 'length' | 'tool_call' | 'cancelled' | 'error'

export type LLMChatMetadata = Record<string, unknown>

export interface LLMChatResult {
  content: string
  imageUrl?: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  finishReason?: LLMChatFinishReason
  metadata?: LLMChatMetadata
}

export interface LLMDeltaEvent {
  type: 'text-delta' | 'attachment' | 'session' | 'done' | 'error'
  delta?: string
  attachment?: ChatAttachment
  sessionUrl?: string
  content?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  finishReason?: LLMChatFinishReason
  error?: string
  metadata?: LLMChatMetadata
}

export type OpenAIImageGenerationAction = 'auto' | 'generate' | 'edit'
export type OpenAIImageGenerationBackground = 'auto' | 'opaque' | 'transparent'
export type OpenAIImageGenerationOutputFormat = 'png' | 'webp' | 'jpeg'
export type OpenAIImageGenerationQuality = 'auto' | 'low' | 'medium' | 'high'

export interface OpenAIImageGenerationOptions {
  action?: OpenAIImageGenerationAction
  background?: OpenAIImageGenerationBackground
  enabled?: boolean
  outputFormat?: OpenAIImageGenerationOutputFormat
  quality?: OpenAIImageGenerationQuality
  size?: string
}

export type VideoGenerationJsonPrimitive = string | number | boolean | null
export type VideoGenerationJsonValue =
  | VideoGenerationJsonPrimitive
  | VideoGenerationJsonValue[]
  | { [key: string]: VideoGenerationJsonValue }
export type VideoGenerationJsonObject = { [key: string]: VideoGenerationJsonValue }

export type VideoGenerationMode = 'std' | 'pro' | '4k'
export type VideoGenerationSound = 'on' | 'off'
export type VideoGenerationDurationMode = 'fixed' | 'adaptive'
export type VideoGenerationCameraPreset =
  | 'none'
  | 'down_back'
  | 'forward_up'
  | 'right_turn_forward'
  | 'left_turn_forward'
export type VideoGenerationCameraControlType = 'simple' | VideoGenerationCameraPreset
export interface VideoGenerationCameraSimpleControls {
  horizontal?: number
  vertical?: number
  pan?: number
  tilt?: number
  roll?: number
  zoom?: number
}
export interface VideoGenerationCameraControl {
  type: VideoGenerationCameraControlType
  config?: VideoGenerationCameraSimpleControls
}
export type VideoGenerationImageReferenceRole = 'first_frame' | 'last_frame' | 'reference_image'
export type VideoGenerationVideoReferenceRole =
  | 'video'
  | 'source_video'
  | 'reference_video'
  | 'video_reference'
export type VideoGenerationAudioReferenceRole =
  | 'audio'
  | 'source_audio'
  | 'reference_audio'
  | 'audio_reference'
  | 'voiceover'
  | 'music'
export type VideoGenerationReferenceRole =
  | VideoGenerationImageReferenceRole
  | VideoGenerationVideoReferenceRole
  | VideoGenerationAudioReferenceRole
export interface VideoGenerationReferenceRoles {
  image?: VideoGenerationImageReferenceRole | VideoGenerationImageReferenceRole[]
  video?: VideoGenerationVideoReferenceRole | VideoGenerationVideoReferenceRole[]
  audio?: VideoGenerationAudioReferenceRole | VideoGenerationAudioReferenceRole[]
}

export interface VideoGenerationOptions {
  aspectRatio?: string
  duration?: number
  durationMode?: VideoGenerationDurationMode
  negativePrompt?: string
  cfgScale?: number
  mode?: VideoGenerationMode
  sound?: VideoGenerationSound
  watermark?: boolean
  callbackUrl?: string
  externalTaskId?: string
  advancedJson?: string | VideoGenerationJsonObject
  requestOverride?: VideoGenerationJsonObject
  cameraPreset?: VideoGenerationCameraPreset
  cameraControl?: VideoGenerationCameraControl
  cameraSimpleControls?: VideoGenerationCameraSimpleControls
  resolution?: string
  frames?: number
  generateAudio?: boolean
  returnLastFrame?: boolean
  referenceRole?: VideoGenerationReferenceRole
  referenceRoles?: VideoGenerationReferenceRoles
  videoReferenceRole?: VideoGenerationVideoReferenceRole
  audioReferenceRole?: VideoGenerationAudioReferenceRole
}

export interface LLMChatParams {
  messages: ChatMessage[]
  systemPrompt?: string
  reasoningEffort?: LLMReasoningEffort
  imageGenerationOptions?: OpenAIImageGenerationOptions
  videoGenerationOptions?: VideoGenerationOptions
  signal?: AbortSignal
  sessionUrl?: string
  conversationId?: string
  onDelta?: (event: LLMDeltaEvent) => void
}

const LLM_CHAT_FINISH_REASONS = new Set<LLMChatFinishReason>([
  'stop',
  'length',
  'tool_call',
  'cancelled',
  'error'
])

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isImageUrlContent = (value: string): boolean => {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  try {
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false
    }

    const pathname = parsed.pathname.toLowerCase()
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].some((extension) =>
      pathname.includes(extension)
    )
  } catch {
    return false
  }
}

export const parseStructuredLLMChatResult = (content: string): LLMChatResult | null => {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isPlainRecord(parsed)) {
      return null
    }

    const hasKnownShape =
      typeof parsed.content === 'string' ||
      typeof parsed.imageUrl === 'string' ||
      typeof parsed.sessionUrl === 'string' ||
      Array.isArray(parsed.attachments) ||
      isPlainRecord(parsed.ocrResult) ||
      typeof parsed.finishReason === 'string' ||
      isPlainRecord(parsed.metadata)

    if (!hasKnownShape) {
      return null
    }

    return {
      content: typeof parsed.content === 'string' ? parsed.content : '',
      ...(typeof parsed.imageUrl === 'string' ? { imageUrl: parsed.imageUrl } : {}),
      ...(typeof parsed.sessionUrl === 'string' ? { sessionUrl: parsed.sessionUrl } : {}),
      ...(Array.isArray(parsed.attachments)
        ? { attachments: parsed.attachments as ChatAttachment[] }
        : {}),
      ...(isPlainRecord(parsed.ocrResult) ? { ocrResult: parsed.ocrResult as OCRResult } : {}),
      ...(typeof parsed.finishReason === 'string' &&
      LLM_CHAT_FINISH_REASONS.has(parsed.finishReason as LLMChatFinishReason)
        ? { finishReason: parsed.finishReason as LLMChatFinishReason }
        : {}),
      ...(isPlainRecord(parsed.metadata) ? { metadata: parsed.metadata as LLMChatMetadata } : {})
    }
  } catch {
    return null
  }
}

export const normalizeLLMChatResult = (value: string | LLMChatResult): LLMChatResult => {
  if (typeof value !== 'string') {
    return {
      content: typeof value.content === 'string' ? value.content : '',
      ...(typeof value.imageUrl === 'string' ? { imageUrl: value.imageUrl } : {}),
      ...(typeof value.sessionUrl === 'string' ? { sessionUrl: value.sessionUrl } : {}),
      ...(Array.isArray(value.attachments) ? { attachments: value.attachments } : {}),
      ...(value.ocrResult ? { ocrResult: value.ocrResult } : {}),
      ...(value.finishReason ? { finishReason: value.finishReason } : {}),
      ...(value.metadata ? { metadata: value.metadata } : {})
    }
  }

  const structured = parseStructuredLLMChatResult(value)
  if (structured) {
    return structured
  }

  if (isImageUrlContent(value)) {
    return {
      content: '',
      imageUrl: value.trim()
    }
  }

  return {
    content: value
  }
}

/** Common LLM client interface chat only (shared) */
export interface LLMCli {
  chat(params: LLMChatParams): Promise<LLMChatResult>
}

/** Extended LLM client interface with generatePrompt (renderer-only) */
export interface LLMCliWithPrompt extends LLMCli {
  generatePrompt(params: GeneratePromptParams): Promise<string>
}
