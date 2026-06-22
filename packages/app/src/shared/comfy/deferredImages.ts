export const DEFERRED_COMFY_IMAGE_VALUE_PREFIX = 'MAGICPOT_DEFERRED_COMFY_IMAGE:'

export type DeferredComfyImageInputValue = {
  fileName: string
  mimeType: string
  /** Inline legacy payload. Kept for backward compatibility with existing saved form state. */
  dataUrl?: string
  /** Durable app-local file path used for newly dragged/loaded images. */
  filePath?: string
  sizeBytes: number
}

export function encodeDeferredComfyImageInputValue(value: DeferredComfyImageInputValue): string {
  return `${DEFERRED_COMFY_IMAGE_VALUE_PREFIX}${encodeURIComponent(JSON.stringify(value))}`
}

export function parseDeferredComfyImageInputValue(
  value: unknown
): DeferredComfyImageInputValue | null {
  if (typeof value !== 'string' || !value.startsWith(DEFERRED_COMFY_IMAGE_VALUE_PREFIX)) {
    return null
  }

  try {
    const parsed = JSON.parse(
      decodeURIComponent(value.slice(DEFERRED_COMFY_IMAGE_VALUE_PREFIX.length))
    ) as Partial<DeferredComfyImageInputValue>

    const hasInlineDataUrl =
      typeof parsed.dataUrl === 'string' && parsed.dataUrl.startsWith('data:image/')
    const filePath = typeof parsed.filePath === 'string' ? parsed.filePath.trim() : ''

    if (typeof parsed.fileName !== 'string' || !parsed.fileName.trim()) {
      return null
    }

    if (!hasInlineDataUrl && !filePath) {
      return null
    }

    return {
      fileName: parsed.fileName,
      mimeType:
        typeof parsed.mimeType === 'string' && parsed.mimeType.trim()
          ? parsed.mimeType
          : 'image/png',
      ...(hasInlineDataUrl ? { dataUrl: parsed.dataUrl } : {}),
      ...(filePath ? { filePath } : {}),
      sizeBytes:
        typeof parsed.sizeBytes === 'number' && Number.isFinite(parsed.sizeBytes)
          ? parsed.sizeBytes
          : 0
    }
  } catch {
    return null
  }
}

export function getDeferredComfyImageDisplayName(value: string): string {
  return parseDeferredComfyImageInputValue(value)?.fileName || value
}
