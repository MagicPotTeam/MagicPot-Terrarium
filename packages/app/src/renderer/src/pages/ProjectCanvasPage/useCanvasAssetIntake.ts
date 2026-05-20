import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'
import type { FileItem } from '@shared/comfy/types'
import { getDownloadFileNameFromUrl, normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'
import { FILE_NODE_DEFAULT_HEIGHT, FILE_NODE_DEFAULT_WIDTH } from './projectCanvasPageShared'
import { resolveOfficeFileNodeData } from './officePreviewUtils'
import { importCanvasFile, rememberCanvasSaveTargetPath } from './canvasStorage'
import { extractModelArchive } from './modelArchive'
import { materializePsdFile } from './psdImport'
import { resolveCanvas3DRenderActivationDelay } from './canvas3DRenderActivation'
import { getCanvasLocalMediaSourceUrl, getElectronCanvasFilePath } from './canvasLocalFileSource'
import { readCanvasLocalImageBlobFromSource } from './canvasLocalImageSource'
import {
  createCanvasFileItemDraft,
  createCanvasHtmlItemDraft,
  createCanvasImageItemDraft,
  createCanvasItemId,
  createCanvasModel3DItemDraft,
  createCanvasTextItemDraft,
  createCanvasVideoItemDraft,
  normalizeImportedCanvasGroups
} from './canvasAssetDraftFactories'
import {
  createExternalCanvasProvenance,
  createImportedFileProvenance,
  createMagicPotNativeProvenance
} from './canvasProvenanceUtils'
import type {
  CanvasImageAsset,
  CanvasFileItem,
  CanvasGroup,
  CanvasGroupBranch,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasProvenanceSource
} from './types'
import type { CanvasTool } from './projectCanvasPageShared'
import {
  buildCanvasImagePlaceholderAsset,
  buildCanvasImagePreviewFromBlob,
  buildCanvasImageDisplayAsset,
  estimateCanvasImageDecodedByteSize,
  getCanvasImagePreviewMaxSideForBatch,
  hydrateCanvasImageItemForCanvas,
  loadImageFromSrc,
  readFileAsDataURL,
  resolveCanvasImageThumbnailDisplayAsset,
  type CanvasImageSourceInput
} from './canvasAssetIntakeHelpers'
import {
  buildBboxToCellIdsMap,
  buildCanvasPreviewSheetsFromOcrResult,
  buildOcrResultHtml,
  isNormalizedOcrBox
} from './ocrCanvasUtils'
import { normalizeOfficeFileNodeDataForCanvas } from './projectCanvasPageShared'
import {
  detectImageHasAlpha,
  estimateDataUrlByteSize,
  inferKnownImageHasAlpha
} from './canvasImageMetadata'
import { resolveAutoArrangeSpatialGridLayout } from './groupAutoArrangeUtils'
import { isModelArchiveFile } from './types'
import { measureCanvasTextBoxSize } from './canvasTextLayout'

type UseCanvasAssetIntakeOptions = {
  canvasId?: string
  dispatch?: unknown
  fitImageToCanvasSize?: (width: number, height: number) => { width: number; height: number }
  getBatchGridLayout?: (
    sizes: Array<{ width: number; height: number }>,
    options?: {
      gap?: number
      minColumns?: number
      maxColumns?: number
      allowUpscale?: boolean
    }
  ) => Array<{ x: number; y: number; width: number; height: number }>
  getCanvasPointFromClient?: (clientX?: number, clientY?: number) => { x: number; y: number } | null
  getCenterPosition?: (width: number, height: number) => { x: number; y: number }
  getNextAutoImagePosition?: (width: number, height: number) => { x: number; y: number }
  getViewportBounds?: () => { x: number; y: number; width: number; height: number }
  markAutoPlacementBatch?: (count: number) => void
  nextZIndexRef: MutableRefObject<number>
  setItemsWithoutHistory?: Dispatch<SetStateAction<CanvasItem[]>>
  setItemsWithHistory: Dispatch<SetStateAction<CanvasItem[]>>
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  setGroupBranches: Dispatch<SetStateAction<CanvasGroupBranch[]>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  notifyError: (message: string) => unknown
  notifyWarning: (message: string) => unknown
  notifySuccess: (message: string) => unknown
  t?: unknown
  isChineseUi?: boolean
  openQuickAppPanel?: () => void
  activateModel3DRender?: (itemId: string, delay?: number) => void
  setPendingTextureModelId?: (itemId: string | null) => void
  setTextureImportDialogOpen?: (open: boolean) => void
  resolveCurrentItemCount?: () => number
  onImageBatchImportProgress?: (progress: CanvasImageBatchImportProgress | null) => void
}

type AddCanvasImageOptions = {
  clientX?: number
  clientY?: number
  fileName?: string
  sizeBytes?: number
  hasAlpha?: boolean
  sourceFile?: Blob
  sourceIdentity?: CanvasImageItem['sourceIdentity']
  thumbnailSet?: CanvasImageItem['thumbnailSet']
  provenance?: CanvasProvenanceSource
  promptId?: string
  fileItem?: FileItem
  sourceWidthHint?: number
  sourceHeightHint?: number
  select?: boolean
  reportBundleId?: CanvasImageItem['reportBundleId']
  reportBundleRole?: CanvasImageItem['reportBundleRole']
  reportBundleRefName?: CanvasImageItem['reportBundleRefName']
  reportBundleManifestUrl?: CanvasImageItem['reportBundleManifestUrl']
}

type AddModel3DUrlOptions = {
  clientX?: number
  clientY?: number
  fileName?: string
  offsetX?: number
  offsetY?: number
  width?: number
  height?: number
  select?: boolean
  hy3dQuickAppKey?: CanvasModel3DItem['hy3dQuickAppKey']
  hy3dParams?: CanvasModel3DItem['hy3dParams']
  hy3dMediaState?: CanvasModel3DItem['hy3dMediaState']
}

type AddModel3DOptions = {
  linkedAssets?: Record<string, string>
  skipTexturePrompt?: boolean
}

type AddOcrResultToCanvasOptions = {
  file: File
  attachment?: ChatAttachment
  ocrResult: OCRResult
  clientX?: number
  clientY?: number
}

type CanvasImageInput = CanvasImageSourceInput
type NormalizedCanvasImageSource = Exclude<CanvasImageSourceInput, string>

export type CanvasImageBatchImportProgressPhase =
  | 'preparing'
  | 'loading'
  | 'committing'
  | 'complete'

export type CanvasImageBatchImportProgress = {
  phase: CanvasImageBatchImportProgressPhase
  total: number
  processed: number
  imported: number
  failed: number
}

type CanvasImageStreamEntry = {
  source: NormalizedCanvasImageSource
  sourceIndex: number
  displayImage?: CanvasImageAsset
  thumbnailSet?: CanvasImageItem['thumbnailSet']
  sizeBytes?: number
  hasAlpha: boolean | null
  sourceWidth: number
  sourceHeight: number
  width: number
  height: number
}

export const PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY = 4
export const PROJECT_CANVAS_IMAGE_STREAM_IMPORT_THRESHOLD = 128
export const PROJECT_CANVAS_IMAGE_STREAM_COMMIT_CHUNK_SIZE = 48
export const PROJECT_CANVAS_IMAGE_STREAM_PROGRESS_BATCH_SIZE = 24
export const PROJECT_CANVAS_IMAGE_STREAM_LOAD_TIMEOUT_MS = 30_000
export const PROJECT_CANVAS_IMAGE_STREAM_PREVIEW_TIMEOUT_MS = 8_000
export const PROJECT_CANVAS_IMAGE_THUMBNAIL_RESOLVE_TIMEOUT_MS =
  PROJECT_CANVAS_IMAGE_STREAM_PREVIEW_TIMEOUT_MS
export const PROJECT_CANVAS_IMAGE_EAGER_DECODE_MAX_BYTES = 128 * 1024 * 1024
export const PROJECT_CANVAS_IMAGE_EAGER_FILE_SIZE_MAX_BYTES = 8 * 1024 * 1024
export const PROJECT_CANVAS_IMAGE_DEFERRED_PREVIEW_MAX_BYTES =
  PROJECT_CANVAS_IMAGE_EAGER_DECODE_MAX_BYTES
export const PROJECT_CANVAS_IMAGE_DEFERRED_PLACEHOLDER_MAX_SIDE = 512
export const PROJECT_CANVAS_IMAGE_LAZY_IMPORT_THRESHOLD = 384
export const PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT = 128
export const PROJECT_CANVAS_IMAGE_LAZY_IMPORT_DEFAULT_SOURCE_EDGE = 1536

function applyImportedImageBatchSelection(
  items: Array<Pick<CanvasImageItem, 'id'>>,
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>,
  setTool: Dispatch<SetStateAction<CanvasTool>>
) {
  if (items.length === 0) {
    return
  }

  setSelectedIds(items.length === 1 ? new Set([items[0].id]) : new Set())
  setTool('select')
}

function getProjectCanvasBatchGap(batchSize: number): number {
  return batchSize >= 48 ? 12 : batchSize >= 24 ? 16 : batchSize >= 8 ? 20 : 24
}

function compactStreamedImageItems(items: CanvasImageItem[], gap: number): CanvasImageItem[] {
  if (items.length < 2) return items

  const minX = Math.min(...items.map((item) => item.x))
  const minY = Math.min(...items.map((item) => item.y))
  const layout = resolveAutoArrangeSpatialGridLayout(
    items.map((item, index) => ({
      index,
      minX: item.x,
      minY: item.y,
      width: item.width,
      height: item.height
    }))
  )

  if (layout.assignments.length !== items.length || layout.rows <= 0 || layout.columns <= 0) {
    return items
  }

  const columnWidths = Array.from({ length: layout.columns }, () => 0)
  const rowHeights = Array.from({ length: layout.rows }, () => 0)

  for (const assignment of layout.assignments) {
    const item = items[assignment.index]
    columnWidths[assignment.col] = Math.max(columnWidths[assignment.col], item.width)
    rowHeights[assignment.row] = Math.max(rowHeights[assignment.row], item.height)
  }

  const columnOffsets = columnWidths.map((_, columnIndex) => {
    let offset = 0
    for (let index = 0; index < columnIndex; index += 1) {
      offset += columnWidths[index] + gap
    }
    return offset
  })
  const rowOffsets = rowHeights.map((_, rowIndex) => {
    let offset = 0
    for (let index = 0; index < rowIndex; index += 1) {
      offset += rowHeights[index] + gap
    }
    return offset
  })

  const compacted = [...items]
  let changed = false

  for (const assignment of layout.assignments) {
    const item = items[assignment.index]
    const nextX = minX + columnOffsets[assignment.col]
    const nextY = minY + rowOffsets[assignment.row]
    if (item.x !== nextX || item.y !== nextY) {
      changed = true
      compacted[assignment.index] = {
        ...item,
        x: nextX,
        y: nextY
      }
    }
  }

  return changed ? compacted : items
}

export async function mapCanvasImageBatchWithConcurrency<T, R>(
  inputs: T[],
  concurrency: number,
  worker: (input: T, index: number) => Promise<R | null>
): Promise<R[]> {
  const workerCount = Math.max(1, Math.min(inputs.length, Math.floor(concurrency) || 1))
  const results: Array<R | null> = new Array(inputs.length).fill(null)
  let nextIndex = 0

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(inputs[index], index)
      }
    })
  )

  return results.flatMap((entry) => (entry != null ? [entry] : []))
}

export async function mapCanvasImageBatchWithProgress<T, R>(
  inputs: T[],
  concurrency: number,
  worker: (input: T, index: number) => Promise<R | null>,
  onResult: (result: R) => Promise<void> | void
): Promise<R[]> {
  const workerCount = Math.max(1, Math.min(inputs.length, Math.floor(concurrency) || 1))
  const results: R[] = []
  let nextIndex = 0

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex
        nextIndex += 1
        const result = await worker(inputs[index], index)
        if (result != null) {
          results.push(result)
          await onResult(result)
        }
      }
    })
  )

  return results
}

async function withCanvasImageIntakeTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      })
    ])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function getPositiveCanvasImageSourceHint(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function resolveCanvasImageSourceDimensions(
  source: Pick<NormalizedCanvasImageSource, 'sourceWidthHint' | 'sourceHeightHint'>,
  fallbackEdge = PROJECT_CANVAS_IMAGE_LAZY_IMPORT_DEFAULT_SOURCE_EDGE
) {
  return {
    sourceWidth: getPositiveCanvasImageSourceHint(source.sourceWidthHint) ?? fallbackEdge,
    sourceHeight: getPositiveCanvasImageSourceHint(source.sourceHeightHint) ?? fallbackEdge
  }
}

function resolveCanvasImageSourceSizeBytes(
  source: Pick<NormalizedCanvasImageSource, 'sizeBytes' | 'src'>
) {
  return typeof source.sizeBytes === 'number' &&
    Number.isFinite(source.sizeBytes) &&
    source.sizeBytes >= 0
    ? source.sizeBytes
    : estimateDataUrlByteSize(source.src)
}

function resolveCanvasImageSourceHasAlpha(
  source: Pick<NormalizedCanvasImageSource, 'hasAlpha' | 'fileName' | 'src'>
) {
  return typeof source.hasAlpha === 'boolean'
    ? source.hasAlpha
    : inferKnownImageHasAlpha(source.fileName, source.src)
}

function hasUsableCanvasImageSourceHints(
  sourceWidthHint: number | undefined,
  sourceHeightHint: number | undefined,
  decodedWidth: number,
  decodedHeight: number
): sourceWidthHint is number {
  if (
    sourceWidthHint == null ||
    sourceHeightHint == null ||
    decodedWidth <= 0 ||
    decodedHeight <= 0
  ) {
    return false
  }

  const hintedAspect = sourceWidthHint / sourceHeightHint
  const decodedAspect = decodedWidth / decodedHeight
  if (!Number.isFinite(hintedAspect) || !Number.isFinite(decodedAspect) || decodedAspect <= 0) {
    return false
  }

  return Math.abs(hintedAspect - decodedAspect) / decodedAspect <= 0.02
}

function resolveDecodedCanvasImageSourceSize({
  decodedWidth,
  decodedHeight,
  sourceWidthHint,
  sourceHeightHint
}: {
  decodedWidth: number
  decodedHeight: number
  sourceWidthHint?: number
  sourceHeightHint?: number
}) {
  if (
    hasUsableCanvasImageSourceHints(sourceWidthHint, sourceHeightHint, decodedWidth, decodedHeight)
  ) {
    return {
      sourceWidth: sourceWidthHint,
      sourceHeight: sourceHeightHint!
    }
  }

  return {
    sourceWidth: decodedWidth,
    sourceHeight: decodedHeight
  }
}

function shouldDeferCanvasImageSourceFullDecode(
  source: Pick<NormalizedCanvasImageSource, 'sourceWidthHint' | 'sourceHeightHint' | 'sizeBytes'>
) {
  const decodedByteSize = estimateCanvasImageDecodedByteSize(
    source.sourceWidthHint,
    source.sourceHeightHint
  )
  if (decodedByteSize != null && decodedByteSize > PROJECT_CANVAS_IMAGE_EAGER_DECODE_MAX_BYTES) {
    return true
  }

  return (
    typeof source.sizeBytes === 'number' &&
    Number.isFinite(source.sizeBytes) &&
    source.sizeBytes > PROJECT_CANVAS_IMAGE_EAGER_FILE_SIZE_MAX_BYTES
  )
}

function resolveCanvasDeferredPreviewSize(
  sourceWidth: number,
  sourceHeight: number,
  maxPreviewSide: number
) {
  const maxSide = Math.max(sourceWidth, sourceHeight)
  if (!Number.isFinite(maxSide) || maxSide <= 0) {
    return {
      width: PROJECT_CANVAS_IMAGE_DEFERRED_PLACEHOLDER_MAX_SIDE,
      height: PROJECT_CANVAS_IMAGE_DEFERRED_PLACEHOLDER_MAX_SIDE
    }
  }

  const scale = Math.min(1, maxPreviewSide / maxSide)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  }
}

function buildCanvasImageLazyPreviewProxy({
  sourceWidth,
  sourceHeight,
  maxPreviewSide
}: {
  sourceWidth: number
  sourceHeight: number
  maxPreviewSide: number
}): CanvasImageAsset | undefined {
  if (typeof document === 'undefined') {
    return undefined
  }

  const size = resolveCanvasDeferredPreviewSize(sourceWidth, sourceHeight, maxPreviewSide)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) {
    return undefined
  }

  context.fillStyle = '#eef1f4'
  context.fillRect(0, 0, size.width, size.height)
  context.strokeStyle = '#c9d0d8'
  context.lineWidth = Math.max(1, Math.round(Math.min(size.width, size.height) / 96))
  context.strokeRect(0, 0, Math.max(0, size.width - 1), Math.max(0, size.height - 1))
  context.strokeStyle = '#d8dde3'
  context.beginPath()
  context.moveTo(0, size.height)
  context.lineTo(size.width, 0)
  context.stroke()

  return canvas
}

function canFetchDeferredCanvasImagePreviewSource(src: string): boolean {
  return /^(blob:|data:|file:\/\/|local-media:\/\/)/i.test(src.trim())
}

async function resolveDeferredCanvasImagePreviewBlob(
  source: NormalizedCanvasImageSource
): Promise<Blob | null> {
  if (source.sourceFile) {
    return source.sourceFile
  }

  const localBlob = await readCanvasLocalImageBlobFromSource(source.src, source.fileName)
  if (localBlob) {
    return localBlob
  }

  if (typeof fetch !== 'function' || !canFetchDeferredCanvasImagePreviewSource(source.src)) {
    return null
  }

  const response = await fetch(source.src)
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to fetch deferred canvas image preview source: ${response.status}`)
  }

  return await response.blob()
}

async function buildDeferredCanvasImagePreview({
  source,
  sourceWidth,
  sourceHeight,
  maxPreviewSide
}: {
  source: NormalizedCanvasImageSource
  sourceWidth: number
  sourceHeight: number
  maxPreviewSide: number
}): Promise<CanvasImageAsset | undefined> {
  try {
    const preview = await withCanvasImageIntakeTimeout(
      (async () => {
        const blob = await resolveDeferredCanvasImagePreviewBlob(source)
        if (!blob) {
          return null
        }

        return buildCanvasImagePreviewFromBlob({
          blob,
          sourceWidth,
          sourceHeight,
          maxPreviewSide
        })
      })(),
      PROJECT_CANVAS_IMAGE_STREAM_PREVIEW_TIMEOUT_MS,
      'Timed out building deferred preview image for canvas intake.'
    )
    if (preview) {
      return preview
    }
  } catch (error) {
    console.warn(
      '[Canvas] Deferred image preview timed out or failed, using placeholder asset:',
      source.src,
      error
    )
  }

  return (
    (await buildCanvasImagePlaceholderAsset(
      resolveCanvasDeferredPreviewSize(sourceWidth, sourceHeight, maxPreviewSide)
    )) ?? undefined
  )
}

async function resolveCanvasImageIntakeThumbnail({
  source,
  maxPreviewSide
}: {
  source: NormalizedCanvasImageSource
  maxPreviewSide: number
}): Promise<{
  displayImage?: CanvasImageAsset
  thumbnailSet?: CanvasImageItem['thumbnailSet']
}> {
  let thumbnail: Awaited<ReturnType<typeof resolveCanvasImageThumbnailDisplayAsset>> = null
  try {
    thumbnail = await withCanvasImageIntakeTimeout(
      resolveCanvasImageThumbnailDisplayAsset({
        src: source.src,
        sourceIdentity: source.sourceIdentity,
        thumbnailSet: source.thumbnailSet,
        sourceFile: source.sourceFile,
        maxPreviewSide
      }),
      PROJECT_CANVAS_IMAGE_THUMBNAIL_RESOLVE_TIMEOUT_MS,
      'Timed out resolving canvas image thumbnail for intake.'
    )
  } catch (error) {
    console.warn(
      '[Canvas] Image intake thumbnail timed out or failed, continuing without thumbnail:',
      source.src,
      error
    )
  }

  if (!thumbnail) {
    return {}
  }

  return {
    displayImage: thumbnail.image,
    thumbnailSet: thumbnail.thumbnailSet
  }
}

async function buildDeferredCanvasImageStreamEntry({
  source,
  sourceIndex,
  maxPreviewSide,
  fitImageToCanvasSize,
  resolveInitialDisplayAsset = true,
  resolveInitialThumbnail = resolveInitialDisplayAsset
}: {
  source: NormalizedCanvasImageSource
  sourceIndex: number
  maxPreviewSide: number
  fitImageToCanvasSize: (width: number, height: number) => { width: number; height: number }
  resolveInitialDisplayAsset?: boolean
  resolveInitialThumbnail?: boolean
}): Promise<CanvasImageStreamEntry> {
  const shouldDeferFullDecode = shouldDeferCanvasImageSourceFullDecode(source)
  const hasDimensionHints =
    getPositiveCanvasImageSourceHint(source.sourceWidthHint) != null &&
    getPositiveCanvasImageSourceHint(source.sourceHeightHint) != null
  const { sourceWidth, sourceHeight } = resolveCanvasImageSourceDimensions(
    source,
    shouldDeferFullDecode && !hasDimensionHints
      ? PROJECT_CANVAS_IMAGE_DEFERRED_PLACEHOLDER_MAX_SIDE
      : PROJECT_CANVAS_IMAGE_LAZY_IMPORT_DEFAULT_SOURCE_EDGE
  )
  const fittedSize = fitImageToCanvasSize(sourceWidth, sourceHeight)
  const thumbnailPreview = resolveInitialThumbnail
    ? await resolveCanvasImageIntakeThumbnail({
        source,
        maxPreviewSide
      })
    : {}
  const displayImage = thumbnailPreview.displayImage
    ? thumbnailPreview.displayImage
    : !resolveInitialDisplayAsset && source.sourceIdentity
      ? buildCanvasImageLazyPreviewProxy({
          sourceWidth,
          sourceHeight,
          maxPreviewSide
        })
      : resolveInitialDisplayAsset
        ? await buildDeferredCanvasImagePreview({
            source,
            sourceWidth,
            sourceHeight,
            maxPreviewSide
          })
        : undefined
  const sizeBytes = resolveCanvasImageSourceSizeBytes(source)

  return {
    source,
    sourceIndex,
    ...(displayImage ? { displayImage } : {}),
    ...(thumbnailPreview.thumbnailSet ? { thumbnailSet: thumbnailPreview.thumbnailSet } : {}),
    ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
    hasAlpha: resolveCanvasImageSourceHasAlpha(source),
    sourceWidth,
    sourceHeight,
    width: fittedSize.width,
    height: fittedSize.height
  }
}

export function useCanvasAssetIntake({
  canvasId,
  fitImageToCanvasSize: fitImageToCanvasSizeInput,
  getBatchGridLayout: getBatchGridLayoutInput,
  getCanvasPointFromClient: getCanvasPointFromClientInput,
  getCenterPosition: getCenterPositionInput,
  getNextAutoImagePosition: getNextAutoImagePositionInput,
  getViewportBounds: getViewportBoundsInput,
  markAutoPlacementBatch: markAutoPlacementBatchInput,
  nextZIndexRef,
  setItemsWithoutHistory,
  setItemsWithHistory,
  setGroups,
  setGroupBranches,
  setSelectedIds,
  setTool,
  notifyError,
  notifyWarning,
  notifySuccess,
  t: translator,
  isChineseUi = false,
  openQuickAppPanel,
  activateModel3DRender,
  setPendingTextureModelId,
  setTextureImportDialogOpen,
  resolveCurrentItemCount,
  onImageBatchImportProgress
}: UseCanvasAssetIntakeOptions) {
  const t = useCallback(
    (key: string, options?: unknown) => {
      if (typeof translator === 'function') {
        return translator(key, options)
      }
      if (
        options &&
        typeof options === 'object' &&
        'defaultValue' in options &&
        typeof (options as { defaultValue?: unknown }).defaultValue === 'string'
      ) {
        return (options as { defaultValue: string }).defaultValue
      }
      return key
    },
    [translator]
  )

  const fitImageToCanvasSize = useCallback(
    (width: number, height: number) =>
      fitImageToCanvasSizeInput?.(width, height) ?? {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height))
      },
    [fitImageToCanvasSizeInput]
  )

  const getViewportBounds = useCallback(
    () => getViewportBoundsInput?.() ?? { x: 0, y: 0, width: 1, height: 1 },
    [getViewportBoundsInput]
  )

  const getCenterPosition = useCallback(
    (width: number, height: number) =>
      getCenterPositionInput?.(width, height) ?? {
        x: Math.round((getViewportBounds().width - width) / 2),
        y: Math.round((getViewportBounds().height - height) / 2)
      },
    [getCenterPositionInput, getViewportBounds]
  )

  const getCanvasPointFromClient = useCallback(
    (clientX?: number, clientY?: number) =>
      getCanvasPointFromClientInput?.(clientX, clientY) ?? null,
    [getCanvasPointFromClientInput]
  )

  const getNextAutoImagePosition = useCallback(
    (width: number, height: number) =>
      getNextAutoImagePositionInput?.(width, height) ?? getCenterPosition(width, height),
    [getCenterPosition, getNextAutoImagePositionInput]
  )

  const getBatchGridLayout = useCallback(
    (
      sizes: Array<{ width: number; height: number }>,
      options?: {
        gap?: number
        minColumns?: number
        maxColumns?: number
        allowUpscale?: boolean
      }
    ) =>
      getBatchGridLayoutInput?.(sizes, options) ??
      sizes.map((size) => ({
        ...getCenterPosition(size.width, size.height),
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height))
      })),
    [getBatchGridLayoutInput, getCenterPosition]
  )

  const markAutoPlacementBatch = useCallback(
    (count: number) => {
      markAutoPlacementBatchInput?.(count)
    },
    [markAutoPlacementBatchInput]
  )

  const resolvePlacement = useCallback(
    ({
      width,
      height,
      clientX,
      clientY,
      mode = 'center'
    }: {
      width: number
      height: number
      clientX?: number
      clientY?: number
      mode?: 'center' | 'auto'
    }) => {
      const clientPoint = getCanvasPointFromClient(clientX, clientY)
      if (clientPoint) {
        return {
          x: clientPoint.x - width / 2,
          y: clientPoint.y - height / 2
        }
      }

      if (mode === 'auto') {
        return getNextAutoImagePosition(width, height)
      }

      return getCenterPosition(width, height)
    },
    [getCanvasPointFromClient, getCenterPosition, getNextAutoImagePosition]
  )

  const appendImportedCanvasPayload = useCallback(
    async (payload: {
      items: CanvasItem[]
      groups: CanvasGroup[]
      groupBranches?: CanvasGroupBranch[]
    }) => {
      const restored: CanvasItem[] = []
      let maxZ = nextZIndexRef.current

      for (const item of payload.items) {
        if (item.type === 'image' && item.src) {
          const hydratedItem = await hydrateCanvasImageItemForCanvas({
            ...item,
            zIndex: maxZ++
          })
          if (hydratedItem) {
            restored.push(hydratedItem)
          } else {
            console.warn('[Canvas] Failed to restore imported image, skipping:', item.id)
          }
          continue
        }

        restored.push({ ...item, zIndex: maxZ++ })
      }

      nextZIndexRef.current = maxZ
      const normalizedGroups = normalizeImportedCanvasGroups(payload.groups, restored)

      if (restored.length > 0) {
        setItemsWithHistory((prev) => [...prev, ...restored])
        setSelectedIds(new Set(restored.map((item) => item.id)))
        setTool('select')
      }

      if (normalizedGroups.length > 0) {
        setGroups((prev) => [...prev, ...normalizedGroups])
      }

      if ((payload.groupBranches?.length ?? 0) > 0) {
        setGroupBranches((prev) => [...prev, ...(payload.groupBranches ?? [])])
      }

      return restored
    },
    [nextZIndexRef, setGroupBranches, setGroups, setItemsWithHistory, setSelectedIds, setTool]
  )

  const handleImportCanvasSceneFile = useCallback(
    async (file: File) => {
      const {
        items: imported,
        groups: importedGroups,
        groupBranches: importedGroupBranches,
        qAppKey
      } = await importCanvasFile(file)
      if (qAppKey) {
        openQuickAppPanel?.()
      }

      const restored = await appendImportedCanvasPayload({
        items: imported,
        groups: importedGroups,
        groupBranches: importedGroupBranches
      })

      const importedFilePath = getElectronCanvasFilePath(file)
      if (canvasId && importedFilePath && (resolveCurrentItemCount?.() ?? 0) === 0) {
        rememberCanvasSaveTargetPath(canvasId, importedFilePath)
      }

      return restored
    },
    [appendImportedCanvasPayload, canvasId, openQuickAppPanel, resolveCurrentItemCount]
  )

  const handleImportPsdFile = useCallback(
    async (file: File) => {
      try {
        const imported = await materializePsdFile(file, {
          startZIndex: nextZIndexRef.current
        })
        const restored = await appendImportedCanvasPayload({
          items: imported.items,
          groups: imported.groups
        })

        if (restored.length === 0) {
          notifyWarning(`No visible content could be imported from ${file.name}.`)
          return restored
        }

        if (imported.warnings.length > 0) {
          notifyWarning(
            `Imported ${restored.length} item(s) from ${imported.sourceApp.toUpperCase()} with ${imported.warnings.length} warning(s).`
          )
        } else {
          notifySuccess(
            `Imported ${restored.length} item(s) from ${imported.sourceApp.toUpperCase()}.`
          )
        }

        return restored
      } catch (error) {
        console.error('[Canvas] PSD import failed:', error)
        notifyError(
          `Failed to import ${file.name}: ${error instanceof Error ? error.message : String(error)}`
        )
        return []
      }
    },
    [appendImportedCanvasPayload, nextZIndexRef, notifyError, notifySuccess, notifyWarning]
  )

  const addImageToCanvas = useCallback(
    async (src: string, options: AddCanvasImageOptions = {}) => {
      try {
        const {
          clientX,
          clientY,
          fileName,
          sizeBytes,
          hasAlpha,
          sourceFile,
          sourceIdentity,
          thumbnailSet,
          provenance,
          promptId,
          fileItem,
          sourceWidthHint,
          sourceHeightHint,
          select,
          reportBundleId,
          reportBundleRole,
          reportBundleRefName,
          reportBundleManifestUrl
        } = options

        const deferredSource: NormalizedCanvasImageSource = {
          src,
          ...(fileName ? { fileName } : {}),
          ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
          ...(typeof hasAlpha === 'boolean' ? { hasAlpha } : {}),
          ...(typeof sourceWidthHint === 'number' ? { sourceWidthHint } : {}),
          ...(typeof sourceHeightHint === 'number' ? { sourceHeightHint } : {}),
          ...(sourceFile ? { sourceFile } : {}),
          ...(sourceIdentity ? { sourceIdentity } : {}),
          ...(thumbnailSet ? { thumbnailSet } : {}),
          ...(provenance ? { provenance } : {})
        }
        if (shouldDeferCanvasImageSourceFullDecode(deferredSource)) {
          const hasDimensionHints =
            getPositiveCanvasImageSourceHint(deferredSource.sourceWidthHint) != null &&
            getPositiveCanvasImageSourceHint(deferredSource.sourceHeightHint) != null
          const { sourceWidth, sourceHeight } = resolveCanvasImageSourceDimensions(
            deferredSource,
            hasDimensionHints
              ? PROJECT_CANVAS_IMAGE_LAZY_IMPORT_DEFAULT_SOURCE_EDGE
              : PROJECT_CANVAS_IMAGE_DEFERRED_PLACEHOLDER_MAX_SIDE
          )
          const thumbnailPreview = await resolveCanvasImageIntakeThumbnail({
            source: deferredSource,
            maxPreviewSide: getCanvasImagePreviewMaxSideForBatch(1)
          })
          const displayImage =
            thumbnailPreview.displayImage ??
            (await buildDeferredCanvasImagePreview({
              source: deferredSource,
              sourceWidth,
              sourceHeight,
              maxPreviewSide: getCanvasImagePreviewMaxSideForBatch(1)
            }))
          const resolvedSizeBytes = resolveCanvasImageSourceSizeBytes(deferredSource)
          const resolvedHasAlpha = resolveCanvasImageSourceHasAlpha(deferredSource)
          const fittedSize = fitImageToCanvasSize(sourceWidth, sourceHeight)
          const pos = resolvePlacement({
            width: fittedSize.width,
            height: fittedSize.height,
            clientX,
            clientY,
            mode: 'auto'
          })

          const newItem = createCanvasImageItemDraft({
            id: createCanvasItemId('img'),
            src,
            ...(fileName ? { fileName } : {}),
            ...(sourceFile ? { sourceFile } : {}),
            ...(typeof resolvedSizeBytes === 'number' ? { sizeBytes: resolvedSizeBytes } : {}),
            ...(typeof resolvedHasAlpha === 'boolean' ? { hasAlpha: resolvedHasAlpha } : {}),
            ...(promptId ? { promptId } : {}),
            ...(fileItem ? { fileItem } : {}),
            x: pos.x,
            y: pos.y,
            width: fittedSize.width,
            height: fittedSize.height,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: nextZIndexRef.current++,
            locked: false,
            provenance: provenance ?? createMagicPotNativeProvenance(),
            ...(displayImage ? { image: displayImage } : {}),
            ...(sourceIdentity ? { sourceIdentity } : {}),
            ...(thumbnailPreview.thumbnailSet
              ? { thumbnailSet: thumbnailPreview.thumbnailSet }
              : {}),
            sourceWidth,
            sourceHeight,
            ...(reportBundleId ? { reportBundleId } : {}),
            ...(reportBundleRole ? { reportBundleRole } : {}),
            ...(reportBundleRefName ? { reportBundleRefName } : {}),
            ...(reportBundleManifestUrl ? { reportBundleManifestUrl } : {})
          })

          setItemsWithHistory((prev) => [...prev, newItem])
          if (select !== false) {
            setSelectedIds(new Set([newItem.id]))
            setTool('select')
          }
          return newItem
        }

        const { img, width, height } = await loadImageFromSrc(src)
        const displayImage = await buildCanvasImageDisplayAsset({
          src,
          fileName,
          originalImage: img,
          sourceWidth: width,
          sourceHeight: height
        })
        const thumbnailPreview = await resolveCanvasImageIntakeThumbnail({
          source: deferredSource,
          maxPreviewSide: getCanvasImagePreviewMaxSideForBatch(1)
        })
        const { sourceWidth: resolvedSourceWidth, sourceHeight: resolvedSourceHeight } =
          resolveDecodedCanvasImageSourceSize({
            decodedWidth: width,
            decodedHeight: height,
            sourceWidthHint,
            sourceHeightHint
          })
        const resolvedSizeBytes =
          typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0
            ? sizeBytes
            : estimateDataUrlByteSize(src)
        const resolvedHasAlpha =
          typeof hasAlpha === 'boolean'
            ? hasAlpha
            : await detectImageHasAlpha({
                fileName,
                sourceUrl: src,
                image: img
              })
        const fittedSize = fitImageToCanvasSize(resolvedSourceWidth, resolvedSourceHeight)
        const pos = resolvePlacement({
          width: fittedSize.width,
          height: fittedSize.height,
          clientX,
          clientY,
          mode: 'auto'
        })

        const newItem = createCanvasImageItemDraft({
          id: createCanvasItemId('img'),
          src,
          ...(fileName ? { fileName } : {}),
          ...(sourceFile ? { sourceFile } : {}),
          ...(typeof resolvedSizeBytes === 'number' ? { sizeBytes: resolvedSizeBytes } : {}),
          ...(typeof resolvedHasAlpha === 'boolean' ? { hasAlpha: resolvedHasAlpha } : {}),
          ...(promptId ? { promptId } : {}),
          ...(fileItem ? { fileItem } : {}),
          x: pos.x,
          y: pos.y,
          width: fittedSize.width,
          height: fittedSize.height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false,
          provenance: provenance ?? createMagicPotNativeProvenance(),
          image: thumbnailPreview.displayImage ?? displayImage,
          ...(sourceIdentity ? { sourceIdentity } : {}),
          ...(thumbnailPreview.thumbnailSet ? { thumbnailSet: thumbnailPreview.thumbnailSet } : {}),
          sourceWidth: resolvedSourceWidth,
          sourceHeight: resolvedSourceHeight,
          ...(reportBundleId ? { reportBundleId } : {}),
          ...(reportBundleRole ? { reportBundleRole } : {}),
          ...(reportBundleRefName ? { reportBundleRefName } : {}),
          ...(reportBundleManifestUrl ? { reportBundleManifestUrl } : {})
        })

        setItemsWithHistory((prev) => [...prev, newItem])
        if (select !== false) {
          setSelectedIds(new Set([newItem.id]))
          setTool('select')
        }
        return newItem
      } catch (error) {
        console.error('[Canvas] Failed to add image:', error)
        notifyError(
          t('canvas.image_add_failed', {
            defaultValue: 'Failed to add image. Please try again.'
          })
        )
        return null
      }
    },
    [
      fitImageToCanvasSize,
      nextZIndexRef,
      notifyError,
      resolvePlacement,
      setItemsWithHistory,
      setSelectedIds,
      setTool,
      t
    ]
  )

  const addImagesToCanvas = useCallback(
    async (sources: CanvasImageInput[]) => {
      const normalizedSources: NormalizedCanvasImageSource[] = sources
        .map((source) => (typeof source === 'string' ? { src: source } : source))
        .filter((source): source is NormalizedCanvasImageSource => Boolean(source.src))
      if (normalizedSources.length === 0) return []

      const maxPreviewSide = getCanvasImagePreviewMaxSideForBatch(normalizedSources.length)
      const batchGap = getProjectCanvasBatchGap(normalizedSources.length)
      const hasDeferredSources = normalizedSources.some(shouldDeferCanvasImageSourceFullDecode)
      const shouldUseStreamingImport =
        normalizedSources.length >= PROJECT_CANVAS_IMAGE_STREAM_IMPORT_THRESHOLD ||
        normalizedSources.length >= PROJECT_CANVAS_IMAGE_STREAM_PROGRESS_BATCH_SIZE ||
        hasDeferredSources
      const shouldReportBatchProgress =
        normalizedSources.length >= PROJECT_CANVAS_IMAGE_STREAM_PROGRESS_BATCH_SIZE

      if (shouldUseStreamingImport) {
        const baseId = Date.now()
        const lazyImportTail =
          normalizedSources.length >= PROJECT_CANVAS_IMAGE_LAZY_IMPORT_THRESHOLD
        let importedCount = 0
        let processedCount = 0
        let failedCount = 0
        let lastProgressEmitAt = 0
        let nextBatchTop: number | null = null
        const pendingEntries: CanvasImageStreamEntry[] = []
        const importedItems: CanvasImageItem[] = []
        let flushChain = Promise.resolve()
        let hasCommittedStreamHistory = false

        const emitImportProgress = (phase: CanvasImageBatchImportProgressPhase, force = false) => {
          if (!shouldReportBatchProgress) return
          const now = Date.now()
          if (
            !force &&
            now - lastProgressEmitAt < 120 &&
            processedCount < normalizedSources.length
          ) {
            return
          }
          lastProgressEmitAt = now
          onImageBatchImportProgress?.({
            phase,
            total: normalizedSources.length,
            processed: processedCount,
            imported: importedCount,
            failed: failedCount
          })
        }

        const flushPendingEntries = (force = false): Promise<void> => {
          if (
            pendingEntries.length === 0 ||
            (!force && pendingEntries.length < PROJECT_CANVAS_IMAGE_STREAM_COMMIT_CHUNK_SIZE)
          ) {
            return flushChain
          }

          flushChain = flushChain.then(async () => {
            const takeCount = force
              ? pendingEntries.length
              : PROJECT_CANVAS_IMAGE_STREAM_COMMIT_CHUNK_SIZE
            const batchEntries = pendingEntries.splice(0, takeCount).sort((left, right) => {
              return left.sourceIndex - right.sourceIndex
            })
            if (batchEntries.length === 0) {
              return
            }

            const batchLayout = getBatchGridLayout(
              batchEntries.map((entry) => ({
                width: entry.width,
                height: entry.height
              })),
              {
                gap: batchGap,
                allowUpscale: false
              }
            )
            const minBatchY = Math.min(...batchLayout.map((entry) => entry.y))
            const maxBatchY = Math.max(...batchLayout.map((entry) => entry.y + entry.height))
            const batchYOffset = nextBatchTop == null ? 0 : nextBatchTop - minBatchY
            nextBatchTop = maxBatchY + batchYOffset + batchGap

            const batchItems = batchEntries.map((entry, batchIndex) => {
              const layoutEntry = batchLayout[batchIndex]
              const fallbackCenterPosition = getCenterPosition(entry.width, entry.height)
              const itemId = `img-${baseId}-${entry.sourceIndex}-${Math.random().toString(36).slice(2, 8)}`
              return createCanvasImageItemDraft({
                id: itemId,
                src: entry.source.src,
                ...(entry.source.fileName ? { fileName: entry.source.fileName } : {}),
                ...(entry.source.sourceFile ? { sourceFile: entry.source.sourceFile } : {}),
                ...(typeof entry.sizeBytes === 'number' ? { sizeBytes: entry.sizeBytes } : {}),
                ...(typeof entry.hasAlpha === 'boolean' ? { hasAlpha: entry.hasAlpha } : {}),
                ...(entry.source.sourceIdentity
                  ? { sourceIdentity: entry.source.sourceIdentity }
                  : {}),
                ...(entry.thumbnailSet ? { thumbnailSet: entry.thumbnailSet } : {}),
                x: layoutEntry?.x ?? fallbackCenterPosition.x,
                y: (layoutEntry?.y ?? fallbackCenterPosition.y) + batchYOffset,
                width: layoutEntry?.width ?? entry.width,
                height: layoutEntry?.height ?? entry.height,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                zIndex: nextZIndexRef.current++,
                locked: false,
                provenance: entry.source.provenance ?? createMagicPotNativeProvenance(),
                ...(entry.displayImage ? { image: entry.displayImage } : {}),
                sourceWidth: entry.sourceWidth,
                sourceHeight: entry.sourceHeight
              })
            })

            if (batchItems.length > 0) {
              importedCount += batchItems.length
              importedItems.push(...batchItems)
              const commitItems =
                hasCommittedStreamHistory && setItemsWithoutHistory
                  ? setItemsWithoutHistory
                  : setItemsWithHistory
              hasCommittedStreamHistory = true
              commitItems((prev) => [...prev, ...batchItems])
              emitImportProgress('committing', true)
              await new Promise((resolve) => setTimeout(resolve, 0))
            }
          })

          return flushChain
        }

        emitImportProgress('loading', true)

        await mapCanvasImageBatchWithProgress(
          normalizedSources,
          PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY,
          async (source, sourceIndex) => {
            try {
              const isLazyTail =
                lazyImportTail && sourceIndex >= PROJECT_CANVAS_IMAGE_LAZY_IMPORT_EAGER_COUNT
              const shouldResolveLazyTailDisplayAsset = isLazyTail && Boolean(source.sourceFile)
              if (shouldDeferCanvasImageSourceFullDecode(source) || isLazyTail) {
                return buildDeferredCanvasImageStreamEntry({
                  source,
                  sourceIndex,
                  maxPreviewSide,
                  fitImageToCanvasSize,
                  resolveInitialDisplayAsset: !isLazyTail || shouldResolveLazyTailDisplayAsset,
                  resolveInitialThumbnail: !isLazyTail
                })
              }

              const { img, width, height } = await withCanvasImageIntakeTimeout(
                loadImageFromSrc(source.src),
                PROJECT_CANVAS_IMAGE_STREAM_LOAD_TIMEOUT_MS,
                'Timed out loading image for streamed canvas intake.'
              )
              let displayImage: Awaited<ReturnType<typeof buildCanvasImageDisplayAsset>> = img
              try {
                displayImage = await withCanvasImageIntakeTimeout(
                  buildCanvasImageDisplayAsset({
                    src: source.src,
                    fileName: source.fileName,
                    originalImage: img,
                    sourceWidth: width,
                    sourceHeight: height,
                    maxPreviewSide
                  }),
                  PROJECT_CANVAS_IMAGE_STREAM_PREVIEW_TIMEOUT_MS,
                  'Timed out building preview image for streamed canvas intake.'
                )
              } catch (error) {
                console.warn(
                  '[Canvas] Streamed batch preview timed out or failed, using original source:',
                  source.src,
                  error
                )
              }
              const thumbnailPreview = await resolveCanvasImageIntakeThumbnail({
                source,
                maxPreviewSide
              })

              const resolvedHasAlpha = resolveCanvasImageSourceHasAlpha(source)
              const fittedSize = fitImageToCanvasSize(width, height)
              const resolvedSizeBytes = resolveCanvasImageSourceSizeBytes(source)
              return {
                source,
                sourceIndex,
                displayImage: thumbnailPreview.displayImage ?? displayImage,
                thumbnailSet: thumbnailPreview.thumbnailSet,
                sizeBytes: resolvedSizeBytes,
                hasAlpha: resolvedHasAlpha,
                sourceWidth: width,
                sourceHeight: height,
                width: fittedSize.width,
                height: fittedSize.height
              }
            } catch (error) {
              console.error(
                '[Canvas] Failed to load image for streamed batch intake:',
                source.src,
                error
              )
              failedCount += 1
              return null
            } finally {
              processedCount += 1
              emitImportProgress('loading')
            }
          },
          async (entry) => {
            pendingEntries.push(entry)
            await flushPendingEntries(false)
          }
        )

        await flushPendingEntries(true)
        await flushChain
        emitImportProgress('complete', true)

        const compactedImportedItems = compactStreamedImageItems(importedItems, batchGap)
        if (compactedImportedItems !== importedItems) {
          importedItems.splice(0, importedItems.length, ...compactedImportedItems)
          const compactedItemsById = new Map(importedItems.map((item) => [item.id, item]))
          const commitItems = setItemsWithoutHistory ?? setItemsWithHistory
          commitItems((prev) => prev.map((item) => compactedItemsById.get(item.id) ?? item))
          await new Promise((resolve) => setTimeout(resolve, 0))
        }

        if (importedCount > 0) {
          markAutoPlacementBatch(importedCount)
          applyImportedImageBatchSelection(importedItems, setSelectedIds, setTool)
        }

        return importedItems
      }

      const loadedImages = await mapCanvasImageBatchWithConcurrency(
        normalizedSources,
        PROJECT_CANVAS_IMAGE_BATCH_LOAD_CONCURRENCY,
        async (source) => {
          try {
            const { img, width, height } = await loadImageFromSrc(source.src)
            const displayImage = await buildCanvasImageDisplayAsset({
              src: source.src,
              fileName: source.fileName,
              originalImage: img,
              sourceWidth: width,
              sourceHeight: height,
              maxPreviewSide
            })
            const thumbnailPreview = await resolveCanvasImageIntakeThumbnail({
              source,
              maxPreviewSide
            })
            const fittedSize = fitImageToCanvasSize(width, height)
            const resolvedSizeBytes =
              typeof source.sizeBytes === 'number' &&
              Number.isFinite(source.sizeBytes) &&
              source.sizeBytes >= 0
                ? source.sizeBytes
                : estimateDataUrlByteSize(source.src)
            const resolvedHasAlpha =
              typeof source.hasAlpha === 'boolean'
                ? source.hasAlpha
                : await detectImageHasAlpha({
                    fileName: source.fileName,
                    sourceUrl: source.src,
                    image: img
                  })
            return {
              src: source.src,
              fileName: source.fileName,
              sourceFile: source.sourceFile,
              sizeBytes: resolvedSizeBytes,
              hasAlpha: resolvedHasAlpha,
              provenance: source.provenance,
              img: thumbnailPreview.displayImage ?? displayImage,
              sourceIdentity: source.sourceIdentity,
              thumbnailSet: thumbnailPreview.thumbnailSet,
              sourceWidth: width,
              sourceHeight: height,
              width: fittedSize.width,
              height: fittedSize.height
            }
          } catch (error) {
            console.error('[Canvas] Failed to load image for batch intake:', source.src, error)
            return null
          }
        }
      )

      if (loadedImages.length === 0) return []

      const layout = getBatchGridLayout(
        loadedImages.map((entry) => ({
          width: entry.width,
          height: entry.height
        })),
        {
          gap: batchGap,
          allowUpscale: false
        }
      )
      markAutoPlacementBatch(loadedImages.length)

      const baseId = Date.now()
      const newItems = loadedImages.map((entry, index) =>
        createCanvasImageItemDraft({
          id: `img-${baseId}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          src: entry.src,
          ...(entry.fileName ? { fileName: entry.fileName } : {}),
          ...(entry.sourceFile ? { sourceFile: entry.sourceFile } : {}),
          ...(typeof entry.sizeBytes === 'number' ? { sizeBytes: entry.sizeBytes } : {}),
          ...(typeof entry.hasAlpha === 'boolean' ? { hasAlpha: entry.hasAlpha } : {}),
          x: layout[index]?.x ?? getCenterPosition(entry.width, entry.height).x,
          y: layout[index]?.y ?? getCenterPosition(entry.width, entry.height).y,
          width: layout[index]?.width ?? entry.width,
          height: layout[index]?.height ?? entry.height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false,
          provenance: entry.provenance ?? createMagicPotNativeProvenance(),
          image: entry.img,
          ...(entry.sourceIdentity ? { sourceIdentity: entry.sourceIdentity } : {}),
          ...(entry.thumbnailSet ? { thumbnailSet: entry.thumbnailSet } : {}),
          sourceWidth: entry.sourceWidth,
          sourceHeight: entry.sourceHeight
        })
      )

      setItemsWithHistory((prev) => [...prev, ...newItems])
      applyImportedImageBatchSelection(newItems, setSelectedIds, setTool)
      return newItems
    },
    [
      fitImageToCanvasSize,
      getBatchGridLayout,
      getCenterPosition,
      markAutoPlacementBatch,
      nextZIndexRef,
      onImageBatchImportProgress,
      setItemsWithoutHistory,
      setItemsWithHistory,
      setSelectedIds,
      setTool
    ]
  )

  const addFileToCanvas = useCallback(
    async (
      file: File,
      clientX?: number,
      clientY?: number,
      options?: {
        reportBundleId?: CanvasFileItem['reportBundleId']
        reportBundleRole?: CanvasFileItem['reportBundleRole']
        reportBundleRefName?: CanvasFileItem['reportBundleRefName']
        reportBundleManifestUrl?: CanvasFileItem['reportBundleManifestUrl']
      }
    ) => {
      const src = getCanvasLocalMediaSourceUrl(file) || URL.createObjectURL(file)

      try {
        const fileNodeData = await resolveOfficeFileNodeData(file)
        const normalizedFileNodeData = normalizeOfficeFileNodeDataForCanvas(fileNodeData)
        const pos = resolvePlacement({
          width: FILE_NODE_DEFAULT_WIDTH,
          height: FILE_NODE_DEFAULT_HEIGHT,
          clientX,
          clientY,
          mode: 'auto'
        })

        const newItem = createCanvasFileItemDraft({
          id: createCanvasItemId('file'),
          src,
          fileName: file.name,
          sourceFile: file,
          mimeType: normalizedFileNodeData.mimeType,
          fileKind: normalizedFileNodeData.fileKind,
          ...(typeof file.size === 'number' ? { sizeBytes: file.size } : {}),
          ...(typeof normalizedFileNodeData.editable === 'boolean'
            ? { editable: normalizedFileNodeData.editable }
            : {}),
          ...(normalizedFileNodeData.previewText
            ? { previewText: normalizedFileNodeData.previewText }
            : {}),
          ...(normalizedFileNodeData.previewImages
            ? { previewImages: normalizedFileNodeData.previewImages }
            : {}),
          ...(normalizedFileNodeData.previewSheets
            ? { previewSheets: normalizedFileNodeData.previewSheets }
            : {}),
          ...(normalizedFileNodeData.content ? { content: normalizedFileNodeData.content } : {}),
          x: pos.x,
          y: pos.y,
          width: FILE_NODE_DEFAULT_WIDTH,
          height: FILE_NODE_DEFAULT_HEIGHT,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false,
          provenance: createImportedFileProvenance(file.name, {
            notes: 'Imported local file into MagicPot canvas'
          }),
          ...(options?.reportBundleId ? { reportBundleId: options.reportBundleId } : {}),
          ...(options?.reportBundleRole ? { reportBundleRole: options.reportBundleRole } : {}),
          ...(options?.reportBundleRefName
            ? { reportBundleRefName: options.reportBundleRefName }
            : {}),
          ...(options?.reportBundleManifestUrl
            ? { reportBundleManifestUrl: options.reportBundleManifestUrl }
            : {})
        })

        setItemsWithHistory((prev) => [...prev, newItem])
        setSelectedIds(new Set([newItem.id]))
        setTool('select')
        return newItem
      } catch (error) {
        if (src.startsWith('blob:')) {
          URL.revokeObjectURL(src)
        }
        console.error('[Canvas] Failed to add file:', error)
        notifyError(
          t('canvas.file_add_failed', {
            defaultValue: '添加文件失败，请重试。'
          })
        )
        return null
      }
    },
    [nextZIndexRef, notifyError, resolvePlacement, setItemsWithHistory, setSelectedIds, setTool, t]
  )

  const addOcrResultToCanvas = useCallback(
    async ({ file, attachment, ocrResult, clientX, clientY }: AddOcrResultToCanvasOptions) => {
      const bundleId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const htmlWidth = 520
      const htmlHeight = ocrResult.kind === 'table' ? 520 : 420
      const gap = 32
      const viewportBounds = getViewportBounds()
      const bundleCenter = getCanvasPointFromClient(clientX, clientY) ?? {
        x: viewportBounds.x + viewportBounds.width / 2,
        y: viewportBounds.y + viewportBounds.height / 2
      }

      let fileSrc: string | null = null

      try {
        const newItems: CanvasItem[] = []
        const htmlItemId = `html-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        let sourceImageItem: CanvasImageItem | null = null

        if (ocrResult.sourceImageUrl?.trim()) {
          const normalizedSourceUrl = normalizeLocalMediaUrl(ocrResult.sourceImageUrl.trim())
          const {
            img,
            width: sourceWidth,
            height: sourceHeight
          } = await loadImageFromSrc(normalizedSourceUrl)
          const displayImage = await buildCanvasImageDisplayAsset({
            src: normalizedSourceUrl,
            fileName: attachment?.fileName,
            originalImage: img,
            sourceWidth,
            sourceHeight
          })
          const fittedSize = fitImageToCanvasSize(sourceWidth, sourceHeight)
          const imageX = bundleCenter.x - gap / 2 - fittedSize.width
          const imageY = bundleCenter.y - fittedSize.height / 2

          sourceImageItem = createCanvasImageItemDraft({
            id: createCanvasItemId('img'),
            src: normalizedSourceUrl,
            ...(attachment?.fileName ? { fileName: attachment.fileName } : {}),
            x: imageX,
            y: imageY,
            width: fittedSize.width,
            height: fittedSize.height,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: nextZIndexRef.current++,
            locked: false,
            provenance: createExternalCanvasProvenance({
              sourceFileName: attachment?.fileName,
              notes: 'OCR source image attached from Agent result'
            }),
            image: displayImage,
            sourceWidth,
            sourceHeight,
            ocrBundleId: bundleId
          })
          newItems.push(sourceImageItem)

          const bboxToCellIds = buildBboxToCellIdsMap(ocrResult)
          for (const [index, box] of (ocrResult.boxes || []).entries()) {
            const boxId = box.id?.trim() || `bbox-${index + 1}`
            const normalized = isNormalizedOcrBox(box)
            const annotationWidth = normalized
              ? box.width * sourceImageItem.width
              : (box.width * sourceImageItem.width) / Math.max(sourceWidth, 1)
            const annotationHeight = normalized
              ? box.height * sourceImageItem.height
              : (box.height * sourceImageItem.height) / Math.max(sourceHeight, 1)
            const annotationX =
              sourceImageItem.x +
              (normalized
                ? box.x * sourceImageItem.width
                : (box.x * sourceImageItem.width) / Math.max(sourceWidth, 1))
            const annotationY =
              sourceImageItem.y +
              (normalized
                ? box.y * sourceImageItem.height
                : (box.y * sourceImageItem.height) / Math.max(sourceHeight, 1))

            if (annotationWidth <= 0 || annotationHeight <= 0) {
              continue
            }

            newItems.push({
              id: `anno-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'annotation',
              shape: 'rect',
              stroke: '#38bdf8',
              fillOpacity: 0.08,
              strokeWidth: 2,
              label: box.label || '',
              x: annotationX,
              y: annotationY,
              width: annotationWidth,
              height: annotationHeight,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              zIndex: nextZIndexRef.current++,
              locked: false,
              provenance: createMagicPotNativeProvenance({
                notes: 'OCR bounding box generated from Agent result'
              }),
              ocrBundleId: bundleId,
              ocrBoxId: boxId,
              ocrCellIds: bboxToCellIds[boxId] || []
            })
          }
        }

        const htmlX = sourceImageItem
          ? sourceImageItem.x + sourceImageItem.width + gap
          : bundleCenter.x - htmlWidth / 2
        const htmlY = bundleCenter.y - htmlHeight / 2

        newItems.push(
          createCanvasHtmlItemDraft({
            id: htmlItemId,
            htmlData: buildOcrResultHtml(ocrResult, attachment?.fileName || file.name),
            x: htmlX,
            y: htmlY,
            width: htmlWidth,
            height: htmlHeight,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: nextZIndexRef.current++,
            locked: false,
            provenance: createMagicPotNativeProvenance({
              notes: 'Interactive OCR result view generated from Agent result'
            }),
            interactive: true,
            ocrBundleId: bundleId
          })
        )

        fileSrc = URL.createObjectURL(file)
        const fileNodeData = await resolveOfficeFileNodeData(file)
        const normalizedFileNodeData = normalizeOfficeFileNodeDataForCanvas(fileNodeData)
        const linkedPreviewSheets =
          ocrResult.kind === 'table'
            ? buildCanvasPreviewSheetsFromOcrResult(ocrResult)
            : normalizedFileNodeData.previewSheets
        newItems.push(
          createCanvasFileItemDraft({
            id: createCanvasItemId('file'),
            src: fileSrc,
            fileName: attachment?.fileName || file.name,
            sourceFile: file,
            mimeType: normalizedFileNodeData.mimeType,
            fileKind: normalizedFileNodeData.fileKind,
            ...(typeof file.size === 'number'
              ? { sizeBytes: attachment?.sizeBytes ?? file.size }
              : {}),
            ...(typeof normalizedFileNodeData.editable === 'boolean'
              ? { editable: normalizedFileNodeData.editable }
              : {}),
            ...(normalizedFileNodeData.previewText
              ? { previewText: normalizedFileNodeData.previewText }
              : {}),
            ...(normalizedFileNodeData.previewImages
              ? { previewImages: normalizedFileNodeData.previewImages }
              : {}),
            ...(linkedPreviewSheets ? { previewSheets: linkedPreviewSheets } : {}),
            ...(normalizedFileNodeData.content ? { content: normalizedFileNodeData.content } : {}),
            x: htmlX,
            y: htmlY + htmlHeight + 24,
            width: FILE_NODE_DEFAULT_WIDTH,
            height: FILE_NODE_DEFAULT_HEIGHT,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            zIndex: nextZIndexRef.current++,
            locked: false,
            provenance: createImportedFileProvenance(attachment?.fileName || file.name, {
              notes: 'OCR export file dragged from Agent result'
            }),
            ocrBundleId: bundleId
          })
        )

        setItemsWithHistory((prev) => [...prev, ...newItems])
        setSelectedIds(new Set([htmlItemId]))
        setTool('select')
        return newItems
      } catch (error) {
        if (fileSrc) {
          URL.revokeObjectURL(fileSrc)
        }
        console.error('[Canvas] Failed to add OCR result bundle to canvas:', error)
        notifyError(
          t('canvas.ocr_bundle_add_failed', {
            defaultValue: 'Failed to add OCR result bundle to canvas.'
          })
        )
        return []
      }
    },
    [
      fitImageToCanvasSize,
      getCanvasPointFromClient,
      getViewportBounds,
      nextZIndexRef,
      notifyError,
      setItemsWithHistory,
      setSelectedIds,
      setTool,
      t
    ]
  )

  const addModel3DToCanvas = useCallback(
    async (file: File, options?: AddModel3DOptions) => {
      try {
        let sourceFile = file
        let linkedAssets = options?.linkedAssets
        let skipTexturePrompt = options?.skipTexturePrompt ?? false

        if (isModelArchiveFile(file.name)) {
          const extracted = await extractModelArchive(file)
          if (!extracted) return null

          sourceFile = extracted.file
          linkedAssets = extracted.linkedAssets
          skipTexturePrompt = skipTexturePrompt || Object.keys(extracted.linkedAssets).length > 0
          console.log('[Canvas] Resolved 3D source file:', file.name, '=>', extracted.sourcePath)
        }

        const src = getCanvasLocalMediaSourceUrl(sourceFile) || URL.createObjectURL(sourceFile)
        const defaultSize = 400
        const pos = getCenterPosition(defaultSize, defaultSize)
        const assetCount = linkedAssets ? Object.keys(linkedAssets).length : 0

        const newItem = createCanvasModel3DItemDraft({
          id: createCanvasItemId('model'),
          src,
          fileName: sourceFile.name,
          sourceFile,
          ...(assetCount > 0 ? { textures: linkedAssets } : {}),
          x: pos.x,
          y: pos.y,
          width: defaultSize,
          height: defaultSize,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false
        }) as CanvasModel3DItem & { deferRender?: boolean }

        newItem.deferRender = true
        setItemsWithHistory((prev) => [...prev, newItem as CanvasItem])
        setSelectedIds(new Set([newItem.id]))
        setTool('select')
        console.log('[Canvas] Imported 3D model:', sourceFile.name)

        const ext = sourceFile.name.toLowerCase().split('.').pop()
        const activationDelay = resolveCanvas3DRenderActivationDelay({
          fileName: sourceFile.name,
          hasLinkedAssets: assetCount > 0,
          isAwaitingTexturePrompt: ext !== 'glb' && !skipTexturePrompt
        })
        if (assetCount > 0) {
          activateModel3DRender?.(newItem.id, activationDelay)
          return newItem
        }

        if (ext !== 'glb' && !skipTexturePrompt) {
          setPendingTextureModelId?.(newItem.id)
          setTextureImportDialogOpen?.(true)
          activateModel3DRender?.(newItem.id, activationDelay)
        } else {
          activateModel3DRender?.(newItem.id, activationDelay)
        }

        return newItem
      } catch (error) {
        console.error('[Canvas] Failed to import 3D model:', error)
        notifyError(
          `${isChineseUi ? '导入 3D 模型失败' : 'Failed to import 3D model'}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return null
      }
    },
    [
      activateModel3DRender,
      getCenterPosition,
      isChineseUi,
      nextZIndexRef,
      notifyError,
      setItemsWithHistory,
      setPendingTextureModelId,
      setSelectedIds,
      setTextureImportDialogOpen,
      setTool
    ]
  )

  const addModel3DUrlToCanvas = useCallback(
    (src: string, options?: AddModel3DUrlOptions): CanvasModel3DItem | null => {
      const normalizedSrc = normalizeLocalMediaUrl(src).trim()
      if (!normalizedSrc) {
        return null
      }

      const defaultWidth = Math.max(120, Math.round(options?.width ?? 400))
      const defaultHeight = Math.max(120, Math.round(options?.height ?? 400))
      let pos = getCenterPosition(defaultWidth, defaultHeight)
      if (options?.clientX !== undefined && options?.clientY !== undefined) {
        const point = getCanvasPointFromClient(options.clientX, options.clientY)
        if (point) {
          pos = { x: point.x - defaultWidth / 2, y: point.y - defaultHeight / 2 }
        }
      } else if (options?.offsetX || options?.offsetY) {
        pos = {
          x: pos.x + (options.offsetX || 0),
          y: pos.y + (options.offsetY || 0)
        }
      }

      const newItem = createCanvasModel3DItemDraft({
        id: createCanvasItemId('model'),
        src: normalizedSrc,
        fileName: options?.fileName || getDownloadFileNameFromUrl(normalizedSrc, 'model.glb'),
        ...(options?.hy3dQuickAppKey ? { hy3dQuickAppKey: options.hy3dQuickAppKey } : {}),
        ...(options?.hy3dParams ? { hy3dParams: options.hy3dParams } : {}),
        ...(options?.hy3dMediaState ? { hy3dMediaState: options.hy3dMediaState } : {}),
        x: pos.x,
        y: pos.y,
        width: defaultWidth,
        height: defaultHeight,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false
      }) as CanvasModel3DItem & { deferRender?: boolean }

      newItem.deferRender = true
      setItemsWithHistory((prev) => [...prev, newItem as CanvasItem])
      if (options?.select !== false) {
        setSelectedIds(new Set([newItem.id]))
      }
      setTool('select')
      activateModel3DRender?.(
        newItem.id,
        resolveCanvas3DRenderActivationDelay({
          fileName: newItem.fileName
        })
      )
      console.log('[Canvas] Added 3D model from URL:', normalizedSrc)
      return newItem
    },
    [
      activateModel3DRender,
      getCenterPosition,
      getCanvasPointFromClient,
      nextZIndexRef,
      setItemsWithHistory,
      setSelectedIds,
      setTool
    ]
  )

  const addHtmlToCanvas = useCallback(
    (
      htmlData: string,
      options?: {
        clientX?: number
        clientY?: number
      }
    ) => {
      const width = 400
      const height = 500
      const pos = resolvePlacement({
        width,
        height,
        clientX: options?.clientX,
        clientY: options?.clientY
      })

      const newItem = createCanvasHtmlItemDraft({
        id: createCanvasItemId('html'),
        htmlData,
        x: pos.x,
        y: pos.y,
        width,
        height,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false,
        interactive: true
      })

      setItemsWithHistory((prev) => [...prev, newItem])
      setSelectedIds(new Set([newItem.id]))
      setTool('select')
      return newItem
    },
    [nextZIndexRef, resolvePlacement, setItemsWithHistory, setSelectedIds, setTool]
  )

  const addVideoToCanvas = useCallback(
    (file: File) => {
      const probeObjectUrl = URL.createObjectURL(file)
      const persistentSrc = getCanvasLocalMediaSourceUrl(file) || probeObjectUrl
      const releaseProbeObjectUrl = () => {
        if (persistentSrc !== probeObjectUrl) {
          URL.revokeObjectURL(probeObjectUrl)
        }
      }

      const createVideoItem = (width: number, height: number) => {
        const pos = getCenterPosition(width, height)
        const newItem = createCanvasVideoItemDraft({
          id: createCanvasItemId('video'),
          src: persistentSrc,
          fileName: file.name,
          sourceFile: file,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false,
          playing: false,
          muted: true,
          volume: 0.5
        })
        setItemsWithHistory((prev) => [...prev, newItem])
        setSelectedIds(new Set([newItem.id]))
        setTool('select')
        return newItem
      }

      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        releaseProbeObjectUrl()
        const rawWidth = Math.max(1, video.videoWidth || 480)
        const rawHeight = Math.max(1, video.videoHeight || 270)
        const maxSide = Math.max(rawWidth, rawHeight)
        const scale = maxSide > 600 ? 600 / maxSide : 1
        createVideoItem(
          Math.max(1, Math.round(rawWidth * scale)),
          Math.max(1, Math.round(rawHeight * scale))
        )
      }
      video.onerror = () => {
        console.error('[Canvas] Failed to load video metadata:', file.name)
        releaseProbeObjectUrl()
        createVideoItem(480, 270)
      }
      video.src = probeObjectUrl
      return undefined
    },
    [getCenterPosition, nextZIndexRef, setItemsWithHistory, setSelectedIds, setTool]
  )

  const addTextToCanvas = useCallback(
    (text: string, clientX?: number, clientY?: number) => {
      const fontSize = 16
      const { width, height } = measureCanvasTextBoxSize({
        text,
        fontSize,
        fontFamily: 'system-ui, sans-serif',
        wrap: 'word'
      })

      let pos = getCenterPosition(width, height)
      const clientPoint = getCanvasPointFromClient(clientX, clientY)
      if (clientPoint) {
        pos = { x: clientPoint.x - width / 2, y: clientPoint.y - height / 2 }
      }

      const newItem = createCanvasTextItemDraft({
        id: createCanvasItemId('text'),
        text,
        fontSize,
        fontFamily: 'system-ui, sans-serif',
        fill: '#e0e0e0',
        x: pos.x,
        y: pos.y,
        width,
        height,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false
      })

      setItemsWithHistory((prev) => [...prev, newItem])
      setSelectedIds(new Set([newItem.id]))
      setTool('select')
      return newItem
    },
    [
      getCanvasPointFromClient,
      getCenterPosition,
      nextZIndexRef,
      setItemsWithHistory,
      setSelectedIds,
      setTool
    ]
  )

  return {
    appendImportedCanvasPayload,
    addFileToCanvas,
    addHtmlToCanvas,
    addImageToCanvas,
    addImagesToCanvas,
    addModel3DToCanvas,
    addModel3DUrlToCanvas,
    addOcrResultToCanvas,
    addTextToCanvas,
    addVideoToCanvas,
    buildCanvasImageDisplayAsset,
    fitImageToCanvasSize,
    getBatchGridLayout,
    getCanvasPointFromClient,
    getCenterPosition,
    getViewportBounds,
    handleImportCanvasSceneFile,
    handleImportPsdFile,
    hydrateCanvasImageItemForCanvas,
    loadImageFromSrc,
    markAutoPlacementBatch,
    readFileAsDataURL
  }
}
