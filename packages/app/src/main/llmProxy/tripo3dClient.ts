import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'

const DEFAULT_TRIPO_BASE_URL = 'https://api.tripo3d.ai/v2/openapi'
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000
const TRIPO_SUCCESS_STATUSES = new Set(['success'])
const TRIPO_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'banned', 'expired'])
const TRIPO_PENDING_STATUSES = new Set(['queued', 'running', 'pending', 'processing', 'unknown'])
const TRIPO_MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.stl', '.usdz', '.3mf'])
const TRIPO_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const TRIPO_UPLOAD_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const TRIPO_MULTIVIEW_ORDER = ['front', 'left', 'back', 'right'] as const
const TRIPO_CONVERT_FORMATS = new Set(['GLTF', 'USDZ', 'FBX', 'OBJ', 'STL', '3MF'])
const DEFAULT_TRIPO_ANIMATION = 'preset:walk'

type FetchImpl = typeof fetch
type TripoImageType = 'jpg' | 'png' | 'webp'
type TripoMultiviewName = (typeof TRIPO_MULTIVIEW_ORDER)[number]

export type Tripo3DGenerateOptions = {
  Model?: string
  GenerateType?: string
  FaceCount?: number
  TargetFormat?: string
  FaceLevel?: string
  PolygonType?: string
  EnablePBR?: boolean
  ProfileTemplate?: string
  SourceFileName?: string
  OriginalTaskId?: string
  ImageModelVersion?: string
  ImageTemplate?: string
  EditView?: string
  Animation?: string
  RigType?: string
  RigSpec?: string
}

type Tripo3DClientOptions = {
  fetchImpl?: FetchImpl
  pollIntervalMs?: number
  pollTimeoutMs?: number
  signal?: AbortSignal
}

type TripoApiResponse<TData> = {
  code?: number | string
  message?: string
  suggestion?: string
  data?: TData
}

type TripoTaskOutput = Record<string, unknown>

type TripoTask = {
  task_id?: string
  type?: string
  status?: string
  output?: TripoTaskOutput
  progress?: number
  error_code?: number | string
  error_msg?: string
}

type TripoResultArtifact = {
  kind: 'model3d' | 'image' | 'file'
  label: string
  url: string
}

type PreparedImageUpload = {
  buffer: Buffer
  fileName: string
  mimeType: string
  imageType: TripoImageType
}

type ExtractedModelInput = {
  rawContent: string
  modelUrl: string
  prompt: string
}

const createAbortError = (signal?: AbortSignal): Error => {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error('The request was aborted.')
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError(signal)
  }
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    try {
      throwIfAborted(signal)
    } catch (error) {
      reject(error)
      return
    }

    if (ms <= 0) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)
    const handleAbort = () => {
      clearTimeout(timer)
      reject(createAbortError(signal))
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
  })

const normalizeTripoStudioUrl = (baseUrl: string): string => {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.hostname === 'studio.tripo3d.ai') return 'https://api.tripo3d.ai'
    if (parsed.hostname === 'studio.tripo3d.com') return 'https://api.tripo3d.com'
  } catch {
    return baseUrl
  }
  return baseUrl
}

const normalizeTripoBaseUrl = (baseUrl?: string): string => {
  const normalized = normalizeTripoStudioUrl(String(baseUrl || DEFAULT_TRIPO_BASE_URL))
    .trim()
    .replace(/\/+$/, '')

  if (!normalized) return DEFAULT_TRIPO_BASE_URL
  if (/\/v2\/openapi$/i.test(normalized)) return normalized
  if (/\/v2$/i.test(normalized)) return `${normalized}/openapi`
  return `${normalized}/v2/openapi`
}

const normalizeMimeType = (value?: string): string =>
  String(value || '')
    .split(';')[0]
    .replace(/^data:/i, '')
    .trim()
    .toLowerCase()

const inferImageTypeFromMimeType = (value?: string): TripoImageType | '' => {
  const mimeType = normalizeMimeType(value)
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg'
  return ''
}

const inferImageTypeFromName = (value?: string): TripoImageType | '' => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized.endsWith('.png')) return 'png'
  if (normalized.endsWith('.webp')) return 'webp'
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'jpg'
  return ''
}

const inferImageTypeFromBuffer = (buffer: Buffer): TripoImageType | '' => {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png'
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    return 'webp'
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg'
  }

  return ''
}

const mimeTypeFromImageType = (imageType: TripoImageType): string => {
  if (imageType === 'png') return 'image/png'
  if (imageType === 'webp') return 'image/webp'
  return 'image/jpeg'
}

const parseDataUrl = (url: string): { buffer: Buffer; mimeType: string } => {
  const commaIndex = url.indexOf(',')
  if (commaIndex < 0) {
    throw new Error('[Tripo3D] Invalid data URL image.')
  }

  const metadata = url.slice(5, commaIndex)
  const payload = url.slice(commaIndex + 1).replace(/\s+/g, '')
  const isBase64 = /;base64/i.test(metadata)
  return {
    buffer: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload)),
    mimeType: normalizeMimeType(metadata)
  }
}

const normalizeLocalPath = (url: string): string => {
  if (url.startsWith('local-media:///')) {
    return decodeURIComponent(url.replace('local-media:///', ''))
  }
  if (url.startsWith('file://')) {
    return fileURLToPath(url)
  }
  return url
}

const isRemoteHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value)

const isLocalFileSource = (value: string): boolean =>
  value.startsWith('local-media:///') ||
  value.startsWith('file://') ||
  /^[A-Za-z]:[\\/]/.test(value)

const isImageAttachment = (attachment: ChatAttachment): boolean => {
  if (!attachment?.url) return false
  if (attachment.type === 'image' || /^data:image\//i.test(attachment.url)) return true
  if (normalizeMimeType(attachment.mimeType).startsWith('image/')) return true
  return /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(attachment.url)
}

const getLastUserMessage = (messages: ChatMessage[]): ChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index]
  }
  return undefined
}

const extractPrompt = (messages: ChatMessage[]): string => {
  const lastUser = getLastUserMessage(messages)
  return String(lastUser?.content || '').trim()
}

const getImageAttachments = (messages: ChatMessage[]): ChatAttachment[] =>
  getLastUserMessage(messages)?.attachments?.filter(isImageAttachment) || []

const normalizeTripoModelVersion = (value?: string): string => {
  const normalized = String(value || '').trim()
  const lower = normalized.toLowerCase()
  if (!normalized) return 'v3.1-20260211'
  if (/^p1/i.test(normalized)) return 'P1-20260311'
  if (lower.includes('turbo')) return 'Turbo-v1.0-20250506'
  if (/^v?3\.1/.test(lower)) return 'v3.1-20260211'
  if (/^v?3\.0/.test(lower)) return 'v3.0-20250812'
  if (/^v?2\.5/.test(lower)) return 'v2.5-20250123'
  if (/^v?2\.0/.test(lower)) return 'v2.0-20240919'
  if (/^v?1\.4/.test(lower)) return 'v1.4-20240625'
  return normalized
}

const normalizeTripoTextureVersion = (value?: string): string => {
  const normalized = normalizeTripoModelVersion(value)
  return normalized === 'v2.5-20250123' ? normalized : 'v3.0-20250812'
}

const normalizeImageModelVersion = (value?: string): string => {
  const normalized = String(value || '').trim()
  return normalized || 'flux.1_kontext_pro'
}

const buildTripoTaskOptions = (options: Tripo3DGenerateOptions): Record<string, unknown> => {
  const generateType = String(options.GenerateType || 'Normal')
  const taskOptions: Record<string, unknown> = {
    model_version: normalizeTripoModelVersion(options.Model),
    texture: generateType !== 'Geometry',
    pbr: !!options.EnablePBR
  }

  if (Number.isFinite(options.FaceCount) && Number(options.FaceCount) > 0) {
    taskOptions.face_limit = Number(options.FaceCount)
  }
  if (generateType === 'LowPoly') {
    taskOptions.smart_low_poly = true
  }
  if (options.PolygonType === 'quadrilateral') {
    taskOptions.quad = true
  }

  return taskOptions
}

const getFaceLimitFromOptions = (options: Tripo3DGenerateOptions): number => {
  if (Number.isFinite(options.FaceCount) && Number(options.FaceCount) > 0) {
    return Number(options.FaceCount)
  }

  switch (String(options.FaceLevel || '').toLowerCase()) {
    case 'high':
      return 50000
    case 'medium':
      return 15000
    case 'low':
    default:
      return 3000
  }
}

const extractStringUrl = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  for (const key of ['url', 'download_url', 'file_url', 'uri']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return ''
}

const getUrlPathExtension = (url: string): string => {
  try {
    return path.extname(new URL(url).pathname.toLowerCase())
  } catch {
    return path.extname(url.toLowerCase().split(/[?#]/)[0])
  }
}

const inferArtifactKind = (url: string): TripoResultArtifact['kind'] => {
  const extension = getUrlPathExtension(url)
  if (TRIPO_IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (TRIPO_MODEL_EXTENSIONS.has(extension)) return 'model3d'
  return 'file'
}

const pushArtifact = (
  artifacts: TripoResultArtifact[],
  seenUrls: Set<string>,
  label: string,
  value: unknown
): void => {
  const url = extractStringUrl(value)
  if (!url || seenUrls.has(url)) return

  seenUrls.add(url)
  const kind = inferArtifactKind(url)
  artifacts.push({
    kind,
    label: kind === 'model3d' ? 'Generated 3D Model' : label,
    url
  })
}

const collectNestedArtifacts = (
  artifacts: TripoResultArtifact[],
  seenUrls: Set<string>,
  value: unknown,
  labelHint = 'Generated File'
): void => {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      pushArtifact(artifacts, seenUrls, labelHint, value)
    }
    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectNestedArtifacts(artifacts, seenUrls, item, labelHint))
    return
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/_/g, ' ')
    const label =
      /image|view|preview|render/i.test(key) && !/model/i.test(key)
        ? `Generated ${normalizedKey}`
        : /model|rig|animation|mesh|file/i.test(key)
          ? 'Generated 3D Model'
          : labelHint
    collectNestedArtifacts(artifacts, seenUrls, nestedValue, label)
  }
}

const extractTaskArtifacts = (task: TripoTask): TripoResultArtifact[] => {
  const output = task.output || {}
  const artifacts: TripoResultArtifact[] = []
  const seenUrls = new Set<string>()

  pushArtifact(artifacts, seenUrls, 'Generated 3D Model', output.pbr_model)
  pushArtifact(artifacts, seenUrls, 'Generated 3D Model', output.model)
  pushArtifact(artifacts, seenUrls, 'Generated Base Model', output.base_model)
  pushArtifact(artifacts, seenUrls, 'Generated Preview', output.rendered_image)
  pushArtifact(artifacts, seenUrls, 'Generated Image', output.generated_image)
  pushArtifact(artifacts, seenUrls, 'Generated Image', output.image)

  const multiview = output.generate_multiview_image
  if (multiview && typeof multiview === 'object') {
    const viewOutput = multiview as Record<string, unknown>
    pushArtifact(artifacts, seenUrls, 'Generated front view', viewOutput.front_view_url)
    pushArtifact(artifacts, seenUrls, 'Generated left view', viewOutput.left_view_url)
    pushArtifact(artifacts, seenUrls, 'Generated back view', viewOutput.back_view_url)
    pushArtifact(artifacts, seenUrls, 'Generated right view', viewOutput.right_view_url)
  }

  collectNestedArtifacts(artifacts, seenUrls, output)
  return artifacts
}

const formatResultArtifact = (artifact: TripoResultArtifact): string => {
  if (artifact.kind === 'image') {
    return `![${artifact.label}](${artifact.url})`
  }
  return `[${artifact.label}](${artifact.url})`
}

const formatTaskResult = (task: TripoTask): string => {
  const artifacts = extractTaskArtifacts(task)
  const resultLines = artifacts.map(formatResultArtifact)

  if (task.task_id) {
    resultLines.push('', `[Tripo3D] Task ID: ${task.task_id}`)
  }

  if (resultLines.length > (task.task_id ? 2 : 0)) {
    return resultLines.join('\n')
  }

  const output = task.output || {}
  if (Object.keys(output).length > 0) {
    resultLines.push('', '```json', JSON.stringify(output, null, 2), '```')
  }

  if (resultLines.length === 0) {
    throw new Error('[Tripo3D] Task completed, but no downloadable result was returned.')
  }
  return resultLines.join('\n').trim()
}

const extractExplicitTaskIdFromText = (value: string): string => {
  const text = String(value || '')
  const explicitMatch =
    text.match(/\[Tripo3D\]\s*Task ID:\s*([A-Za-z0-9_-]+)/i) ||
    text.match(/(?:tripo[-_\s]?task(?:\s*id)?|task_id)\s*[:=]\s*([A-Za-z0-9_-]+)/i)
  if (explicitMatch?.[1]) return explicitMatch[1].trim()

  const bareLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[A-Za-z0-9_-]{6,}$/.test(line))
  return bareLine || ''
}

const extractFirstUrl = (value: string): string => {
  const markdownMatch = value.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/i)
  if (markdownMatch?.[1]) return markdownMatch[1].trim()
  return value.match(/https?:\/\/[^\s)]+/i)?.[0]?.trim() || ''
}

const extractModelInput = (messages: ChatMessage[]): ExtractedModelInput => {
  const rawContent = extractPrompt(messages)
  const lines = rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const modelUrl = extractFirstUrl(rawContent)

  if (!modelUrl) {
    return {
      rawContent,
      modelUrl: lines[0] || '',
      prompt: lines.slice(1).join('\n').trim()
    }
  }

  const prompt = lines
    .filter((line) => !line.includes(modelUrl) && !extractFirstUrl(line))
    .join('\n')
    .trim()

  return { rawContent, modelUrl, prompt }
}

const normalizeTripoView = (value?: string): TripoMultiviewName => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return TRIPO_MULTIVIEW_ORDER.includes(normalized as TripoMultiviewName)
    ? (normalized as TripoMultiviewName)
    : 'front'
}

const inferTripoViewName = (attachment: ChatAttachment): TripoMultiviewName | '' => {
  const candidate = `${attachment.fileName || ''} ${attachment.url || ''}`.toLowerCase()
  if (/(^|[^a-z0-9])front([^a-z0-9]|$)/.test(candidate)) return 'front'
  if (/(^|[^a-z0-9])left([^a-z0-9]|$)/.test(candidate)) return 'left'
  if (/(^|[^a-z0-9])back([^a-z0-9]|$)/.test(candidate)) return 'back'
  if (/(^|[^a-z0-9])right([^a-z0-9]|$)/.test(candidate)) return 'right'
  return ''
}

const parseModelFileToken = (value: string): string => {
  const normalized = String(value || '').trim()
  return (
    normalized.match(/^tripo-file-token:([A-Za-z0-9_-]+)/i)?.[1] ||
    normalized.match(/^file_token[:=]\s*([A-Za-z0-9_-]+)/i)?.[1] ||
    ''
  )
}

export class Tripo3DClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchImpl
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number
  private readonly signal?: AbortSignal

  constructor(apiKey: string, baseUrl?: string, options: Tripo3DClientOptions = {}) {
    this.apiKey = apiKey.trim()
    this.baseUrl = normalizeTripoBaseUrl(baseUrl)
    this.fetchImpl = options.fetchImpl || fetch
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    this.signal = options.signal
  }

  async generateFromMessages(
    messages: ChatMessage[],
    mode: string,
    options: Tripo3DGenerateOptions = {}
  ): Promise<string> {
    throwIfAborted(this.signal)

    if (!this.apiKey) {
      throw new Error('[Tripo3D] Missing API key. Configure a Tripo Quick App API profile first.')
    }

    const prompt = extractPrompt(messages)
    const imageAttachments = getImageAttachments(messages)
    const taskData = await this.buildTaskData(mode, prompt, imageAttachments, messages, options)
    const taskId = await this.createTask(taskData)
    const task = await this.waitForTask(taskId)
    return formatTaskResult(task)
  }

  private async buildTaskData(
    mode: string,
    prompt: string,
    imageAttachments: ChatAttachment[],
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Promise<Record<string, unknown>> {
    switch (mode) {
      case 'SubmitHunyuanTo3DProJob':
      case 'SubmitHunyuanTo3DRapidJob':
        return this.buildGenerationTaskData(prompt, imageAttachments, options)
      case 'TripoTextToImage':
        return this.buildTextToImageTaskData(prompt)
      case 'TripoGenerateImage':
        return this.buildGenerateImageTaskData(prompt, imageAttachments, options)
      case 'TripoGenerateMultiviewImage':
        return this.buildGenerateMultiviewImageTaskData(imageAttachments)
      case 'TripoEditMultiviewImage':
        return this.buildEditMultiviewImageTaskData(prompt, messages, options)
      case 'TripoImportModel':
        return this.buildImportModelTaskData(messages)
      case 'SubmitTextureTo3DJob':
        return this.buildTextureModelTaskData(messages, imageAttachments, options)
      case 'SubmitHunyuan3DPartJob':
        return this.buildMeshSegmentationTaskData(messages, options)
      case 'TripoMeshCompletion':
        return this.buildMeshCompletionTaskData(messages, options)
      case 'SubmitReduceFaceJob':
        return this.buildLowPolyTaskData(messages, options)
      case 'TripoPreRigCheck':
        return this.buildPreRigCheckTaskData(messages, options)
      case 'TripoRig':
        return this.buildRigTaskData(messages, options)
      case 'TripoRetarget':
        return this.buildRetargetTaskData(messages, options)
      case 'Convert3DFormat':
        return this.buildConvertModelTaskData(messages, options)
      default:
        throw new Error(`[Tripo3D] Unsupported Tripo workflow: ${mode}`)
    }
  }

  private async buildGenerationTaskData(
    prompt: string,
    imageAttachments: ChatAttachment[],
    options: Tripo3DGenerateOptions
  ): Promise<Record<string, unknown>> {
    const taskOptions = buildTripoTaskOptions(options)

    if (imageAttachments.length > 1) {
      const files = await this.buildTripoMultiviewFiles(imageAttachments)
      return {
        type: 'multiview_to_model',
        files,
        ...taskOptions
      }
    }

    if (imageAttachments.length === 1) {
      return {
        type: 'image_to_model',
        file: await this.buildImageFileContent(imageAttachments[0]),
        ...taskOptions
      }
    }

    if (!prompt) {
      throw new Error('[Tripo3D] Enter a prompt or attach at least one reference image.')
    }

    return {
      type: 'text_to_model',
      prompt,
      ...taskOptions
    }
  }

  private buildTextToImageTaskData(prompt: string): Record<string, unknown> {
    if (!prompt) {
      throw new Error('[Tripo3D] Text-to-image requires a prompt.')
    }

    return {
      type: 'text_to_image',
      prompt
    }
  }

  private async buildGenerateImageTaskData(
    prompt: string,
    imageAttachments: ChatAttachment[],
    options: Tripo3DGenerateOptions
  ): Promise<Record<string, unknown>> {
    if (!prompt) {
      throw new Error('[Tripo3D] Advanced image generation requires a prompt.')
    }

    const files = await Promise.all(
      imageAttachments.slice(0, 10).map((attachment) => this.buildImageFileContent(attachment))
    )

    return {
      type: 'generate_image',
      prompt,
      model_version: normalizeImageModelVersion(options.ImageModelVersion),
      ...this.buildGenerateImageTemplateOptions(options.ImageTemplate),
      ...(files.length === 1 ? { file: files[0] } : {}),
      ...(files.length > 1 ? { files } : {})
    }
  }

  private buildGenerateImageTemplateOptions(value?: string): Record<string, unknown> {
    const normalized = String(value || '').trim()
    if (!normalized) return {}
    if (normalized === 't_pose') return { t_pose: true }
    if (normalized === 'sketch_to_render') return { sketch_to_render: true }
    return { template: normalized }
  }

  private async buildGenerateMultiviewImageTaskData(
    imageAttachments: ChatAttachment[]
  ): Promise<Record<string, unknown>> {
    const [imageAttachment] = imageAttachments
    if (!imageAttachment) {
      throw new Error('[Tripo3D] Multiview image generation requires one source image.')
    }

    return {
      type: 'generate_multiview_image',
      file: await this.buildImageFileContent(imageAttachment)
    }
  }

  private buildEditMultiviewImageTaskData(
    prompt: string,
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    const originalTaskId = this.resolveOriginalTaskId(messages, options, 'edit_multiview_image')
    if (!prompt) {
      throw new Error('[Tripo3D] Editing a multiview image requires an edit prompt.')
    }

    return {
      type: 'edit_multiview_image',
      original_task_id: originalTaskId,
      prompts: [
        {
          prompt,
          view: normalizeTripoView(options.EditView)
        }
      ]
    }
  }

  private buildImportModelTaskData(messages: ChatMessage[]): Record<string, unknown> {
    const modelInput = extractModelInput(messages)
    const file = this.buildModelFileContent(modelInput.modelUrl || modelInput.rawContent)
    return {
      type: 'import_model',
      file
    }
  }

  private async buildTextureModelTaskData(
    messages: ChatMessage[],
    imageAttachments: ChatAttachment[],
    options: Tripo3DGenerateOptions
  ): Promise<Record<string, unknown>> {
    const modelInput = extractModelInput(messages)
    const texturePrompt =
      modelInput.prompt || modelInput.rawContent.replace(modelInput.modelUrl, '').trim()
    const originalTaskId = this.resolveOriginalTaskId(messages, options, 'texture_model')

    if (texturePrompt && imageAttachments.length > 0) {
      throw new Error(
        '[Tripo3D] Texture prompt text and texture reference images are mutually exclusive.'
      )
    }

    let texturePromptPayload: Record<string, unknown>
    if (imageAttachments.length > 0) {
      const imageFiles = await Promise.all(
        imageAttachments.map((attachment) => this.buildImageFileContent(attachment))
      )
      texturePromptPayload =
        imageFiles.length === 1 ? { image: imageFiles[0] } : { images: imageFiles }
    } else if (texturePrompt) {
      texturePromptPayload = { text: texturePrompt }
    } else {
      throw new Error('[Tripo3D] Texture model requires a text prompt or reference image.')
    }

    return {
      type: 'texture_model',
      original_model_task_id: originalTaskId,
      texture_prompt: texturePromptPayload,
      model_version: normalizeTripoTextureVersion(options.Model),
      texture: true,
      pbr: !!options.EnablePBR,
      texture_quality: 'standard'
    }
  }

  private buildMeshSegmentationTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    return {
      type: 'mesh_segmentation',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'mesh_segmentation'),
      model_version: 'v1.0-20250506'
    }
  }

  private buildMeshCompletionTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    const modelInput = extractModelInput(messages)
    const partNames = splitCommaList(modelInput.prompt)
    return {
      type: 'mesh_completion',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'mesh_completion'),
      model_version: 'v1.0-20250506',
      ...(partNames.length > 0 ? { part_names: partNames } : {})
    }
  }

  private buildLowPolyTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    return {
      type: 'highpoly_to_lowpoly',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'highpoly_to_lowpoly'),
      model_version: 'P-v2.0-20251225',
      quad: options.PolygonType === 'quadrilateral',
      face_limit: getFaceLimitFromOptions(options),
      bake: true
    }
  }

  private buildPreRigCheckTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    return {
      type: 'animate_prerigcheck',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'animate_prerigcheck'),
      model_version: 'v2.0-20250506'
    }
  }

  private buildRigTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    return {
      type: 'animate_rig',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'animate_rig'),
      model_version: 'v2.5-20260210',
      out_format: 'glb',
      rig_type: options.RigType || 'biped',
      spec: options.RigSpec || 'tripo'
    }
  }

  private buildRetargetTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    const animation = String(options.Animation || DEFAULT_TRIPO_ANIMATION).trim()
    return {
      type: 'animate_retarget',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'animate_retarget'),
      out_format: 'glb',
      bake_animation: true,
      export_with_geometry: true,
      animation: animation || DEFAULT_TRIPO_ANIMATION
    }
  }

  private buildConvertModelTaskData(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions
  ): Record<string, unknown> {
    const format = String(options.TargetFormat || 'STL')
      .trim()
      .toUpperCase()
    if (!TRIPO_CONVERT_FORMATS.has(format)) {
      throw new Error('[Tripo3D] Conversion format must be GLTF, USDZ, FBX, OBJ, STL, or 3MF.')
    }

    return {
      type: 'convert_model',
      original_model_task_id: this.resolveOriginalTaskId(messages, options, 'convert_model'),
      format,
      quad: options.PolygonType === 'quadrilateral',
      face_limit: getFaceLimitFromOptions(options),
      bake: true,
      pack_uv: true
    }
  }

  private async buildTripoMultiviewFiles(
    imageAttachments: ChatAttachment[]
  ): Promise<Array<Record<string, unknown>>> {
    const viewMap = new Map<TripoMultiviewName, ChatAttachment>()
    const remaining: ChatAttachment[] = []

    for (const attachment of imageAttachments) {
      const viewName = inferTripoViewName(attachment)
      if (viewName && !viewMap.has(viewName)) {
        viewMap.set(viewName, attachment)
      } else {
        remaining.push(attachment)
      }
    }

    for (const viewName of TRIPO_MULTIVIEW_ORDER) {
      if (viewMap.has(viewName)) continue
      const nextAttachment = remaining.shift()
      if (nextAttachment) {
        viewMap.set(viewName, nextAttachment)
      }
    }

    const missingViews = TRIPO_MULTIVIEW_ORDER.filter((viewName) => !viewMap.has(viewName))
    if (missingViews.length > 0) {
      throw new Error(
        `[Tripo3D] Multiview-to-model requires front, left, back, and right images. Missing: ${missingViews.join(', ')}.`
      )
    }

    return Promise.all(
      TRIPO_MULTIVIEW_ORDER.map((viewName) =>
        this.buildImageFileContent(viewMap.get(viewName) as ChatAttachment)
      )
    )
  }

  private async buildImageFileContent(
    attachment: ChatAttachment
  ): Promise<Record<string, unknown>> {
    const metadataToken = attachment.metadata?.tripoImageToken
    if (typeof metadataToken === 'string' && metadataToken.trim()) {
      return {
        type: inferImageTypeFromMimeType(attachment.mimeType) || 'jpg',
        file_token: metadataToken.trim()
      }
    }

    if (isRemoteHttpUrl(attachment.url)) {
      return {
        type:
          inferImageTypeFromMimeType(attachment.mimeType) ||
          inferImageTypeFromName(attachment.fileName) ||
          inferImageTypeFromName(attachment.url) ||
          'jpg',
        url: attachment.url
      }
    }

    const upload = await this.prepareImageUpload(attachment)
    const token = await this.uploadImage(upload)
    return {
      type: upload.imageType,
      file_token: token
    }
  }

  private buildModelFileContent(value: string): Record<string, unknown> {
    const normalized = String(value || '').trim()
    if (!normalized) {
      throw new Error('[Tripo3D] Import model requires a model file token or URL.')
    }

    try {
      const parsed = JSON.parse(normalized) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        return parsed
      }
    } catch {
      /* plain string input */
    }

    const fileToken = parseModelFileToken(normalized)
    if (fileToken) {
      return {
        type: 'model',
        file_token: fileToken
      }
    }

    if (isRemoteHttpUrl(normalized)) {
      return {
        type: 'model',
        url: normalized
      }
    }

    throw new Error(
      '[Tripo3D] Import model currently requires a Tripo STS file token/object or a public model URL.'
    )
  }

  private async prepareImageUpload(attachment: ChatAttachment): Promise<PreparedImageUpload> {
    let buffer: Buffer
    let mimeType = normalizeMimeType(attachment.mimeType)
    let sourceName = attachment.fileName || ''

    if (attachment.url.startsWith('data:')) {
      const parsed = parseDataUrl(attachment.url)
      buffer = parsed.buffer
      mimeType = mimeType || parsed.mimeType
    } else if (isLocalFileSource(attachment.url)) {
      const filePath = normalizeLocalPath(attachment.url)
      buffer = await fs.readFile(filePath)
      sourceName = sourceName || path.basename(filePath)
    } else {
      throw new Error(
        '[Tripo3D] Unsupported image source. Use a local image, data URL, or HTTP URL.'
      )
    }

    if (buffer.length > TRIPO_UPLOAD_IMAGE_MAX_BYTES) {
      throw new Error('[Tripo3D] Uploaded images must be 20 MB or smaller.')
    }

    const imageType =
      inferImageTypeFromMimeType(mimeType) ||
      inferImageTypeFromName(sourceName) ||
      inferImageTypeFromBuffer(buffer)

    if (!imageType) {
      throw new Error('[Tripo3D] Unsupported image format. Use JPG, PNG, or WEBP.')
    }

    return {
      buffer,
      mimeType: mimeType || mimeTypeFromImageType(imageType),
      fileName: sourceName || `reference.${imageType === 'jpg' ? 'jpg' : imageType}`,
      imageType
    }
  }

  private async uploadImage(upload: PreparedImageUpload): Promise<string> {
    const form = new FormData()
    const blob = new Blob([upload.buffer as unknown as BlobPart], {
      type: upload.mimeType || 'application/octet-stream'
    })
    form.append('file', blob, upload.fileName)

    const response = await this.request<
      TripoApiResponse<{
        image_token?: string
        file_token?: string
        token?: string
      }>
    >('POST', '/upload/sts', { body: form })

    const token =
      response.data?.image_token?.trim() ||
      response.data?.file_token?.trim() ||
      response.data?.token?.trim()

    if (!token) {
      throw new Error('[Tripo3D] Image upload succeeded, but no image token was returned.')
    }
    return token
  }

  private resolveOriginalTaskId(
    messages: ChatMessage[],
    options: Tripo3DGenerateOptions,
    taskType: string
  ): string {
    const fromOptions = String(options.OriginalTaskId || '').trim()
    if (fromOptions) return fromOptions

    const modelInput = extractModelInput(messages)
    const fromText =
      extractExplicitTaskIdFromText(modelInput.rawContent) ||
      extractExplicitTaskIdFromText(modelInput.modelUrl)
    if (fromText) return fromText

    throw new Error(
      `[Tripo3D] ${taskType} requires the original Tripo task ID. Generate or import the model with Tripo first, or paste its Task ID.`
    )
  }

  private async createTask(taskData: Record<string, unknown>): Promise<string> {
    const response = await this.request<
      TripoApiResponse<{ task_id?: string }> | { task_id?: string }
    >('POST', '/task', { json: taskData })
    const taskId =
      ('data' in response ? response.data?.task_id : undefined) ||
      ('task_id' in response ? response.task_id : undefined)

    if (!taskId) {
      throw new Error('[Tripo3D] Task submission did not return a task ID.')
    }
    return taskId
  }

  private async getTask(taskId: string): Promise<TripoTask> {
    const response = await this.request<TripoApiResponse<TripoTask> | TripoTask>(
      'GET',
      `/task/${encodeURIComponent(taskId)}`
    )
    const task = 'data' in response && response.data ? response.data : response
    return task as TripoTask
  }

  private async waitForTask(taskId: string): Promise<TripoTask> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < this.pollTimeoutMs) {
      throwIfAborted(this.signal)
      const task = await this.getTask(taskId)
      const status = String(task.status || '').toLowerCase()

      if (TRIPO_SUCCESS_STATUSES.has(status)) {
        return task
      }

      if (TRIPO_FAILURE_STATUSES.has(status)) {
        const errorDetail = [task.error_code, task.error_msg].filter(Boolean).join(' ')
        throw new Error(`[Tripo3D] Task failed: ${errorDetail || status}`.trim())
      }

      if (!TRIPO_PENDING_STATUSES.has(status)) {
        console.warn('[Tripo3D] Unknown task status while polling', {
          taskId,
          status,
          progress: task.progress
        })
      }

      await delay(this.pollIntervalMs, this.signal)
    }

    throw new Error('[Tripo3D] Task timed out. Please retry later.')
  }

  private async request<T>(
    method: string,
    apiPath: string,
    options: { json?: Record<string, unknown>; body?: BodyInit } = {}
  ): Promise<T> {
    throwIfAborted(this.signal)
    const response = await this.fetchImpl(this.buildUrl(apiPath), {
      method,
      signal: this.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.json ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.json ? JSON.stringify(options.json) : options.body
    })

    const rawText = await response.text()
    let payload: unknown = {}
    if (rawText.trim()) {
      try {
        payload = JSON.parse(rawText)
      } catch {
        throw new Error(`[Tripo3D] API returned non-JSON response: ${rawText.slice(0, 200)}`)
      }
    }

    if (!response.ok) {
      throw new Error(
        `[Tripo3D] API request failed: ${response.status} ${response.statusText} ${this.describeApiError(payload)}`.trim()
      )
    }

    const code = (payload as TripoApiResponse<unknown>).code
    if (code !== undefined && code !== 0 && code !== '0') {
      throw new Error(`[Tripo3D] API error: ${this.describeApiError(payload)}`.trim())
    }

    return payload as T
  }

  private describeApiError(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return ''
    const response = payload as TripoApiResponse<unknown>
    return [response.code, response.message, response.suggestion].filter(Boolean).join(' ')
  }

  private buildUrl(apiPath: string): string {
    return `${this.baseUrl}/${apiPath.replace(/^\/+/, '')}`
  }
}

const splitCommaList = (value: string): string[] =>
  String(value || '')
    .split(/[,，\n]/)
    .map((part) => part.trim())
    .filter(Boolean)

export const getDefaultTripo3DBaseUrl = (): string => DEFAULT_TRIPO_BASE_URL
