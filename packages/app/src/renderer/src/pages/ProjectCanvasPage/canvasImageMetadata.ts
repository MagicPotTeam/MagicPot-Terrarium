import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'

import { getFileExtension } from './types'

const OPAQUE_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg'])
const OPAQUE_IMAGE_MIME_TYPES = new Set(['image/jpeg'])
const PIXEL_ALPHA_SCAN_EXTENSIONS = new Set(['.png', '.webp'])
const PIXEL_ALPHA_SCAN_MIME_TYPES = new Set(['image/png', 'image/webp'])
const IMAGE_ALPHA_SAMPLE_MAX_SIDE = 256

export function extractMimeTypeFromSourceUrl(sourceUrl?: string): string | undefined {
  if (!sourceUrl || !sourceUrl.startsWith('data:')) return undefined
  const header = sourceUrl.slice(5).split(',')[0] || ''
  const mimeType = header.split(';')[0]?.trim().toLowerCase()
  return mimeType || undefined
}

export function inferImageMimeType(fileName?: string, sourceUrl?: string): string | undefined {
  const mimeType = normalizeFileMimeType(fileName, extractMimeTypeFromSourceUrl(sourceUrl), '')
    .trim()
    .toLowerCase()
  return mimeType || undefined
}

export function inferKnownImageHasAlpha(fileName?: string, sourceUrl?: string): boolean | null {
  const extension = getFileExtension(fileName || '')
  const mimeType = inferImageMimeType(fileName, sourceUrl)
  if (OPAQUE_IMAGE_EXTENSIONS.has(extension)) return false
  if (mimeType && OPAQUE_IMAGE_MIME_TYPES.has(mimeType)) return false
  return null
}

function canInspectImageAlphaByPixels(fileName?: string, sourceUrl?: string): boolean {
  const extension = getFileExtension(fileName || '')
  const mimeType = inferImageMimeType(fileName, sourceUrl)
  if (PIXEL_ALPHA_SCAN_EXTENSIONS.has(extension)) return true
  return Boolean(mimeType && PIXEL_ALPHA_SCAN_MIME_TYPES.has(mimeType))
}

export function estimateDataUrlByteSize(sourceUrl?: string): number | undefined {
  if (!sourceUrl?.startsWith('data:')) return undefined
  const commaIndex = sourceUrl.indexOf(',')
  if (commaIndex < 0) return undefined

  const header = sourceUrl.slice(5, commaIndex).toLowerCase()
  const payload = sourceUrl.slice(commaIndex + 1)
  if (!payload) return 0

  if (header.includes(';base64')) {
    const normalizedPayload = payload.replace(/\s+/g, '')
    if (!normalizedPayload) return 0
    const padding = normalizedPayload.endsWith('==') ? 2 : normalizedPayload.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((normalizedPayload.length * 3) / 4) - padding)
  }

  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length
  } catch {
    return new TextEncoder().encode(payload).length
  }
}

export async function detectImageHasAlpha({
  fileName,
  sourceUrl,
  image,
  sampleMaxSide = IMAGE_ALPHA_SAMPLE_MAX_SIDE
}: {
  fileName?: string
  sourceUrl?: string
  image: HTMLImageElement
  sampleMaxSide?: number
}): Promise<boolean | null> {
  const knownValue = inferKnownImageHasAlpha(fileName, sourceUrl)
  if (knownValue != null) return knownValue
  if (!canInspectImageAlphaByPixels(fileName, sourceUrl)) return null

  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  if (sourceWidth <= 0 || sourceHeight <= 0) return null

  try {
    const scale = Math.min(1, sampleMaxSide / Math.max(sourceWidth, sourceHeight))
    const sampleWidth = Math.max(1, Math.round(sourceWidth * scale))
    const sampleHeight = Math.max(1, Math.round(sourceHeight * scale))
    const bitmap =
      typeof createImageBitmap === 'function' &&
      (sampleWidth !== sourceWidth || sampleHeight !== sourceHeight)
        ? await createImageBitmap(image, {
            resizeWidth: sampleWidth,
            resizeHeight: sampleHeight,
            resizeQuality: 'high'
          })
        : null
    const frame = new VideoFrame(bitmap ?? image, { timestamp: 0 })
    const pixelData = new Uint8Array(frame.allocationSize({ format: 'RGBA' }))

    try {
      await frame.copyTo(pixelData, { format: 'RGBA' })
    } finally {
      frame.close()
      bitmap?.close?.()
    }

    for (let index = 3; index < pixelData.length; index += 4) {
      if (pixelData[index] < 255) return true
    }
    return false
  } catch {
    return null
  }
}
