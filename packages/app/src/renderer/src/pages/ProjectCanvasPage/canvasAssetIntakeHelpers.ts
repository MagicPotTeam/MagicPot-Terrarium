import { shouldKeepOriginalCanvasImage } from './canvasPageLocalStateUtils'
import { detectImageHasAlpha, estimateDataUrlByteSize } from './canvasImageMetadata'
import { markCanvasImagePlaceholderAsset } from './canvasImageAssetUtils'
import type { CanvasImageAsset, CanvasImageItem, CanvasProvenanceSource } from './types'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'
import { isCanvasThumbnailSetFresh, pickBestCanvasThumbnailLevel } from './canvasThumbnailCache'
import { ensureCanvasThumbnailSet, readWarmCanvasThumbnailSet } from './canvasThumbnailWorkerClient'
import type { CanvasImageSourceIdentity, CanvasImageThumbnailSet } from './canvasThumbnailTypes'

export const CANVAS_IMAGE_PROXY_MAX_SIDE = 2048
export const CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE = 1024
export const CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE = 512
export const CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE = 384
export const CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE = 256
export const CANVAS_IMAGE_PROXY_HUGE_BATCH_MAX_SIDE = 192
export const CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL = 4

export type LoadedCanvasImage = {
  img: HTMLImageElement
  width: number
  height: number
}

export type CanvasImageSourceInput =
  | string
  | {
      src: string
      fileName?: string
      sizeBytes?: number
      hasAlpha?: boolean
      sourceWidthHint?: number
      sourceHeightHint?: number
      sourceFile?: Blob
      sourceIdentity?: CanvasImageSourceIdentity
      thumbnailSet?: CanvasImageThumbnailSet
      provenance?: CanvasProvenanceSource
    }

export type CanvasImageFileMetadata = {
  width: number
  height: number
  decodedByteSize: number
  hasAlpha: boolean | null
}

export function getCanvasImagePreviewMaxSideForBatch(batchSize: number): number {
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    return CANVAS_IMAGE_PROXY_MAX_SIDE
  }

  if (batchSize >= 384) {
    return CANVAS_IMAGE_PROXY_HUGE_BATCH_MAX_SIDE
  }

  if (batchSize >= 256) {
    return CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE
  }

  if (batchSize >= 128) {
    return CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE
  }

  if (batchSize >= 32) {
    return CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE
  }

  if (batchSize >= 5) {
    return CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE
  }

  return CANVAS_IMAGE_PROXY_MAX_SIDE
}

function normalizeCanvasImagePreviewMaxSide(maxPreviewSide?: number): number {
  if (typeof maxPreviewSide !== 'number' || !Number.isFinite(maxPreviewSide)) {
    return CANVAS_IMAGE_PROXY_MAX_SIDE
  }

  return Math.max(1, Math.floor(maxPreviewSide))
}

async function buildCanvasImagePreview(
  image: HTMLImageElement,
  width: number,
  height: number
): Promise<CanvasImageAsset | null> {
  if (typeof document === 'undefined') {
    return null
  }

  try {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(image, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high'
        })
      } catch {
        // Fall back to canvas when ImageBitmap resize is unavailable for this source.
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }

    context.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in context) {
      context.imageSmoothingQuality = 'high'
    }
    context.drawImage(image, 0, 0, width, height)

    let previewSrc: string | null = null

    if (typeof canvas.toBlob === 'function') {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((value) => resolve(value), 'image/png')
      })
      if (blob) {
        previewSrc = URL.createObjectURL(blob)
      }
    }

    if (!previewSrc) {
      previewSrc = canvas.toDataURL('image/png')
    }

    try {
      const { img } = await loadImageFromSrc(previewSrc)
      return img
    } finally {
      if (previewSrc.startsWith('blob:')) {
        URL.revokeObjectURL(previewSrc)
      }
    }
  } catch {
    return null
  }
}

async function readBlobSliceAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }

  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read blob slice as ArrayBuffer.'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read blob slice.'))
    reader.readAsArrayBuffer(blob)
  })
}

export async function readPngImageFileMetadata(
  file: Blob
): Promise<CanvasImageFileMetadata | null> {
  try {
    const header = new Uint8Array(await readBlobSliceAsArrayBuffer(file.slice(0, 26)))
    if (header.length < 26) {
      return null
    }

    const isPng =
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a
    const isIhdr =
      header[12] === 0x49 && header[13] === 0x48 && header[14] === 0x44 && header[15] === 0x52
    if (!isPng || !isIhdr) {
      return null
    }

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const width = view.getUint32(16, false)
    const height = view.getUint32(20, false)
    if (width <= 0 || height <= 0) {
      return null
    }

    const colorType = header[25]
    const hasAlpha =
      colorType === 4 || colorType === 6 ? true : colorType === 0 || colorType === 2 ? false : null

    return {
      width,
      height,
      decodedByteSize: width * height * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL,
      hasAlpha
    }
  } catch {
    return null
  }
}

export async function readJpegImageFileMetadata(
  file: Blob
): Promise<CanvasImageFileMetadata | null> {
  try {
    const bytes = new Uint8Array(await readBlobSliceAsArrayBuffer(file.slice(0, 256 * 1024)))
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return null
    }

    let offset = 2
    while (offset + 9 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) {
        offset += 1
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1
      }
      if (offset >= bytes.length) {
        return null
      }

      const marker = bytes[offset]
      offset += 1
      if (marker === 0xd9 || marker === 0xda) {
        return null
      }
      if (marker >= 0xd0 && marker <= 0xd8) {
        continue
      }
      if (offset + 2 > bytes.length) {
        return null
      }

      const segmentLength = (bytes[offset] << 8) | bytes[offset + 1]
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        return null
      }

      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isStartOfFrame && segmentLength >= 7) {
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4]
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6]
        if (width > 0 && height > 0) {
          return {
            width,
            height,
            decodedByteSize: width * height * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL,
            hasAlpha: false
          }
        }
        return null
      }

      offset += segmentLength
    }
  } catch {
    return null
  }

  return null
}

function readWebpUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) {
    return false
  }

  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) {
      return false
    }
  }

  return true
}

export async function readWebpImageFileMetadata(
  file: Blob
): Promise<CanvasImageFileMetadata | null> {
  try {
    const bytes = new Uint8Array(await readBlobSliceAsArrayBuffer(file.slice(0, 64)))
    if (bytes.length < 30 || !matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) {
      return null
    }

    const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunkType === 'VP8X' && bytes.length >= 30) {
      const width = readWebpUint24(bytes, 24) + 1
      const height = readWebpUint24(bytes, 27) + 1
      return {
        width,
        height,
        decodedByteSize: width * height * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL,
        hasAlpha: Boolean(bytes[20] & 0x10)
      }
    }

    if (chunkType === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b0 = bytes[21]
      const b1 = bytes[22]
      const b2 = bytes[23]
      const b3 = bytes[24]
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      return {
        width,
        height,
        decodedByteSize: width * height * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL,
        hasAlpha: null
      }
    }

    if (
      chunkType === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff
      if (width > 0 && height > 0) {
        return {
          width,
          height,
          decodedByteSize: width * height * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL,
          hasAlpha: false
        }
      }
    }
  } catch {
    return null
  }

  return null
}

export async function readCanvasImageBlobMetadata(
  file: Blob
): Promise<CanvasImageFileMetadata | null> {
  const pngMetadata = await readPngImageFileMetadata(file)
  if (pngMetadata) {
    return pngMetadata
  }

  const jpegMetadata = await readJpegImageFileMetadata(file)
  if (jpegMetadata) {
    return jpegMetadata
  }

  const webpMetadata = await readWebpImageFileMetadata(file)
  if (webpMetadata) {
    return webpMetadata
  }

  if (typeof createImageBitmap !== 'function') {
    return null
  }

  try {
    const bitmap = await createImageBitmap(file)
    const width = bitmap.width
    const height = bitmap.height
    bitmap.close()

    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      return null
    }

    return {
      width,
      height,
      decodedByteSize: width * height * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL,
      hasAlpha: null
    }
  } catch {
    return null
  }
}

export function estimateCanvasImageDecodedByteSize(width?: number, height?: number): number | null {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }

  return Math.ceil(width) * Math.ceil(height) * CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL
}

export async function buildCanvasImagePreviewFromBlob({
  blob,
  sourceWidth,
  sourceHeight,
  maxPreviewSide
}: {
  blob: Blob
  sourceWidth: number
  sourceHeight: number
  maxPreviewSide?: number
}): Promise<CanvasImageAsset | null> {
  if (typeof createImageBitmap !== 'function') {
    return null
  }

  const previewMaxSide = normalizeCanvasImagePreviewMaxSide(maxPreviewSide)
  const maxSide = Math.max(sourceWidth, sourceHeight)
  if (!Number.isFinite(maxSide) || maxSide <= 0) {
    return null
  }

  const scale = Math.min(1, previewMaxSide / maxSide)
  const previewWidth = Math.max(1, Math.round(sourceWidth * scale))
  const previewHeight = Math.max(1, Math.round(sourceHeight * scale))

  try {
    return await createImageBitmap(blob, {
      resizeWidth: previewWidth,
      resizeHeight: previewHeight,
      resizeQuality: 'high'
    })
  } catch {
    return null
  }
}

export async function readFileAsDataURL(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to read file.'))
    reader.readAsDataURL(file)
  })
}

function shouldUseAnonymousCrossOrigin(src: string): boolean {
  return !/^(data:|blob:|file:\/\/|local-media:\/\/)/i.test(src.trim())
}

export function loadImageFromSrc(src: string): Promise<LoadedCanvasImage> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    if (shouldUseAnonymousCrossOrigin(src)) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => {
      img.onload = null
      img.onerror = null
      resolve({ img, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      img.onload = null
      img.onerror = null
      console.error('[Canvas] Failed to load image source:', describeCanvasImageSource(src))
      reject(new Error('Failed to load image'))
    }
    img.src = src
  })
}

async function createComfyImageObjectUrl(item: CanvasImageItem): Promise<string | null> {
  if (!item.fileItem?.filename || !window.api?.svcComfy) {
    return null
  }

  try {
    const response = await window.api.svcComfy.getView(item.fileItem)
    const mimeType = normalizeFileMimeType(item.fileItem.filename, undefined, 'image/png')
    return URL.createObjectURL(new Blob([response.result as BlobPart], { type: mimeType }))
  } catch (error) {
    console.warn('[Canvas] Failed to reload image from Comfy file item:', item.id, error)
    return null
  }
}

async function loadHydratableCanvasImageSource(
  item: CanvasImageItem,
  loadImageFromSrcFn: (src: string) => Promise<LoadedCanvasImage>
): Promise<{ src: string; loaded: LoadedCanvasImage } | null> {
  try {
    return {
      src: item.src,
      loaded: await loadImageFromSrcFn(item.src)
    }
  } catch {
    const recoveredSrc = await createComfyImageObjectUrl(item)
    if (!recoveredSrc || recoveredSrc === item.src) {
      return null
    }

    try {
      return {
        src: recoveredSrc,
        loaded: await loadImageFromSrcFn(recoveredSrc)
      }
    } catch (error) {
      URL.revokeObjectURL(recoveredSrc)
      console.warn('[Canvas] Failed to hydrate recovered Comfy image source:', item.id, error)
      return null
    }
  }
}

export async function buildCanvasImagePlaceholderAsset({
  width,
  height
}: {
  width: number
  height: number
}): Promise<CanvasImageAsset | null> {
  if (typeof document === 'undefined') {
    return null
  }

  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const canvas = document.createElement('canvas')
  canvas.width = safeWidth
  canvas.height = safeHeight

  try {
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = '#2f343d'
      context.fillRect(0, 0, safeWidth, safeHeight)
      context.strokeStyle = '#4b5563'
      context.globalAlpha = 0.55
      context.lineWidth = 2
      context.beginPath()
      context.moveTo(0, 0)
      context.lineTo(safeWidth, safeHeight)
      context.moveTo(safeWidth, 0)
      context.lineTo(0, safeHeight)
      context.stroke()
      context.globalAlpha = 1
      context.strokeStyle = '#64748b'
      context.lineWidth = 1
      context.strokeRect(0.5, 0.5, Math.max(0, safeWidth - 1), Math.max(0, safeHeight - 1))
    }
  } catch {
    // Returning a blank canvas is still a valid non-blocking placeholder.
  }

  return markCanvasImagePlaceholderAsset(canvas)
}

function describeCanvasImageSource(src: string): string {
  if (src.startsWith('data:')) {
    const commaIndex = src.indexOf(',')
    const header = commaIndex >= 0 ? src.slice(0, commaIndex) : src.slice(0, 64)
    return `${header},... (${src.length} chars)`
  }

  if (src.length > 512) {
    return `${src.slice(0, 256)}...${src.slice(-128)} (${src.length} chars)`
  }

  return src
}

function canFetchCanvasImageThumbnailSource(src: string): boolean {
  return /^(blob:|data:|file:\/\/|local-media:\/\/)/i.test(src.trim())
}

async function resolveCanvasImageThumbnailSourceBlob({
  src,
  sourceFile
}: {
  src: string
  sourceFile?: Blob
}): Promise<Blob | null> {
  if (sourceFile) {
    return sourceFile
  }

  if (typeof fetch !== 'function' || !canFetchCanvasImageThumbnailSource(src)) {
    return null
  }

  const response = await fetch(src)
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to fetch canvas image thumbnail source: ${response.status}`)
  }

  return await response.blob()
}

export async function resolveCanvasImageThumbnailDisplayAsset({
  src,
  sourceIdentity,
  thumbnailSet,
  sourceFile,
  maxPreviewSide = CANVAS_IMAGE_PROXY_MAX_SIDE,
  loadImageFromSrcFn = loadImageFromSrc
}: {
  src: string
  sourceIdentity?: CanvasImageSourceIdentity
  thumbnailSet?: CanvasImageThumbnailSet
  sourceFile?: Blob
  maxPreviewSide?: number
  loadImageFromSrcFn?: (src: string) => Promise<LoadedCanvasImage>
}): Promise<{ image: CanvasImageAsset; thumbnailSet: CanvasImageThumbnailSet } | null> {
  if (!sourceIdentity) {
    return null
  }

  let resolvedThumbnailSet = isCanvasThumbnailSetFresh(thumbnailSet, sourceIdentity)
    ? thumbnailSet
    : null

  if (!resolvedThumbnailSet) {
    const warm = await readWarmCanvasThumbnailSet(sourceIdentity)
    resolvedThumbnailSet = warm.thumbnailSet
  }

  if (!resolvedThumbnailSet) {
    try {
      const sourceBlob = await resolveCanvasImageThumbnailSourceBlob({ src, sourceFile })
      if (sourceBlob) {
        resolvedThumbnailSet = (
          await ensureCanvasThumbnailSet({
            source: sourceBlob,
            identity: sourceIdentity
          })
        ).thumbnailSet
      }
    } catch (error) {
      console.warn('[Canvas] Failed to generate thumbnail set for image source:', src, error)
    }
  }

  const thumbnailLevel = pickBestCanvasThumbnailLevel(resolvedThumbnailSet, maxPreviewSide)
  if (!resolvedThumbnailSet || !thumbnailLevel?.src) {
    return null
  }

  try {
    const { img } = await loadImageFromSrcFn(thumbnailLevel.src)
    return {
      image: img,
      thumbnailSet: resolvedThumbnailSet
    }
  } catch (error) {
    console.warn('[Canvas] Failed to load thumbnail preview image:', thumbnailLevel.src, error)
    return null
  }
}

export async function buildCanvasImageDisplayAsset({
  src,
  fileName,
  originalImage,
  sourceWidth,
  sourceHeight,
  maxPreviewSide
}: {
  src: string
  fileName?: string
  originalImage: HTMLImageElement
  sourceWidth: number
  sourceHeight: number
  maxPreviewSide?: number
}): Promise<CanvasImageAsset> {
  if (shouldKeepOriginalCanvasImage(src, fileName)) {
    return originalImage
  }

  const previewMaxSide = normalizeCanvasImagePreviewMaxSide(maxPreviewSide)
  const maxSide = Math.max(sourceWidth, sourceHeight)
  if (!Number.isFinite(maxSide) || maxSide <= previewMaxSide) {
    return originalImage
  }

  const scale = previewMaxSide / maxSide
  const previewWidth = Math.max(1, Math.round(sourceWidth * scale))
  const previewHeight = Math.max(1, Math.round(sourceHeight * scale))

  try {
    const previewImage = await buildCanvasImagePreview(originalImage, previewWidth, previewHeight)
    if (previewImage) {
      return previewImage
    }
  } catch (error) {
    console.warn('[Canvas] Failed to build preview image, using original source instead.', error)
  }

  return originalImage
}

export async function hydrateCanvasImageItemForCanvas(
  itemOrArgs:
    | CanvasImageItem
    | {
        item: CanvasImageItem
        loadImageFromSrc?: (src: string) => Promise<LoadedCanvasImage>
        maxPreviewSide?: number
      }
): Promise<CanvasImageItem | null> {
  const item = 'item' in itemOrArgs ? itemOrArgs.item : itemOrArgs
  const loadImageFromSrcFn =
    'item' in itemOrArgs ? (itemOrArgs.loadImageFromSrc ?? loadImageFromSrc) : loadImageFromSrc
  const maxPreviewSide =
    'item' in itemOrArgs && typeof itemOrArgs.maxPreviewSide !== 'undefined'
      ? normalizeCanvasImagePreviewMaxSide(itemOrArgs.maxPreviewSide)
      : CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE
  if (!item.src) return null

  const thumbnailPreview = await resolveCanvasImageThumbnailDisplayAsset({
    src: item.src,
    sourceIdentity: item.sourceIdentity,
    thumbnailSet: item.thumbnailSet,
    maxPreviewSide,
    loadImageFromSrcFn
  })
  if (thumbnailPreview) {
    return {
      ...item,
      image: thumbnailPreview.image,
      thumbnailSet: thumbnailPreview.thumbnailSet,
      sourceWidth: item.sourceWidth ?? item.width,
      sourceHeight: item.sourceHeight ?? item.height
    }
  }

  const resolvedSource = await loadHydratableCanvasImageSource(item, loadImageFromSrcFn)
  if (!resolvedSource) {
    console.warn('[Canvas] Failed to hydrate imported image, skipping:', item.id)
    const placeholder = await buildCanvasImagePlaceholderAsset({
      width: item.width,
      height: item.height
    })
    return placeholder
      ? {
          ...item,
          image: placeholder,
          sourceWidth: item.sourceWidth ?? item.width,
          sourceHeight: item.sourceHeight ?? item.height
        }
      : null
  }

  try {
    const {
      src,
      loaded: { img, width, height }
    } = resolvedSource
    const sourceWidth = item.sourceWidth ?? width
    const sourceHeight = item.sourceHeight ?? height
    const sizeBytes =
      typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0
        ? item.sizeBytes
        : estimateDataUrlByteSize(src)
    const hasAlpha =
      typeof item.hasAlpha === 'boolean'
        ? item.hasAlpha
        : await detectImageHasAlpha({
            fileName: item.fileName,
            sourceUrl: src,
            image: img
          })
    const displayImage = await buildCanvasImageDisplayAsset({
      src,
      fileName: item.fileName,
      originalImage: img,
      sourceWidth,
      sourceHeight,
      maxPreviewSide
    })

    return {
      ...item,
      src,
      image: displayImage,
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
      ...(typeof hasAlpha === 'boolean' ? { hasAlpha } : {}),
      sourceWidth,
      sourceHeight
    }
  } catch {
    console.warn('[Canvas] Failed to hydrate imported image, skipping:', item.id)
    return null
  }
}
