import type { CanvasTargetAssetMetadata } from '@shared/canvasTarget'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'

import {
  estimateDataUrlByteSize,
  extractMimeTypeFromSourceUrl,
  inferKnownImageHasAlpha
} from './canvasImageMetadata'
import {
  buildAspectRatio,
  extractFileNameFromSourceUrl,
  inferResourceKind,
  normalizeFiniteNumber,
  normalizeNonEmptyString,
  truncateText
} from './canvasTargetWorkflowCommon'
import type { CanvasItem } from './types'
import { getFileExtension } from './types'

function resolveAssetFileNames(
  item: CanvasItem,
  sourceUrl: string | undefined,
  fileName: string | undefined
): {
  localFileName?: string
  originalFileName?: string
} {
  const localFileName =
    normalizeNonEmptyString(fileName) ??
    normalizeNonEmptyString(extractFileNameFromSourceUrl(sourceUrl))
  const originalFileName =
    normalizeNonEmptyString(item.provenance?.sourceFileName) ??
    localFileName ??
    normalizeNonEmptyString(extractFileNameFromSourceUrl(sourceUrl))

  return {
    ...(localFileName ? { localFileName } : {}),
    ...(originalFileName ? { originalFileName } : {})
  }
}

function inferFileFormat(fileName?: string, mimeType?: string, sourceUrl?: string): string | null {
  const normalizedFileName = fileName || extractFileNameFromSourceUrl(sourceUrl)
  const extension = getFileExtension(normalizedFileName || '')
  if (extension) return extension.slice(1).toUpperCase()

  const normalizedMimeType = normalizeFileMimeType(fileName, mimeType, '').trim().toLowerCase()
  if (!normalizedMimeType) return null

  const subtype = normalizedMimeType.split('/')[1]?.split('+')[0]?.split('.').pop()?.trim()

  return subtype ? subtype.toUpperCase() : null
}

function buildBaseAssetExtra(
  item: CanvasItem,
  sourceUrl: string | undefined,
  fileName: string | undefined,
  mimeType: string | undefined
): Record<string, unknown> {
  const resolvedFileNames = resolveAssetFileNames(item, sourceUrl, fileName)
  return {
    originalFileName: resolvedFileNames.originalFileName ?? null,
    localFileName: resolvedFileNames.localFileName ?? null,
    fileFormat: inferFileFormat(fileName, mimeType, sourceUrl),
    resourceKind: inferResourceKind(sourceUrl),
    displayWidth: item.width,
    displayHeight: item.height,
    displayAspectRatio: buildAspectRatio(item.width, item.height),
    rotation: item.rotation,
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    locked: item.locked
  }
}

function mergeAssetExtra(
  base: Record<string, unknown>,
  override?: Record<string, unknown>
): Record<string, unknown> {
  if (!override) return base
  return {
    ...base,
    ...override
  }
}

function normalizeModel3DRuntimeExtra(
  runtimeExtra?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!runtimeExtra) {
    return runtimeExtra
  }

  const normalizedRuntimeExtra = { ...runtimeExtra }
  if (normalizedRuntimeExtra.faceCount == null && normalizedRuntimeExtra.triangleCount != null) {
    normalizedRuntimeExtra.faceCount = normalizedRuntimeExtra.triangleCount
  }

  delete normalizedRuntimeExtra.triangleCount
  return normalizedRuntimeExtra
}

export function sanitizeCanvasItemForCheckContext(item: CanvasItem): Record<string, unknown> {
  const base = {
    id: item.id,
    type: item.type,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    zIndex: item.zIndex,
    locked: item.locked,
    provenance: item.provenance ?? null
  }

  switch (item.type) {
    case 'image':
      return {
        ...base,
        fileName: item.fileName,
        src: item.src,
        sizeBytes: item.sizeBytes,
        crop: item.crop ?? null,
        hasAlpha: item.hasAlpha,
        promptId: item.promptId
      }
    case 'video':
      return {
        ...base,
        fileName: item.fileName,
        src: item.src,
        playing: item.playing,
        muted: item.muted,
        volume: item.volume,
        promptId: item.promptId
      }
    case 'model3d':
      return {
        ...base,
        fileName: item.fileName,
        src: item.src,
        textures: item.textures ? Object.keys(item.textures) : []
      }
    case 'file':
      return {
        ...base,
        fileName: item.fileName,
        src: item.src,
        mimeType: item.mimeType,
        fileKind: item.fileKind,
        sizeBytes: item.sizeBytes,
        previewText: truncateText(item.previewText),
        editable: item.editable ?? false,
        previewImages: item.previewImages?.map((image) => ({
          id: image.id,
          fileName: image.fileName,
          mimeType: image.mimeType
        }))
      }
    case 'text':
      return {
        ...base,
        text: item.text,
        fontSize: item.fontSize,
        fontFamily: item.fontFamily,
        fill: item.fill,
        fontWeight: item.fontWeight
      }
    case 'annotation':
      return {
        ...base,
        shape: item.shape,
        stroke: item.stroke,
        fillOpacity: item.fillOpacity,
        strokeWidth: item.strokeWidth,
        label: item.label,
        endX: item.endX,
        endY: item.endY,
        points: item.points,
        text: item.text,
        fontSize: item.fontSize,
        fontWeight: item.fontWeight
      }
    case 'html':
      return {
        ...base,
        htmlData: truncateText(item.htmlData, 800),
        interactive: item.interactive ?? false
      }
    default:
      return base
  }
}

export function buildCanvasTargetAssetMetadata(
  item: CanvasItem,
  runtimeExtra?: Record<string, unknown>
): CanvasTargetAssetMetadata {
  const provenance = item.provenance ? { ...item.provenance } : undefined

  switch (item.type) {
    case 'image': {
      const resolvedFileNames = resolveAssetFileNames(item, item.src, item.fileName)
      const mimeType = normalizeFileMimeType(
        resolvedFileNames.localFileName,
        extractMimeTypeFromSourceUrl(item.src),
        'image/png'
      )
      const sourceWidth =
        typeof item.sourceWidth === 'number' && Number.isFinite(item.sourceWidth)
          ? item.sourceWidth
          : undefined
      const sourceHeight =
        typeof item.sourceHeight === 'number' && Number.isFinite(item.sourceHeight)
          ? item.sourceHeight
          : undefined
      const sourceAspectRatio = buildAspectRatio(sourceWidth, sourceHeight) ?? undefined
      const sizeBytes =
        typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0
          ? item.sizeBytes
          : estimateDataUrlByteSize(item.src)
      const hasAlpha =
        typeof item.hasAlpha === 'boolean'
          ? item.hasAlpha
          : inferKnownImageHasAlpha(item.fileName, item.src)
      return {
        itemId: item.id,
        type: 'image',
        fileName: resolvedFileNames.localFileName,
        originalFileName: resolvedFileNames.originalFileName,
        mimeType,
        sizeBytes,
        sourceWidth,
        sourceHeight,
        sourceAspectRatio,
        promptId: item.promptId,
        sourceUrl: item.src,
        provenance,
        extra: mergeAssetExtra(
          {
            ...buildBaseAssetExtra(item, item.src, item.fileName, mimeType),
            sourceWidth: sourceWidth ?? null,
            sourceHeight: sourceHeight ?? null,
            sourceAspectRatio: sourceAspectRatio ?? null,
            crop: item.crop ?? null,
            hasAlpha: hasAlpha ?? null,
            colorSpace: null,
            textureUsage: null
          },
          runtimeExtra
        )
      }
    }
    case 'video': {
      const resolvedFileNames = resolveAssetFileNames(item, item.src, item.fileName)
      const mimeType = normalizeFileMimeType(
        resolvedFileNames.localFileName,
        extractMimeTypeFromSourceUrl(item.src),
        'video/mp4'
      )
      const sourceWidth = normalizeFiniteNumber(runtimeExtra?.sourceWidth)
      const sourceHeight = normalizeFiniteNumber(runtimeExtra?.sourceHeight)
      const sourceAspectRatio = buildAspectRatio(sourceWidth, sourceHeight)
      return {
        itemId: item.id,
        type: 'video',
        fileName: resolvedFileNames.localFileName,
        originalFileName: resolvedFileNames.originalFileName,
        mimeType,
        sourceWidth: sourceWidth ?? undefined,
        sourceHeight: sourceHeight ?? undefined,
        sourceAspectRatio: sourceAspectRatio ?? undefined,
        promptId: item.promptId,
        sourceUrl: item.src,
        provenance,
        extra: mergeAssetExtra(
          {
            ...buildBaseAssetExtra(item, item.src, item.fileName, mimeType),
            sourceWidth: sourceWidth ?? null,
            sourceHeight: sourceHeight ?? null,
            sourceAspectRatio: sourceAspectRatio ?? null,
            durationSeconds: null,
            currentTimeSeconds: null,
            fps: null,
            codec: null,
            bitrateKbps: null,
            colorSpace: null,
            audioChannels: null,
            loop: true,
            playing: item.playing,
            muted: item.muted,
            volume: item.volume
          },
          runtimeExtra
        )
      }
    }
    case 'model3d': {
      const textureNames = item.textures ? Object.keys(item.textures) : []
      const normalizedRuntimeExtra = normalizeModel3DRuntimeExtra(runtimeExtra)
      const resolvedFileNames = resolveAssetFileNames(item, item.src, item.fileName)
      const mimeType = normalizeFileMimeType(
        resolvedFileNames.localFileName,
        extractMimeTypeFromSourceUrl(item.src),
        'application/octet-stream'
      )
      return {
        itemId: item.id,
        type: 'model3d',
        fileName: resolvedFileNames.localFileName,
        originalFileName: resolvedFileNames.originalFileName,
        mimeType,
        sourceUrl: item.src,
        textures: textureNames,
        provenance,
        extra: mergeAssetExtra(
          {
            ...buildBaseAssetExtra(item, item.src, item.fileName, mimeType),
            textureCount: textureNames.length,
            vertexCount: null,
            faceCount: null,
            materialCount: null,
            animationCount: null,
            boneCount: null,
            uvSetCount: null,
            normalData: null,
            tangentData: null
          },
          normalizedRuntimeExtra
        )
      }
    }
    case 'file': {
      const resolvedFileNames = resolveAssetFileNames(item, item.src, item.fileName)
      return {
        itemId: item.id,
        type: 'file',
        fileName: resolvedFileNames.localFileName,
        originalFileName: resolvedFileNames.originalFileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        fileKind: item.fileKind,
        sourceUrl: item.src,
        previewText: truncateText(item.previewText),
        previewImageCount: item.previewImages?.length || 0,
        provenance,
        extra: {
          originalFileName: resolvedFileNames.originalFileName ?? null,
          localFileName: resolvedFileNames.localFileName ?? null,
          editable: item.editable ?? false
        }
      }
    }
    case 'text':
      return {
        itemId: item.id,
        type: 'text',
        textContent: truncateText(item.text),
        provenance,
        extra: {
          fontSize: item.fontSize,
          fontFamily: item.fontFamily,
          fontWeight: item.fontWeight,
          fill: item.fill
        }
      }
    case 'annotation':
      return {
        itemId: item.id,
        type: 'annotation',
        textContent: truncateText(item.text || item.label),
        provenance,
        extra: {
          shape: item.shape,
          stroke: item.stroke,
          fillOpacity: item.fillOpacity,
          strokeWidth: item.strokeWidth
        }
      }
    case 'html':
      return {
        itemId: item.id,
        type: 'html',
        textContent: truncateText(item.htmlData, 800),
        provenance,
        extra: {
          interactive: item.interactive ?? false
        }
      }
    default: {
      const unknownItem = item as CanvasItem
      return {
        itemId: unknownItem.id,
        type: 'unknown',
        provenance: unknownItem.provenance ? { ...unknownItem.provenance } : undefined
      }
    }
  }
}
