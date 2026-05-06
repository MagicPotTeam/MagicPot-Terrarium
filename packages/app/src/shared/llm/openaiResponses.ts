import type { LLMModelUse } from '@shared/config/config'
import type {
  ChatMessage,
  OpenAIImageGenerationAction,
  OpenAIImageGenerationBackground,
  OpenAIImageGenerationOptions,
  OpenAIImageGenerationOutputFormat,
  OpenAIImageGenerationQuality
} from './types'

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

export type OpenAIResponsesInputMessage = {
  role: 'user' | 'assistant'
  content: ResponsesInputContent[]
}

export type OpenAIResponsesImageAttachment = {
  url: string
  mimeType?: string
  fileName?: string
}

export type OpenAIResponsesImageGenerationTool = {
  type: 'image_generation'
  action?: OpenAIImageGenerationAction
  background?: OpenAIImageGenerationBackground
  output_format?: OpenAIImageGenerationOutputFormat
  quality?: OpenAIImageGenerationQuality
  size?: string
}

export type OpenAIResponsesCitation = {
  key: string
  label: string
}

export type OpenAIResponsesOutput = {
  citations: OpenAIResponsesCitation[]
  text: string
  images: OpenAIResponsesImageAttachment[]
}

const DEFAULT_IMAGE_ANALYSIS_PROMPT = 'Please analyze the attached image.'
const DEFAULT_FILE_ANALYSIS_PROMPT = 'Please analyze the attached files.'
const DEFAULT_MULTIMODAL_ANALYSIS_PROMPT = 'Please analyze the attached files and images.'
const DEFAULT_IMAGE_MIME_TYPE = 'image/png'

const IMAGE_GENERATION_ACTIONS = new Set<OpenAIImageGenerationAction>(['auto', 'generate', 'edit'])
const IMAGE_GENERATION_BACKGROUNDS = new Set<OpenAIImageGenerationBackground>([
  'auto',
  'opaque',
  'transparent'
])
const IMAGE_GENERATION_OUTPUT_FORMATS = new Set<OpenAIImageGenerationOutputFormat>([
  'png',
  'webp',
  'jpeg'
])
const IMAGE_GENERATION_QUALITIES = new Set<OpenAIImageGenerationQuality>([
  'auto',
  'low',
  'medium',
  'high'
])
const IMAGE_GENERATION_SIZE_PATTERN = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/
const IMAGE_GENERATION_SIZE_STEP = 16
const IMAGE_GENERATION_MAX_DIMENSION = 3840
const IMAGE_GENERATION_MAX_ASPECT_RATIO = 3
const IMAGE_GENERATION_MIN_PIXEL_BUDGET = 1024 * 1024
const IMAGE_GENERATION_MAX_PIXEL_BUDGET = 3840 * 2160

const IMAGE_GENERATION_NEGATIVE_HINTS = [
  /提示词/,
  /\bprompt\b/i,
  /分析/,
  /描述/,
  /解释/,
  /\banaly[sz]e\b/i,
  /\bdescribe\b/i,
  /\bexplain\b/i,
  /\bocr\b/i,
  /\bcode\b/i,
  /代码/
]

const IMAGE_GENERATION_POSITIVE_HINTS = [
  /^\/(?:image|draw)\b/i,
  /^(?:直接)?(?:出图|画图|绘图)$/i,
  /(?:直接)?(?:出图|画图|绘图|生成图|生成图片)/,
  /\b(generate|create|draw|make|render|illustrate|design)\b[\s\S]{0,48}\b(image|picture|photo|art|illustration|poster|wallpaper|avatar|logo)\b/i,
  /\b(image|picture|photo|art|illustration|poster|wallpaper|avatar|logo)\b[\s\S]{0,48}\b(generate|create|draw|make|render|illustrate|design)\b/i,
  /(生成|画|出|做|绘制|创建)[\s\S]{0,24}(图|图片|照片|海报|壁纸|插画|头像|logo|封面)/,
  /(要|给我|帮我)[\s\S]{0,24}(图|图片|照片|海报|壁纸|插画|头像|logo|封面)/,
  /(美女图|壁纸|海报|插画|头像|封面)/
]

const normalizeImageGenerationEnum = <T extends string>(
  value: unknown,
  allowed: Set<T>
): T | undefined => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return allowed.has(normalized as T) ? (normalized as T) : undefined
}

const normalizeOpenAIImageGenerationDimension = (value: unknown): number | undefined => {
  const dimension = Math.round(Number(value))
  if (!Number.isFinite(dimension) || dimension <= 0) {
    return undefined
  }

  return Math.min(
    IMAGE_GENERATION_MAX_DIMENSION,
    Math.max(
      IMAGE_GENERATION_SIZE_STEP,
      Math.round(dimension / IMAGE_GENERATION_SIZE_STEP) * IMAGE_GENERATION_SIZE_STEP
    )
  )
}

const normalizeOpenAIImageGenerationDimensions = (
  widthInput: unknown,
  heightInput: unknown
): { width: number; height: number } | undefined => {
  let width = normalizeOpenAIImageGenerationDimension(widthInput)
  let height = normalizeOpenAIImageGenerationDimension(heightInput)
  if (!width || !height) {
    return undefined
  }

  const minHeightForWidth =
    Math.ceil(width / IMAGE_GENERATION_MAX_ASPECT_RATIO / IMAGE_GENERATION_SIZE_STEP) *
    IMAGE_GENERATION_SIZE_STEP
  const minWidthForHeight =
    Math.ceil(height / IMAGE_GENERATION_MAX_ASPECT_RATIO / IMAGE_GENERATION_SIZE_STEP) *
    IMAGE_GENERATION_SIZE_STEP

  if (width / height > IMAGE_GENERATION_MAX_ASPECT_RATIO) {
    height = Math.min(IMAGE_GENERATION_MAX_DIMENSION, Math.max(height, minHeightForWidth))
  } else if (height / width > IMAGE_GENERATION_MAX_ASPECT_RATIO) {
    width = Math.min(IMAGE_GENERATION_MAX_DIMENSION, Math.max(width, minWidthForHeight))
  }

  const pixelCount = width * height
  if (pixelCount < IMAGE_GENERATION_MIN_PIXEL_BUDGET) {
    const scale = Math.sqrt(IMAGE_GENERATION_MIN_PIXEL_BUDGET / pixelCount)
    width = Math.min(
      IMAGE_GENERATION_MAX_DIMENSION,
      Math.ceil((width * scale) / IMAGE_GENERATION_SIZE_STEP) * IMAGE_GENERATION_SIZE_STEP
    )
    height = Math.min(
      IMAGE_GENERATION_MAX_DIMENSION,
      Math.ceil((height * scale) / IMAGE_GENERATION_SIZE_STEP) * IMAGE_GENERATION_SIZE_STEP
    )
  }

  const scaledPixelCount = width * height
  if (scaledPixelCount > IMAGE_GENERATION_MAX_PIXEL_BUDGET) {
    const scale = Math.sqrt(IMAGE_GENERATION_MAX_PIXEL_BUDGET / scaledPixelCount)
    width = Math.max(
      IMAGE_GENERATION_SIZE_STEP,
      Math.floor((width * scale) / IMAGE_GENERATION_SIZE_STEP) * IMAGE_GENERATION_SIZE_STEP
    )
    height = Math.max(
      IMAGE_GENERATION_SIZE_STEP,
      Math.floor((height * scale) / IMAGE_GENERATION_SIZE_STEP) * IMAGE_GENERATION_SIZE_STEP
    )
  }

  return { width, height }
}

export const normalizeOpenAIImageGenerationSize = (value?: string): string | undefined => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')

  if (!normalized) {
    return undefined
  }
  if (normalized === 'auto') {
    return 'auto'
  }

  const match = normalized.match(IMAGE_GENERATION_SIZE_PATTERN)
  if (!match) {
    return undefined
  }

  const dimensions = normalizeOpenAIImageGenerationDimensions(match[1], match[2])
  return dimensions ? `${dimensions.width}x${dimensions.height}` : undefined
}

export const normalizeOpenAIImageGenerationOptions = (
  options?: OpenAIImageGenerationOptions
): OpenAIImageGenerationOptions | undefined => {
  if (!options || typeof options !== 'object') {
    return undefined
  }

  const action = normalizeImageGenerationEnum(options.action, IMAGE_GENERATION_ACTIONS)
  const background = normalizeImageGenerationEnum(options.background, IMAGE_GENERATION_BACKGROUNDS)
  const outputFormat = normalizeImageGenerationEnum(
    options.outputFormat,
    IMAGE_GENERATION_OUTPUT_FORMATS
  )
  const quality = normalizeImageGenerationEnum(options.quality, IMAGE_GENERATION_QUALITIES)
  const enabled = options.enabled === true
  const size = normalizeOpenAIImageGenerationSize(options.size)

  const normalized: OpenAIImageGenerationOptions = {
    ...(action ? { action } : {}),
    ...(background ? { background } : {}),
    ...(enabled ? { enabled } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {})
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

const hasUserImageAttachment = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) =>
      message.role === 'user' &&
      (message.attachments || []).some((attachment) => attachment.type === 'image')
  )

const resolveReferenceImageGenerationSize = (messages: ChatMessage[]): string | undefined => {
  const latestUserImage = [...messages]
    .reverse()
    .flatMap((message) =>
      message.role === 'user'
        ? (message.attachments || []).filter((attachment) => attachment.type === 'image')
        : []
    )
    .find((attachment) => attachment.sourceWidth && attachment.sourceHeight)

  const dimensions = normalizeOpenAIImageGenerationDimensions(
    latestUserImage?.sourceWidth,
    latestUserImage?.sourceHeight
  )
  return dimensions ? `${dimensions.width}x${dimensions.height}` : undefined
}

export const buildOpenAIImageGenerationTool = (options: {
  messages: ChatMessage[]
  imageGenerationOptions?: OpenAIImageGenerationOptions
}): OpenAIResponsesImageGenerationTool => {
  const normalizedOptions = normalizeOpenAIImageGenerationOptions(options.imageGenerationOptions)
  const tool: OpenAIResponsesImageGenerationTool = {
    type: 'image_generation',
    action:
      normalizedOptions?.action || (hasUserImageAttachment(options.messages) ? 'auto' : 'generate')
  }
  const requestedSize = normalizedOptions?.size
  const referenceImageSize = resolveReferenceImageGenerationSize(options.messages)
  const resolvedSize =
    requestedSize && requestedSize !== 'auto'
      ? requestedSize
      : referenceImageSize || requestedSize || 'auto'

  if (normalizedOptions?.outputFormat) {
    tool.output_format = normalizedOptions.outputFormat
  }
  if (resolvedSize) {
    tool.size = resolvedSize
  }
  if (normalizedOptions?.quality) {
    tool.quality = normalizedOptions.quality
  }
  if (normalizedOptions?.background) {
    tool.background = normalizedOptions.background
  }

  return tool
}

const extensionFromMimeType = (mimeType?: string): string => {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'png'
  }
}

const normalizeImageMimeType = (value?: string): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!normalized) {
    return DEFAULT_IMAGE_MIME_TYPE
  }

  if (normalized.startsWith('image/')) {
    return normalized
  }

  if (normalized === 'jpg') return 'image/jpeg'
  if (normalized === 'svg') return 'image/svg+xml'
  return `image/${normalized}`
}

const pushUniqueText = (parts: string[], value: unknown): void => {
  if (typeof value !== 'string') {
    return
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return
  }

  if (!parts.includes(trimmed)) {
    parts.push(trimmed)
  }
}

const pushUniqueCitation = (citations: OpenAIResponsesCitation[], value: unknown): void => {
  if (!value || typeof value !== 'object') {
    return
  }

  const record = value as Record<string, unknown>
  const nestedUrlCitation =
    record.url_citation && typeof record.url_citation === 'object'
      ? (record.url_citation as Record<string, unknown>)
      : null
  const nestedFileCitation =
    record.file_citation && typeof record.file_citation === 'object'
      ? (record.file_citation as Record<string, unknown>)
      : null
  const type = String(record.type || '')
    .trim()
    .toLowerCase()
  const urlSource = nestedUrlCitation || record
  if (type === 'url_citation' || typeof urlSource.url === 'string') {
    const url = typeof urlSource.url === 'string' ? urlSource.url.trim() : ''
    if (!url) {
      return
    }

    const title = typeof urlSource.title === 'string' ? urlSource.title.trim() : ''
    const label = title ? `${title}: ${url}` : url
    if (!citations.some((citation) => citation.key === `url:${url}`)) {
      citations.push({
        key: `url:${url}`,
        label
      })
    }

    return
  }

  const fileSource = nestedFileCitation || record
  if (
    type === 'file_citation' ||
    typeof fileSource.file_id === 'string' ||
    typeof fileSource.filename === 'string'
  ) {
    const fileId = typeof fileSource.file_id === 'string' ? fileSource.file_id.trim() : ''
    const fileName = typeof fileSource.filename === 'string' ? fileSource.filename.trim() : ''
    const key = fileId || fileName
    if (!key) {
      return
    }

    if (!citations.some((citation) => citation.key === `file:${key}`)) {
      citations.push({
        key: `file:${key}`,
        label: fileName ? `File: ${fileName}` : `File: ${key}`
      })
    }
  }
}

const appendCitationText = (text: string, citations: OpenAIResponsesCitation[]): string => {
  if (!citations.length) {
    return text
  }

  const sourceLines = citations.map((citation) => `- ${citation.label}`)

  return [text.trim(), 'Sources:', ...sourceLines].filter(Boolean).join('\n')
}

export function buildDefaultOpenAIWebSearchTool(): Record<string, unknown> {
  let timezone = ''

  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    timezone = ''
  }

  return {
    type: 'web_search',
    ...(timezone
      ? {
          user_location: {
            type: 'approximate',
            timezone
          }
        }
      : {})
  }
}

export function buildDefaultOpenAIResponsesInclude(options?: {
  includeFileSearchResults?: boolean
  includeWebSearchSources?: boolean
}): string[] {
  const include: string[] = []

  if (options?.includeWebSearchSources !== false) {
    include.push('web_search_call.action.sources')
  }

  if (options?.includeFileSearchResults) {
    include.push('file_search_call.results')
  }

  return include
}

const normalizeDataUrl = (
  value: string,
  fallbackMimeType?: string
): OpenAIResponsesImageAttachment => {
  if (value.startsWith('data:')) {
    const mimeMatch = value.match(/^data:([^;,]+)/i)
    const mimeType = normalizeImageMimeType(mimeMatch?.[1] || fallbackMimeType)
    return {
      url: value,
      mimeType,
      fileName: `openai-image.${extensionFromMimeType(mimeType)}`
    }
  }

  const mimeType = normalizeImageMimeType(fallbackMimeType)
  return {
    url: `data:${mimeType};base64,${value}`,
    mimeType,
    fileName: `openai-image.${extensionFromMimeType(mimeType)}`
  }
}

const pushImageAttachment = (
  images: OpenAIResponsesImageAttachment[],
  attachment: OpenAIResponsesImageAttachment | null
): void => {
  if (!attachment?.url) {
    return
  }

  if (!images.some((candidate) => candidate.url === attachment.url)) {
    images.push(attachment)
  }
}

const tryExtractImageAttachment = (value: unknown): OpenAIResponsesImageAttachment | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return {
        url: trimmed,
        mimeType: DEFAULT_IMAGE_MIME_TYPE,
        fileName: `openai-image.${extensionFromMimeType(DEFAULT_IMAGE_MIME_TYPE)}`
      }
    }

    if (trimmed.startsWith('data:')) {
      return normalizeDataUrl(trimmed)
    }

    return normalizeDataUrl(trimmed)
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const mimeType = normalizeImageMimeType(
    typeof record.mime_type === 'string'
      ? record.mime_type
      : typeof record.output_format === 'string'
        ? record.output_format
        : typeof record.format === 'string'
          ? record.format
          : undefined
  )

  if (typeof record.url === 'string' && record.url.trim()) {
    return {
      url: record.url.trim(),
      mimeType,
      fileName: `openai-image.${extensionFromMimeType(mimeType)}`
    }
  }

  if (typeof record.image_url === 'string' && record.image_url.trim()) {
    return {
      url: record.image_url.trim(),
      mimeType,
      fileName: `openai-image.${extensionFromMimeType(mimeType)}`
    }
  }

  if (typeof record.b64_json === 'string' && record.b64_json.trim()) {
    return normalizeDataUrl(record.b64_json.trim(), mimeType)
  }

  if (typeof record.partial_image_b64 === 'string' && record.partial_image_b64.trim()) {
    return normalizeDataUrl(record.partial_image_b64.trim(), mimeType)
  }

  if (typeof record.result === 'string' && record.result.trim()) {
    return normalizeDataUrl(record.result.trim(), mimeType)
  }

  return null
}

const collectOutputTextAndImages = (
  value: unknown,
  textParts: string[],
  images: OpenAIResponsesImageAttachment[],
  citations: OpenAIResponsesCitation[]
): void => {
  if (!value || typeof value !== 'object') {
    return
  }

  const record = value as Record<string, unknown>
  pushUniqueText(textParts, record.output_text)
  pushUniqueText(textParts, record.text)

  const directImage = tryExtractImageAttachment(record)
  if (
    directImage &&
    String(record.type || '')
      .toLowerCase()
      .includes('image')
  ) {
    pushImageAttachment(images, directImage)
  }

  if (String(record.type || '').toLowerCase() === 'web_search_call') {
    const action =
      record.action && typeof record.action === 'object'
        ? (record.action as Record<string, unknown>)
        : null
    const sources = Array.isArray(action?.sources) ? action.sources : []
    for (const source of sources) {
      pushUniqueCitation(citations, source)
    }
  }

  if (String(record.type || '').toLowerCase() === 'file_search_call') {
    const results = Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.search_results)
        ? record.search_results
        : []
    for (const result of results) {
      pushUniqueCitation(citations, result)
    }
  }

  const content = Array.isArray(record.content) ? record.content : []
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const itemRecord = item as Record<string, unknown>
    pushUniqueText(textParts, itemRecord.text)
    const annotations = Array.isArray(itemRecord.annotations) ? itemRecord.annotations : []
    for (const annotation of annotations) {
      pushUniqueCitation(citations, annotation)
    }

    const contentImage = tryExtractImageAttachment(itemRecord)
    if (
      contentImage &&
      String(itemRecord.type || '')
        .toLowerCase()
        .includes('image')
    ) {
      pushImageAttachment(images, contentImage)
    }
  }

  const result = record.result
  if (Array.isArray(result)) {
    for (const item of result) {
      pushImageAttachment(images, tryExtractImageAttachment(item))
    }
  } else {
    const resultImage = tryExtractImageAttachment(result)
    if (resultImage) {
      pushImageAttachment(images, resultImage)
    }
  }
}

export function buildOpenAIResponsesInput(messages: ChatMessage[]): OpenAIResponsesInputMessage[] {
  const input: OpenAIResponsesInputMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      continue
    }

    if (message.role === 'user') {
      const content: OpenAIResponsesInputMessage['content'] = []
      const imageAttachments = (message.attachments || []).filter(
        (attachment) => attachment.type === 'image'
      )
      const fileAttachments = (message.attachments || []).filter(
        (attachment) => attachment.type === 'file'
      )

      if (message.content.trim()) {
        content.push({
          type: 'input_text',
          text: message.content
        })
      } else if (imageAttachments.length > 0 && fileAttachments.length > 0) {
        content.push({
          type: 'input_text',
          text: DEFAULT_MULTIMODAL_ANALYSIS_PROMPT
        })
      } else if (imageAttachments.length > 0) {
        content.push({
          type: 'input_text',
          text: DEFAULT_IMAGE_ANALYSIS_PROMPT
        })
      } else if (fileAttachments.length > 0) {
        content.push({
          type: 'input_text',
          text: DEFAULT_FILE_ANALYSIS_PROMPT
        })
      }

      for (const attachment of imageAttachments) {
        content.push({
          type: 'input_image',
          image_url: attachment.url
        })
      }

      if (content.length > 0) {
        input.push({
          role: 'user',
          content
        })
      }
      continue
    }

    if (message.content.trim()) {
      input.push({
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: message.content
          }
        ]
      })
    }
  }

  return input
}

export function extractOpenAIResponsesOutput(payload: unknown): OpenAIResponsesOutput {
  const textParts: string[] = []
  const images: OpenAIResponsesImageAttachment[] = []
  const citations: OpenAIResponsesCitation[] = []

  if (!payload || typeof payload !== 'object') {
    return { text: '', images, citations }
  }

  const record = payload as Record<string, unknown>
  collectOutputTextAndImages(record, textParts, images, citations)

  const output = Array.isArray(record.output) ? record.output : []
  for (const item of output) {
    collectOutputTextAndImages(item, textParts, images, citations)
  }

  return {
    citations,
    text: textParts.join('\n').trim(),
    images
  }
}

export function serializeOpenAIResponsesOutput(payload: unknown): string | null {
  const { text, images, citations } = extractOpenAIResponsesOutput(payload)
  const formattedText = appendCitationText(text, citations)

  if (!images.length) {
    return formattedText || null
  }

  return JSON.stringify({
    content: formattedText,
    attachments: images.map((image) => ({
      type: 'image',
      url: image.url,
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
      ...(image.fileName ? { fileName: image.fileName } : {})
    }))
  })
}

export function detectImageGenerationIntent(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) {
    return false
  }

  if (IMAGE_GENERATION_NEGATIVE_HINTS.some((pattern) => pattern.test(normalized))) {
    return false
  }

  return IMAGE_GENERATION_POSITIVE_HINTS.some((pattern) => pattern.test(normalized))
}

export function shouldUseOpenAIImageGeneration(options: {
  messages: ChatMessage[]
  modelUse?: LLMModelUse
  imageGenerationOptions?: OpenAIImageGenerationOptions
}): boolean {
  if (options.modelUse === 'image') {
    return true
  }

  const explicitAction = normalizeOpenAIImageGenerationOptions(
    options.imageGenerationOptions
  )?.action
  if (options.imageGenerationOptions?.enabled === true) {
    return true
  }
  if (explicitAction === 'generate' || explicitAction === 'edit') {
    return true
  }

  const lastUserMessage = [...options.messages].reverse().find((message) => message.role === 'user')

  if (!lastUserMessage) {
    return false
  }

  return detectImageGenerationIntent(lastUserMessage.content)
}
