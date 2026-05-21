import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasGroup,
  CanvasImageAsset,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'
import { isConstraintAttachedCaptionAnnotation } from './canvasAttachedCaptionUtils'
import { loadImageFromSrc } from './canvasAssetIntakeHelpers'
import { getCanvasImageAssetSize } from './canvasImageAssetUtils'
import { estimateDataUrlByteSize } from './canvasImageMetadata'
import { normalizeCanvasImageDisplayCrop } from './canvasImageDisplayUtils'

export type CanvasAgentAttachment = {
  type: 'image' | 'file' | 'video' | 'model3d'
  url: string
  mimeType: string
  fileName: string
  sizeBytes?: number
  sourceWidth?: number
  sourceHeight?: number
  reportBundleId?: CanvasFileItem['reportBundleId']
  reportBundleRole?: CanvasFileItem['reportBundleRole']
  reportBundleRefName?: CanvasFileItem['reportBundleRefName']
  reportBundleManifestUrl?: CanvasFileItem['reportBundleManifestUrl']
  metadata?: Record<string, unknown>
}

export const CANVAS_IMAGE_CROP_SOURCE_METADATA_KEY = 'magicpotCanvasCropSource'

export type CanvasImageCropSourceMetadata = {
  url: string
  fileName: string
  sourceWidth: number
  sourceHeight: number
  crop: { x: number; y: number; width: number; height: number }
}

export type CanvasLayoutRequestMessage = {
  role: 'user'
  content: string
  attachments?: CanvasAgentAttachment[]
}

type AttachedCaptionAnnotation = CanvasAnnotationItem & {
  attachedToId?: string
  attachmentPlacement?: 'bottom-center'
}

function isAttachedCaptionAnnotation(item: CanvasItem): item is AttachedCaptionAnnotation {
  return (
    item.type === 'annotation' &&
    item.shape === 'text-anno' &&
    typeof (item as AttachedCaptionAnnotation).attachedToId === 'string' &&
    Boolean((item as AttachedCaptionAnnotation).attachedToId)
  )
}

function getCoreAgentSendItemIds(targetItems: CanvasItem[]): string[] {
  return targetItems.filter((item) => !isAttachedCaptionAnnotation(item)).map((item) => item.id)
}

function findExactGroupForAgentSend(
  targetItems: CanvasItem[],
  allItems: CanvasItem[],
  groups: CanvasGroup[]
): CanvasGroup | null {
  const coreIds = getCoreAgentSendItemIds(targetItems)
  if (coreIds.length === 0) return null

  const coreIdSet = new Set(coreIds)
  const allItemIds = new Set(allItems.map((item) => item.id))

  for (const group of groups) {
    const validGroupItemIds = group.itemIds.filter((itemId) => allItemIds.has(itemId))
    if (validGroupItemIds.length !== coreIdSet.size) continue
    if (validGroupItemIds.every((itemId) => coreIdSet.has(itemId))) {
      return group
    }
  }

  return null
}

export function getCanvasBlobItemMimeType(item: CanvasVideoItem | CanvasModel3DItem): string {
  const ext = item.fileName.toLowerCase().split('.').pop() || ''

  if (item.type === 'video') {
    switch (ext) {
      case 'mp4':
        return 'video/mp4'
      case 'webm':
        return 'video/webm'
      case 'mov':
        return 'video/quicktime'
      case 'avi':
        return 'video/x-msvideo'
      case 'mkv':
        return 'video/x-matroska'
      case 'ogg':
        return 'video/ogg'
      default:
        return 'video/*'
    }
  }

  switch (ext) {
    case 'glb':
      return 'model/gltf-binary'
    case 'gltf':
      return 'model/gltf+json'
    case 'fbx':
      return 'application/octet-stream'
    case 'obj':
      return 'text/plain'
    case 'stl':
      return 'model/stl'
    default:
      return 'application/octet-stream'
  }
}

function toLocalMediaUrl(src: string): string {
  if (src.startsWith('local-media://')) return src
  if (src.startsWith('file:///')) return `local-media:///${src.slice('file:///'.length)}`
  return src
}

function inferFileNameFromUrl(src: string, fallback: string): string {
  const normalizedSrc = toLocalMediaUrl(src)

  if (normalizedSrc.startsWith('data:')) {
    return fallback
  }

  const localMatch = normalizedSrc.match(/^local-media:\/\/\/?(.*)$/)
  if (localMatch?.[1]) {
    const segments = decodeURIComponent(localMatch[1]).split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || fallback
  }

  try {
    const parsed = new URL(normalizedSrc)
    const segments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean)
    return segments[segments.length - 1] || fallback
  } catch {
    return fallback
  }
}

function getCanvasFileMimeType(
  item: Pick<CanvasFileItem, 'fileName' | 'mimeType' | 'fileKind'>
): string {
  const rawMimeType = item.mimeType?.trim().toLowerCase()
  if (rawMimeType && rawMimeType !== 'application/octet-stream') return rawMimeType

  const lowerFileName = item.fileName.toLowerCase()
  if (lowerFileName.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (lowerFileName.endsWith('.doc')) return 'application/msword'
  if (lowerFileName.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  if (lowerFileName.endsWith('.xls')) return 'application/vnd.ms-excel'
  if (lowerFileName.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  if (lowerFileName.endsWith('.ppt')) return 'application/vnd.ms-powerpoint'
  if (lowerFileName.endsWith('.md') || item.fileKind === 'markdown') return 'text/markdown'
  if (lowerFileName.endsWith('.txt') || item.fileKind === 'text') return 'text/plain'
  return rawMimeType || 'application/octet-stream'
}

function getCanvasImageMimeType(item: Pick<CanvasImageItem, 'fileName' | 'src'>): string {
  const dataUrlMimeTypeMatch = item.src.match(/^data:([^;,]+)/i)
  if (dataUrlMimeTypeMatch?.[1]) {
    return dataUrlMimeTypeMatch[1]
  }

  const lowerFileName = item.fileName?.toLowerCase() || ''
  if (lowerFileName.endsWith('.png')) return 'image/png'
  if (lowerFileName.endsWith('.jpg') || lowerFileName.endsWith('.jpeg')) return 'image/jpeg'
  if (lowerFileName.endsWith('.webp')) return 'image/webp'
  if (lowerFileName.endsWith('.gif')) return 'image/gif'
  if (lowerFileName.endsWith('.bmp')) return 'image/bmp'
  if (lowerFileName.endsWith('.svg')) return 'image/svg+xml'
  if (lowerFileName.endsWith('.ico')) return 'image/x-icon'
  return 'image/png'
}

type MaterializedCanvasImageAttachmentSource = {
  src: string
  fileName: string
  sizeBytes?: number
  sourceWidth: number
  sourceHeight: number
}

function getPositiveNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function getPngFileName(fileName: string): string {
  const trimmed = fileName.trim()
  if (!trimmed) return 'canvas-image.png'

  const withoutExtension = trimmed.replace(/\.[^./\\]+$/, '')
  return `${withoutExtension || 'canvas-image'}.png`
}

function isFullSourceCrop(
  crop: NonNullable<CanvasImageItem['crop']>,
  sourceWidth: number,
  sourceHeight: number
): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === sourceWidth && crop.height === sourceHeight
}

async function resolveCanvasImageAttachmentSourceAsset(
  item: CanvasImageItem,
  sourceWidth: number,
  sourceHeight: number
): Promise<{ image: CanvasImageAsset; width: number; height: number } | null> {
  const itemImageSize = getCanvasImageAssetSize(item.image)
  if (
    item.image &&
    itemImageSize.width > 0 &&
    itemImageSize.height > 0 &&
    Math.abs(itemImageSize.width - sourceWidth) <= 1 &&
    Math.abs(itemImageSize.height - sourceHeight) <= 1
  ) {
    return {
      image: item.image,
      width: itemImageSize.width,
      height: itemImageSize.height
    }
  }

  const loaded = await loadImageFromSrc(item.src)
  if (loaded.width <= 0 || loaded.height <= 0) {
    return null
  }

  return {
    image: loaded.img,
    width: loaded.width,
    height: loaded.height
  }
}

function resolveCanvasImageAttachmentSourceSize(item: CanvasImageItem): {
  sourceWidth: number | null
  sourceHeight: number | null
} {
  const initialImageSize = getCanvasImageAssetSize(item.image)
  const sourceWidth =
    getPositiveNumber(item.sourceWidth) ??
    getPositiveNumber(initialImageSize.width) ??
    getPositiveNumber(item.width)
  const sourceHeight =
    getPositiveNumber(item.sourceHeight) ??
    getPositiveNumber(initialImageSize.height) ??
    getPositiveNumber(item.height)

  return { sourceWidth, sourceHeight }
}

function materializeCanvasImageAttachmentSourceFromAsset(
  item: CanvasImageItem,
  sourceAsset: { image: CanvasImageAsset; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number
): MaterializedCanvasImageAttachmentSource | null {
  if (!item.crop || typeof document === 'undefined') return null

  const sourceCrop = normalizeCanvasImageDisplayCrop(item.crop, sourceWidth, sourceHeight)
  if (!sourceCrop || isFullSourceCrop(sourceCrop, sourceWidth, sourceHeight)) {
    return null
  }

  const scaleX = sourceAsset.width / sourceWidth
  const scaleY = sourceAsset.height / sourceHeight
  const cropX = sourceCrop.x * scaleX
  const cropY = sourceCrop.y * scaleY
  const cropWidth = sourceCrop.width * scaleX
  const cropHeight = sourceCrop.height * scaleY
  const outputWidth = Math.max(1, Math.round(sourceCrop.width))
  const outputHeight = Math.max(1, Math.round(sourceCrop.height))

  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const context = canvas.getContext('2d')
  if (!context) return null

  context.drawImage(
    sourceAsset.image,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    outputWidth,
    outputHeight
  )

  const src = canvas.toDataURL('image/png')
  return {
    src,
    fileName: getPngFileName(item.fileName?.trim() || inferFileNameFromUrl(item.src, item.id)),
    sizeBytes: estimateDataUrlByteSize(src),
    sourceWidth: outputWidth,
    sourceHeight: outputHeight
  }
}

export function buildCanvasImageCropSourceMetadata(
  item: CanvasImageItem
): CanvasImageCropSourceMetadata | null {
  if (!item.crop) return null

  const { sourceWidth, sourceHeight } = resolveCanvasImageAttachmentSourceSize(item)
  if (!sourceWidth || !sourceHeight) return null

  const sourceCrop = normalizeCanvasImageDisplayCrop(item.crop, sourceWidth, sourceHeight)
  if (!sourceCrop || isFullSourceCrop(sourceCrop, sourceWidth, sourceHeight)) {
    return null
  }

  return {
    url: toLocalMediaUrl(item.src),
    fileName: getPngFileName(item.fileName?.trim() || inferFileNameFromUrl(item.src, item.id)),
    sourceWidth,
    sourceHeight,
    crop: {
      x: sourceCrop.x,
      y: sourceCrop.y,
      width: sourceCrop.width,
      height: sourceCrop.height
    }
  }
}

export function materializeCanvasImageAttachmentSourceSync(
  item: CanvasImageItem
): MaterializedCanvasImageAttachmentSource | null {
  if (!item.crop || !item.image) return null

  const { sourceWidth, sourceHeight } = resolveCanvasImageAttachmentSourceSize(item)
  if (!sourceWidth || !sourceHeight) return null

  const itemImageSize = getCanvasImageAssetSize(item.image)
  const itemImageAspect = itemImageSize.width / itemImageSize.height
  const sourceAspect = sourceWidth / sourceHeight
  if (
    itemImageSize.width <= 0 ||
    itemImageSize.height <= 0 ||
    Math.abs(itemImageSize.width - sourceWidth) > 1 ||
    Math.abs(itemImageSize.height - sourceHeight) > 1 ||
    !Number.isFinite(itemImageAspect) ||
    !Number.isFinite(sourceAspect) ||
    sourceAspect <= 0 ||
    Math.abs(itemImageAspect - sourceAspect) / sourceAspect > 0.05
  ) {
    return null
  }

  return materializeCanvasImageAttachmentSourceFromAsset(
    item,
    {
      image: item.image,
      width: itemImageSize.width,
      height: itemImageSize.height
    },
    sourceWidth,
    sourceHeight
  )
}

export async function materializeCanvasImageAttachmentSource(
  item: CanvasImageItem
): Promise<MaterializedCanvasImageAttachmentSource | null> {
  if (!item.crop || typeof document === 'undefined') return null

  let { sourceWidth, sourceHeight } = resolveCanvasImageAttachmentSourceSize(item)

  if (!sourceWidth || !sourceHeight) {
    const loaded = await loadImageFromSrc(item.src)
    sourceWidth = getPositiveNumber(loaded.width)
    sourceHeight = getPositiveNumber(loaded.height)
  }

  if (!sourceWidth || !sourceHeight) return null

  const sourceAsset = await resolveCanvasImageAttachmentSourceAsset(item, sourceWidth, sourceHeight)
  if (!sourceAsset) return null

  return materializeCanvasImageAttachmentSourceFromAsset(
    item,
    sourceAsset,
    sourceWidth,
    sourceHeight
  )
}

export async function materializeCanvasAgentAttachmentItems(
  items: CanvasItem[]
): Promise<CanvasItem[]> {
  const materializedItems: CanvasItem[] = []

  for (const item of items) {
    if (item.type !== 'image' || !item.crop) {
      materializedItems.push(item)
      continue
    }

    const cropSource = buildCanvasImageCropSourceMetadata(item)
    try {
      const source = await materializeCanvasImageAttachmentSource(item)
      if (!source) {
        if (!cropSource) {
          materializedItems.push(item)
        }
        continue
      }

      const { crop: _crop, ...itemWithoutCrop } = item
      materializedItems.push({
        ...itemWithoutCrop,
        src: source.src,
        fileName: source.fileName,
        sizeBytes: source.sizeBytes,
        sourceWidth: source.sourceWidth,
        sourceHeight: source.sourceHeight,
        width: source.sourceWidth,
        height: source.sourceHeight
      })
    } catch (error) {
      console.warn('[SendToAgent] failed to export cropped canvas image attachment:', error)
      if (!cropSource) {
        materializedItems.push(item)
      }
    }
  }

  return materializedItems
}

export function materializeCanvasAgentAttachmentItemsSync(items: CanvasItem[]): CanvasItem[] {
  let hasMaterializedItem = false
  const materializedItems = items.map((item) => {
    if (item.type !== 'image' || !item.crop) return item

    try {
      const source = materializeCanvasImageAttachmentSourceSync(item)
      if (!source) return item

      hasMaterializedItem = true
      const { crop: _crop, ...itemWithoutCrop } = item
      return {
        ...itemWithoutCrop,
        src: source.src,
        fileName: source.fileName,
        sizeBytes: source.sizeBytes,
        sourceWidth: source.sourceWidth,
        sourceHeight: source.sourceHeight,
        width: source.sourceWidth,
        height: source.sourceHeight
      }
    } catch (error) {
      console.warn('[CanvasDrag] failed to export cropped canvas image attachment:', error)
      return item
    }
  })

  return hasMaterializedItem ? materializedItems : items
}

export function buildCanvasFileAttachment(item: CanvasFileItem): CanvasAgentAttachment {
  return {
    type: 'file',
    url: toLocalMediaUrl(item.src),
    mimeType: getCanvasFileMimeType(item),
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    reportBundleId: item.reportBundleId,
    reportBundleRole: item.reportBundleRole,
    reportBundleRefName: item.reportBundleRefName,
    reportBundleManifestUrl: item.reportBundleManifestUrl
  }
}

export function buildCanvasImageAttachment(item: CanvasImageItem): CanvasAgentAttachment {
  const fileName = item.fileName?.trim() || inferFileNameFromUrl(item.src, `${item.id}.png`)
  return {
    type: 'image',
    url: toLocalMediaUrl(item.src),
    mimeType: getCanvasImageMimeType(item),
    fileName,
    sizeBytes: item.sizeBytes,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight
  }
}

export function buildCanvasAgentAttachments(items: CanvasItem[]): CanvasAgentAttachment[] {
  return items.flatMap((item) => {
    if (item.type === 'image') {
      return [buildCanvasImageAttachment(item)]
    }
    if (item.type === 'file') {
      return [buildCanvasFileAttachment(item)]
    }
    if (item.type === 'video') {
      return [
        {
          type: 'video' as const,
          url: toLocalMediaUrl(item.src),
          fileName: item.fileName,
          mimeType: getCanvasBlobItemMimeType(item)
        }
      ]
    }
    if (item.type === 'model3d') {
      return [
        {
          type: 'model3d' as const,
          url: toLocalMediaUrl(item.src),
          fileName: item.fileName,
          mimeType: getCanvasBlobItemMimeType(item)
        }
      ]
    }
    return []
  })
}

function collectAttachedCaptionTexts(items: CanvasItem[]): Map<string, string[]> {
  const captionsByParentId = new Map<string, string[]>()

  for (const item of items) {
    if (!isConstraintAttachedCaptionAnnotation(item) || !item.attachedToId) continue

    const captionText = String(item.text || item.label || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!captionText) continue

    const captions = captionsByParentId.get(item.attachedToId) || []
    captions.push(captionText)
    captionsByParentId.set(item.attachedToId, captions)
  }

  return captionsByParentId
}

function formatManifestValue(value: string): string {
  return JSON.stringify(value)
}

function getCanvasManifestFileName(item: CanvasItem, fallback: string): string {
  if ('fileName' in item && typeof item.fileName === 'string' && item.fileName.trim()) {
    return item.fileName.trim()
  }

  if (item.type === 'image') return `${item.id}.png`
  if (item.type === 'video') return `${item.id}.mp4`
  if (item.type === 'model3d') return `${item.id}.glb`
  if (item.type === 'file') return `${item.id}.file`
  return fallback
}

function getCanvasManifestDimensions(item: CanvasImageItem): string {
  const width = Math.round(item.sourceWidth || item.width || 0)
  const height = Math.round(item.sourceHeight || item.height || 0)
  return width > 0 && height > 0
    ? `${width}x${height}`
    : `${Math.round(item.width)}x${Math.round(item.height)}`
}

export function buildCanvasAgentAttachmentManifest(items: CanvasItem[]): string {
  const attachedCaptionsByParentId = collectAttachedCaptionTexts(items)
  const entries: string[] = []
  let imageOrder = 0
  let fileOrder = 0
  let videoOrder = 0
  let modelOrder = 0

  for (const item of items) {
    if (isAttachedCaptionAnnotation(item)) {
      continue
    }

    if (item.type === 'image') {
      imageOrder += 1
      const fields = [
        'type=image',
        `order=${imageOrder}`,
        `fileName=${formatManifestValue(
          getCanvasManifestFileName(item, `canvas-image-${imageOrder}.png`)
        )}`,
        `canvasItemId=${formatManifestValue(item.id)}`,
        `dimensions=${getCanvasManifestDimensions(item)}`
      ]
      const attachedCaptions = attachedCaptionsByParentId.get(item.id)
      if (attachedCaptions?.length) {
        fields.push(`attachedCaption=${formatManifestValue(attachedCaptions.join(' | '))}`)
      }
      entries.push(`- ${fields.join('; ')}`)
      continue
    }

    if (item.type === 'file') {
      fileOrder += 1
      entries.push(
        `- type=file; order=${fileOrder}; fileName=${formatManifestValue(
          getCanvasManifestFileName(item, `canvas-file-${fileOrder}`)
        )}; canvasItemId=${formatManifestValue(item.id)}; mimeType=${formatManifestValue(
          getCanvasFileMimeType(item)
        )}`
      )
      continue
    }

    if (item.type === 'video') {
      videoOrder += 1
      entries.push(
        `- type=video; order=${videoOrder}; fileName=${formatManifestValue(
          getCanvasManifestFileName(item, `canvas-video-${videoOrder}.mp4`)
        )}; canvasItemId=${formatManifestValue(item.id)}; mimeType=${formatManifestValue(
          getCanvasBlobItemMimeType(item)
        )}`
      )
      continue
    }

    if (item.type === 'model3d') {
      modelOrder += 1
      entries.push(
        `- type=model3d; order=${modelOrder}; fileName=${formatManifestValue(
          getCanvasManifestFileName(item, `canvas-model-${modelOrder}.glb`)
        )}; canvasItemId=${formatManifestValue(item.id)}; mimeType=${formatManifestValue(
          getCanvasBlobItemMimeType(item)
        )}`
      )
    }
  }

  if (entries.length === 0) {
    return ''
  }

  return [
    'Canvas asset manifest:',
    ...entries,
    'When returning per-asset results, keep the same attachment order. Key by fileName first; if it is missing or duplicated, fall back to canvasItemId.'
  ].join('\n')
}

export function expandCanvasItemsForAgentSend(
  targetItems: CanvasItem[],
  allItems: CanvasItem[]
): CanvasItem[] {
  const attachedCaptionsByParentId = new Map<string, AttachedCaptionAnnotation[]>()

  for (const item of allItems) {
    if (!isConstraintAttachedCaptionAnnotation(item) || !item.attachedToId) continue
    const captions = attachedCaptionsByParentId.get(item.attachedToId) || []
    captions.push(item)
    attachedCaptionsByParentId.set(item.attachedToId, captions)
  }

  const nextItems: CanvasItem[] = []
  const seenIds = new Set<string>()

  for (const item of targetItems) {
    if (!seenIds.has(item.id)) {
      nextItems.push(item)
      seenIds.add(item.id)
    }

    const attachedCaptions = attachedCaptionsByParentId.get(item.id) || []
    for (const caption of attachedCaptions) {
      if (seenIds.has(caption.id)) continue
      nextItems.push(caption)
      seenIds.add(caption.id)
    }
  }

  return nextItems
}

export function buildCanvasAgentGroupCompletionPrompt(
  targetItems: CanvasItem[],
  allItems: CanvasItem[],
  groups: CanvasGroup[]
): string {
  const coreItemIds = getCoreAgentSendItemIds(targetItems)
  if (coreItemIds.length === 0) return ''

  const coreItemIdSet = new Set(coreItemIds)
  const hasAttachedCaptions = allItems.some(
    (item) =>
      isConstraintAttachedCaptionAnnotation(item) &&
      item.attachedToId &&
      coreItemIdSet.has(item.attachedToId)
  )
  const matchedGroup = findExactGroupForAgentSend(targetItems, allItems, groups)

  if (!matchedGroup && !hasAttachedCaptions) {
    return ''
  }

  if (matchedGroup && !hasAttachedCaptions) {
    const groupItems = matchedGroup.itemIds
      .map((itemId) => allItems.find((item) => item.id === itemId))
      .filter((item): item is CanvasItem => Boolean(item))
    const isImagesOnly = groupItems.length > 0 && groupItems.every((item) => item.type === 'image')
    if (isImagesOnly) return ''
  }

  const promptLines: string[] = []

  if (matchedGroup) {
    promptLines.push(
      `This selection matches the canvas group "${matchedGroup.name}". Treat the whole group as shared reference context.`
    )
  }

  if (hasAttachedCaptions) {
    promptLines.push(
      'Use any attached captions, labels, and annotations as hard constraints when understanding or completing these assets.'
    )
  }

  promptLines.push(
    'If the group has gaps, missing elements, or a broken sequence, infer the missing asset from the existing style, size, material, numbering pattern, and layout.'
  )
  promptLines.push('For example, if LV1 and LV3 exist but LV2 is missing, infer and add LV2 first.')
  promptLines.push(
    'Keep the completed result consistent with the existing group and clearly state where each new element should be placed.'
  )

  return promptLines.join('\n')
}

export function buildCanvasFileContentUpdate(
  item: CanvasFileItem,
  rawContent: string,
  blobUrl: string
): Pick<CanvasFileItem, 'src' | 'mimeType' | 'content' | 'previewText' | 'sizeBytes' | 'editable'> {
  const content = rawContent.replace(/\r\n/g, '\n')
  const mimeType = getCanvasFileMimeType(item)
  return {
    src: blobUrl,
    mimeType,
    content,
    previewText: content,
    sizeBytes: new Blob([content], { type: mimeType }).size,
    editable: true
  }
}

export function buildCanvasLayoutRequestMessages(
  items: CanvasItem[],
  prompt: string
): CanvasLayoutRequestMessage[] {
  const attachments = buildCanvasAgentAttachments(items)

  return [
    {
      role: 'user',
      content: prompt,
      ...(attachments.length > 0 ? { attachments } : {})
    }
  ]
}
