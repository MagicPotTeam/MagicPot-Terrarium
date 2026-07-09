import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { CanvasFigmaBinding } from '@shared/figma'
import { api } from '../../utils/windowUtils'
import { exportCanvasFile, exportCanvasFileAsStandalone } from './canvasStorage'
import {
  getExportFileExtension,
  getExportMimeType,
  sanitizeFilePart
} from './canvasExportNamingUtils'
import { buildRasterBackedSvgMarkup, SVG_EXPORT_MIME_TYPE } from './canvasExportSvgUtils'
import { type ExportSubmenuPlacement, resolveExportSubmenuPlacement } from './exportMenuPlacement'
import type { CanvasExportBounds } from './groupPlaybackUtils'
import {
  getProjectCanvasRuntimeExportBounds,
  withProjectCanvasRuntime,
  type ProjectCanvasRuntimeSnapshot
} from './projectCanvasRuntime'
import {
  EXPORT_IMAGE_PADDING,
  EXPORT_IMAGE_PIXEL_RATIO,
  isCanvasExportableItem,
  resolveCanvasExportRasterConfig,
  type CanvasExportableItem,
  type ExportImageFormat,
  type ExportMenuScope,
  type RasterExportImageFormat
} from './projectCanvasPageShared'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasGroup,
  CanvasGroupBranch,
  CanvasHtmlItem,
  CanvasItem,
  CanvasTextItem
} from './types'

type NotifyFn = (message: string) => unknown
type CanvasRenderedImageFormat = 'png' | 'jpeg' | 'svg'
const QUICK_CANVAS_IMAGE_URL_CACHE_LIMIT = 12
type CanvasExportClipBounds = CanvasExportBounds

type UseCanvasExportWorkflowOptions = {
  canvasId: string
  projectName: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  groupBranches: CanvasGroupBranch[]
  figmaBinding: CanvasFigmaBinding | null
  selectedIds: Set<string>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  stageRef: MutableRefObject<unknown>
  canvasContainerRef: MutableRefObject<HTMLDivElement | null>
  stagePos: { x: number; y: number }
  stageScale: number
  bgColor: string
  loadImageFromSrc: (
    src: string
  ) => Promise<{ img: HTMLImageElement; width: number; height: number }>
  getCanvasItemVisualBounds: (item: CanvasItem) => CanvasExportBounds | null
  notifySuccess: NotifyFn
  notifyError: NotifyFn
}

function buildCanvasExportBounds(
  entries: { bounds: CanvasExportBounds }[]
): CanvasExportBounds | null {
  if (entries.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const { bounds } of entries) {
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }

  return {
    x: minX - EXPORT_IMAGE_PADDING,
    y: minY - EXPORT_IMAGE_PADDING,
    width: maxX - minX + EXPORT_IMAGE_PADDING * 2,
    height: maxY - minY + EXPORT_IMAGE_PADDING * 2
  }
}

function isUsableCanvasExportBounds(
  bounds: CanvasExportBounds | null | undefined
): bounds is CanvasExportBounds {
  return !!bounds && bounds.width > 0 && bounds.height > 0
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines = Number.MAX_SAFE_INTEGER
): string[] {
  const content = text.replace(/\r\n/g, '\n')
  const paragraphs = content.split('\n')
  const lines: string[] = []

  for (const paragraph of paragraphs) {
    let currentLine = ''
    for (const char of paragraph || ' ') {
      const candidate = `${currentLine}${char}`
      if (currentLine && ctx.measureText(candidate).width > maxWidth) {
        lines.push(currentLine)
        currentLine = char
      } else {
        currentLine = candidate
      }

      if (lines.length >= maxLines) {
        return lines
      }
    }

    lines.push(currentLine || ' ')
    if (lines.length >= maxLines) {
      return lines
    }
  }

  return lines
}

function drawCanvasTextLines(options: {
  ctx: CanvasRenderingContext2D
  lines: string[]
  x: number
  y: number
  lineHeightPx: number
  maxHeight?: number
}) {
  const { ctx, lines, x, y, lineHeightPx, maxHeight } = options

  lines.forEach((line, index) => {
    const baselineY = y + index * lineHeightPx
    if (maxHeight != null && baselineY > y + maxHeight) {
      return
    }
    ctx.fillText(line, x, baselineY)
  })
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to serialize export image data.'))
    reader.readAsDataURL(blob)
  })
}

function resolveCanvasAnnotationShape(item: CanvasAnnotationItem) {
  return item.shape || 'rect'
}

function getCanvasAnnotationLocalPoints(
  item: CanvasAnnotationItem
): Array<{ x: number; y: number }> {
  const shape = resolveCanvasAnnotationShape(item)
  if ((shape === 'arrow' || shape === 'line') && item.endX != null && item.endY != null) {
    return [
      { x: 0, y: 0 },
      { x: item.endX - item.x, y: item.endY - item.y }
    ]
  }

  if (shape === 'freedraw' && item.points && item.points.length >= 2) {
    const points: Array<{ x: number; y: number }> = []
    for (let index = 0; index < item.points.length; index += 2) {
      points.push({
        x: item.points[index] - item.x,
        y: item.points[index + 1] - item.y
      })
    }
    return points
  }

  return []
}

function drawCanvasTextItem(ctx: CanvasRenderingContext2D, item: CanvasTextItem) {
  ctx.save()
  drawRoundedRectPath(ctx, 0, 0, item.width, item.height, 6)
  ctx.fillStyle = 'rgba(30,30,30,0.85)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = item.fill
  ctx.font = `${item.fontWeight === 'bold' ? '700' : '400'} ${item.fontSize}px ${item.fontFamily}`
  ctx.textBaseline = 'top'
  const lineHeightPx = item.fontSize * 1.5
  const lines = wrapCanvasText(ctx, item.text || '', Math.max(10, item.width - 24))
  drawCanvasTextLines({
    ctx,
    lines,
    x: 12,
    y: 12,
    lineHeightPx,
    maxHeight: Math.max(0, item.height - 24)
  })
  ctx.restore()
}

function drawCanvasFileItem(ctx: CanvasRenderingContext2D, item: CanvasFileItem) {
  ctx.save()
  drawRoundedRectPath(ctx, 0, 0, item.width, item.height, 16)
  ctx.fillStyle = '#182330'
  ctx.fill()
  ctx.strokeStyle = 'rgba(148,163,184,0.32)'
  ctx.lineWidth = 1
  ctx.stroke()

  drawRoundedRectPath(ctx, 16, 16, 72, 32, 10)
  ctx.fillStyle = '#0f172a'
  ctx.fill()
  ctx.strokeStyle = '#334155'
  ctx.stroke()

  ctx.fillStyle = '#93c5fd'
  ctx.font = '700 12px system-ui'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText((item.fileName.split('.').pop() || 'FILE').slice(0, 6).toUpperCase(), 52, 32)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#f8fafc'
  ctx.font = '700 16px system-ui'
  const titleLines = wrapCanvasText(ctx, item.fileName, Math.max(60, item.width - 120), 2)
  drawCanvasTextLines({
    ctx,
    lines: titleLines,
    x: 104,
    y: 18,
    lineHeightPx: 18
  })

  ctx.fillStyle = '#93c5fd'
  ctx.font = '12px system-ui'
  const metaText = item.mimeType || item.fileKind || 'file'
  ctx.fillText(metaText, 104, 62)

  drawRoundedRectPath(
    ctx,
    16,
    86,
    Math.max(120, item.width - 32),
    Math.max(56, item.height - 102),
    12
  )
  ctx.fillStyle = 'rgba(30,41,59,0.92)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(148,163,184,0.16)'
  ctx.stroke()

  ctx.fillStyle = '#cbd5e1'
  ctx.font = '13px system-ui'
  const previewText = (item.previewText || item.content || 'Preview is not available yet.').replace(
    /\s+/g,
    ' '
  )
  const previewLines = wrapCanvasText(ctx, previewText, Math.max(96, item.width - 56), 10)
  drawCanvasTextLines({
    ctx,
    lines: previewLines,
    x: 28,
    y: 98,
    lineHeightPx: 18,
    maxHeight: Math.max(0, item.height - 118)
  })
  ctx.restore()
}

function drawCanvasAnnotationItem(ctx: CanvasRenderingContext2D, item: CanvasAnnotationItem) {
  const shape = resolveCanvasAnnotationShape(item)
  const strokeWidth = Math.max(1, item.strokeWidth)
  const fillAlpha = Math.max(0, Math.min(1, item.fillOpacity))

  ctx.save()
  ctx.lineWidth = strokeWidth
  ctx.strokeStyle = item.stroke
  ctx.fillStyle = item.stroke
  ctx.globalAlpha = 1

  if (shape === 'arrow' || shape === 'line') {
    const [start, end] = getCanvasAnnotationLocalPoints(item)
    if (start && end) {
      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      ctx.lineTo(end.x, end.y)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()

      if (shape === 'arrow') {
        const angle = Math.atan2(end.y - start.y, end.x - start.x)
        const pointerLength = 14
        const pointerWidth = 12
        ctx.beginPath()
        ctx.moveTo(end.x, end.y)
        ctx.lineTo(
          end.x - Math.cos(angle) * pointerLength + Math.sin(angle) * (pointerWidth / 2),
          end.y - Math.sin(angle) * pointerLength - Math.cos(angle) * (pointerWidth / 2)
        )
        ctx.lineTo(
          end.x - Math.cos(angle) * pointerLength - Math.sin(angle) * (pointerWidth / 2),
          end.y - Math.sin(angle) * pointerLength + Math.cos(angle) * (pointerWidth / 2)
        )
        ctx.closePath()
        ctx.fill()
      }
    }
    ctx.restore()
    return
  }

  if (shape === 'freedraw') {
    const points = getCanvasAnnotationLocalPoints(item)
    if (points.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y))
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
    ctx.restore()
    return
  }

  ctx.globalAlpha = fillAlpha
  if (shape === 'ellipse' || shape === 'circle') {
    ctx.beginPath()
    ctx.ellipse(
      item.width / 2,
      item.height / 2,
      shape === 'circle' ? Math.min(item.width, item.height) / 2 : item.width / 2,
      shape === 'circle' ? Math.min(item.width, item.height) / 2 : item.height / 2,
      0,
      0,
      Math.PI * 2
    )
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.stroke()
  } else if (shape === 'rhombus') {
    ctx.beginPath()
    ctx.moveTo(item.width / 2, 0)
    ctx.lineTo(item.width, item.height / 2)
    ctx.lineTo(item.width / 2, item.height)
    ctx.lineTo(0, item.height / 2)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.stroke()
  } else if (shape === 'parallelogram') {
    ctx.beginPath()
    ctx.moveTo(item.width * 0.2, 0)
    ctx.lineTo(item.width, 0)
    ctx.lineTo(item.width * 0.8, item.height)
    ctx.lineTo(0, item.height)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.stroke()
  } else {
    drawRoundedRectPath(
      ctx,
      0,
      0,
      item.width,
      item.height,
      shape === 'rounded-rect' ? Math.min(item.width, item.height) * 0.15 : 3
    )
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.stroke()
  }

  if (shape === 'text-anno' && item.text) {
    ctx.fillStyle = item.stroke
    ctx.font = `${item.fontWeight === 'bold' ? '700' : '400'} ${item.fontSize || 36}px system-ui`
    ctx.textBaseline = 'top'
    const textLines = wrapCanvasText(ctx, item.text, Math.max(10, item.width))
    drawCanvasTextLines({
      ctx,
      lines: textLines,
      x: 0,
      y: 0,
      lineHeightPx: (item.fontSize || 36) * 1.05,
      maxHeight: item.height
    })
  } else if (item.label) {
    ctx.fillStyle = item.stroke
    ctx.font = '700 16px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const labelLines = wrapCanvasText(ctx, item.label, Math.max(10, item.width - 16), 3)
    const lineHeightPx = 18
    const blockHeight = labelLines.length * lineHeightPx
    labelLines.forEach((line, index) => {
      ctx.fillText(line, item.width / 2, item.height / 2 - blockHeight / 2 + index * lineHeightPx)
    })
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
  }

  ctx.restore()
}

function buildQuickCanvasItemCacheSnapshot(item: CanvasItem) {
  const common = {
    id: item.id,
    type: item.type,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    zIndex: item.zIndex
  }

  if (item.type === 'image') {
    return {
      ...common,
      src: item.src,
      crop: item.crop ?? null
    }
  }

  if (item.type === 'text') {
    return {
      ...common,
      text: item.text,
      fill: item.fill,
      fontSize: item.fontSize,
      fontFamily: item.fontFamily,
      fontWeight: item.fontWeight
    }
  }

  if (item.type === 'file') {
    return {
      ...common,
      fileName: item.fileName,
      mimeType: item.mimeType,
      fileKind: item.fileKind,
      previewText: item.previewText ?? null,
      content: item.previewText ? null : (item.content ?? null)
    }
  }

  if (item.type === 'annotation') {
    return {
      ...common,
      shape: item.shape,
      stroke: item.stroke,
      strokeWidth: item.strokeWidth,
      fillOpacity: item.fillOpacity,
      label: item.label ?? null,
      text: item.text ?? null,
      fontSize: item.fontSize ?? null,
      fontWeight: item.fontWeight ?? null,
      endX: item.endX ?? null,
      endY: item.endY ?? null,
      points: item.points ?? null
    }
  }

  if (item.type === 'video') {
    return {
      ...common,
      src: item.src,
      playing: item.playing
    }
  }

  if (item.type === 'model3d') {
    return {
      ...common,
      src: item.src
    }
  }

  if (item.type === 'html') {
    return {
      ...common,
      htmlData: item.htmlData
    }
  }

  return common
}

function createHtmlCanvasContext(
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }

  return { canvas, ctx }
}

export function useCanvasExportWorkflow({
  canvasId,
  projectName,
  items,
  groups,
  groupBranches,
  figmaBinding,
  selectedIds,
  setSelectedIds,
  canvasContainerRef,
  stagePos,
  stageScale,
  bgColor,
  loadImageFromSrc,
  getCanvasItemVisualBounds,
  notifySuccess,
  notifyError
}: UseCanvasExportWorkflowOptions) {
  const { t } = useTranslation()
  const [exportMenuAnchor, setExportMenuAnchor] = useState<HTMLElement | null>(null)
  const [exportSubmenuAnchor, setExportSubmenuAnchor] = useState<HTMLElement | null>(null)
  const [exportSubmenuPlacement, setExportSubmenuPlacement] =
    useState<ExportSubmenuPlacement>('right')
  const [exportCtxMenuPos, setExportCtxMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [forceRenderAllItemsForExport, setForceRenderAllItemsForExport] = useState(false)
  const quickCanvasImageUrlCacheRef = useRef(new Map<string, string>())
  const quickCanvasImageUrlPendingRef = useRef(new Map<string, Promise<string | null>>())

  const disposeQuickCanvasImageUrl = useCallback((imageUrl: string) => {
    if (imageUrl.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(imageUrl)
    }
  }, [])

  useEffect(() => {
    const quickCanvasImageUrlCache = quickCanvasImageUrlCacheRef.current
    const quickCanvasImageUrlPending = quickCanvasImageUrlPendingRef.current

    return () => {
      for (const imageUrl of quickCanvasImageUrlCache.values()) {
        disposeQuickCanvasImageUrl(imageUrl)
      }
      quickCanvasImageUrlCache.clear()
      quickCanvasImageUrlPending.clear()
    }
  }, [disposeQuickCanvasImageUrl])

  const waitForExportPaint = useCallback(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve())
        })
      }),
    []
  )

  const prepareExportRender = useCallback(async () => {
    const selectionSnapshot = new Set(selectedIds)

    flushSync(() => {
      setForceRenderAllItemsForExport(true)
      setSelectedIds(new Set())
    })

    await waitForExportPaint()
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 180)
    })

    return selectionSnapshot
  }, [selectedIds, setSelectedIds, waitForExportPaint])

  const restoreExportRender = useCallback(
    (selectionSnapshot: Set<string>) => {
      flushSync(() => {
        setForceRenderAllItemsForExport(false)
        setSelectedIds(selectionSnapshot)
      })
    },
    [setSelectedIds]
  )

  const renderHtmlItemToImage = useCallback(
    async (item: CanvasHtmlItem): Promise<HTMLImageElement> => {
      const svgMarkup = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
          <foreignObject width="100%" height="100%">
            <div
              xmlns="http://www.w3.org/1999/xhtml"
              style="width:100%;height:100%;overflow:hidden;background:#ffffff;"
            >
              ${item.htmlData}
            </div>
          </foreignObject>
        </svg>
      `

      const blob = new Blob([svgMarkup], { type: `${SVG_EXPORT_MIME_TYPE};charset=utf-8` })
      const objectUrl = URL.createObjectURL(blob)

      try {
        const { img } = await loadImageFromSrc(objectUrl)
        return img
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    },
    [loadImageFromSrc]
  )

  const renderCanvasBlob = useCallback(
    (canvas: HTMLCanvasElement, format: RasterExportImageFormat) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob)
              return
            }
            reject(new Error('Failed to render export image blob'))
          },
          getExportMimeType(format),
          format === 'jpeg' ? 0.92 : undefined
        )
      }),
    []
  )

  const normalizeExportPath = useCallback((filePath: string, format: ExportImageFormat) => {
    const parsed = window.path.parse(filePath)
    const nextExt = getExportFileExtension(format)
    const lowerExt = (parsed.ext || '').toLowerCase()
    const allowedExts =
      format === 'png' ? ['.png'] : format === 'jpeg' ? ['.jpg', '.jpeg'] : ['.svg']

    if (allowedExts.includes(lowerExt)) return filePath

    return window.path.join(parsed.dir || '', `${parsed.name || 'export'}${nextExt}`)
  }, [])

  const chooseExportPath = useCallback(
    async (defaultName: string, format: ExportImageFormat) => {
      const res = await api().svcDialog.showSaveDialog({
        title: t('canvas.export_scene_dialog_title'),
        defaultPath: defaultName,
        filters: [
          format === 'png'
            ? { name: 'PNG Image', extensions: ['png'] }
            : format === 'jpeg'
              ? { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }
              : { name: 'SVG Image', extensions: ['svg'] }
        ]
      })

      if (res.canceled || !res.filePath) return null
      return normalizeExportPath(res.filePath, format)
    },
    [normalizeExportPath, t]
  )

  const saveCanvasToPath = useCallback(
    async (canvas: HTMLCanvasElement, targetPath: string, format: RasterExportImageFormat) => {
      const blob = await renderCanvasBlob(canvas, format)
      const buffer = new Uint8Array(await blob.arrayBuffer())

      await api().svcFs.saveImageToPath({
        image: buffer,
        outputPath: window.path.dirname(targetPath),
        filename: window.path.basename(targetPath)
      })
    },
    [renderCanvasBlob]
  )

  const saveCanvasToDirectory = useCallback(
    async (
      canvas: HTMLCanvasElement,
      dir: string,
      fileName: string,
      format: RasterExportImageFormat
    ) => {
      const blob = await renderCanvasBlob(canvas, format)
      const buffer = new Uint8Array(await blob.arrayBuffer())

      await api().svcHyper.saveImageToDir({
        data: buffer,
        fileName,
        dir
      })
    },
    [renderCanvasBlob]
  )

  const saveSvgToPath = useCallback(async (svgMarkup: string, targetPath: string) => {
    const buffer = new TextEncoder().encode(svgMarkup)

    await api().svcFs.saveImageToPath({
      image: buffer,
      outputPath: window.path.dirname(targetPath),
      filename: window.path.basename(targetPath)
    })
  }, [])

  const saveSvgToDirectory = useCallback(
    async (svgMarkup: string, dir: string, fileName: string) => {
      const buffer = new TextEncoder().encode(svgMarkup)

      await api().svcHyper.saveImageToDir({
        data: buffer,
        fileName,
        dir
      })
    },
    []
  )

  const drawTransformedItemSource = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      item: CanvasItem,
      exportBounds: CanvasExportBounds,
      pixelRatio: number,
      draw: (targetCtx: CanvasRenderingContext2D) => void
    ) => {
      ctx.save()
      ctx.translate((item.x - exportBounds.x) * pixelRatio, (item.y - exportBounds.y) * pixelRatio)
      if (item.rotation) {
        ctx.rotate((item.rotation * Math.PI) / 180)
      }
      ctx.scale((item.scaleX || 1) * pixelRatio, (item.scaleY || 1) * pixelRatio)
      draw(ctx)
      ctx.restore()
    },
    []
  )

  const drawCanvasItemForExport = useCallback(
    async (
      ctx: CanvasRenderingContext2D,
      item: CanvasItem,
      itemBounds: CanvasExportBounds,
      exportBounds: CanvasExportBounds,
      pixelRatio: number
    ) => {
      if (item.type === 'video') {
        const container = canvasContainerRef.current
        const video = container?.querySelector(
          `[data-canvas-item-id="${item.id}"] video`
        ) as HTMLVideoElement | null

        if (!video || video.readyState < 2) return

        drawTransformedItemSource(ctx, item, exportBounds, pixelRatio, (targetCtx) => {
          const videoWidth = video.videoWidth || item.width
          const videoHeight = video.videoHeight || item.height
          const scale = Math.min(item.width / videoWidth, item.height / videoHeight)
          const drawWidth = videoWidth * scale
          const drawHeight = videoHeight * scale
          const offsetX = (item.width - drawWidth) / 2
          const offsetY = (item.height - drawHeight) / 2

          targetCtx.fillStyle = '#000000'
          targetCtx.fillRect(0, 0, item.width, item.height)
          targetCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight)
        })
        return
      }

      if (item.type === 'model3d') {
        const container = canvasContainerRef.current
        const modelCanvas = container?.querySelector(
          `[data-canvas-item-id="${item.id}"] canvas`
        ) as HTMLCanvasElement | null

        if (!modelCanvas) return

        drawTransformedItemSource(ctx, item, exportBounds, pixelRatio, (targetCtx) => {
          targetCtx.drawImage(modelCanvas, 0, 0, item.width, item.height)
        })
        return
      }

      if (item.type === 'html') {
        const htmlImage = await renderHtmlItemToImage(item)
        drawTransformedItemSource(ctx, item, exportBounds, pixelRatio, (targetCtx) => {
          targetCtx.drawImage(htmlImage, 0, 0, item.width, item.height)
        })
        return
      }

      if (item.type === 'image') {
        const { img } = await loadImageFromSrc(item.src)
        drawTransformedItemSource(ctx, item, exportBounds, pixelRatio, (targetCtx) => {
          if (item.crop) {
            targetCtx.drawImage(
              img,
              item.crop.x,
              item.crop.y,
              item.crop.width,
              item.crop.height,
              0,
              0,
              item.width,
              item.height
            )
            return
          }

          targetCtx.drawImage(img, 0, 0, item.width, item.height)
        })
        return
      }

      drawTransformedItemSource(ctx, item, exportBounds, pixelRatio, (targetCtx) => {
        if (item.type === 'text') {
          drawCanvasTextItem(targetCtx, item as CanvasTextItem)
          return
        }

        if (item.type === 'file') {
          drawCanvasFileItem(targetCtx, item as CanvasFileItem)
          return
        }

        if (item.type === 'annotation') {
          drawCanvasAnnotationItem(targetCtx, item as CanvasAnnotationItem)
        }
      })
    },
    [canvasContainerRef, drawTransformedItemSource, loadImageFromSrc, renderHtmlItemToImage]
  )

  const ensureExportImageDataUrl = useCallback((dataUrl: string): string => {
    if (dataUrl.startsWith('data:image/')) {
      return dataUrl
    }

    throw new Error('Exported image exceeded browser canvas limits. Try a smaller selection.')
  }, [])

  const renderCanvasDataUri = useCallback(
    async (canvas: HTMLCanvasElement, format: RasterExportImageFormat) => {
      const blob = await renderCanvasBlob(canvas, format)
      return ensureExportImageDataUrl(await blobToDataUri(blob))
    },
    [ensureExportImageDataUrl, renderCanvasBlob]
  )

  const createRuntimeExportSnapshot = useCallback(
    (targetItems: CanvasItem[]) =>
      withProjectCanvasRuntime((runtime) => {
        runtime.setItems(targetItems)
        runtime.setViewport({ x: stagePos.x, y: stagePos.y, scale: stageScale })
        return runtime.createSnapshot({ selectedIds })
      }),
    [selectedIds, stagePos.x, stagePos.y, stageScale]
  )

  const resolveCanvasExportEntryBounds = useCallback(
    (item: CanvasItem, snapshot: ProjectCanvasRuntimeSnapshot): CanvasExportBounds | null => {
      const visualBounds = getCanvasItemVisualBounds(item)
      if (isUsableCanvasExportBounds(visualBounds)) {
        return visualBounds
      }

      return getProjectCanvasRuntimeExportBounds(snapshot, { itemIds: [item.id] })
    },
    [getCanvasItemVisualBounds]
  )

  const createCanvasExportEntries = useCallback(
    (targetItems: CanvasItem[]) => {
      const snapshot = createRuntimeExportSnapshot(targetItems)
      const entries = [...targetItems]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((item) => ({
          item,
          bounds: resolveCanvasExportEntryBounds(item, snapshot)
        }))
        .filter((entry): entry is { item: CanvasItem; bounds: CanvasExportBounds } =>
          isUsableCanvasExportBounds(entry.bounds)
        )

      return { entries, snapshot }
    },
    [createRuntimeExportSnapshot, resolveCanvasExportEntryBounds]
  )

  const renderCanvasItemsToCanvas = useCallback(
    async (
      targetItems: CanvasItem[],
      format: RasterExportImageFormat,
      includeBackground: boolean,
      clipBounds?: CanvasExportClipBounds | null
    ): Promise<HTMLCanvasElement> => {
      const { entries, snapshot } = createCanvasExportEntries(targetItems)

      const exportBounds =
        (isUsableCanvasExportBounds(clipBounds) ? clipBounds : null) ??
        buildCanvasExportBounds(entries) ??
        getProjectCanvasRuntimeExportBounds(snapshot, {
          itemIds: entries.map((entry) => entry.item.id),
          padding: EXPORT_IMAGE_PADDING
        })
      if (!exportBounds) {
        throw new Error('There is no renderable content to export')
      }

      const rasterConfig = resolveCanvasExportRasterConfig(
        exportBounds.width,
        exportBounds.height,
        EXPORT_IMAGE_PIXEL_RATIO
      )

      const canvasContext = createHtmlCanvasContext(
        rasterConfig.canvasWidth,
        rasterConfig.canvasHeight
      )
      if (!canvasContext) {
        throw new Error('Failed to create export canvas context')
      }
      const { canvas, ctx } = canvasContext

      if (rasterConfig.wasClamped) {
        console.warn(
          '[CanvasExport] Selection export was downscaled to stay within canvas limits',
          {
            exportBounds,
            rasterConfig
          }
        )
      }

      if (includeBackground) {
        if (bgColor !== 'transparent') {
          ctx.fillStyle = bgColor
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        } else if (format === 'jpeg') {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
      } else if (format === 'jpeg') {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }

      for (const entry of entries) {
        await drawCanvasItemForExport(
          ctx,
          entry.item,
          entry.bounds,
          exportBounds,
          rasterConfig.pixelRatio
        )
      }

      return canvas
    },
    [bgColor, createCanvasExportEntries, drawCanvasItemForExport]
  )

  const renderCanvasItemsImageDataUrl = useCallback(
    async (
      targetItems: CanvasItem[],
      includeBackground = false,
      clipBounds?: CanvasExportClipBounds | null
    ): Promise<string> => {
      const selectionSnapshot = await prepareExportRender()

      try {
        const canvas = await renderCanvasItemsToCanvas(
          targetItems,
          'png',
          includeBackground,
          clipBounds
        )
        return await renderCanvasDataUri(canvas, 'png')
      } finally {
        restoreExportRender(selectionSnapshot)
      }
    },
    [prepareExportRender, renderCanvasDataUri, renderCanvasItemsToCanvas, restoreExportRender]
  )

  const renderCanvasItemsImageBytes = useCallback(
    async (
      targetItems: CanvasItem[],
      format: CanvasRenderedImageFormat,
      includeBackground = false
    ): Promise<Uint8Array> => {
      const selectionSnapshot = await prepareExportRender()

      try {
        const rasterFormat: RasterExportImageFormat = format === 'jpeg' ? 'jpeg' : 'png'
        const canvas = await renderCanvasItemsToCanvas(targetItems, rasterFormat, includeBackground)

        if (format === 'svg') {
          const dataUri = await renderCanvasDataUri(canvas, 'png')
          const backgroundColor =
            includeBackground && bgColor !== 'transparent' ? bgColor : undefined
          const svgMarkup = buildRasterBackedSvgMarkup({
            width: canvas.width,
            height: canvas.height,
            imageHref: dataUri,
            backgroundColor
          })
          return new TextEncoder().encode(svgMarkup)
        }

        const blob = await renderCanvasBlob(canvas, rasterFormat)
        return new Uint8Array(await blob.arrayBuffer())
      } finally {
        restoreExportRender(selectionSnapshot)
      }
    },
    [
      bgColor,
      prepareExportRender,
      renderCanvasBlob,
      renderCanvasDataUri,
      renderCanvasItemsToCanvas,
      restoreExportRender
    ]
  )

  const renderCanvasItemsSvgMarkup = useCallback(
    async (targetItems: CanvasItem[], includeBackground = false): Promise<string> => {
      const selectionSnapshot = await prepareExportRender()

      try {
        const canvas = await renderCanvasItemsToCanvas(targetItems, 'png', includeBackground)
        const dataUri = await renderCanvasDataUri(canvas, 'png')
        const backgroundColor = includeBackground && bgColor !== 'transparent' ? bgColor : undefined

        return buildRasterBackedSvgMarkup({
          width: canvas.width,
          height: canvas.height,
          imageHref: dataUri,
          backgroundColor
        })
      } finally {
        restoreExportRender(selectionSnapshot)
      }
    },
    [
      bgColor,
      prepareExportRender,
      renderCanvasDataUri,
      renderCanvasItemsToCanvas,
      restoreExportRender
    ]
  )

  const buildQuickCanvasItemsImageUrlKey = useCallback(
    (targetItems: CanvasItem[]) => {
      const snapshot = createRuntimeExportSnapshot(targetItems)
      return JSON.stringify({
        stagePos,
        stageScale,
        items: [...targetItems]
          .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
          .map((item) => ({
            item: buildQuickCanvasItemCacheSnapshot(item),
            bounds: resolveCanvasExportEntryBounds(item, snapshot)
          }))
      })
    },
    [createRuntimeExportSnapshot, resolveCanvasExportEntryBounds, stagePos, stageScale]
  )

  const rememberQuickCanvasItemsImageUrl = useCallback(
    (cacheKey: string, imageUrl: string) => {
      const cache = quickCanvasImageUrlCacheRef.current
      const existing = cache.get(cacheKey)
      if (existing) {
        cache.delete(cacheKey)
        if (existing !== imageUrl) {
          disposeQuickCanvasImageUrl(existing)
        }
      }
      cache.set(cacheKey, imageUrl)

      while (cache.size > QUICK_CANVAS_IMAGE_URL_CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value
        if (!oldestKey) break
        const oldestImageUrl = cache.get(oldestKey)
        cache.delete(oldestKey)
        if (oldestImageUrl) {
          disposeQuickCanvasImageUrl(oldestImageUrl)
        }
      }
    },
    [disposeQuickCanvasImageUrl]
  )

  const getQuickCanvasItemsImageUrl = useCallback(
    (targetItems: CanvasItem[]): string | null => {
      const cacheKey = buildQuickCanvasItemsImageUrlKey(targetItems)
      const cachedImageUrl = quickCanvasImageUrlCacheRef.current.get(cacheKey)
      if (!cachedImageUrl) {
        return null
      }

      quickCanvasImageUrlCacheRef.current.delete(cacheKey)
      quickCanvasImageUrlCacheRef.current.set(cacheKey, cachedImageUrl)
      return cachedImageUrl
    },
    [buildQuickCanvasItemsImageUrlKey]
  )

  const renderQuickCanvasItemsToCanvas = useCallback(
    (targetItems: CanvasItem[]): HTMLCanvasElement | null => {
      const { entries, snapshot } = createCanvasExportEntries(targetItems)

      const exportBounds =
        buildCanvasExportBounds(entries) ??
        getProjectCanvasRuntimeExportBounds(snapshot, {
          itemIds: entries.map((entry) => entry.item.id),
          padding: EXPORT_IMAGE_PADDING
        })
      if (!exportBounds) return null

      const rasterConfig = resolveCanvasExportRasterConfig(
        exportBounds.width,
        exportBounds.height,
        EXPORT_IMAGE_PIXEL_RATIO
      )

      const canvasContext = createHtmlCanvasContext(
        rasterConfig.canvasWidth,
        rasterConfig.canvasHeight
      )
      if (!canvasContext) return null
      const { canvas, ctx } = canvasContext

      if (rasterConfig.wasClamped) {
        console.warn('[CanvasExport] Quick export was downscaled to stay within canvas limits', {
          exportBounds,
          rasterConfig
        })
      }

      const container = canvasContainerRef.current
      const webglCanvas = container?.querySelector(
        '.project-canvas-webgl-layer canvas'
      ) as HTMLCanvasElement | null

      if (webglCanvas && stageScale !== 0) {
        const visibleScale = Math.max(Math.abs(stageScale), 0.0001)
        const sourceX = stagePos.x + exportBounds.x * visibleScale
        const sourceY = stagePos.y + exportBounds.y * visibleScale
        const sourceWidth = Math.max(1, exportBounds.width * visibleScale)
        const sourceHeight = Math.max(1, exportBounds.height * visibleScale)
        ctx.drawImage(
          webglCanvas,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height
        )
      }

      for (const { item } of entries) {
        if (item.type === 'text' || item.type === 'file' || item.type === 'annotation') {
          drawTransformedItemSource(
            ctx,
            item,
            exportBounds,
            rasterConfig.pixelRatio,
            (targetCtx) => {
              if (item.type === 'text') {
                drawCanvasTextItem(targetCtx, item)
                return
              }

              if (item.type === 'file') {
                drawCanvasFileItem(targetCtx, item)
                return
              }

              drawCanvasAnnotationItem(targetCtx, item)
            }
          )
          continue
        }

        if (item.type !== 'video' && item.type !== 'model3d') continue

        const source = container?.querySelector(
          item.type === 'video'
            ? `[data-canvas-item-id="${item.id}"] video`
            : `[data-canvas-item-id="${item.id}"] canvas`
        ) as HTMLVideoElement | HTMLCanvasElement | null

        if (!source) continue
        if (item.type === 'video' && source instanceof HTMLVideoElement && source.readyState < 2) {
          continue
        }

        ctx.save()
        ctx.translate(
          (item.x - exportBounds.x) * rasterConfig.pixelRatio,
          (item.y - exportBounds.y) * rasterConfig.pixelRatio
        )
        if (item.rotation) {
          ctx.rotate((item.rotation * Math.PI) / 180)
        }
        ctx.scale(
          (item.scaleX || 1) * rasterConfig.pixelRatio,
          (item.scaleY || 1) * rasterConfig.pixelRatio
        )

        if (item.type === 'video' && source instanceof HTMLVideoElement) {
          const videoWidth = source.videoWidth || item.width
          const videoHeight = source.videoHeight || item.height
          const scale = Math.min(item.width / videoWidth, item.height / videoHeight)
          const drawWidth = videoWidth * scale
          const drawHeight = videoHeight * scale
          const offsetX = (item.width - drawWidth) / 2
          const offsetY = (item.height - drawHeight) / 2

          ctx.fillStyle = '#000000'
          ctx.fillRect(0, 0, item.width, item.height)
          ctx.drawImage(source, offsetX, offsetY, drawWidth, drawHeight)
        } else {
          ctx.drawImage(source, 0, 0, item.width, item.height)
        }

        ctx.restore()
      }
      return canvas
    },
    [
      canvasContainerRef,
      createCanvasExportEntries,
      drawTransformedItemSource,
      stagePos.x,
      stagePos.y,
      stageScale
    ]
  )

  const prepareQuickCanvasItemsImageUrl = useCallback(
    async (targetItems: CanvasItem[]): Promise<string | null> => {
      const cacheKey = buildQuickCanvasItemsImageUrlKey(targetItems)
      const cachedImageUrl = quickCanvasImageUrlCacheRef.current.get(cacheKey)
      if (cachedImageUrl) {
        quickCanvasImageUrlCacheRef.current.delete(cacheKey)
        quickCanvasImageUrlCacheRef.current.set(cacheKey, cachedImageUrl)
        return cachedImageUrl
      }

      const pendingImageUrl = quickCanvasImageUrlPendingRef.current.get(cacheKey)
      if (pendingImageUrl) {
        return await pendingImageUrl
      }

      const nextImageUrlPromise = (async () => {
        const canvas = renderQuickCanvasItemsToCanvas(targetItems)
        if (!canvas) {
          return null
        }

        const blob = await renderCanvasBlob(canvas, 'png')
        const imageUrl =
          typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(blob)
            : ensureExportImageDataUrl(await blobToDataUri(blob))
        rememberQuickCanvasItemsImageUrl(cacheKey, imageUrl)
        return imageUrl
      })()

      quickCanvasImageUrlPendingRef.current.set(cacheKey, nextImageUrlPromise)

      try {
        return await nextImageUrlPromise
      } finally {
        quickCanvasImageUrlPendingRef.current.delete(cacheKey)
      }
    },
    [
      buildQuickCanvasItemsImageUrlKey,
      ensureExportImageDataUrl,
      rememberQuickCanvasItemsImageUrl,
      renderCanvasBlob,
      renderQuickCanvasItemsToCanvas
    ]
  )

  const closeExportMenus = useCallback(() => {
    setExportSubmenuAnchor(null)
    setExportMenuAnchor(null)
  }, [])

  const handleOpenExportMenu = useCallback((anchorEl: HTMLElement) => {
    setExportMenuAnchor(anchorEl)
  }, [])

  const handleOpenExportContextMenu = useCallback((position: { x: number; y: number }) => {
    setExportCtxMenuPos(position)
  }, [])

  const handleCloseExportContextMenu = useCallback(() => {
    setExportCtxMenuPos(null)
  }, [])

  const handleCloseExportSubmenu = useCallback(() => {
    setExportSubmenuAnchor(null)
  }, [])

  const openExportSubmenu = useCallback((anchorEl: HTMLElement) => {
    const rect = anchorEl.getBoundingClientRect()
    setExportSubmenuPlacement(
      resolveExportSubmenuPlacement(rect.left, rect.right, window.innerWidth)
    )
    setExportSubmenuAnchor(anchorEl)
  }, [])

  const buildCanvasFileName = useCallback(
    (suffix?: string) => {
      const datePart = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')
      const baseName = sanitizeFilePart(projectName)
      return suffix
        ? `${baseName}_${suffix}_${datePart}.mpcanvas`
        : `${baseName}_${datePart}.mpcanvas`
    },
    [projectName]
  )

  const buildExportImageFileName = useCallback(
    (scope: ExportMenuScope, format: ExportImageFormat) => {
      const datePart = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')
      const baseName = sanitizeFilePart(projectName)
      const extension = getExportFileExtension(format)

      switch (scope) {
        case 'selected-scene':
          return `${baseName}_selected_scene_${datePart}${extension}`
        case 'all-elements':
          return `${baseName}_elements_${datePart}${extension}`
        case 'selected-elements':
          return `${baseName}_selected_elements_${datePart}${extension}`
        default:
          return `${baseName}_scene_${datePart}${extension}`
      }
    },
    [projectName]
  )

  const buildElementExportFileName = useCallback(
    (item: CanvasExportableItem, index: number, format: ExportImageFormat) => {
      const extension = getExportFileExtension(format)
      const preferredBase =
        item.type === 'image'
          ? item.fileName?.replace(/\.[^.]+$/, '') ||
            `element_${String(index + 1).padStart(3, '0')}`
          : item.fileName.replace(/\.[^.]+$/, '')

      return `${String(index + 1).padStart(3, '0')}_${sanitizeFilePart(preferredBase)}${extension}`
    },
    []
  )

  const handleSaveCanvas = useCallback(async () => {
    closeExportMenus()
    await exportCanvasFile(
      items,
      buildCanvasFileName(),
      canvasId,
      false,
      groups,
      figmaBinding,
      groupBranches
    )
  }, [buildCanvasFileName, canvasId, closeExportMenus, figmaBinding, groupBranches, groups, items])

  const handleSaveCanvasAs = useCallback(async () => {
    closeExportMenus()
    await exportCanvasFile(
      items,
      buildCanvasFileName(),
      canvasId,
      true,
      groups,
      figmaBinding,
      groupBranches
    )
  }, [buildCanvasFileName, canvasId, closeExportMenus, figmaBinding, groupBranches, groups, items])

  const handleSaveCanvasAsFromContextMenu = useCallback(async () => {
    setExportCtxMenuPos(null)
    await handleSaveCanvasAs()
  }, [handleSaveCanvasAs])

  const handleExportCanvasProjectFile = useCallback(async () => {
    closeExportMenus()
    await exportCanvasFileAsStandalone(
      items,
      buildCanvasFileName(),
      canvasId,
      groups,
      figmaBinding,
      groupBranches
    )
  }, [buildCanvasFileName, canvasId, closeExportMenus, figmaBinding, groupBranches, groups, items])

  const exportCanvasSceneAsImage = useCallback(
    async (
      targetItems: CanvasItem[],
      scope: Extract<ExportMenuScope, 'scene' | 'selected-scene'>,
      format: RasterExportImageFormat,
      emptyKey: string
    ) => {
      closeExportMenus()

      if (targetItems.length === 0) {
        notifyError(t(emptyKey))
        return
      }

      const outputPath = await chooseExportPath(buildExportImageFileName(scope, format), format)
      if (!outputPath) return

      const selectionSnapshot = await prepareExportRender()

      try {
        const canvas = await renderCanvasItemsToCanvas(targetItems, format, true)
        await saveCanvasToPath(canvas, outputPath, format)
        notifySuccess(t('canvas.export_scene_success'))
      } catch (err) {
        console.error('Failed to export canvas scene:', err)
        notifyError(
          `${t('canvas.export_failed')} ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        restoreExportRender(selectionSnapshot)
      }
    },
    [
      buildExportImageFileName,
      chooseExportPath,
      closeExportMenus,
      notifyError,
      notifySuccess,
      prepareExportRender,
      renderCanvasItemsToCanvas,
      restoreExportRender,
      saveCanvasToPath,
      t
    ]
  )

  const exportCanvasSceneAsSvg = useCallback(
    async (
      targetItems: CanvasItem[],
      scope: Extract<ExportMenuScope, 'scene' | 'selected-scene'>,
      emptyKey: string
    ) => {
      closeExportMenus()

      if (targetItems.length === 0) {
        notifyError(t(emptyKey))
        return
      }

      const outputPath = await chooseExportPath(buildExportImageFileName(scope, 'svg'), 'svg')
      if (!outputPath) return

      try {
        const svgMarkup = await renderCanvasItemsSvgMarkup(targetItems, true)
        await saveSvgToPath(svgMarkup, outputPath)
        notifySuccess(t('canvas.export_scene_success'))
      } catch (err) {
        console.error('Failed to export canvas scene as SVG:', err)
        notifyError(
          `${t('canvas.export_failed')} ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    [
      buildExportImageFileName,
      chooseExportPath,
      closeExportMenus,
      notifyError,
      notifySuccess,
      renderCanvasItemsSvgMarkup,
      saveSvgToPath,
      t
    ]
  )

  const exportCanvasElementsAsImages = useCallback(
    async (
      targetItems: CanvasExportableItem[],
      emptyKey: string,
      format: RasterExportImageFormat
    ) => {
      closeExportMenus()

      if (targetItems.length === 0) {
        notifyError(t(emptyKey))
        return
      }

      const result = await api().svcDialog.showOpenDialog({
        title: t('canvas.export_images_select_dir'),
        properties: ['openDirectory']
      })
      if (result.canceled || !result.filePaths?.length) return

      const outputDir = result.filePaths[0]
      const selectionSnapshot = await prepareExportRender()

      try {
        for (const [index, item] of targetItems.entries()) {
          const canvas = await renderCanvasItemsToCanvas([item], format, false)
          const fileName = buildElementExportFileName(item, index, format)
          await saveCanvasToDirectory(canvas, outputDir, fileName, format)
        }
      } catch (err) {
        console.error('Failed to export canvas elements as images:', err)
        notifyError(
          `${t('canvas.export_failed')} ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        restoreExportRender(selectionSnapshot)
      }
    },
    [
      buildElementExportFileName,
      closeExportMenus,
      notifyError,
      prepareExportRender,
      renderCanvasItemsToCanvas,
      restoreExportRender,
      saveCanvasToDirectory,
      t
    ]
  )

  const exportCanvasElementsAsSvg = useCallback(
    async (targetItems: CanvasExportableItem[], emptyKey: string) => {
      closeExportMenus()

      if (targetItems.length === 0) {
        notifyError(t(emptyKey))
        return
      }

      const result = await api().svcDialog.showOpenDialog({
        title: t('canvas.export_images_select_dir'),
        properties: ['openDirectory']
      })
      if (result.canceled || !result.filePaths?.length) return

      const outputDir = result.filePaths[0]

      try {
        for (const [index, item] of targetItems.entries()) {
          const svgMarkup = await renderCanvasItemsSvgMarkup([item], false)
          const fileName = buildElementExportFileName(item, index, 'svg')
          await saveSvgToDirectory(svgMarkup, outputDir, fileName)
        }
      } catch (err) {
        console.error('Failed to export canvas elements as SVG:', err)
        notifyError(
          `${t('canvas.export_failed')} ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    [
      buildElementExportFileName,
      closeExportMenus,
      notifyError,
      renderCanvasItemsSvgMarkup,
      saveSvgToDirectory,
      t
    ]
  )

  const handleExportScopeWithFormat = useCallback(
    (scope: ExportMenuScope, format: ExportImageFormat) => {
      const selectedItems = items.filter((item) => selectedIds.has(item.id))
      const exportableItems = items.filter(isCanvasExportableItem)
      const selectedExportableItems = selectedItems.filter(isCanvasExportableItem)

      if (scope === 'scene') {
        if (format === 'svg') {
          void exportCanvasSceneAsSvg(items, 'scene', 'canvas.export_scene_empty')
          return
        }

        void exportCanvasSceneAsImage(items, 'scene', format, 'canvas.export_scene_empty')
        return
      }

      if (scope === 'selected-scene') {
        if (format === 'svg') {
          void exportCanvasSceneAsSvg(selectedItems, 'selected-scene', 'canvas.export_scene_empty')
          return
        }

        void exportCanvasSceneAsImage(
          selectedItems,
          'selected-scene',
          format,
          'canvas.export_scene_empty'
        )
        return
      }

      if (scope === 'all-elements') {
        if (format === 'svg') {
          void exportCanvasElementsAsSvg(exportableItems, 'canvas.export_images_empty')
          return
        }

        void exportCanvasElementsAsImages(exportableItems, 'canvas.export_images_empty', format)
        return
      }

      if (format === 'svg') {
        void exportCanvasElementsAsSvg(
          selectedExportableItems,
          'canvas.export_selected_images_empty'
        )
        return
      }

      void exportCanvasElementsAsImages(
        selectedExportableItems,
        'canvas.export_selected_images_empty',
        format
      )
    },
    [
      exportCanvasElementsAsSvg,
      exportCanvasElementsAsImages,
      exportCanvasSceneAsSvg,
      exportCanvasSceneAsImage,
      items,
      selectedIds
    ]
  )

  return {
    exportMenuAnchor,
    exportSubmenuAnchor,
    exportSubmenuPlacement,
    exportCtxMenuPos,
    forceRenderAllItemsForExport,
    closeExportMenus,
    handleOpenExportMenu,
    handleOpenExportContextMenu,
    handleCloseExportContextMenu,
    handleCloseExportSubmenu,
    openExportSubmenu,
    handleSaveCanvas,
    handleSaveCanvasAs,
    handleSaveCanvasAsFromContextMenu,
    handleExportCanvasProjectFile,
    handleExportScopeWithFormat,
    renderCanvasItemsImageBytes,
    renderCanvasItemsImageDataUrl,
    renderCanvasItemsSvgMarkup,
    getQuickCanvasItemsImageUrl,
    prepareQuickCanvasItemsImageUrl
  }
}
