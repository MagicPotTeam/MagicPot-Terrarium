import type { CustomSkillOutputMode } from '@shared/config/config'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

type SkillOutputResult = {
  content: string
  sessionUrl?: string
  attachments?: ChatAttachment[]
  ocrResult?: ChatMessage['ocrResult']
}

type ForcedSkillOutputMode = Extract<CustomSkillOutputMode, 'text' | 'image' | 'video' | 'model3d'>

const UNSUPPORTED_OUTPUT_MODE_MESSAGE = String.fromCharCode(
  0x8be5,
  0x6a21,
  0x578b,
  0x4e0d,
  0x652f,
  0x6301,
  0x8be5,
  0x8f93,
  0x51fa,
  0x65b9,
  0x5f0f
)

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv']
const MODEL3D_EXTENSIONS = [
  '.glb',
  '.gltf',
  '.obj',
  '.fbx',
  '.dae',
  '.3ds',
  '.ply',
  '.stl',
  '.usdz'
]
const MARKDOWN_LINK_REGEX = /(!)?\[([^\]]*)\]\(([^)]+)\)/g
const PLAIN_URL_REGEX = /\b(?:https?:\/\/|file:\/\/\/?|local-media:\/\/)[^\s<>)"']+/g
const HUNYUAN_ARTIFACT_REGEX =
  /^\[Hunyuan3D\]\s+(model|video|image|file):\s+type=([A-Za-z_]+)\s+url=([^\s]+)\s*$/gim

const normalizeOutputMode = (mode: unknown): ForcedSkillOutputMode | null => {
  switch (mode) {
    case 'text':
    case 'image':
    case 'video':
    case 'model3d':
      return mode
    default:
      return null
  }
}

export const resolveSkillOutputImageGenerationOptions = <T extends object | undefined>(
  outputMode: unknown,
  imageGenerationOptions: T
): T | (NonNullable<T> & { enabled: true }) | { enabled: true } => {
  if (outputMode !== 'image') {
    return imageGenerationOptions
  }

  return {
    ...(imageGenerationOptions || {}),
    enabled: true
  } as NonNullable<T> & { enabled: true }
}

const normalizeMediaUrl = (url: string): string => url.trim().replace(/[.,;:!?]+$/u, '')

const getLowerPathBits = (url: string): string[] => {
  const normalized = normalizeMediaUrl(url)
  if (normalized.startsWith('data:image/')) {
    return [normalized.toLowerCase()]
  }

  try {
    const parsed = new URL(normalized)
    return [parsed.pathname, parsed.search, parsed.hash].map((part) =>
      decodeURIComponent(part).toLowerCase()
    )
  } catch {
    return [normalized.toLowerCase()]
  }
}

const hasExtension = (url: string, extensions: readonly string[]): boolean => {
  const bits = getLowerPathBits(url)
  return extensions.some((extension) => bits.some((part) => part.includes(extension)))
}

const inferMediaType = (
  url: string,
  options?: {
    label?: string
    mimeType?: string
    forcedImage?: boolean
    hunyuanKind?: string
    hunyuanType?: string
  }
): Exclude<ChatAttachment['type'], 'file'> | null => {
  const normalizedUrl = normalizeMediaUrl(url)
  const label = options?.label?.toLowerCase() || ''
  const mimeType = options?.mimeType?.toLowerCase() || ''
  const hunyuanKind = options?.hunyuanKind?.toLowerCase() || ''
  const hunyuanType = options?.hunyuanType?.toUpperCase() || ''

  if (
    options?.forcedImage ||
    normalizedUrl.startsWith('data:image/') ||
    mimeType.startsWith('image/') ||
    hunyuanKind === 'image' ||
    hunyuanType === 'IMAGE' ||
    hunyuanType === 'TEXTURE_IMAGE' ||
    hasExtension(normalizedUrl, IMAGE_EXTENSIONS)
  ) {
    return 'image'
  }

  if (
    mimeType.startsWith('video/') ||
    hunyuanKind === 'video' ||
    hunyuanType === 'MP4' ||
    label.includes('video') ||
    hasExtension(normalizedUrl, VIDEO_EXTENSIONS)
  ) {
    return 'video'
  }

  if (
    hunyuanKind === 'model' ||
    label.includes('3d') ||
    label.includes('model') ||
    hasExtension(normalizedUrl, MODEL3D_EXTENSIONS)
  ) {
    return 'model3d'
  }

  return null
}

const getFileNameFromUrl = (url: string, fallback: string): string => {
  try {
    const parsed = new URL(normalizeMediaUrl(url))
    const lastSegment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    return lastSegment || fallback
  } catch {
    return fallback
  }
}

const buildMediaAttachment = (
  type: Exclude<ChatAttachment['type'], 'file'>,
  url: string,
  source?: Partial<ChatAttachment>
): ChatAttachment => {
  const normalizedUrl = normalizeMediaUrl(url)
  if (type === 'image') {
    return {
      ...source,
      type,
      url: normalizedUrl,
      mimeType: source?.mimeType || 'image/png'
    }
  }

  return {
    ...source,
    type,
    url: normalizedUrl,
    fileName:
      source?.fileName ||
      getFileNameFromUrl(normalizedUrl, type === 'video' ? 'video.mp4' : 'model.glb')
  }
}

const normalizeAttachmentAsMedia = (attachment: ChatAttachment): ChatAttachment | null => {
  const mediaType =
    attachment.type === 'image' || attachment.type === 'video' || attachment.type === 'model3d'
      ? attachment.type
      : inferMediaType(attachment.url, {
          label: attachment.fileName,
          mimeType: attachment.mimeType
        })

  return mediaType ? buildMediaAttachment(mediaType, attachment.url, attachment) : null
}

const collectContentMediaAttachments = (content: string): ChatAttachment[] => {
  const attachments: ChatAttachment[] = []

  HUNYUAN_ARTIFACT_REGEX.lastIndex = 0
  let hunyuanMatch: RegExpExecArray | null = null
  while ((hunyuanMatch = HUNYUAN_ARTIFACT_REGEX.exec(content)) !== null) {
    const mediaType = inferMediaType(hunyuanMatch[3], {
      hunyuanKind: hunyuanMatch[1],
      hunyuanType: hunyuanMatch[2]
    })
    if (mediaType) {
      attachments.push(buildMediaAttachment(mediaType, hunyuanMatch[3]))
    }
  }

  MARKDOWN_LINK_REGEX.lastIndex = 0
  let markdownMatch: RegExpExecArray | null = null
  while ((markdownMatch = MARKDOWN_LINK_REGEX.exec(content)) !== null) {
    const mediaType = inferMediaType(markdownMatch[3], {
      forcedImage: markdownMatch[1] === '!',
      label: markdownMatch[2]
    })
    if (mediaType) {
      attachments.push(buildMediaAttachment(mediaType, markdownMatch[3]))
    }
  }

  PLAIN_URL_REGEX.lastIndex = 0
  let urlMatch: RegExpExecArray | null = null
  while ((urlMatch = PLAIN_URL_REGEX.exec(content)) !== null) {
    const mediaType = inferMediaType(urlMatch[0])
    if (mediaType) {
      attachments.push(buildMediaAttachment(mediaType, urlMatch[0]))
    }
  }

  return dedupeAttachments(attachments)
}

const dedupeAttachments = (attachments: ChatAttachment[]): ChatAttachment[] => {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const stripMediaReferences = (content: string): string => {
  const withoutHunyuan = content.replace(HUNYUAN_ARTIFACT_REGEX, '')
  const withoutMarkdown = withoutHunyuan.replace(MARKDOWN_LINK_REGEX, (match, bang, label, url) => {
    const mediaType = inferMediaType(String(url), {
      forcedImage: bang === '!',
      label: String(label || '')
    })
    return mediaType ? '' : match
  })

  return withoutMarkdown
    .replace(PLAIN_URL_REGEX, (match) => (inferMediaType(match) ? '' : match))
    .trim()
}

export const applySkillOutputModeContract = (
  result: SkillOutputResult,
  outputMode: unknown
): SkillOutputResult => {
  const forcedMode = normalizeOutputMode(outputMode)
  if (!forcedMode) {
    return result
  }

  if (forcedMode === 'text') {
    const content = stripMediaReferences(result.content)
    if (!content) {
      throw new Error(UNSUPPORTED_OUTPUT_MODE_MESSAGE)
    }

    return {
      content,
      sessionUrl: result.sessionUrl
    }
  }

  const mediaAttachments = dedupeAttachments([
    ...(result.attachments || []).flatMap((attachment) => {
      const mediaAttachment = normalizeAttachmentAsMedia(attachment)
      return mediaAttachment ? [mediaAttachment] : []
    }),
    ...collectContentMediaAttachments(result.content)
  ])
  const matchingAttachments = mediaAttachments.filter(
    (attachment) => attachment.type === forcedMode
  )

  if (matchingAttachments.length === 0) {
    throw new Error(UNSUPPORTED_OUTPUT_MODE_MESSAGE)
  }

  return {
    content: '',
    sessionUrl: result.sessionUrl,
    attachments: matchingAttachments
  }
}
