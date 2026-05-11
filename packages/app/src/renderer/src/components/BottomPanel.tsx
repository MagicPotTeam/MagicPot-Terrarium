import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Box, IconButton, Tooltip, Typography, useTheme } from '@mui/material'
import {
  Close as CloseIcon,
  Terminal as TerminalIcon,
  Dvr as ComfyIcon,
  InfoOutlined as InfoOutlinedIcon,
  Fullscreen as FullscreenIcon,
  FullscreenExit as FullscreenExitIcon,
  PlayArrow as PlayArrowIcon,
  Stop as StopIcon,
  DeleteOutline as ClearIcon
} from '@mui/icons-material'
import { useAppDispatch, useAppSelector } from '../store'
import {
  toggleBottomPanel,
  toggleBottomPanelMaximized,
  setBottomPanelTab
} from '../store/slices/layoutSlice'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import type { CanvasTargetAssetMetadata } from '@shared/canvasTarget'
import type {
  DesignInspectionContextPack,
  DesignInspectionItemSummary,
  DesignInspectionSelectionBounds
} from '@shared/designInspection'

const MAX_LOG_LINES = 1000
const SCROLL_THRESHOLD = 20
const ELEMENT_PANEL_MAX_RENDERED_CARDS = 60

const ELEMENT_PANEL_COPY = {
  tabLabel: '\u5143\u7d20',
  emptyTitle: '\u8fd8\u672a\u9009\u4e2d\u5143\u7d20',
  emptyDescription:
    '\u5728\u753b\u5e03\u4e2d\u6846\u9009\u6216\u70b9\u9009\u5143\u7d20\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u5f53\u524d\u9009\u533a\u7684\u5173\u952e\u4fe1\u606f\u3002',
  selectionSummary: '\u9009\u533a\u6982\u89c8',
  currentElements: '\u5f53\u524d\u5143\u7d20',
  currentCanvas: '\u5f53\u524d\u753b\u5e03',
  projectName: '\u9879\u76ee',
  canvasId: 'Canvas ID',
  selectionCount: '\u5df2\u9009\u5143\u7d20',
  bounds: '\u9009\u533a\u8fb9\u754c',
  groupCount: '\u9009\u4e2d\u7ec4',
  referenceCount: '\u5f15\u7528\u8d44\u6e90',
  documentCount: '\u6587\u6863',
  id: 'ID',
  type: '\u7c7b\u578b',
  originalFileName: '\u539f\u59cb\u6587\u4ef6\u540d',
  localFileName: '\u672c\u5730\u6587\u4ef6\u540d',
  fileFormat: '\u6587\u4ef6\u683c\u5f0f',
  position: '\u4f4d\u7f6e',
  size: '\u5c3a\u5bf8',
  displayAspectRatio: '\u663e\u793a\u5bbd\u9ad8\u6bd4',
  layer: '\u5c42\u7ea7',
  source: '\u6765\u6e90',
  sourceUrl: '\u8d44\u6e90',
  resourceKind: '\u8d44\u6e90\u7c7b\u578b',
  promptId: 'Prompt ID',
  sourceResolution: '\u539f\u59cb\u5206\u8fa8\u7387',
  sourceAspectRatio: '\u539f\u59cb\u5bbd\u9ad8\u6bd4',
  crop: '\u88c1\u5207',
  alphaChannel: '\u900f\u660e\u901a\u9053',
  colorSpace: '\u8272\u5f69\u7a7a\u95f4',
  textureUsage: '\u8d34\u56fe\u7528\u9014',
  rotation: '\u65cb\u8f6c',
  scale: '\u7f29\u653e',
  locked: '\u9501\u5b9a',
  duration: '\u65f6\u957f',
  currentTime: '\u5f53\u524d\u65f6\u95f4',
  fps: 'FPS',
  codec: '\u7f16\u7801',
  bitrate: '\u7801\u7387',
  playing: '\u64ad\u653e\u4e2d',
  muted: '\u9759\u97f3',
  volume: '\u97f3\u91cf',
  loop: '\u5faa\u73af',
  audioChannels: '\u97f3\u9891\u58f0\u9053',
  textures: '\u7eb9\u7406',
  textureCount: '\u8d34\u56fe\u6570\u91cf',
  vertexCount: '\u9876\u70b9\u6570',
  faceCount: '\u9762\u6570',
  materialCount: '\u6750\u8d28\u6570',
  animationCount: '\u52a8\u753b\u6570',
  boneCount: '\u9aa8\u9abc\u6570',
  uvSetCount: 'UV \u901a\u9053',
  normalData: '\u6cd5\u7ebf',
  tangentData: '\u5207\u7ebf',
  mimeType: 'MIME',
  previewText: '\u6458\u8981',
  textContent: '\u6587\u672c',
  fontSize: '\u5b57\u53f7',
  fontFamily: '\u5b57\u4f53',
  fontWeight: '\u5b57\u91cd',
  color: '\u989c\u8272',
  fillColor: '\u586b\u5145\u989c\u8272',
  strokeColor: '\u7ebf\u6761\u989c\u8272',
  label: '\u6807\u7b7e',
  shape: '\u5f62\u72b6',
  previewImageCount: '\u9884\u89c8\u56fe',
  fileKind: '\u6587\u4ef6\u7c7b\u522b',
  sizeBytes: '\u6587\u4ef6\u5927\u5c0f',
  editable: '\u53ef\u7f16\u8f91',
  interactive: '\u53ef\u4ea4\u4e92',
  none: '\u65e0',
  yes: '\u662f',
  no: '\u5426',
  noExtraInfo: '\u6682\u65e0\u66f4\u591a\u53ef\u5c55\u793a\u7684\u5143\u7d20\u7ec6\u8282',
  originMagicPotNative: 'MagicPot',
  originImportedFile: '\u5bfc\u5165\u6587\u4ef6',
  originExternal: '\u5916\u90e8\u8d44\u6e90',
  originFigma: 'Figma',
  originPsd: 'PSD',
  originPsb: 'PSB',
  originSvg: 'SVG'
} as const

type ElementInfoPayload = {
  canvasId?: string
  projectName?: string
  selectionCount: number
  structure: DesignInspectionContextPack | null
  assetMetadata: CanvasTargetAssetMetadata[]
  layerIndexByItemId?: Record<string, number>
}

type ElementInfoField = {
  label: string
  value: string
}

function formatMetric(value: number | undefined | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '')
}

function formatBounds(bounds: DesignInspectionSelectionBounds | null | undefined): string | null {
  if (!bounds) return null
  const x = formatMetric(bounds.x)
  const y = formatMetric(bounds.y)
  const width = formatMetric(bounds.width)
  const height = formatMetric(bounds.height)
  if (!x || !y || !width || !height) return null
  return `x: ${x}, y: ${y}, w: ${width}, h: ${height}`
}

function formatBoolean(
  value: boolean | undefined,
  yesLabel: string,
  noLabel: string
): string | null {
  if (typeof value !== 'boolean') return null
  return value ? yesLabel : noLabel
}

function formatBytes(sizeBytes: number | undefined): string | null {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

function truncateDisplayText(value: string | undefined, maxLength = 80): string | null {
  if (!value) return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function summarizeSourceUrl(sourceUrl: string | undefined): string | null {
  if (!sourceUrl) return null
  if (sourceUrl.startsWith('data:')) return 'data URL'
  if (sourceUrl.startsWith('blob:')) return 'blob URL'
  try {
    const parsed = new URL(sourceUrl)
    return parsed.pathname.split('/').pop() || parsed.host || sourceUrl
  } catch {
    return truncateDisplayText(sourceUrl, 64)
  }
}

function withFallback(value: string | null | undefined): string {
  return value && value.trim() ? value : ELEMENT_PANEL_COPY.none
}

function createField(label: string, value: string | null | undefined): ElementInfoField {
  return { label, value: withFallback(value) }
}

function normalizeDisplayString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function isRichMediaAssetType(type: string | undefined): type is 'image' | 'video' | 'model3d' {
  return type === 'image' || type === 'video' || type === 'model3d'
}

function formatResolution(width: unknown, height: unknown): string | null {
  const resolvedWidth =
    typeof width === 'number' && Number.isFinite(width) && width > 0 ? formatMetric(width) : null
  const resolvedHeight =
    typeof height === 'number' && Number.isFinite(height) && height > 0
      ? formatMetric(height)
      : null
  if (!resolvedWidth || !resolvedHeight) return null
  return `${resolvedWidth} x ${resolvedHeight}`
}

function formatAspectRatio(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const normalized = formatMetric(value)
  return normalized ? `${normalized}:1` : null
}

function formatScale(scaleX: unknown, scaleY: unknown): string | null {
  const normalizedX = formatMetric(typeof scaleX === 'number' ? scaleX : null)
  const normalizedY = formatMetric(typeof scaleY === 'number' ? scaleY : null)
  if (!normalizedX || !normalizedY) return null
  return `x: ${normalizedX}, y: ${normalizedY}`
}

function formatDurationSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const totalSeconds = Math.round(value)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatVolume(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.max(0, Math.min(1, value))
  return `${Math.round(normalized * 100)}%`
}

function formatBitrate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const normalized = formatMetric(value)
  return normalized ? `${normalized} kbps` : null
}

function formatResourceKind(value: unknown): string | null {
  switch (value) {
    case 'data-url':
      return 'Data URL'
    case 'blob-url':
      return 'Blob URL'
    case 'remote-url':
      return '\u8fdc\u7a0b URL'
    case 'local-path':
      return '\u672c\u5730\u8def\u5f84'
    case 'relative-path':
      return '\u76f8\u5bf9\u8def\u5f84'
    case 'unknown':
      return '\u672a\u77e5'
    default:
      return summarizeUnknownValue(value)
  }
}

function summarizeUnknownValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return truncateDisplayText(value, 120)
  if (typeof value === 'number') return formatMetric(value) ?? String(value)
  if (typeof value === 'boolean') return value ? ELEMENT_PANEL_COPY.yes : ELEMENT_PANEL_COPY.no
  if (Array.isArray(value)) {
    const parts = value.map((entry) => summarizeUnknownValue(entry)).filter(Boolean) as string[]
    return parts.length > 0 ? parts.join(', ') : null
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => {
        const summary = summarizeUnknownValue(entryValue)
        return summary ? `${key}: ${summary}` : null
      })
      .filter(Boolean) as string[]
    return entries.length > 0 ? entries.join(', ') : null
  }
  return String(value)
}

function formatElementTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'image':
      return '\u56fe\u7247'
    case 'video':
      return '\u89c6\u9891'
    case 'model3d':
      return '3D'
    case 'file':
      return '\u6587\u4ef6'
    case 'text':
      return '\u6587\u672c'
    case 'annotation':
      return '\u6807\u6ce8'
    case 'html':
      return 'HTML'
    case 'group':
      return '\u7ec4'
    default:
      return type || '\u672a\u77e5'
  }
}

function formatProvenanceLabel(kind: string | undefined): string | null {
  switch (kind) {
    case 'magicpot-native':
      return ELEMENT_PANEL_COPY.originMagicPotNative
    case 'imported-file':
      return ELEMENT_PANEL_COPY.originImportedFile
    case 'external':
      return ELEMENT_PANEL_COPY.originExternal
    case 'figma':
      return ELEMENT_PANEL_COPY.originFigma
    case 'psd':
      return ELEMENT_PANEL_COPY.originPsd
    case 'psb':
      return ELEMENT_PANEL_COPY.originPsb
    case 'svg':
      return ELEMENT_PANEL_COPY.originSvg
    default:
      return kind || null
  }
}

function summarizeProvenance(provenance: unknown): string | null {
  if (!provenance || typeof provenance !== 'object') return null
  const record = provenance as Record<string, unknown>
  const parts = [
    formatProvenanceLabel(typeof record.kind === 'string' ? record.kind : undefined),
    typeof record.sourceFileName === 'string' ? record.sourceFileName : null,
    typeof record.sourceNodeName === 'string' ? record.sourceNodeName : null,
    typeof record.sourceNodeId === 'string' ? `node: ${record.sourceNodeId}` : null,
    typeof record.sourceDocumentId === 'string' ? `doc: ${record.sourceDocumentId}` : null
  ].filter(Boolean) as string[]
  return parts.length > 0 ? parts.join(' / ') : null
}

function resolveElementFileNames(
  item: DesignInspectionItemSummary,
  assetMetadata?: CanvasTargetAssetMetadata
): {
  originalFileName: string | null
  localFileName: string | null
} {
  const extra = assetMetadata?.extra ?? {}
  const provenance = assetMetadata?.provenance ?? item.provenance
  const localFileName =
    normalizeDisplayString(extra.localFileName) ??
    normalizeDisplayString(assetMetadata?.fileName) ??
    normalizeDisplayString(item.fileName)
  const originalFileName =
    normalizeDisplayString(extra.originalFileName) ??
    normalizeDisplayString(
      provenance && typeof provenance === 'object'
        ? (provenance as Record<string, unknown>).sourceFileName
        : null
    ) ??
    localFileName

  return {
    originalFileName,
    localFileName: localFileName ?? originalFileName
  }
}

function pushField(
  fields: ElementInfoField[],
  label: string,
  value: string | null | undefined
): void {
  if (!value) return
  fields.push({ label, value })
}

function buildRichMediaElementFields(
  item: DesignInspectionItemSummary,
  assetMetadata: CanvasTargetAssetMetadata | undefined,
  layerIndexByItemId?: Record<string, number>
): ElementInfoField[] {
  const extra = assetMetadata?.extra ?? {}
  const fileNames = resolveElementFileNames(item, assetMetadata)
  const layerIndex = layerIndexByItemId?.[item.id]
  const displayAspectRatio =
    typeof extra.displayAspectRatio === 'number' && Number.isFinite(extra.displayAspectRatio)
      ? extra.displayAspectRatio
      : item.width > 0 && item.height > 0
        ? item.width / item.height
        : null

  const commonFields = [
    createField(ELEMENT_PANEL_COPY.id, item.id),
    createField(ELEMENT_PANEL_COPY.type, formatElementTypeLabel(assetMetadata?.type || item.type)),
    createField(ELEMENT_PANEL_COPY.originalFileName, fileNames.originalFileName),
    createField(ELEMENT_PANEL_COPY.localFileName, fileNames.localFileName),
    createField(ELEMENT_PANEL_COPY.fileFormat, summarizeUnknownValue(extra.fileFormat)),
    createField(ELEMENT_PANEL_COPY.mimeType, assetMetadata?.mimeType || item.mimeType || null),
    createField(
      ELEMENT_PANEL_COPY.source,
      summarizeProvenance(item.provenance ?? assetMetadata?.provenance)
    ),
    createField(ELEMENT_PANEL_COPY.sourceUrl, summarizeSourceUrl(assetMetadata?.sourceUrl)),
    createField(ELEMENT_PANEL_COPY.resourceKind, formatResourceKind(extra.resourceKind)),
    createField(ELEMENT_PANEL_COPY.promptId, assetMetadata?.promptId || null),
    createField(
      ELEMENT_PANEL_COPY.position,
      `x: ${formatMetric(item.x) || '0'}, y: ${formatMetric(item.y) || '0'}`
    ),
    createField(
      ELEMENT_PANEL_COPY.size,
      `w: ${formatMetric(item.width) || '0'}, h: ${formatMetric(item.height) || '0'}`
    ),
    createField(ELEMENT_PANEL_COPY.displayAspectRatio, formatAspectRatio(displayAspectRatio)),
    createField(ELEMENT_PANEL_COPY.bounds, formatBounds(item.bounds)),
    createField(ELEMENT_PANEL_COPY.layer, layerIndex == null ? null : String(layerIndex)),
    createField(
      ELEMENT_PANEL_COPY.rotation,
      formatMetric(typeof extra.rotation === 'number' ? extra.rotation : null)
    ),
    createField(ELEMENT_PANEL_COPY.scale, formatScale(extra.scaleX, extra.scaleY)),
    createField(
      ELEMENT_PANEL_COPY.locked,
      formatBoolean(
        typeof extra.locked === 'boolean' ? extra.locked : item.locked,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    ),
    createField(ELEMENT_PANEL_COPY.sizeBytes, formatBytes(assetMetadata?.sizeBytes))
  ]

  if (assetMetadata?.type === 'image' || item.type === 'image') {
    return [
      ...commonFields,
      createField(
        ELEMENT_PANEL_COPY.sourceResolution,
        formatResolution(extra.sourceWidth, extra.sourceHeight)
      ),
      createField(ELEMENT_PANEL_COPY.sourceAspectRatio, formatAspectRatio(extra.sourceAspectRatio)),
      createField(ELEMENT_PANEL_COPY.crop, summarizeUnknownValue(extra.crop)),
      createField(
        ELEMENT_PANEL_COPY.alphaChannel,
        formatBoolean(
          extra.hasAlpha as boolean | undefined,
          ELEMENT_PANEL_COPY.yes,
          ELEMENT_PANEL_COPY.no
        )
      ),
      createField(ELEMENT_PANEL_COPY.colorSpace, summarizeUnknownValue(extra.colorSpace)),
      createField(ELEMENT_PANEL_COPY.textureUsage, summarizeUnknownValue(extra.textureUsage))
    ]
  }

  if (assetMetadata?.type === 'video' || item.type === 'video') {
    return [
      ...commonFields,
      createField(
        ELEMENT_PANEL_COPY.sourceResolution,
        formatResolution(extra.sourceWidth, extra.sourceHeight)
      ),
      createField(ELEMENT_PANEL_COPY.sourceAspectRatio, formatAspectRatio(extra.sourceAspectRatio)),
      createField(ELEMENT_PANEL_COPY.duration, formatDurationSeconds(extra.durationSeconds)),
      createField(ELEMENT_PANEL_COPY.currentTime, formatDurationSeconds(extra.currentTimeSeconds)),
      createField(ELEMENT_PANEL_COPY.fps, summarizeUnknownValue(extra.fps)),
      createField(ELEMENT_PANEL_COPY.codec, summarizeUnknownValue(extra.codec)),
      createField(ELEMENT_PANEL_COPY.bitrate, formatBitrate(extra.bitrateKbps)),
      createField(
        ELEMENT_PANEL_COPY.playing,
        formatBoolean(
          extra.playing as boolean | undefined,
          ELEMENT_PANEL_COPY.yes,
          ELEMENT_PANEL_COPY.no
        )
      ),
      createField(
        ELEMENT_PANEL_COPY.muted,
        formatBoolean(
          extra.muted as boolean | undefined,
          ELEMENT_PANEL_COPY.yes,
          ELEMENT_PANEL_COPY.no
        )
      ),
      createField(ELEMENT_PANEL_COPY.volume, formatVolume(extra.volume)),
      createField(
        ELEMENT_PANEL_COPY.loop,
        formatBoolean(
          extra.loop as boolean | undefined,
          ELEMENT_PANEL_COPY.yes,
          ELEMENT_PANEL_COPY.no
        )
      ),
      createField(ELEMENT_PANEL_COPY.colorSpace, summarizeUnknownValue(extra.colorSpace)),
      createField(ELEMENT_PANEL_COPY.audioChannels, summarizeUnknownValue(extra.audioChannels))
    ]
  }

  return [
    ...commonFields,
    createField(ELEMENT_PANEL_COPY.textureCount, summarizeUnknownValue(extra.textureCount)),
    createField(
      ELEMENT_PANEL_COPY.textures,
      assetMetadata?.textures && assetMetadata.textures.length > 0
        ? assetMetadata.textures.join(', ')
        : null
    ),
    createField(ELEMENT_PANEL_COPY.vertexCount, summarizeUnknownValue(extra.vertexCount)),
    createField(
      ELEMENT_PANEL_COPY.faceCount,
      summarizeUnknownValue(extra.faceCount ?? extra.triangleCount)
    ),
    createField(ELEMENT_PANEL_COPY.materialCount, summarizeUnknownValue(extra.materialCount)),
    createField(ELEMENT_PANEL_COPY.animationCount, summarizeUnknownValue(extra.animationCount)),
    createField(ELEMENT_PANEL_COPY.boneCount, summarizeUnknownValue(extra.boneCount)),
    createField(ELEMENT_PANEL_COPY.uvSetCount, summarizeUnknownValue(extra.uvSetCount)),
    createField(
      ELEMENT_PANEL_COPY.normalData,
      formatBoolean(
        extra.normalData as boolean | undefined,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    ),
    createField(
      ELEMENT_PANEL_COPY.tangentData,
      formatBoolean(
        extra.tangentData as boolean | undefined,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    )
  ]
}

function buildElementFields(
  item: DesignInspectionItemSummary,
  assetMetadata?: CanvasTargetAssetMetadata,
  layerIndexByItemId?: Record<string, number>
): ElementInfoField[] {
  const resolvedType = assetMetadata?.type || item.type
  if (isRichMediaAssetType(resolvedType)) {
    return buildRichMediaElementFields(item, assetMetadata, layerIndexByItemId)
  }

  const fields: ElementInfoField[] = []
  const extra = assetMetadata?.extra ?? {}
  const fileNames = resolveElementFileNames(item, assetMetadata)
  const layerIndex = layerIndexByItemId?.[item.id]
  const hasFill = Boolean(item.fill)
  const hasStroke = Boolean(item.stroke)
  const fillLabel = hasFill && hasStroke ? ELEMENT_PANEL_COPY.fillColor : ELEMENT_PANEL_COPY.color
  const strokeLabel =
    hasFill && hasStroke ? ELEMENT_PANEL_COPY.strokeColor : ELEMENT_PANEL_COPY.color

  pushField(fields, ELEMENT_PANEL_COPY.id, item.id)
  pushField(
    fields,
    ELEMENT_PANEL_COPY.type,
    formatElementTypeLabel(assetMetadata?.type || item.type)
  )
  fields.push(createField(ELEMENT_PANEL_COPY.originalFileName, fileNames.originalFileName))
  fields.push(createField(ELEMENT_PANEL_COPY.localFileName, fileNames.localFileName))
  pushField(
    fields,
    ELEMENT_PANEL_COPY.position,
    `x: ${formatMetric(item.x) || '0'}, y: ${formatMetric(item.y) || '0'}`
  )
  pushField(
    fields,
    ELEMENT_PANEL_COPY.size,
    `w: ${formatMetric(item.width) || '0'}, h: ${formatMetric(item.height) || '0'}`
  )
  pushField(fields, ELEMENT_PANEL_COPY.bounds, formatBounds(item.bounds))
  pushField(fields, ELEMENT_PANEL_COPY.layer, layerIndex ? String(layerIndex) : null)
  pushField(
    fields,
    ELEMENT_PANEL_COPY.source,
    summarizeProvenance(item.provenance ?? assetMetadata?.provenance)
  )
  pushField(fields, ELEMENT_PANEL_COPY.textContent, truncateDisplayText(item.textContent))
  pushField(
    fields,
    ELEMENT_PANEL_COPY.previewText,
    truncateDisplayText(assetMetadata?.previewText || item.previewText, 120)
  )
  pushField(fields, ELEMENT_PANEL_COPY.sourceUrl, summarizeSourceUrl(assetMetadata?.sourceUrl))
  pushField(fields, ELEMENT_PANEL_COPY.promptId, assetMetadata?.promptId || null)
  pushField(fields, ELEMENT_PANEL_COPY.mimeType, assetMetadata?.mimeType || item.mimeType || null)
  pushField(fields, ELEMENT_PANEL_COPY.fileKind, assetMetadata?.fileKind || null)
  pushField(fields, ELEMENT_PANEL_COPY.sizeBytes, formatBytes(assetMetadata?.sizeBytes))
  pushField(fields, ELEMENT_PANEL_COPY.fontSize, formatMetric(item.fontSize))
  pushField(fields, ELEMENT_PANEL_COPY.fontFamily, item.fontFamily || null)
  pushField(fields, ELEMENT_PANEL_COPY.fontWeight, item.fontWeight || null)
  pushField(fields, fillLabel, item.fill || null)
  pushField(fields, strokeLabel, item.stroke || null)
  pushField(fields, ELEMENT_PANEL_COPY.label, item.label || null)
  pushField(fields, ELEMENT_PANEL_COPY.shape, item.shape || null)
  pushField(
    fields,
    ELEMENT_PANEL_COPY.previewImageCount,
    typeof assetMetadata?.previewImageCount === 'number'
      ? String(assetMetadata.previewImageCount)
      : null
  )

  if (assetMetadata?.type === 'image') {
    pushField(fields, ELEMENT_PANEL_COPY.crop, summarizeUnknownValue(assetMetadata.extra?.crop))
  }

  if (assetMetadata?.type === 'video') {
    pushField(
      fields,
      ELEMENT_PANEL_COPY.playing,
      formatBoolean(
        extra.playing as boolean | undefined,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    )
    pushField(
      fields,
      ELEMENT_PANEL_COPY.muted,
      formatBoolean(
        extra.muted as boolean | undefined,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    )
    pushField(fields, ELEMENT_PANEL_COPY.volume, summarizeUnknownValue(extra.volume))
  }

  if (assetMetadata?.type === 'model3d') {
    pushField(
      fields,
      ELEMENT_PANEL_COPY.textures,
      assetMetadata.textures && assetMetadata.textures.length > 0
        ? assetMetadata.textures.join(', ')
        : null
    )
  }

  if (assetMetadata?.type === 'file') {
    pushField(
      fields,
      ELEMENT_PANEL_COPY.editable,
      formatBoolean(
        extra.editable as boolean | undefined,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    )
  }

  if (assetMetadata?.type === 'html') {
    pushField(
      fields,
      ELEMENT_PANEL_COPY.interactive,
      formatBoolean(
        extra.interactive as boolean | undefined,
        ELEMENT_PANEL_COPY.yes,
        ELEMENT_PANEL_COPY.no
      )
    )
  }

  return fields
}

function buildElementCardTitle(
  item: DesignInspectionItemSummary,
  assetMetadata?: CanvasTargetAssetMetadata
): string {
  return (
    assetMetadata?.fileName ||
    item.fileName ||
    item.label ||
    truncateDisplayText(item.textContent, 40) ||
    formatElementTypeLabel(assetMetadata?.type || item.type)
  )
}

const getConsolePalette = (mode: 'light' | 'dark') => ({
  background: mode === 'light' ? '#f8fafc' : '#1e1e1e',
  text: mode === 'light' ? '#1f2937' : '#cccccc',
  muted: mode === 'light' ? '#667085' : '#9ca3af',
  toolbarIcon: mode === 'light' ? '#667085' : '#6e7681',
  toolbarDisabled: mode === 'light' ? '#c0c8d2' : '#333',
  scrollbarTrack: mode === 'light' ? '#e5e7eb' : '#2a2a2a',
  scrollbarThumb: mode === 'light' ? '#c0c8d2' : '#555',
  scrollbarThumbHover: mode === 'light' ? '#a8b3c2' : '#777'
})

const getElementPanelPalette = (mode: 'light' | 'dark') => ({
  panelBg: mode === 'light' ? '#eef4ff' : '#111827',
  cardBg: mode === 'light' ? '#ffffff' : 'rgba(17,24,39,0.9)',
  cardBorder: mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(255,255,255,0.08)',
  title: mode === 'light' ? '#1f2937' : '#f3f4f6',
  body: mode === 'light' ? '#1f2937' : '#e5e7eb',
  muted: mode === 'light' ? '#667085' : '#9ca3af',
  accent: mode === 'light' ? '#2563eb' : '#60a5fa'
})

const ELEMENT_PANEL_CARD_MIN_WIDTH = 320
const ELEMENT_PANEL_FIELD_MIN_WIDTH = 220

const ElementInfoSectionTitle: React.FC<{ title: string }> = ({ title }) => (
  <Typography
    variant="subtitle2"
    sx={(theme) => {
      const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
      return {
        mb: 1,
        fontWeight: 700,
        color: palette.title,
        letterSpacing: 0.2
      }
    }}
  >
    {title}
  </Typography>
)

const ElementInfoFieldRow: React.FC<ElementInfoField> = ({ label, value }) => (
  <Box
    sx={{
      display: 'grid',
      gridTemplateColumns: {
        xs: 'minmax(0, 1fr)',
        sm: '104px minmax(0, 1fr)'
      },
      gap: 1,
      alignItems: 'start'
    }}
  >
    <Typography
      variant="caption"
      sx={(theme) => {
        const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
        return { color: palette.muted, lineHeight: 1.5 }
      }}
    >
      {label}
    </Typography>
    <Typography
      variant="body2"
      sx={(theme) => {
        const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
        return { color: palette.body, lineHeight: 1.5, wordBreak: 'break-word' }
      }}
    >
      {value}
    </Typography>
  </Box>
)

const ElementInfoCard: React.FC<{
  title: string
  subtitle?: string | null
  fields: ElementInfoField[]
}> = ({ title, subtitle, fields }) => (
  <Box
    data-testid="element-info-card"
    sx={(theme) => {
      const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
      return {
        border: `1px solid ${palette.cardBorder}`,
        borderRadius: 2,
        background: palette.cardBg,
        p: 1.5
      }
    }}
  >
    <Box sx={{ mb: fields.length > 0 ? 1.25 : 0 }}>
      <Typography
        variant="body2"
        sx={(theme) => {
          const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
          return { color: palette.title, fontWeight: 700 }
        }}
      >
        {title}
      </Typography>
      {subtitle ? (
        <Typography
          variant="caption"
          sx={(theme) => {
            const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
            return { mt: 0.25, color: palette.accent, display: 'block' }
          }}
        >
          {subtitle}
        </Typography>
      ) : null}
    </Box>
    {fields.length > 0 ? (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(${ELEMENT_PANEL_FIELD_MIN_WIDTH}px, 1fr))`,
          gap: 0.75,
          alignItems: 'start'
        }}
      >
        {fields.map((field) => (
          <ElementInfoFieldRow key={`${field.label}-${field.value}`} {...field} />
        ))}
      </Box>
    ) : (
      <Typography
        variant="caption"
        sx={(theme) => {
          const palette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
          return { color: palette.muted }
        }}
      >
        {ELEMENT_PANEL_COPY.noExtraInfo}
      </Typography>
    )}
  </Box>
)

const TerminalPanel: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const consolePalette = getConsolePalette(theme.palette.mode as 'light' | 'dark')
  const [lines, setLines] = useState<string[]>([])
  const shouldAutoScroll = useRef(true)
  const outputRef = useRef<HTMLPreElement>(null)

  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    if (shouldAutoScroll.current) scrollToBottom()
  }, [lines, scrollToBottom])

  useEffect(() => {
    let unmounted = false
    const start = async () => {
      try {
        await api().svcLog.watchAppLogs(
          {},
          {
            onData: (data) => {
              if (unmounted) return
              const time = new Date(data.timestamp).toLocaleTimeString()
              const prefix = data.level === 'error' ? 'ERR' : data.level === 'warn' ? 'WRN' : ''
              const line = prefix ? `${time} ${prefix} ${data.message}` : `${time} ${data.message}`
              setLines((prev) => {
                const next = [...prev, line]
                return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
              })
            }
          }
        )
      } catch (error) {
        if (!isServerStreamingError(error)) {
          console.error('Watch logs failed:', error)
        }
      }
    }
    start()
    return () => {
      unmounted = true
    }
  }, [])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 0.5, py: 0.2, minHeight: 24 }}>
        <Tooltip title={t('terminal.clear')}>
          <IconButton
            size="small"
            onClick={() => setLines([])}
            sx={{ p: 0.3, color: consolePalette.toolbarIcon, '&:hover': { color: '#f87171' } }}
          >
            <ClearIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <pre
        ref={outputRef}
        onScroll={() => {
          if (!outputRef.current) return
          const { scrollTop, scrollHeight, clientHeight } = outputRef.current
          shouldAutoScroll.current =
            Math.abs(scrollTop + clientHeight - scrollHeight) < SCROLL_THRESHOLD
        }}
        style={{
          flex: 1,
          margin: 0,
          padding: '4px 8px',
          overflow: 'auto',
          background: consolePalette.background,
          color: consolePalette.text,
          fontFamily: '"Cascadia Code", "Consolas", "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
      >
        {lines.join('\n')}
      </pre>
    </Box>
  )
}

const ComfyUIPanel: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const consolePalette = getConsolePalette(theme.palette.mode as 'light' | 'dark')
  const { state, setPid, setIsRunning, addOutput, clearOutput } = useComfyProcess()
  const shouldAutoScroll = useRef(true)
  const outputRef = useRef<HTMLPreElement>(null)

  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    if (shouldAutoScroll.current) scrollToBottom()
  }, [state.output, scrollToBottom])

  const handleStartServer = useCallback(async () => {
    if (state.isRunning) {
      return
    }

    try {
      const { pid } = await api().svcHyper.comfyPortDetect({})
      if (pid !== 0) {
        if (pid !== state.pid) {
          setPid(pid)
        }
        window.dispatchEvent(new CustomEvent('comfyui:ready'))
        return
      }

      setIsRunning(true)
      addOutput(t('terminal.starting_server'))
      await api().svcHyper.startComfyUI(
        {},
        {
          onData: (data) => {
            if (data.pid !== 0 && data.pid !== state.pid) {
              setPid(data.pid)
            }
          }
        }
      )
    } catch (error: unknown) {
      if (isServerStreamingError(error)) {
        addOutput('ERROR> ' + (error as Error).message)
      } else {
        addOutput('ERROR> ' + String(error))
      }
    } finally {
      setIsRunning(false)
    }
  }, [setIsRunning, addOutput, setPid, state.isRunning, state.pid, t])

  const handleStopServer = useCallback(async () => {
    addOutput(t('terminal.stopping_server'))
    await api().svcHyper.killSubProcess({ pid: state.pid })
    addOutput(t('terminal.server_stopped'))
    setIsRunning(false)
  }, [addOutput, t, state.pid, setIsRunning])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 0.3,
          px: 0.5,
          py: 0.2,
          minHeight: 24
        }}
      >
        {state.isRunning && (
          <Box sx={{ mr: 'auto', display: 'flex', alignItems: 'center', gap: 0.5, pl: 0.5 }}>
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: '#4ade80',
                animation: 'pulse 1.5s infinite',
                '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.3 } }
              }}
            />
            <span style={{ fontSize: 11, color: '#4ade80' }}>Running</span>
            {state.pid !== 0 && (
              <span style={{ fontSize: 11, color: consolePalette.toolbarIcon }}>
                PID:{state.pid}
              </span>
            )}
          </Box>
        )}
        <Tooltip title={t('terminal.btn_start')}>
          <span>
            <IconButton
              size="small"
              onClick={handleStartServer}
              disabled={state.isRunning}
              sx={{
                p: 0.3,
                color: '#4ade80',
                '&.Mui-disabled': { color: consolePalette.toolbarDisabled }
              }}
            >
              <PlayArrowIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t('terminal.btn_stop')}>
          <span>
            <IconButton
              size="small"
              onClick={handleStopServer}
              disabled={!state.isRunning}
              sx={{
                p: 0.3,
                color: '#f87171',
                '&.Mui-disabled': { color: consolePalette.toolbarDisabled }
              }}
            >
              <StopIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t('terminal.clear')}>
          <IconButton
            size="small"
            onClick={clearOutput}
            sx={{ p: 0.3, color: consolePalette.toolbarIcon, '&:hover': { color: '#f87171' } }}
          >
            <ClearIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <pre
        ref={outputRef}
        onScroll={() => {
          if (!outputRef.current) return
          const { scrollTop, scrollHeight, clientHeight } = outputRef.current
          shouldAutoScroll.current =
            Math.abs(scrollTop + clientHeight - scrollHeight) < SCROLL_THRESHOLD
        }}
        style={{
          flex: 1,
          margin: 0,
          padding: '4px 8px',
          overflow: 'auto',
          background: consolePalette.background,
          color: consolePalette.text,
          fontFamily: '"Cascadia Code", "Consolas", "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
      >
        {state.output.join('\n')}
      </pre>
    </Box>
  )
}

const ElementInfoPanel: React.FC = () => {
  const theme = useTheme()
  const panelPalette = getElementPanelPalette(theme.palette.mode as 'light' | 'dark')
  const [payload, setPayload] = useState<ElementInfoPayload | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const assetMetadataById = useMemo(
    () => new Map((payload?.assetMetadata || []).map((item) => [item.itemId, item])),
    [payload?.assetMetadata]
  )
  const selectionSignature = useMemo(() => {
    const itemIds = payload?.structure?.selection.itemIds || []
    return `${payload?.canvasId || ''}:${itemIds.join('|')}`
  }, [payload?.canvasId, payload?.structure?.selection.itemIds])

  useEffect(() => {
    const handleSelectionInfo = (event: Event) => {
      setPayload((event as CustomEvent<ElementInfoPayload>).detail)
    }

    window.addEventListener('canvas:selection-info', handleSelectionInfo as EventListener)
    return () => {
      window.removeEventListener('canvas:selection-info', handleSelectionInfo as EventListener)
    }
  }, [])

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = 0
    }
  }, [selectionSignature])

  if (!payload || payload.selectionCount === 0 || !payload.structure) {
    return (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 3,
          textAlign: 'center',
          color: panelPalette.muted
        }}
      >
        <Box>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 700 }}>
            {ELEMENT_PANEL_COPY.emptyTitle}
          </Typography>
          <Typography variant="body2" sx={{ color: panelPalette.muted }}>
            {ELEMENT_PANEL_COPY.emptyDescription}
          </Typography>
        </Box>
      </Box>
    )
  }

  const selectionItems = payload.structure.selectionItems
  const visibleSelectionItems = selectionItems.slice(0, ELEMENT_PANEL_MAX_RENDERED_CARDS)
  const hiddenSelectionItemCount = Math.max(0, selectionItems.length - visibleSelectionItems.length)

  return (
    <Box
      ref={outputRef}
      sx={{
        flex: 1,
        p: 1.5,
        overflow: 'auto',
        background: panelPalette.panelBg,
        color: panelPalette.body
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        {hiddenSelectionItemCount > 0 && (
          <Box
            data-testid="element-panel-render-limit"
            sx={{
              mb: 1,
              px: 1.25,
              py: 0.85,
              border: `1px solid ${panelPalette.cardBorder}`,
              borderRadius: 1,
              background: panelPalette.cardBg,
              color: panelPalette.muted
            }}
          >
            <Typography variant="caption" sx={{ color: 'inherit' }}>
              {`\u5df2\u9009 ${selectionItems.length} \u4e2a\u5143\u7d20\uff0c\u4ec5\u6e32\u67d3\u524d ${visibleSelectionItems.length} \u4e2a\u8be6\u60c5\u5361\u3002`}
            </Typography>
          </Box>
        )}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(${ELEMENT_PANEL_CARD_MIN_WIDTH}px, 1fr))`,
            gap: 1
          }}
        >
          {visibleSelectionItems.map((item) => {
            const assetMetadata = assetMetadataById.get(item.id)
            return (
              <ElementInfoCard
                key={item.id}
                title={buildElementCardTitle(item, assetMetadata)}
                subtitle={formatElementTypeLabel(assetMetadata?.type || item.type)}
                fields={buildElementFields(item, assetMetadata, payload.layerIndexByItemId)}
              />
            )
          })}
        </Box>
      </Box>
    </Box>
  )
}

const BOTTOM_PANEL_DEFAULT_HEIGHT = 220

type BottomTabId = 'terminal' | 'comfyui' | 'elements'

interface BottomPanelProps {
  height?: number | string
}

const BottomPanel: React.FC<BottomPanelProps> = ({ height = BOTTOM_PANEL_DEFAULT_HEIGHT }) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const dispatch = useAppDispatch()
  const visible = useAppSelector((s) => s.layout.bottomPanelVisible)
  const activeTab = useAppSelector((s) => s.layout.bottomPanelActiveTab)
  const maximized = useAppSelector((s) => s.layout.bottomPanelMaximized)

  const bottomTabs: { id: BottomTabId; label: string; Icon: React.ElementType }[] = [
    { id: 'terminal', label: t('terminal.terminal_log'), Icon: TerminalIcon },
    { id: 'comfyui', label: 'ComfyUI', Icon: ComfyIcon },
    { id: 'elements', label: ELEMENT_PANEL_COPY.tabLabel, Icon: InfoOutlinedIcon }
  ]

  return (
    <Box
      sx={(theme) => ({
        height,
        minHeight: height,
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        borderTop: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.mode === 'light' ? '#edf2fb' : '#1e1e1e',
        flexShrink: 0,
        overflow: 'hidden'
      })}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 28,
          px: 0.5,
          borderBottom: `1px solid ${theme.palette.divider}`,
          backgroundColor: isLight ? '#e2e8f4' : '#181818'
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {bottomTabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <Box
                key={tab.id}
                onClick={() => dispatch(setBottomPanelTab(tab.id))}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  px: 1,
                  py: 0.4,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive
                    ? isLight
                      ? theme.palette.primary.main
                      : '#fff'
                    : theme.palette.text.secondary,
                  borderBottom: isActive
                    ? `2px solid ${isLight ? theme.palette.primary.main : '#007acc'}`
                    : '2px solid transparent',
                  backgroundColor: isActive && isLight ? 'rgba(255,255,255,0.55)' : 'transparent',
                  borderTopLeftRadius: 6,
                  borderTopRightRadius: 6,
                  userSelect: 'none',
                  '&:hover': { color: isLight ? theme.palette.text.primary : '#ccc' }
                }}
              >
                {React.createElement(tab.Icon, { sx: { fontSize: 14 } })}
                <span>{tab.label}</span>
              </Box>
            )
          })}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.2, pr: 0.5 }}>
          <Tooltip
            title={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
            placement="top"
          >
            <IconButton
              size="small"
              onClick={() => dispatch(toggleBottomPanelMaximized())}
              sx={{
                p: 0.25,
                color: theme.palette.text.secondary,
                '&:hover': { color: theme.palette.text.primary }
              }}
            >
              {maximized ? (
                <FullscreenExitIcon sx={{ fontSize: 15 }} />
              ) : (
                <FullscreenIcon sx={{ fontSize: 15 }} />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title={t('titlebar.close')} placement="top">
            <IconButton
              size="small"
              onClick={() => dispatch(toggleBottomPanel())}
              sx={{ p: 0.25, color: theme.palette.text.secondary, '&:hover': { color: '#f87171' } }}
            >
              <CloseIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box
        sx={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {activeTab === 'terminal' && <TerminalPanel />}
        {activeTab === 'comfyui' && <ComfyUIPanel />}
        {activeTab === 'elements' && <ElementInfoPanel />}
      </Box>
    </Box>
  )
}

export { BOTTOM_PANEL_DEFAULT_HEIGHT }
export default BottomPanel
