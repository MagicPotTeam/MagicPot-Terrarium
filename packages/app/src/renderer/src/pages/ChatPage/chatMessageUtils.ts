import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { buildNormalizedTaggingSidecarText, parseNormalizedTaggingResponse } from '@shared/llm'
import { getDownloadFileNameFromUrl, isModel3DUrl, normalizeLocalMediaUrl } from './chatPageShared'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { BUILT_IN_TAGGING_SKILL_ID } from './builtInSkills'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v']
const IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'local-media:'])
const MARKDOWN_IMAGE_REGEX =
  /!\[.*?\]\(((?:https?:\/\/|file:\/\/|local-media:\/\/|data:image\/)[^)]+)\)/g
const MARKDOWN_MODEL_REGEX = /\[(?:Generated 3D Model|3D Model|Model)\]\(([^)]+)\)/gi
const MARKDOWN_VIDEO_REGEX =
  /\[(?:Generated Video|Video)\]\(((?:https?:\/\/|file:\/\/|local-media:\/\/)[^)]+)\)/gi
const MARKDOWN_FILE_REGEX = /\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/|local-media:\/\/)[^)]+)\)/g
const HUNYUAN_ARTIFACT_REGEX =
  /^\[Hunyuan3D\]\s+(model|video|image|file):\s+type=([A-Za-z_]+)\s+url=([^\s]+)\s*$/gim

const isImageUrl = (url: string): boolean => {
  if (url.startsWith('data:image/')) {
    return true
  }

  try {
    const parsedUrl = new URL(url)
    if (!IMAGE_PROTOCOLS.has(parsedUrl.protocol)) {
      return false
    }

    const pathname = parsedUrl.pathname.toLowerCase()
    return IMAGE_EXTENSIONS.some((extension) => pathname.includes(extension))
  } catch {
    return false
  }
}

/** Check whether a URL points to a downloadable file (not image, not 3D model, not a webpage) */
const isGenericFileUrl = (url: string): boolean => {
  try {
    const parsedUrl = new URL(url)
    if (!['http:', 'https:', 'file:', 'local-media:'].includes(parsedUrl.protocol)) {
      return false
    }
    const pathname = parsedUrl.pathname.toLowerCase()
    // Must have a file extension to be considered a file
    const lastSegment = pathname.split('/').pop() || ''
    const dotIndex = lastSegment.lastIndexOf('.')
    if (dotIndex <= 0) return false
    // Exclude image extensions
    if (IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return false
    // Exclude 3D model extensions (handled by isModel3DUrl)
    // The remaining URLs with file extensions are treated as generic files
    return true
  } catch {
    return false
  }
}

const isVideoUrl = (url: string): boolean => {
  try {
    const parsedUrl = new URL(url)
    if (!['http:', 'https:', 'file:', 'local-media:'].includes(parsedUrl.protocol)) {
      return false
    }

    const pathname = parsedUrl.pathname.toLowerCase()
    return VIDEO_EXTENSIONS.some((extension) => pathname.includes(extension))
  } catch {
    return false
  }
}

const hasExplicitFileExtension = (value: string): boolean => {
  const trimmed = value.trim()
  const lastDot = trimmed.lastIndexOf('.')
  return lastDot > 0 && lastDot < trimmed.length - 1
}

const hasArchiveExtension = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  return ['.zip', '.rar', '.7z', '.tar', '.gz'].some((extension) => normalized.endsWith(extension))
}

const collectImageAttachments = (response: string): ChatAttachment[] => {
  const attachments: ChatAttachment[] = []
  MARKDOWN_IMAGE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null

  while ((match = MARKDOWN_IMAGE_REGEX.exec(response)) !== null) {
    attachments.push({
      type: 'image',
      url: match[1],
      mimeType: 'image/png'
    })
  }

  return attachments
}

const collectModelAttachments = (response: string): ChatAttachment[] => {
  const attachments: ChatAttachment[] = []
  MARKDOWN_MODEL_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null

  while ((match = MARKDOWN_MODEL_REGEX.exec(response)) !== null) {
    attachments.push({
      type: 'model3d',
      url: match[1],
      fileName: getDownloadFileNameFromUrl(match[1], 'model.glb')
    })
  }

  return attachments
}

const createVideoAttachment = (url: string): ChatAttachment => {
  const fileName = getDownloadFileNameFromUrl(url, 'video.mp4')
  return {
    type: 'video',
    url,
    fileName,
    mimeType: guessMimeTypeFromFileName(fileName, 'video/mp4')
  }
}

const collectVideoAttachments = (response: string): ChatAttachment[] => {
  const attachments: ChatAttachment[] = []
  MARKDOWN_VIDEO_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null

  while ((match = MARKDOWN_VIDEO_REGEX.exec(response)) !== null) {
    attachments.push(createVideoAttachment(match[1]))
  }

  MARKDOWN_FILE_REGEX.lastIndex = 0
  while ((match = MARKDOWN_FILE_REGEX.exec(response)) !== null) {
    const linkText = match[1]
    const url = match[2]
    if (
      isVideoUrl(url) ||
      VIDEO_EXTENSIONS.some((extension) => linkText.toLowerCase().endsWith(extension))
    ) {
      attachments.push(createVideoAttachment(url))
    }
  }

  return attachments
}

const collectHunyuanArtifactAttachments = (response: string): ChatAttachment[] => {
  const attachments: ChatAttachment[] = []
  HUNYUAN_ARTIFACT_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null

  while ((match = HUNYUAN_ARTIFACT_REGEX.exec(response)) !== null) {
    const kind = match[1].toLowerCase()
    const normalizedType = match[2].trim().toUpperCase()
    const url = match[3]

    const attachmentType: ChatAttachment['type'] =
      normalizedType === 'POSTPROCESS_OBJ' ||
      normalizedType === 'ZIP' ||
      normalizedType === 'MTL' ||
      kind === 'file'
        ? 'file'
        : normalizedType === 'MP4' || kind === 'video'
          ? 'video'
          : normalizedType === 'IMAGE' ||
              normalizedType === 'TEXTURE_IMAGE' ||
              isImageUrl(url) ||
              kind === 'image'
            ? 'image'
            : isModel3DUrl(url) || kind === 'model'
              ? 'model3d'
              : 'file'

    if (attachmentType === 'image') {
      attachments.push({
        type: 'image',
        url,
        mimeType: guessMimeTypeFromFileName(
          getDownloadFileNameFromUrl(url, 'image.png'),
          'image/png'
        )
      })
      continue
    }

    if (attachmentType === 'video') {
      const fileName = getDownloadFileNameFromUrl(url, 'video.mp4')
      attachments.push({
        type: 'video',
        url,
        fileName,
        mimeType: guessMimeTypeFromFileName(fileName, 'video/mp4')
      })
      continue
    }

    if (attachmentType === 'model3d') {
      attachments.push({
        type: 'model3d',
        url,
        fileName: getDownloadFileNameFromUrl(url, 'model.glb')
      })
      continue
    }

    const fileName = getDownloadFileNameFromUrl(url, 'file')
    attachments.push({
      type: 'file',
      url,
      fileName,
      mimeType: guessMimeTypeFromFileName(fileName)
    })
  }

  return attachments
}

/** Collect generic file attachments from markdown links like [filename](url) */
const collectFileAttachments = (response: string): ChatAttachment[] => {
  const attachments: ChatAttachment[] = []
  MARKDOWN_FILE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null

  while ((match = MARKDOWN_FILE_REGEX.exec(response)) !== null) {
    const linkText = match[1]
    const url = match[2]
    // Skip if it is an image, video, or 3D model (those are handled separately)
    if (isImageUrl(url) || isVideoUrl(url) || isModel3DUrl(url)) continue
    if (!isGenericFileUrl(url) && !hasArchiveExtension(linkText)) continue

    const urlFileName = getDownloadFileNameFromUrl(url, 'file')
    const resolvedFileName = linkText && hasExplicitFileExtension(linkText) ? linkText : urlFileName

    attachments.push({
      type: 'file',
      url,
      fileName: resolvedFileName,
      mimeType: guessMimeTypeFromFileName(resolvedFileName)
    })
  }

  return attachments
}

const stripCollectedFileMarkdownLinks = (response: string): string => {
  MARKDOWN_FILE_REGEX.lastIndex = 0
  return response.replace(MARKDOWN_FILE_REGEX, (match, linkText, url) => {
    if (
      isVideoUrl(url) ||
      VIDEO_EXTENSIONS.some((extension) => String(linkText).toLowerCase().endsWith(extension))
    ) {
      return ''
    }
    if (isImageUrl(url) || isModel3DUrl(url)) return match
    if (!isGenericFileUrl(url) && !hasArchiveExtension(linkText)) return match
    return ''
  })
}

const dedupeAttachments = (attachments: ChatAttachment[]): ChatAttachment[] => {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = `${attachment.type}::${attachment.url}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const normalizeAttachmentResidualContent = (response: string): string =>
  response.replace(/\n{3,}/g, '\n\n').trim()

const buildStructuredAttachmentLabel = (attachment: ChatAttachment): string =>
  attachment.fileName || `unnamed-${attachment.type}`

const buildStructuredAttachmentHeading = (attachment: ChatAttachment): string => {
  if (attachment.type === 'image') return 'Attached image'
  if (attachment.type === 'video') return 'Attached video'
  if (attachment.type === 'model3d') return 'Attached 3D model'
  return 'Attached file'
}

const buildStructuredAttachmentTypeLabel = (attachment: ChatAttachment): string => {
  if (attachment.type === 'video') return 'video'
  if (attachment.type === 'model3d') return '3D model'
  return attachment.type
}

const buildStructuredAttachmentFallbackSummary = (attachment: ChatAttachment): string =>
  `${buildStructuredAttachmentTypeLabel(attachment)} attached: ${buildStructuredAttachmentLabel(
    attachment
  )}${attachment.mimeType ? ` (${attachment.mimeType})` : ''}`

const buildStructuredAttachmentMetadataSummary = (attachment: ChatAttachment): string => {
  const parts: string[] = []

  if (attachment.fileName?.trim()) {
    parts.push(`fileName="${attachment.fileName.trim()}"`)
  }

  if (attachment.mimeType?.trim()) {
    parts.push(`mimeType="${attachment.mimeType.trim()}"`)
  }

  if (typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)) {
    parts.push(`sizeBytes=${Math.max(0, Math.round(attachment.sizeBytes))}`)
  }

  if (
    typeof attachment.sourceWidth === 'number' &&
    Number.isFinite(attachment.sourceWidth) &&
    attachment.sourceWidth > 0 &&
    typeof attachment.sourceHeight === 'number' &&
    Number.isFinite(attachment.sourceHeight) &&
    attachment.sourceHeight > 0
  ) {
    parts.push(
      `resolution=${Math.round(attachment.sourceWidth)}x${Math.round(attachment.sourceHeight)}`
    )
  }

  return parts.length > 0 ? `Metadata: ${parts.join('; ')}` : ''
}

const buildStructuredAttachmentSummaryBlock = (attachment: ChatAttachment): string =>
  [
    `[${buildStructuredAttachmentHeading(attachment)}] ${buildStructuredAttachmentLabel(attachment)}`,
    buildStructuredAttachmentMetadataSummary(attachment),
    buildStructuredAttachmentFallbackSummary(attachment)
  ]
    .filter(Boolean)
    .join('\n')

const stripStructuredAttachmentSummaryBlocks = (
  content: string,
  attachments: ChatAttachment[] | undefined
): string => {
  if (!attachments?.length || !content.trim()) {
    return normalizeAttachmentResidualContent(content)
  }

  let nextContent = content
  for (const attachment of attachments) {
    const summaryBlock = buildStructuredAttachmentSummaryBlock(attachment)
    if (!summaryBlock) {
      continue
    }

    nextContent = nextContent.split(summaryBlock).join('')
  }

  return normalizeAttachmentResidualContent(nextContent)
}

const normalizeStructuredAttachments = (
  attachments: ChatAttachment[] | undefined,
  fallbackOcrResult?: ChatMessage['ocrResult']
): ChatAttachment[] | undefined => {
  if (!attachments?.length) {
    return undefined
  }

  const normalizedAttachments = attachments.map((attachment) => ({
    ...attachment,
    url: normalizeLocalMediaUrl(attachment.url)
  }))

  const fileAttachments = normalizedAttachments.filter((attachment) => attachment.type === 'file')
  const singleFileAttachment = fileAttachments.length === 1 ? fileAttachments[0] : null

  return normalizedAttachments.map((attachment) => {
    if (attachment.ocrResult || !fallbackOcrResult || attachment !== singleFileAttachment) {
      return attachment
    }

    return {
      ...attachment,
      ocrResult: fallbackOcrResult
    }
  })
}

const buildBuiltInTaggingAssistantMessage = (
  result: {
    content?: string
    attachments?: ChatAttachment[]
    ocrResult?: ChatMessage['ocrResult']
  },
  modelName?: string
): ChatMessage | null => {
  const parsed = parseNormalizedTaggingResponse(result.content || '')
  const firstResult = parsed?.results[0]
  if (!firstResult) {
    return null
  }

  const resolvedOcrResult = result.ocrResult ?? firstResult.ocrResult
  const attachments = normalizeStructuredAttachments(result.attachments, resolvedOcrResult)

  return {
    role: 'assistant',
    content: buildNormalizedTaggingSidecarText(firstResult),
    ...(attachments?.length ? { attachments } : {}),
    ...(resolvedOcrResult ? { ocrResult: resolvedOcrResult } : {}),
    modelName
  }
}

export const buildAssistantMessageFromResponse = (
  response: string,
  modelName?: string
): ChatMessage => {
  const trimmedResponse = response.trim()
  const imageAttachments = collectImageAttachments(trimmedResponse)
  const modelAttachments = collectModelAttachments(trimmedResponse)
  const videoAttachments = collectVideoAttachments(trimmedResponse)
  const inlineFileAttachments = collectFileAttachments(trimmedResponse)
  const hunyuanArtifactAttachments = collectHunyuanArtifactAttachments(trimmedResponse)
  const inlineAttachments = dedupeAttachments([
    ...imageAttachments,
    ...modelAttachments,
    ...videoAttachments,
    ...inlineFileAttachments,
    ...hunyuanArtifactAttachments
  ])

  if (inlineAttachments.length > 0) {
    MARKDOWN_IMAGE_REGEX.lastIndex = 0
    MARKDOWN_MODEL_REGEX.lastIndex = 0
    MARKDOWN_VIDEO_REGEX.lastIndex = 0
    HUNYUAN_ARTIFACT_REGEX.lastIndex = 0
    return {
      role: 'assistant',
      content: normalizeAttachmentResidualContent(
        stripCollectedFileMarkdownLinks(
          trimmedResponse
            .replace(MARKDOWN_IMAGE_REGEX, '')
            .replace(MARKDOWN_MODEL_REGEX, '')
            .replace(MARKDOWN_VIDEO_REGEX, '')
            .replace(HUNYUAN_ARTIFACT_REGEX, '')
        )
      ),
      attachments: inlineAttachments,
      modelName
    }
  }

  if (isImageUrl(trimmedResponse)) {
    return {
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'image',
          url: trimmedResponse,
          mimeType: 'image/png'
        }
      ],
      modelName
    }
  }

  if (isVideoUrl(trimmedResponse)) {
    return {
      role: 'assistant',
      content: '',
      attachments: [createVideoAttachment(trimmedResponse)],
      modelName
    }
  }

  if (isModel3DUrl(trimmedResponse)) {
    return {
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'model3d',
          url: trimmedResponse,
          fileName: getDownloadFileNameFromUrl(trimmedResponse, 'model.glb')
        }
      ],
      modelName
    }
  }

  // Check for generic file URLs (unsupported file types returned by agent)
  const fileAttachments = collectFileAttachments(trimmedResponse)
  if (fileAttachments.length > 0) {
    MARKDOWN_FILE_REGEX.lastIndex = 0
    const remainingContent = trimmedResponse.replace(MARKDOWN_FILE_REGEX, '').trim()
    return {
      role: 'assistant',
      content: remainingContent,
      attachments: fileAttachments,
      modelName
    }
  }

  // If the entire response is a bare file URL, return it as a file attachment
  if (isGenericFileUrl(trimmedResponse)) {
    return {
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'file',
          url: trimmedResponse,
          fileName: getDownloadFileNameFromUrl(trimmedResponse, 'file'),
          mimeType: guessMimeTypeFromFileName(getDownloadFileNameFromUrl(trimmedResponse, 'file'))
        }
      ],
      modelName
    }
  }

  return {
    role: 'assistant',
    content: trimmedResponse,
    modelName
  }
}

export const buildAssistantMessageFromResult = (
  result: {
    content?: string
    attachments?: ChatAttachment[]
    ocrResult?: ChatMessage['ocrResult']
  },
  modelName?: string,
  options?: {
    skillId?: string | null
  }
): ChatMessage => {
  if (options?.skillId === BUILT_IN_TAGGING_SKILL_ID) {
    const taggingMessage = buildBuiltInTaggingAssistantMessage(result, modelName)
    if (taggingMessage) {
      return taggingMessage
    }
  }

  const message = buildAssistantMessageFromResponse(result.content || '', modelName)
  const structuredAttachments = normalizeStructuredAttachments(result.attachments, result.ocrResult)
  const attachments =
    structuredAttachments?.length || message.attachments?.length
      ? dedupeAttachments([...(structuredAttachments || []), ...(message.attachments || [])])
      : undefined
  const content = stripStructuredAttachmentSummaryBlocks(message.content, attachments)

  const normalizedMessage: ChatMessage = {
    role: 'assistant',
    content,
    ...(attachments?.length ? { attachments } : {}),
    ...(result.ocrResult ? { ocrResult: result.ocrResult } : {}),
    modelName
  }

  return normalizedMessage
}
