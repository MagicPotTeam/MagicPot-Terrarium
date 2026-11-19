import { shouldKeepOriginalCanvasImage } from './canvasPageLocalStateUtils'
import { detectImageHasAlpha, estimateDataUrlByteSize } from './canvasImageMetadata'
import { markCanvasImagePlaceholderAsset } from './canvasImageAssetUtils'
import type { CanvasImageAsset, CanvasImageItem, CanvasProvenanceSource } from './types'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'
import { isCanvasThumbnailSetFresh, pickBestCanvasThumbnailLevel } from './canvasThumbnailCache'
import { ensureCanvasThumbnailSet, readWarmCanvasThumbnailSet } from './canvasThumbnailWorkerClient'
import type {
  CanvasImageSourceIdentity,
  CanvasImageThumbnailSet,
  CanvasThumbnailEnsureResult
} from './canvasThumbnailTypes'
import {
  canReadCanvasLocalImageSource,
  createCanvasLocalImageObjectUrl,
  createCanvasLocalImageObjectUrlHandle,
  readCanvasLocalImageBlobFromSource
} from './canvasLocalImageSource'
import { resolveAuthorizedCanvasLocalMediaSourceUrl } from './canvasLocalFileSource'
import { createCanvasImageObjectUrlHandle } from './canvasImageObjectUrlRegistry'

export const CANVAS_IMAGE_PROXY_MAX_SIDE = 2048
export const CANVAS_IMAGE_PROXY_SMALL_BATCH_MAX_SIDE = 1024
export const CANVAS_IMAGE_PROXY_DEFAULT_BATCH_MAX_SIDE = 512
export const CANVAS_IMAGE_PROXY_MEDIUM_BATCH_MAX_SIDE = 384
export const CANVAS_IMAGE_PROXY_LARGE_BATCH_MAX_SIDE = 256
export const CANVAS_IMAGE_PROXY_HUGE_BATCH_MAX_SIDE = 192
export const CANVAS_IMAGE_RGBA_BYTES_PER_PIXEL = 4
const CANVAS_IMAGE_BITMAP_PREMULTIPLY_ALPHA = 'none' as const

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
      sourceUrlOwned?: boolean
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
          resizeQuality: 'high',
          premultiplyAlpha: CANVAS_IMAGE_BITMAP_PREMULTIPLY_ALPHA
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
    let revokePreviewSrc: (() => void) | null = null

    if (typeof canvas.toBlob === 'function') {
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((value) => resolve(value), 'image/png')
      })
      if (blob) {
        const previewHandle = createCanvasImageObjectUrlHandle(
          `canvas-intake:preview:${width}x${height}:${blob.size}`,
          blob
        )
        previewSrc = previewHandle?.url ?? null
        revokePreviewSrc = previewHandle?.revoke ?? null
      }
    }

    if (!previewSrc) {
      previewSrc = canvas.toDataURL('image/png')
    }

    try {
      const { img } = await loadImageFromSrc(previewSrc)
      return img
    } finally {
      if (revokePreviewSrc) {
        revokePreviewSrc()
      } else if (previewSrc.startsWith('blob:')) {
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

/**
 * EXIF orientation of a JPEG APP1 segment (1-8), or null. The decoder turns the picture for
 * orientations 5-8, so a frame sized from the header has to swap width and height for them.
 */
function readJpegExifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0", then a TIFF header: byte order, 42, offset of the first directory.
  if (end - start < 14 || !matchesAscii(bytes, start, 'Exif') || bytes[start + 4] !== 0) {
    return null
  }

  const tiff = start + 6
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  const bigEndian = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d
  if (!littleEndian && !bigEndian) {
    return null
  }
  const readUint16 = (at: number) =>
    littleEndian ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]
  const readUint32 = (at: number) =>
    littleEndian
      ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
      : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  if (readUint16(tiff + 2) !== 42) {
    return null
  }

  const directory = tiff + readUint32(tiff + 4)
  if (directory + 2 > end) {
    return null
  }
  const entryCount = readUint16(directory)
  for (let index = 0; index < entryCount; index += 1) {
    const entry = directory + 2 + index * 12
    if (entry + 12 > end) {
      return null
    }
    if (readUint16(entry) === 0x0112) {
      const orientation = readUint16(entry + 8)
      return orientation >= 1 && orientation <= 8 ? orientation : null
    }
  }
  return null
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
    let exifOrientation: number | null = null
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
      if (marker === 0xe1 && exifOrientation == null) {
        exifOrientation = readJpegExifOrientation(bytes, offset + 2, offset + segmentLength)
      }

      if (isStartOfFrame && segmentLength >= 7) {
        const storedHeight = (bytes[offset + 3] << 8) | bytes[offset + 4]
        const storedWidth = (bytes[offset + 5] << 8) | bytes[offset + 6]
        // Orientations 5-8 are shown turned by a quarter: the displayed size is the swapped one.
        const turned = exifOrientation != null && exifOrientation >= 5
        const width = turned ? storedHeight : storedWidth
        const height = turned ? storedWidth : storedHeight
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
      resizeQuality: 'high',
      premultiplyAlpha: CANVAS_IMAGE_BITMAP_PREMULTIPLY_ALPHA
    })
  } catch {
    return null
  }
}

export async function readFileAsDataURL(file: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to read file.'))
    reader.readAsDataURL(file)
  })
}

function shouldUseAnonymousCrossOrigin(src: string): boolean {
  const normalized = src.trim()
  return /^local-media:\/\//i.test(normalized) || !/^(data:|blob:|file:\/\/)/i.test(normalized)
}

function loadImageElementFromSrc(src: string, logSource = src): Promise<LoadedCanvasImage> {
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
      console.error('[Canvas] Failed to load image source:', describeCanvasImageSource(logSource))
      reject(new Error('Failed to load image'))
    }
    img.src = src
  })
}

export async function loadImageFromSrc(src: string): Promise<LoadedCanvasImage> {
  if (!canReadCanvasLocalImageSource(src)) {
    return loadImageElementFromSrc(src, src)
  }
  const authorizedSource = await resolveAuthorizedCanvasLocalMediaSourceUrl(src)
  if (!authorizedSource) {
    throw new Error('Local image source is not authorized.')
  }
  return loadImageElementFromSrc(authorizedSource, src)
}

async function createComfyImageObjectUrl(
  item: CanvasImageItem
): Promise<{ url: string; revoke: () => void } | null> {
  if (!item.fileItem?.filename || !window.api?.svcComfy) {
    return null
  }

  try {
    const response = await window.api.svcComfy.getView(item.fileItem)
    const mimeType = normalizeFileMimeType(item.fileItem.filename, undefined, 'image/png')
    const handle = createCanvasImageObjectUrlHandle(
      `canvas-intake:comfy:${item.id}`,
      new Blob([response.result as BlobPart], { type: mimeType })
    )
    return handle
  } catch (error) {
    console.warn('[Canvas] Failed to reload image from Comfy file item:', item.id, error)
    return null
  }
}

async function loadHydratableCanvasImageSource(
  item: CanvasImageItem,
  loadImageFromSrcFn: (src: string) => Promise<LoadedCanvasImage>
): Promise<{ src: string; loaded: LoadedCanvasImage; revoke?: () => void } | null> {
  try {
    return {
      src: item.src,
      loaded: await loadImageFromSrcFn(item.src)
    }
  } catch {
    const recoveredLocalHandle = await createCanvasLocalImageObjectUrlHandle(
      item.src,
      item.fileName,
      `canvas-intake:local:${item.id}`
    )
    if (recoveredLocalHandle) {
      try {
        return {
          src: item.src,
          loaded: await loadImageFromSrcFn(recoveredLocalHandle.url),
          revoke: recoveredLocalHandle.revoke
        }
      } catch (error) {
        recoveredLocalHandle.revoke()
        console.warn('[Canvas] Failed to hydrate recovered local image source:', item.id, error)
      }
    }

    const recoveredSrc = await createComfyImageObjectUrl(item)
    if (!recoveredSrc || recoveredSrc.url === item.src) {
      return null
    }

    try {
      return {
        src: recoveredSrc.url,
        loaded: await loadImageFromSrcFn(recoveredSrc.url),
        revoke: recoveredSrc.revoke
      }
    } catch (error) {
      recoveredSrc.revoke()
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

/**
 * The pending tile is as wide as an import preview (512 px), so the renderer treats a frame that
 * waits for its pixels like one that already has its preview: it starts no source decode of its
 * own unless the frame is shown at more than twice that size. It is only a few rows high: it is
 * one flat colour, stretched to the frame, and every frame gets its own texture of it in the
 * renderer (4 KiB each instead of 1 MiB for a square tile).
 */
export const CANVAS_IMAGE_PENDING_PIXELS_ASSET_WIDTH = 512
export const CANVAS_IMAGE_PENDING_PIXELS_ASSET_HEIGHT = 2

const canvasImagePendingPixelsAssets = new WeakSet<object>()

/**
 * A flat, half-transparent tile for the frames of one import whose pixels are still on their
 * way: each import makes its own, so that it can tell its waiting frames from any other item
 * that came to carry the tile (a copy of a waiting frame, an undo that restored another frame).
 * It is drawn stretched to the item's own rectangle. It carries the placeholder marker: the item
 * counts as "placeholder" for the renderer's health metrics until its real pixels replace it.
 */
export function createCanvasImagePendingPixelsAsset(): CanvasImageAsset | null {
  if (typeof document === 'undefined') {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_IMAGE_PENDING_PIXELS_ASSET_WIDTH
  canvas.height = CANVAS_IMAGE_PENDING_PIXELS_ASSET_HEIGHT
  try {
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = 'rgba(128, 134, 144, 0.32)'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
  } catch {
    // A blank tile still frames the item.
  }

  const tile = markCanvasImagePlaceholderAsset(canvas)
  canvasImagePendingPixelsAssets.add(tile)
  return tile
}

export function isCanvasImagePendingPixelsAsset(
  image: CanvasImageAsset | null | undefined
): boolean {
  return Boolean(image) && canvasImagePendingPixelsAssets.has(image as object)
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

  const localBlob = await readCanvasLocalImageBlobFromSource(src)
  if (localBlob) {
    return localBlob
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

/**
 * An image element decoded from encoded bytes in memory. The object URL only lives for the
 * load: the element keeps the bytes it was loaded from.
 */
async function loadCanvasImageFromBlob(
  blob: Blob,
  loadImageFromSrcFn: (src: string) => Promise<LoadedCanvasImage>
): Promise<HTMLImageElement | null> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null
  }

  let objectUrl = ''
  try {
    objectUrl = URL.createObjectURL(blob)
    const { img } = await loadImageFromSrcFn(objectUrl)
    return img
  } catch {
    return null
  } finally {
    if (objectUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl)
    }
  }
}

/**
 * A thumbnail set lists every level, but only the levels below the source size have a file of
 * their own. An entry at or above it repeats the largest file (same file name). For the image
 * the set belongs to, such an entry stands for the source itself: this returns the set with
 * those entries pointing at the source, so that "the level above the largest thumbnail" is the
 * original picture and not an enlarged thumbnail. A set with one file per level (every set
 * written before, and every source above 2048 px) is returned as it is.
 */
export function bindCanvasThumbnailSetToSource(
  thumbnailSet: CanvasImageThumbnailSet,
  source: { src: string; sourceWidth?: number; sourceHeight?: number; sizeBytes?: number }
): CanvasImageThumbnailSet {
  if (!source.src) {
    return thumbnailSet
  }

  const levels = [...thumbnailSet.levels].sort((left, right) => left.maxSide - right.maxSide)
  const hasSourceSize =
    typeof source.sourceWidth === 'number' &&
    typeof source.sourceHeight === 'number' &&
    source.sourceWidth > 0 &&
    source.sourceHeight > 0
  let changed = false
  let fileLevel: CanvasImageThumbnailSet['levels'][number] | null = null
  const bound = levels.map((level) => {
    if (!fileLevel || !level.filename || level.filename !== fileLevel.filename) {
      fileLevel = level
      return level
    }
    if (level.src === source.src) {
      return level
    }

    // Without a known source size the entry is sized like the level it stands for.
    const fileMaxSide = Math.max(fileLevel.width, fileLevel.height, 1)
    const scale = level.maxSide / fileMaxSide
    changed = true
    return {
      ...level,
      src: source.src,
      width: hasSourceSize ? Math.round(source.sourceWidth!) : Math.round(fileLevel.width * scale),
      height: hasSourceSize
        ? Math.round(source.sourceHeight!)
        : Math.round(fileLevel.height * scale),
      ...(typeof source.sizeBytes === 'number' && source.sizeBytes > 0
        ? { sizeBytes: source.sizeBytes }
        : {})
    }
  })

  return changed ? { ...thumbnailSet, levels: bound } : thumbnailSet
}

export async function resolveCanvasImageThumbnailDisplayAsset({
  src,
  sourceIdentity,
  thumbnailSet,
  sourceFile,
  sourceWidth,
  sourceHeight,
  sizeBytes,
  maxPreviewSide = CANVAS_IMAGE_PROXY_MAX_SIDE,
  onFirstImage,
  signal,
  onQueued,
  onDispatch,
  loadImageFromSrcFn = loadImageFromSrc
}: {
  src: string
  sourceIdentity?: CanvasImageSourceIdentity
  thumbnailSet?: CanvasImageThumbnailSet
  sourceFile?: Blob
  /** Pixel size of the source from the header pass, when known. */
  sourceWidth?: number
  sourceHeight?: number
  sizeBytes?: number
  maxPreviewSide?: number
  /**
   * Called at most once, and only while the thumbnails are being generated: the image of the
   * display level, ready before the larger levels are encoded and written. It is the same
   * image the resolved result carries (the result adds the thumbnail set).
   */
  onFirstImage?: (image: CanvasImageAsset) => void
  /** The caller gave up: a thumbnail job still waiting for a worker is dropped. */
  signal?: AbortSignal
  /** Called when the thumbnail job of this image waits for a worker, and when one starts it. */
  onQueued?: () => void
  onDispatch?: () => void
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

  let generatedLevels: CanvasThumbnailEnsureResult['generatedLevels']
  // Set from the pool's callback: a holder, so that the read below is not narrowed to null.
  const early: { level: { maxSide: number; image: Promise<HTMLImageElement | null> } | null } = {
    level: null
  }
  if (!resolvedThumbnailSet) {
    try {
      const sourceBlob = await resolveCanvasImageThumbnailSourceBlob({ src, sourceFile })
      if (sourceBlob) {
        const ensured = await ensureCanvasThumbnailSet({
          source: sourceBlob,
          identity: sourceIdentity,
          // The cache was read just above.
          skipWarmRead: true,
          ...(signal ? { signal } : {}),
          ...(onQueued ? { onQueued } : {}),
          ...(onDispatch ? { onDispatch } : {}),
          ...(typeof sourceWidth === 'number' && typeof sourceHeight === 'number'
            ? { sourceWidth, sourceHeight }
            : {}),
          ...(onFirstImage
            ? {
                firstLevelMaxSide: maxPreviewSide,
                onFirstLevel: (level) => {
                  if (early.level) {
                    return
                  }
                  const image = loadCanvasImageFromBlob(level.blob, loadImageFromSrcFn)
                  early.level = { maxSide: level.maxSide, image }
                  void image.then((loaded) => {
                    if (loaded) {
                      onFirstImage(loaded)
                    }
                  })
                }
              }
            : {})
        })
        resolvedThumbnailSet = ensured.thumbnailSet
        generatedLevels = ensured.generatedLevels
      }
    } catch (error) {
      console.warn('[Canvas] Failed to generate thumbnail set for image source:', src, error)
    }
  }

  if (resolvedThumbnailSet) {
    resolvedThumbnailSet = bindCanvasThumbnailSetToSource(resolvedThumbnailSet, {
      src,
      sourceWidth,
      sourceHeight,
      sizeBytes
    })
  }

  const thumbnailLevel = pickBestCanvasThumbnailLevel(resolvedThumbnailSet, maxPreviewSide)
  if (!resolvedThumbnailSet || !thumbnailLevel?.src) {
    return null
  }

  if (thumbnailLevel.src !== src) {
    // The level that was handed over early is the display level: keep that one image, so the
    // canvas uploads it once.
    const earlyLevel = early.level
    if (earlyLevel && earlyLevel.maxSide === thumbnailLevel.maxSide) {
      const image = await earlyLevel.image
      if (image) {
        return { image, thumbnailSet: resolvedThumbnailSet }
      }
    }

    // A level that was encoded a moment ago is shown from those bytes: no authorisation round
    // trip and no read of the file that was just written.
    const generatedLevel = generatedLevels?.find(
      (level) => level.filename === thumbnailLevel.filename
    )
    if (generatedLevel) {
      const image = await loadCanvasImageFromBlob(generatedLevel.blob, loadImageFromSrcFn)
      if (image) {
        return { image, thumbnailSet: resolvedThumbnailSet }
      }
    }
  }

  try {
    const { img } = await loadImageFromSrcFn(thumbnailLevel.src)
    return {
      image: img,
      thumbnailSet: resolvedThumbnailSet
    }
  } catch (error) {
    const recoveredThumbnailHandle = await createCanvasLocalImageObjectUrlHandle(
      thumbnailLevel.src,
      thumbnailLevel.filename,
      `canvas-intake:thumbnail:${src}:${thumbnailLevel.maxSide}`
    )
    if (recoveredThumbnailHandle) {
      try {
        const { img } = await loadImageFromSrcFn(recoveredThumbnailHandle.url)
        return {
          image: img,
          thumbnailSet: resolvedThumbnailSet
        }
      } catch (recoveredError) {
        console.warn(
          '[Canvas] Failed to load recovered thumbnail preview image:',
          thumbnailLevel.src,
          recoveredError
        )
      } finally {
        recoveredThumbnailHandle.revoke()
      }
    }

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
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    sizeBytes: item.sizeBytes,
    maxPreviewSide,
    loadImageFromSrcFn
  })
  if (thumbnailPreview) {
    return {
      ...item,
      image: thumbnailPreview.image,
      thumbnailSet: thumbnailPreview.thumbnailSet
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
          image: placeholder
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
  } finally {
    resolvedSource.revoke?.()
  }
}
