import {
  type InternalImageDragPayload,
  parseInternalImageDragPayload,
  UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
} from './droppedImageUtils'
import { guessMimeTypeFromFileName } from './fileDisplay'
import { api } from './windowUtils'

type VideoDropReader = Pick<DataTransfer, 'getData' | 'files'>

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.ogg': 'video/ogg',
  '.webm': 'video/webm'
}

const getFileExtension = (fileName?: string): string => {
  const trimmed = fileName?.trim().toLowerCase() || ''
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return ''
  return trimmed.slice(lastDot)
}

const isSupportedVideoDropFile = (file: Pick<File, 'name' | 'type'>): boolean => {
  if (file.type.startsWith('video/')) {
    return true
  }
  return getFileExtension(file.name) in VIDEO_MIME_BY_EXTENSION
}

const describeDroppedVideoFile = (file: Pick<File, 'name' | 'type'>): string => {
  const extension = getFileExtension(file.name)
  if (extension) {
    return extension
  }
  if (file.type.startsWith('video/')) {
    return `.${file.type.slice('video/'.length).toLowerCase()}`
  }
  return 'unknown file'
}

const isLikelyVideoUrl = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  if (
    normalized.startsWith('blob:') ||
    normalized.startsWith('data:video/') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('file://') ||
    normalized.startsWith('local-media://')
  ) {
    return true
  }

  return getFileExtension(normalized) in VIDEO_MIME_BY_EXTENSION
}

const inferFileNameFromUrl = (url: string, fallback: string): string => {
  try {
    const parsed = new URL(url)
    const pathname = decodeURIComponent(parsed.pathname)
    const segments = pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] || fallback
  } catch {
    return fallback
  }
}

const loadVideoFileFromUrl = async (url: string, fallbackFileName: string): Promise<File> => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load dropped video (${response.status})`)
  }

  const blob = await response.blob()
  const fileName = inferFileNameFromUrl(url, fallbackFileName)
  return new File([blob], fileName, {
    type: blob.type || guessMimeTypeFromFileName(fileName, 'video/mp4')
  })
}

export const isVideoOnlyInternalDragPayload = (payload: InternalImageDragPayload): boolean => {
  if (payload.itemTypes && payload.itemTypes.length > 0) {
    return payload.itemTypes.every((type) => type === 'video')
  }

  return getFileExtension(payload.fileItem?.filename) in VIDEO_MIME_BY_EXTENSION
}

const describeUnsupportedInternalDragTypes = (payload: InternalImageDragPayload): string | null => {
  const unsupportedTypes = Array.from(
    new Set((payload.itemTypes || []).filter((type) => type !== 'video'))
  )

  if (unsupportedTypes.length === 0) {
    return null
  }

  return unsupportedTypes.join(', ')
}

const hasInternalFilePayload = (payload: InternalImageDragPayload): boolean =>
  Boolean(
    payload.itemTypes?.includes('file') ||
    payload.attachments?.some((attachment) => attachment.type === 'file')
  )

export const getDroppedVideoDropError = (dataTransfer: VideoDropReader): string | null => {
  const droppedFiles = Array.from(dataTransfer.files ?? [])
  const unsupportedFiles = droppedFiles.filter((file) => !isSupportedVideoDropFile(file))
  if (unsupportedFiles.length > 0) {
    const labels = Array.from(
      new Set(unsupportedFiles.map((file) => describeDroppedVideoFile(file)))
    )
    return `当前视频输入只支持视频文件，不能拖入 ${labels.join(', ')}。`
  }

  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  if (internalPayload && !isVideoOnlyInternalDragPayload(internalPayload)) {
    if (hasInternalFilePayload(internalPayload)) {
      return UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
    }

    const unsupportedTypes =
      describeUnsupportedInternalDragTypes(internalPayload) || 'non-video content'
    return `当前视频输入只支持视频内容，不能拖入 ${unsupportedTypes}。`
  }

  return null
}

const loadVideoFileFromInternalPayload = async (
  payload: InternalImageDragPayload
): Promise<File | null> => {
  const fallbackFileName =
    payload.fileItem?.filename ||
    (payload.promptId ? `qapp-${payload.promptId}.mp4` : 'qapp-video.mp4')

  if (payload.fileItem?.filename) {
    try {
      const response = await api().svcComfy.getView(payload.fileItem)
      return new File([response.result as BlobPart], payload.fileItem.filename, {
        type: guessMimeTypeFromFileName(payload.fileItem.filename, 'video/mp4')
      })
    } catch (error) {
      if (!payload.objectUrl) {
        throw error
      }
    }
  }

  if (!payload.objectUrl) {
    return null
  }

  return loadVideoFileFromUrl(payload.objectUrl, fallbackFileName)
}

const getDroppedVideoUrl = (dataTransfer: Pick<DataTransfer, 'getData'>): string | null => {
  const uriList = dataTransfer.getData('text/uri-list').trim()
  if (uriList && isLikelyVideoUrl(uriList)) {
    return uriList
  }

  const textPayload = dataTransfer.getData('text/plain').trim()
  if (textPayload && isLikelyVideoUrl(textPayload)) {
    return textPayload
  }

  return null
}

export const getDroppedVideoFile = async (dataTransfer: VideoDropReader): Promise<File | null> => {
  const droppedFiles = Array.from(dataTransfer.files ?? [])
  const videoFile = droppedFiles.find((file) => isSupportedVideoDropFile(file))
  if (videoFile) {
    return videoFile
  }

  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  if (internalPayload) {
    if (!isVideoOnlyInternalDragPayload(internalPayload)) {
      return null
    }
    return loadVideoFileFromInternalPayload(internalPayload)
  }

  const droppedVideoUrl = getDroppedVideoUrl(dataTransfer)
  if (!droppedVideoUrl) {
    return null
  }

  return loadVideoFileFromUrl(droppedVideoUrl, 'dropped-video.mp4')
}
