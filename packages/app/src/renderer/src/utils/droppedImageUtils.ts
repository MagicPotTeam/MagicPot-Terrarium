import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'
import type { FileItem } from '@shared/comfy/types'
import {
  DEFAULT_PARAMS,
  type Hy3dImageAttachment,
  type Hy3dMediaState,
  type Hy3dParams
} from '@renderer/pages/ChatPage/hy3d/types'
import { api } from './windowUtils'
import {
  getDownloadFileNameFromUrl,
  normalizeLocalMediaUrl
} from '@renderer/pages/ChatPage/chatPageShared'
import { loadImageFromSrc } from '@renderer/pages/ProjectCanvasPage/canvasAssetIntakeHelpers'
import { stripHtmlToText } from './htmlText'

export const QAPP_IMAGE_DRAG_MIME = 'application/x-qapp-image'
export const AGENT_IMAGE_DRAG_MIME = 'application/x-ai-image'
export const INTERNAL_IMAGE_DRAG_PREFIX = 'MAGICPOT_DRAG::'
export const CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY = 'magicpotCanvasCropSource'
export const UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE = '提交的元素含有该功能不知道格式，请重新选择。'

type InternalDragItemType = 'annotation' | 'file' | 'html' | 'image' | 'model3d' | 'text' | 'video'
type InternalAttachmentType = ChatAttachment['type']

const INTERNAL_DRAG_ITEM_TYPES = new Set<InternalDragItemType>([
  'annotation',
  'file',
  'html',
  'image',
  'model3d',
  'text',
  'video'
])

const INTERNAL_ATTACHMENT_TYPES = new Set<InternalAttachmentType>([
  'file',
  'image',
  'model3d',
  'video'
])

const INTERNAL_DRAG_ITEM_TYPE_LABELS: Record<InternalDragItemType, string> = {
  annotation: '标注',
  file: '文件',
  html: 'HTML',
  image: '图片',
  model3d: '3D',
  text: '文本',
  video: '视频'
}

export type InternalImageDragPayload = {
  objectUrl?: string
  promptId?: string
  fileItem?: FileItem
  sourceCanvasId?: string
  itemTypes?: InternalDragItemType[]
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  previewImageUrl?: string
  textContent?: string
  hiddenTextContent?: string
  sourceWidth?: number
  sourceHeight?: number
  hy3dQuickAppKey?: string
  hy3dParams?: Hy3dParams
  hy3dMediaState?: Hy3dMediaState
}

type DragDataReader = Pick<DataTransfer, 'getData'>
type ImageDropReader = Pick<DataTransfer, 'getData' | 'files'>
type ImageDropOptions = {
  allowSvg?: boolean
}

const IMAGE_EXTENSIONS_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

const isSupportedImageDropFile = (
  file: Pick<File, 'name' | 'type'>,
  options?: ImageDropOptions
): boolean => file.type.startsWith('image/') && (options?.allowSvg || file.type !== 'image/svg+xml')

const describeDroppedImageFile = (file: Pick<File, 'name' | 'type'>): string => {
  const trimmedName = file.name.trim()
  if (trimmedName) {
    const lastDot = trimmedName.lastIndexOf('.')
    if (lastDot > 0 && lastDot < trimmedName.length - 1) {
      return trimmedName.slice(lastDot).toLowerCase()
    }
    return trimmedName
  }

  if (file.type === 'image/svg+xml') return '.svg'
  if (file.type.startsWith('image/')) {
    return `.${file.type.slice('image/'.length).toLowerCase()}`
  }

  return 'unknown file'
}

const parseOcrResult = (value: unknown): OCRResult | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const parsed = value as OCRResult
  if (!['text', 'table', 'document'].includes(parsed.kind)) {
    return undefined
  }

  return parsed
}

const isHy3dImageAttachment = (value: unknown): value is Hy3dImageAttachment =>
  !!value &&
  typeof value === 'object' &&
  (value as { type?: unknown }).type === 'image' &&
  typeof (value as { url?: unknown }).url === 'string'

type CanvasImageCropSourceMetadata = {
  url: string
  fileName?: string
  sourceWidth: number
  sourceHeight: number
  crop: { x: number; y: number; width: number; height: number }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getPositiveFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const parseCanvasImageCropSourceMetadata = (
  value: unknown
): CanvasImageCropSourceMetadata | null => {
  if (!isPlainRecord(value)) return null

  const crop = isPlainRecord(value.crop) ? value.crop : null
  const sourceWidth = getPositiveFiniteNumber(value.sourceWidth)
  const sourceHeight = getPositiveFiniteNumber(value.sourceHeight)
  const cropX = typeof crop?.x === 'number' && Number.isFinite(crop.x) ? crop.x : undefined
  const cropY = typeof crop?.y === 'number' && Number.isFinite(crop.y) ? crop.y : undefined
  const cropWidth = getPositiveFiniteNumber(crop?.width)
  const cropHeight = getPositiveFiniteNumber(crop?.height)

  if (
    typeof value.url !== 'string' ||
    !value.url.trim() ||
    !sourceWidth ||
    !sourceHeight ||
    cropX === undefined ||
    cropY === undefined ||
    !cropWidth ||
    !cropHeight
  ) {
    return null
  }

  return {
    url: value.url,
    fileName:
      typeof value.fileName === 'string' && value.fileName.trim() ? value.fileName : undefined,
    sourceWidth,
    sourceHeight,
    crop: {
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight
    }
  }
}

const parseHy3dMediaState = (value: unknown): Hy3dMediaState | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Partial<Hy3dMediaState>
  return {
    conceptImages: Array.isArray(candidate.conceptImages)
      ? candidate.conceptImages.filter(isHy3dImageAttachment)
      : [],
    textureRefImages: Array.isArray(candidate.textureRefImages)
      ? candidate.textureRefImages.filter(isHy3dImageAttachment)
      : [],
    profileRefImage: isHy3dImageAttachment(candidate.profileRefImage)
      ? candidate.profileRefImage
      : null
  }
}

const parseHy3dParams = (value: unknown): Hy3dParams | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  return {
    ...DEFAULT_PARAMS,
    ...(value as Partial<Hy3dParams>)
  }
}

const parsePayload = (raw: string): InternalImageDragPayload | null => {
  try {
    const parsed = JSON.parse(raw) as InternalImageDragPayload
    if (!parsed || typeof parsed !== 'object') return null

    const itemTypes = Array.isArray(parsed.itemTypes)
      ? parsed.itemTypes.filter(
          (type): type is InternalDragItemType =>
            typeof type === 'string' && INTERNAL_DRAG_ITEM_TYPES.has(type as InternalDragItemType)
        )
      : undefined

    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.flatMap((attachment) => {
          if (!attachment || typeof attachment !== 'object') return []
          if (
            typeof attachment.type !== 'string' ||
            !INTERNAL_ATTACHMENT_TYPES.has(attachment.type as InternalAttachmentType)
          ) {
            return []
          }
          if (typeof attachment.url !== 'string' || !attachment.url.trim()) return []

          return [
            {
              type: attachment.type as InternalAttachmentType,
              url: attachment.url,
              mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
              fileName: typeof attachment.fileName === 'string' ? attachment.fileName : undefined,
              sizeBytes:
                typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)
                  ? attachment.sizeBytes
                  : undefined,
              sourceWidth:
                typeof (attachment as ChatAttachment).sourceWidth === 'number' &&
                Number.isFinite((attachment as ChatAttachment).sourceWidth) &&
                (attachment as ChatAttachment).sourceWidth! > 0
                  ? (attachment as ChatAttachment).sourceWidth
                  : undefined,
              sourceHeight:
                typeof (attachment as ChatAttachment).sourceHeight === 'number' &&
                Number.isFinite((attachment as ChatAttachment).sourceHeight) &&
                (attachment as ChatAttachment).sourceHeight! > 0
                  ? (attachment as ChatAttachment).sourceHeight
                  : undefined,
              ocrResult: parseOcrResult((attachment as ChatAttachment).ocrResult),
              reportBundleId:
                typeof (attachment as ChatAttachment).reportBundleId === 'string'
                  ? (attachment as ChatAttachment).reportBundleId
                  : undefined,
              reportBundleRole:
                typeof (attachment as ChatAttachment).reportBundleRole === 'string'
                  ? (attachment as ChatAttachment).reportBundleRole
                  : undefined,
              reportBundleRefName:
                typeof (attachment as ChatAttachment).reportBundleRefName === 'string'
                  ? (attachment as ChatAttachment).reportBundleRefName
                  : undefined,
              reportBundleManifestUrl:
                typeof (attachment as ChatAttachment).reportBundleManifestUrl === 'string'
                  ? (attachment as ChatAttachment).reportBundleManifestUrl
                  : undefined,
              reportBundleLabel:
                typeof (attachment as ChatAttachment).reportBundleLabel === 'string'
                  ? (attachment as ChatAttachment).reportBundleLabel
                  : undefined,
              ...(isPlainRecord((attachment as ChatAttachment).metadata)
                ? { metadata: { ...(attachment as ChatAttachment).metadata } }
                : {})
            } satisfies ChatAttachment
          ]
        })
      : undefined
    const hy3dParams = parseHy3dParams((parsed as InternalImageDragPayload).hy3dParams)
    const hy3dMediaState = parseHy3dMediaState((parsed as InternalImageDragPayload).hy3dMediaState)

    return {
      objectUrl: typeof parsed.objectUrl === 'string' ? parsed.objectUrl : undefined,
      promptId: typeof parsed.promptId === 'string' ? parsed.promptId : undefined,
      fileItem: parsed.fileItem,
      sourceCanvasId:
        typeof parsed.sourceCanvasId === 'string' && parsed.sourceCanvasId.trim()
          ? parsed.sourceCanvasId
          : undefined,
      itemTypes: itemTypes && itemTypes.length > 0 ? itemTypes : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      ocrResult: parseOcrResult(parsed.ocrResult),
      previewImageUrl:
        typeof parsed.previewImageUrl === 'string' ? parsed.previewImageUrl : undefined,
      textContent:
        typeof parsed.textContent === 'string' && parsed.textContent.trim()
          ? parsed.textContent
          : undefined,
      ...((typeof parsed.hiddenTextContent === 'string' && parsed.hiddenTextContent.trim()
        ? { hiddenTextContent: parsed.hiddenTextContent }
        : {}) as Pick<InternalImageDragPayload, 'hiddenTextContent'>),
      sourceWidth:
        typeof parsed.sourceWidth === 'number' &&
        Number.isFinite(parsed.sourceWidth) &&
        parsed.sourceWidth > 0
          ? parsed.sourceWidth
          : undefined,
      sourceHeight:
        typeof parsed.sourceHeight === 'number' &&
        Number.isFinite(parsed.sourceHeight) &&
        parsed.sourceHeight > 0
          ? parsed.sourceHeight
          : undefined,
      hy3dQuickAppKey:
        typeof (parsed as InternalImageDragPayload).hy3dQuickAppKey === 'string' &&
        (parsed as InternalImageDragPayload).hy3dQuickAppKey?.trim()
          ? (parsed as InternalImageDragPayload).hy3dQuickAppKey
          : undefined,
      hy3dParams,
      hy3dMediaState
    }
  } catch {
    return null
  }
}

export const parseInternalImageDragPayload = (
  dataTransfer: DragDataReader
): InternalImageDragPayload | null => {
  const directPayload = dataTransfer.getData(QAPP_IMAGE_DRAG_MIME).trim()
  if (directPayload) return parsePayload(directPayload)

  const textPayload = dataTransfer.getData('text/plain').trim()
  if (!textPayload.startsWith(INTERNAL_IMAGE_DRAG_PREFIX)) return null

  return parsePayload(textPayload.slice(INTERNAL_IMAGE_DRAG_PREFIX.length).trim())
}

export const isImageOnlyInternalDragPayload = (payload: InternalImageDragPayload): boolean => {
  if (!payload.itemTypes || payload.itemTypes.length === 0) return true
  return payload.itemTypes.every((type) => type === 'image')
}

const hasInternalFilePayload = (payload: InternalImageDragPayload): boolean =>
  Boolean(
    payload.itemTypes?.includes('file') ||
    payload.attachments?.some((attachment) => attachment.type === 'file')
  )

export const hasRestorableHy3dQuickAppPayload = (payload: InternalImageDragPayload): boolean =>
  Boolean(
    (payload.itemTypes?.includes('model3d') ||
      payload.attachments?.some((attachment) => attachment.type === 'model3d')) &&
    payload.hy3dParams
  )

const describeUnsupportedInternalDragTypes = (payload: InternalImageDragPayload): string | null => {
  const unsupportedTypes = Array.from(
    new Set((payload.itemTypes || []).filter((type) => type !== 'image'))
  )
  if (unsupportedTypes.length === 0) return null

  return unsupportedTypes.map((type) => INTERNAL_DRAG_ITEM_TYPE_LABELS[type] || type).join(', ')
}

const describeUnsupportedWorkflowImportTypes = (
  payload: InternalImageDragPayload
): string | null => {
  const unsupportedTypes = Array.from(
    new Set((payload.itemTypes || []).filter((type) => type !== 'image' && type !== 'video'))
  )
  if (unsupportedTypes.length === 0) return null

  return unsupportedTypes.map((type) => INTERNAL_DRAG_ITEM_TYPE_LABELS[type] || type).join(', ')
}

export const getQuickAppWorkflowImportError = (
  payload: InternalImageDragPayload
): string | null => {
  if (hasInternalFilePayload(payload)) {
    return UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
  }

  if (hasRestorableHy3dQuickAppPayload(payload)) {
    return null
  }

  const unsupportedTypes = describeUnsupportedWorkflowImportTypes(payload)
  if (unsupportedTypes) {
    return `当前快应用根区域只支持拖入带工作流的图片/视频或 .mpqapp 文件，不支持 ${unsupportedTypes}。`
  }

  if (!payload.promptId && !payload.fileItem) {
    return '该拖拽内容不包含可导入的工作流信息，请拖入快应用结果图、结果视频或 .mpqapp 文件。'
  }

  return null
}

export const getDroppedImageDropError = (
  dataTransfer: ImageDropReader,
  options?: ImageDropOptions
): string | null => {
  const droppedFiles = Array.from(dataTransfer.files ?? [])
  const unsupportedFiles = droppedFiles.filter((file) => !isSupportedImageDropFile(file, options))
  if (unsupportedFiles.length > 0) {
    const labels = Array.from(
      new Set(unsupportedFiles.map((file) => describeDroppedImageFile(file)))
    )
    return `当前图片输入只支持图片文件，不能拖入 ${labels.join(', ')}。`
  }

  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  if (internalPayload && !isImageOnlyInternalDragPayload(internalPayload)) {
    if (hasInternalFilePayload(internalPayload)) {
      return '当前图片输入只支持图片内容，不能拖入文件。'
    }

    const unsupportedTypes = describeUnsupportedInternalDragTypes(internalPayload) || '非图片内容'
    return `当前图片输入只支持图片内容，不能拖入 ${unsupportedTypes}。`
  }

  return null
}

const isLikelyImageUrl = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.startsWith('blob:') ||
    normalized.startsWith('data:image/') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('file://') ||
    normalized.startsWith('local-media://')
  )
}

export const getDroppedImageUrl = (dataTransfer: DragDataReader): string | null => {
  const directAgentUrl = dataTransfer.getData(AGENT_IMAGE_DRAG_MIME).trim()
  if (directAgentUrl && isLikelyImageUrl(directAgentUrl)) return directAgentUrl

  const uriList = dataTransfer.getData('text/uri-list').trim()
  if (uriList && isLikelyImageUrl(uriList)) return uriList

  const textPayload = dataTransfer.getData('text/plain').trim()
  if (
    textPayload &&
    !textPayload.startsWith(INTERNAL_IMAGE_DRAG_PREFIX) &&
    isLikelyImageUrl(textPayload)
  ) {
    return textPayload
  }

  return null
}

const decodeLocalImagePath = (url: string): string | null => {
  if (url.startsWith('local-media:///')) {
    return decodeURIComponent(url.slice('local-media:///'.length))
  }

  if (url.startsWith('local-media://')) {
    return decodeURIComponent(url.slice('local-media://'.length).replace(/^\/+/, ''))
  }

  if (url.startsWith('file:///')) {
    return decodeURIComponent(url.slice('file:///'.length))
  }

  if (url.startsWith('file://')) {
    return decodeURIComponent(url.slice('file://'.length).replace(/^\/+/, ''))
  }

  return null
}

const inferMimeTypeFromFileName = (fileName: string): string => {
  const lowerName = fileName.toLowerCase()
  const extension = Object.keys(IMAGE_EXTENSIONS_TO_MIME).find((ext) => lowerName.endsWith(ext))
  return (extension && IMAGE_EXTENSIONS_TO_MIME[extension]) || 'image/png'
}

const inferFileNameFromUrl = (url: string, fallback: string): string => {
  if (url.startsWith('data:')) {
    return fallback
  }

  const localPath = decodeLocalImagePath(url)
  if (localPath) {
    const segments = localPath.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || fallback
  }

  try {
    const parsed = new URL(url)
    const pathname = decodeURIComponent(parsed.pathname)
    const segments = pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] || fallback
  } catch {
    return fallback
  }
}

const loadImageFileFromUrl = async (url: string, fallbackFileName: string): Promise<File> => {
  const localPath = decodeLocalImagePath(url)
  if (localPath) {
    const { image, filename } = await api().svcFs.readImageFromPath({ fullPath: localPath })
    const fileName = filename || fallbackFileName
    return new File([image as BlobPart], fileName, {
      type: inferMimeTypeFromFileName(fileName)
    })
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load dropped image (${response.status})`)
  }

  const blob = await response.blob()
  const fileName = url.trim().toLowerCase().startsWith('data:')
    ? fallbackFileName
    : inferFileNameFromUrl(url, fallbackFileName)
  return new File([blob], fileName, {
    type: blob.type || inferMimeTypeFromFileName(fileName)
  })
}

const estimateDataUrlByteSize = (dataUrl: string): number | undefined => {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return undefined

  const payload = dataUrl.slice(commaIndex + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

type LoadedDropImageSource = {
  image: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

const loadImageSourceFromFile = async (file: File): Promise<LoadedDropImageSource> => {
  if (typeof createImageBitmap === 'function') {
    const image = await createImageBitmap(file)
    return {
      image,
      width: image.width,
      height: image.height,
      close: () => image.close()
    }
  }

  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Cannot decode image in this environment')
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to decode dropped image'))
  })
  image.src = objectUrl

  try {
    const loadedImage = await loaded
    return {
      image: loadedImage,
      width: loadedImage.naturalWidth || loadedImage.width,
      height: loadedImage.naturalHeight || loadedImage.height,
      close: () => URL.revokeObjectURL(objectUrl)
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

const loadImageSourceFromCanvasLoader = async (url: string): Promise<LoadedDropImageSource> => {
  const loaded = await loadImageFromSrc(url)
  return {
    image: loaded.img,
    width: loaded.width,
    height: loaded.height
  }
}

const cropImageAttachmentFromSource = async (
  cropSource: CanvasImageCropSourceMetadata,
  fallbackFileName: string
): Promise<ChatAttachment> => {
  if (typeof document === 'undefined') {
    throw new Error('Cannot crop image without a document')
  }

  const sourceImage: LoadedDropImageSource = await (async (): Promise<LoadedDropImageSource> => {
    try {
      const file = await loadImageFileFromUrl(cropSource.url, fallbackFileName)
      return await loadImageSourceFromFile(file)
    } catch (error) {
      console.warn(
        '[DropImage] failed to decode cropped canvas source through file payload; retrying canvas loader:',
        error
      )
      return await loadImageSourceFromCanvasLoader(cropSource.url)
    }
  })()
  const outputWidth = Math.max(1, Math.round(cropSource.crop.width))
  const outputHeight = Math.max(1, Math.round(cropSource.crop.height))
  const scaleX = sourceImage.width / cropSource.sourceWidth
  const scaleY = sourceImage.height / cropSource.sourceHeight
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight

  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Cannot create image crop canvas')

    context.drawImage(
      sourceImage.image,
      cropSource.crop.x * scaleX,
      cropSource.crop.y * scaleY,
      cropSource.crop.width * scaleX,
      cropSource.crop.height * scaleY,
      0,
      0,
      outputWidth,
      outputHeight
    )

    const url = canvas.toDataURL('image/png')
    return {
      type: 'image',
      url,
      mimeType: 'image/png',
      fileName: cropSource.fileName || fallbackFileName,
      sizeBytes: estimateDataUrlByteSize(url),
      sourceWidth: outputWidth,
      sourceHeight: outputHeight
    }
  } finally {
    sourceImage.close?.()
  }
}

export const materializeInternalImageDragAttachment = async (
  attachment: ChatAttachment
): Promise<ChatAttachment | null> => {
  if (attachment.type !== 'image') return attachment

  const cropSource = parseCanvasImageCropSourceMetadata(
    attachment.metadata?.[CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY]
  )
  if (!cropSource) return attachment

  try {
    const croppedAttachment = await cropImageAttachmentFromSource(
      cropSource,
      attachment.fileName || cropSource.fileName || 'canvas-image.png'
    )
    const metadata = isPlainRecord(attachment.metadata) ? { ...attachment.metadata } : undefined
    if (metadata) {
      delete metadata[CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY]
    }

    const materializedAttachment: ChatAttachment = {
      ...attachment,
      ...croppedAttachment
    }
    if (metadata && Object.keys(metadata).length > 0) {
      materializedAttachment.metadata = metadata
    } else {
      delete materializedAttachment.metadata
    }
    return materializedAttachment
  } catch (error) {
    console.warn('[DropImage] failed to crop internal canvas image from original source:', error)
    return null
  }
}

export const materializeInternalImageDragAttachments = async (
  attachments: ChatAttachment[]
): Promise<ChatAttachment[]> => {
  const materialized = await Promise.all(attachments.map(materializeInternalImageDragAttachment))
  return materialized.filter((attachment): attachment is ChatAttachment => Boolean(attachment))
}

export const hasInternalCanvasImageCropSourceAttachment = (
  payload: InternalImageDragPayload
): boolean =>
  Boolean(
    payload.attachments?.some(
      (attachment) =>
        attachment.type === 'image' &&
        parseCanvasImageCropSourceMetadata(
          attachment.metadata?.[CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY]
        )
    )
  )

const loadImageFileFromInternalPayload = async (
  payload: InternalImageDragPayload
): Promise<File | null> => {
  const croppedImageAttachments =
    payload.attachments?.filter(
      (attachment) =>
        attachment.type === 'image' &&
        parseCanvasImageCropSourceMetadata(
          attachment.metadata?.[CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY]
        )
    ) || []
  if (croppedImageAttachments.length === 1) {
    const materializedAttachment = await materializeInternalImageDragAttachment(
      croppedImageAttachments[0]
    )
    if (!materializedAttachment) return null
    return loadImageFileFromUrl(
      materializedAttachment.url,
      materializedAttachment.fileName || 'canvas-image.png'
    )
  }

  const fallbackFileName =
    payload.fileItem?.filename ||
    (payload.promptId ? `qapp-${payload.promptId}.png` : 'qapp-image.png')

  if (payload.fileItem?.filename) {
    try {
      const response = await api().svcComfy.getView(payload.fileItem)
      return new File([response.result as BlobPart], payload.fileItem.filename, {
        type: inferMimeTypeFromFileName(payload.fileItem.filename)
      })
    } catch (error) {
      if (!payload.objectUrl) throw error
    }
  }

  if (!payload.objectUrl) return null

  return loadImageFileFromUrl(payload.objectUrl, fallbackFileName)
}

export const getDroppedImageFile = async (
  dataTransfer: ImageDropReader,
  options?: ImageDropOptions
): Promise<File | null> => {
  const droppedFiles = Array.from(dataTransfer.files ?? [])
  const imageFile = droppedFiles.find((file) => isSupportedImageDropFile(file, options))
  if (imageFile) return imageFile

  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  if (internalPayload) {
    if (!isImageOnlyInternalDragPayload(internalPayload)) return null
    return loadImageFileFromInternalPayload(internalPayload)
  }

  const droppedImageUrl = getDroppedImageUrl(dataTransfer)
  if (!droppedImageUrl) return null

  return loadImageFileFromUrl(droppedImageUrl, 'dropped-image.png')
}

export const getDroppedAttachmentFile = async (
  dataTransfer: DragDataReader
): Promise<File | null> => {
  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  const attachment = internalPayload?.attachments?.find((item) => item.type === 'file')

  if (!attachment?.url) {
    return null
  }

  const normalizedUrl = normalizeLocalMediaUrl(attachment.url)
  const localPath = decodeLocalImagePath(normalizedUrl)
  if (localPath) {
    const { data, filename } = await api().svcFs.readFileFromPath({ fullPath: localPath })
    const fileName =
      attachment.fileName || filename || getDownloadFileNameFromUrl(normalizedUrl, 'attachment')

    return new File([data as BlobPart], fileName, {
      type: attachment.mimeType || 'application/octet-stream'
    })
  }

  const response = await fetch(normalizedUrl)
  if (!response.ok) {
    throw new Error(`Failed to load dropped attachment (${response.status})`)
  }

  const blob = await response.blob()
  const fileName = attachment.fileName || getDownloadFileNameFromUrl(normalizedUrl, 'attachment')

  return new File([blob], fileName, {
    type: attachment.mimeType || blob.type || 'application/octet-stream'
  })
}

export const getDroppedTextContent = (dataTransfer: DragDataReader): string | null => {
  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  if (internalPayload?.textContent?.trim() && internalPayload.itemTypes?.includes('text')) {
    return internalPayload.textContent
  }
  if (internalPayload) {
    return null
  }

  const plainText = dataTransfer.getData('text/plain')
  if (plainText && !plainText.trim().startsWith(INTERNAL_IMAGE_DRAG_PREFIX) && plainText.trim()) {
    return plainText
  }

  const legacyText = dataTransfer.getData('text') || dataTransfer.getData('Text')
  if (legacyText.trim()) {
    return legacyText
  }

  const htmlText = dataTransfer.getData('text/html')
  if (htmlText.trim()) {
    const strippedText = stripHtmlToText(htmlText)
    return strippedText || null
  }

  return null
}
