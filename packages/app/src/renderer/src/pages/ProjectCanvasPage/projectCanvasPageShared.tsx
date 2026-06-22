/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import SvgIcon from '@mui/material/SvgIcon'
import type { SvgIconProps } from '@mui/material/SvgIcon'
import type { AdobeBridgeTarget } from '@shared/api/svcAdobeBridge'
import { getDownloadFileNameFromUrl, normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'
import { AGENT_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import type { OfficeFileNodeData } from './officePreviewUtils'
export {
  EXPORT_IMAGE_MAX_AREA,
  EXPORT_IMAGE_MAX_SIDE,
  EXPORT_IMAGE_PADDING,
  EXPORT_IMAGE_PIXEL_RATIO,
  resolveCanvasExportRasterConfig,
  type CanvasExportRasterConfig
} from './canvasExportRasterUtils'
import type {
  AnnotationShape,
  CanvasAnnotationItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'

export const normalizeOfficeFileNodeDataForCanvas = (fileNodeData: OfficeFileNodeData) => ({
  ...fileNodeData,
  previewText: fileNodeData.previewText ?? undefined,
  previewImages: fileNodeData.previewImages.length > 0 ? fileNodeData.previewImages : undefined,
  previewSheets: fileNodeData.previewSheets.length > 0 ? fileNodeData.previewSheets : undefined,
  content: fileNodeData.content ?? undefined
})

export type AvailableQAppOption = {
  key: string
  name: string
}

export const RhombusIconSVG = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M12 2L22 12L12 22L2 12Z" />
  </SvgIcon>
)

export const ParallelogramIconSVG = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M6 6h14l-4 12H2z" />
  </SvgIcon>
)

export const DoubleLineRectIconSVG = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M4 4h16v16H4zm2 2v12h12V6z" />
  </SvgIcon>
)

export const DocumentIconSVG = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
  </SvgIcon>
)

export const DatabaseIconSVG = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M12 3c-4.97 0-9 1.79-9 4s4.03 4 9 4 9-1.79 9-4-4.03-4-9-4zm0 18c4.97 0 9-1.79 9-4v-4.22c-1.93 1.35-5.06 2.22-9 2.22s-7.07-.87-9-2.22V17c0 2.21 4.03 4 9 4zm0-6c-4.97 0-9-1.79-9-4v-4.22c1.93 1.35 5.06 2.22 9 2.22s-7.07-.87 9-2.22V11c0 2.21-4.03 4-9 4z" />
  </SvgIcon>
)

export const RoundedRectIconSVG = (props: SvgIconProps) => (
  <SvgIcon {...props}>
    <path d="M7 4h10c1.66 0 3 1.34 3 3v10c0 1.66-1.34 3-3 3H7c-1.66 0-3-1.34-3-3V7c0-1.66 1.34-3 3-3zm0 2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h10c.55 0 1-.45 1-1V7c0-.55-.45-1-1-1H7z" />
  </SvgIcon>
)

export const FLOW_SHAPE_ICONS = {
  rhombus: RhombusIconSVG,
  parallelogram: ParallelogramIconSVG,
  'double-line-rect': DoubleLineRectIconSVG,
  document: DocumentIconSVG,
  cylinder: DatabaseIconSVG,
  'rounded-rect': RoundedRectIconSVG
} as const

export type CanvasExportableItem = CanvasImageItem | CanvasModel3DItem | CanvasVideoItem
export type RasterExportImageFormat = 'png' | 'jpeg'
export type ExportImageFormat = RasterExportImageFormat | 'svg'
export type ExportMenuScope = 'scene' | 'selected-scene' | 'all-elements' | 'selected-elements'
export type CanvasTool =
  | 'select'
  | 'hand'
  | 'annotate'
  | 'export-select'
  | 'crop-select'
  | 'extract-select'
  | 'target-select'
export type CanvasDragPayload = {
  textContent?: string
  hiddenTextContent?: string
  sourceCanvasId?: string
} & Record<string, unknown>
export type AgentTargetApp = 'photoshop' | 'figma' | AdobeBridgeTarget
export type SendCanvasItemsToAgentOptions = {
  promptPrefix?: string
  targetApp?: AgentTargetApp
  targetScope?: string
  includeCanvasPromptText?: boolean
  includeGroupCompletionPrompt?: boolean
}

export type ResolvedDroppedAgentImageData = {
  src: string
  fileName?: string
  sizeBytes?: number
  sourceFile?: Blob
  sourceWidthHint?: number
  sourceHeightHint?: number
}

export function isCanvasExportableItem(item: CanvasItem): item is CanvasExportableItem {
  return (item.type === 'image' || item.type === 'model3d' || item.type === 'video') && !!item.src
}

export const SELECTION_ACTION_BUTTON_WIDTH = 96
export const SELECTION_ACTION_BUTTON_HEIGHT = 36
export const SELECTION_ACTION_BUTTON_GAP = 8
export const MULTI_SELECTION_ACTION_COUNT = 5
export const SELECTION_ACTION_STACK_MARGIN = 16
export const FILLED_ANNOTATION_OPACITY = 0.18
export const INLINE_TEXT_EDIT_SCREEN_MARGIN = 24
export const INLINE_MEDIA_CAPTION_BOTTOM_CLEARANCE = 96
export const FILE_NODE_DEFAULT_WIDTH = 240
export const FILE_NODE_DEFAULT_HEIGHT = 148

const FILLABLE_ANNOTATION_SHAPES: AnnotationShape[] = [
  'rect',
  'ellipse',
  'circle',
  'rhombus',
  'parallelogram',
  'double-line-rect',
  'document',
  'cylinder',
  'rounded-rect'
]

type CanvasBoundsPoint = {
  x: number
  y: number
}

function rotateCanvasBoundsPoint(point: CanvasBoundsPoint, rotation: number): CanvasBoundsPoint {
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

function resolveCanvasBoundsFromPoints(
  points: CanvasBoundsPoint[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) {
    return null
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return { minX, minY, maxX, maxY }
}

function transformCanvasBoundsLocalPoint(
  item: Pick<CanvasItem, 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation'>,
  point: CanvasBoundsPoint
): CanvasBoundsPoint {
  const scaledPoint = {
    x: point.x * (item.scaleX || 1),
    y: point.y * (item.scaleY || 1)
  }
  const rotatedPoint = rotateCanvasBoundsPoint(scaledPoint, item.rotation || 0)

  return {
    x: item.x + rotatedPoint.x,
    y: item.y + rotatedPoint.y
  }
}

function resolveCanvasRectItemBounds(
  item: Pick<CanvasItem, 'x' | 'y' | 'width' | 'height' | 'scaleX' | 'scaleY' | 'rotation'>
) {
  return (
    resolveCanvasBoundsFromPoints([
      transformCanvasBoundsLocalPoint(item, { x: 0, y: 0 }),
      transformCanvasBoundsLocalPoint(item, { x: item.width, y: 0 }),
      transformCanvasBoundsLocalPoint(item, { x: 0, y: item.height }),
      transformCanvasBoundsLocalPoint(item, { x: item.width, y: item.height })
    ]) ?? {
      minX: item.x,
      minY: item.y,
      maxX: item.x,
      maxY: item.y
    }
  )
}

function resolveCanvasAnnotationPointBounds(item: CanvasAnnotationItem) {
  if ((item.shape === 'arrow' || item.shape === 'line') && item.endX != null && item.endY != null) {
    return resolveCanvasBoundsFromPoints([
      transformCanvasBoundsLocalPoint(item, { x: 0, y: 0 }),
      transformCanvasBoundsLocalPoint(item, { x: item.endX - item.x, y: item.endY - item.y })
    ])
  }

  if (item.shape === 'freedraw' && item.points && item.points.length >= 2) {
    const points: CanvasBoundsPoint[] = []

    for (let index = 0; index < item.points.length; index += 2) {
      points.push(
        transformCanvasBoundsLocalPoint(item, {
          x: item.points[index] - item.x,
          y: item.points[index + 1] - item.y
        })
      )
    }

    return resolveCanvasBoundsFromPoints(points)
  }

  return null
}

export function applySelectedTextSizeChange(
  items: CanvasItem[],
  selectedIds: Set<string>,
  size: number,
  isTextMode: boolean
): CanvasItem[] {
  if (selectedIds.size === 0) return items

  return items.map((item) => {
    if (!selectedIds.has(item.id)) return item

    if (isTextMode) {
      if (item.type === 'text') {
        const baseFontSize = Math.max(item.fontSize || 16, 1)
        const scale = size / baseFontSize
        return {
          ...item,
          fontSize: size,
          width: Math.max(60, item.width * scale),
          height: Math.max(30, item.height * scale),
          scaleX: 1,
          scaleY: 1
        }
      }

      if (item.type === 'annotation' && item.shape === 'text-anno') {
        const baseFontSize = Math.max(item.fontSize || 36, 1)
        const scale = size / baseFontSize
        return {
          ...item,
          fontSize: size,
          width: Math.max(20, item.width * scale),
          height: Math.max(20, item.height * scale),
          scaleX: 1,
          scaleY: 1
        }
      }

      return item
    }

    if (item.type === 'annotation') {
      return { ...item, strokeWidth: size }
    }

    return item
  }) as CanvasItem[]
}

const QAPP_IMAGE_DRAG_MIME = 'application/x-qapp-image'

const IMAGE_DROP_FILE_NAME_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg)$/i

type QuickAppImageDragPayload = {
  objectUrl?: unknown
  itemTypes?: unknown[]
  fileItem?: {
    filename?: unknown
  }
  attachments?: unknown[]
  sourceWidth?: unknown
  sourceHeight?: unknown
}

const getPositiveFiniteImageHint = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const resolveDroppedImageFile = (dataTransfer: Pick<DataTransfer, 'files'>): File | undefined =>
  Array.from(dataTransfer.files ?? []).find((file) => {
    const type = (file.type || '').toLowerCase()
    return type.startsWith('image/') || IMAGE_DROP_FILE_NAME_PATTERN.test(file.name || '')
  })

const resolveQuickAppImageDragData = (rawPayload: string): ResolvedDroppedAgentImageData | null => {
  if (!rawPayload.trim()) return null

  try {
    const payload = JSON.parse(rawPayload) as QuickAppImageDragPayload
    if (!payload || typeof payload !== 'object') return null
    if (
      Array.isArray(payload.itemTypes) &&
      payload.itemTypes.length > 0 &&
      !payload.itemTypes.includes('image')
    ) {
      return null
    }

    const imageAttachment = Array.isArray(payload.attachments)
      ? payload.attachments.find(
          (
            attachment
          ): attachment is {
            type?: unknown
            url?: unknown
            fileName?: unknown
            sourceWidth?: unknown
            sourceHeight?: unknown
            sizeBytes?: unknown
          } =>
            !!attachment &&
            typeof attachment === 'object' &&
            (attachment as { type?: unknown }).type === 'image' &&
            typeof (attachment as { url?: unknown }).url === 'string' &&
            Boolean((attachment as { url?: string }).url?.trim())
        )
      : undefined

    const rawSrc =
      (typeof imageAttachment?.url === 'string' && imageAttachment.url.trim()) ||
      (typeof payload.objectUrl === 'string' && payload.objectUrl.trim()) ||
      ''
    const normalizedSrc = normalizeLocalMediaUrl(rawSrc)
    if (!normalizedSrc) return null

    const fileName =
      (typeof imageAttachment?.fileName === 'string' && imageAttachment.fileName.trim()) ||
      (typeof payload.fileItem?.filename === 'string' && payload.fileItem.filename.trim()) ||
      getDownloadFileNameFromUrl(normalizedSrc, 'dropped-image.png')

    return {
      src: normalizedSrc,
      fileName,
      sizeBytes:
        typeof imageAttachment?.sizeBytes === 'number' && Number.isFinite(imageAttachment.sizeBytes)
          ? imageAttachment.sizeBytes
          : undefined,
      sourceWidthHint:
        getPositiveFiniteImageHint(imageAttachment?.sourceWidth) ??
        getPositiveFiniteImageHint(payload.sourceWidth),
      sourceHeightHint:
        getPositiveFiniteImageHint(imageAttachment?.sourceHeight) ??
        getPositiveFiniteImageHint(payload.sourceHeight)
    }
  } catch {
    return null
  }
}

export async function resolveDroppedAgentImageDataUrl(
  dataTransfer: Pick<DataTransfer, 'getData' | 'files'>
): Promise<ResolvedDroppedAgentImageData | null> {
  const agentImageUrl = dataTransfer.getData(AGENT_IMAGE_DRAG_MIME).trim()
  const quickAppImagePayload = dataTransfer.getData(QAPP_IMAGE_DRAG_MIME).trim()
  if (!agentImageUrl && !quickAppImagePayload) return null

  const droppedImageFile = resolveDroppedImageFile(dataTransfer)
  const quickAppImageData = resolveQuickAppImageDragData(quickAppImagePayload)
  if (droppedImageFile && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const droppedFileName = droppedImageFile.name?.trim()
    if (
      quickAppImageData &&
      (!droppedFileName ||
        !quickAppImageData.fileName ||
        quickAppImageData.fileName.trim() !== droppedFileName)
    ) {
      return quickAppImageData
    }

    return {
      src: URL.createObjectURL(droppedImageFile),
      fileName: droppedImageFile.name || undefined,
      sizeBytes:
        Number.isFinite(droppedImageFile.size) && droppedImageFile.size >= 0
          ? droppedImageFile.size
          : undefined,
      sourceFile: droppedImageFile
    }
  }

  const normalizedAgentUrl = normalizeLocalMediaUrl(agentImageUrl)
  if (normalizedAgentUrl) {
    return {
      src: normalizedAgentUrl,
      fileName: getDownloadFileNameFromUrl(normalizedAgentUrl, 'dropped-image.png')
    }
  }

  if (quickAppImageData) {
    return quickAppImageData
  }

  return null
}

export const VIDEO_FRAME_CAPTURE_EPSILON_SECONDS = 0.05

export function isFillableAnnotationShape(
  shape: AnnotationShape | null | undefined
): shape is AnnotationShape {
  return Boolean(shape && FILLABLE_ANNOTATION_SHAPES.includes(shape))
}

export function getCanvasItemBounds(item: CanvasItem): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (item.type === 'annotation') {
    const annotationPointBounds = resolveCanvasAnnotationPointBounds(item)
    if (annotationPointBounds) {
      return annotationPointBounds
    }
  }

  return resolveCanvasRectItemBounds(item)
}

export function getCanvasItemsBounds(targetItems: CanvasItem[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} | null {
  if (targetItems.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const item of targetItems) {
    const bounds = getCanvasItemBounds(item)
    minX = Math.min(minX, bounds.minX)
    minY = Math.min(minY, bounds.minY)
    maxX = Math.max(maxX, bounds.maxX)
    maxY = Math.max(maxY, bounds.maxY)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return { minX, minY, maxX, maxY }
}

export function translateCanvasItem(item: CanvasItem, dx: number, dy: number): CanvasItem {
  const updated = {
    ...item,
    x: item.x + dx,
    y: item.y + dy
  }

  if (
    item.type === 'annotation' &&
    (item.shape === 'arrow' || item.shape === 'line') &&
    item.endX != null &&
    item.endY != null
  ) {
    return {
      ...(updated as CanvasAnnotationItem),
      endX: item.endX + dx,
      endY: item.endY + dy
    }
  }

  if (item.type === 'annotation' && item.shape === 'freedraw' && item.points) {
    return {
      ...(updated as CanvasAnnotationItem),
      points: item.points.map((value, index) => (index % 2 === 0 ? value + dx : value + dy))
    }
  }

  return updated as CanvasItem
}

export const ANNOTATION_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#ffffff'
]

export const BG_COLORS = [
  { label: 'Default Dark', value: '#1a1a1a' },
  { label: 'Dark Gray', value: '#252525' },
  { label: 'Graphite', value: '#3a3a3a' },
  { label: 'Pure Black', value: '#0d0d0d' },
  { label: 'Cream', value: '#f5f0e8' },
  { label: 'Light Gray', value: '#e8e8e8' },
  { label: 'Pure White', value: '#ffffff' },
  { label: 'Dark Blue', value: '#0f1923' },
  { label: 'Dark Green', value: '#0f1a0f' },
  { label: 'Transparent', value: 'transparent' }
]
