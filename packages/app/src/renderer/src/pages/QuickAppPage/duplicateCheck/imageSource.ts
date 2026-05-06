import type { DuplicateCheckComparableImage } from '@shared/api/svcDuplicateCheck'
import type { CanvasImageItem } from '@renderer/pages/ProjectCanvasPage/types'
import { normalizeLocalMediaUrl } from '@renderer/pages/ChatPage/chatPageShared'

export type DuplicateCheckClientImage = DuplicateCheckComparableImage & {
  previewUrl: string
}

export const inferMimeTypeFromName = (fileName: string): string => {
  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  if (lowerName.endsWith('.gif')) return 'image/gif'
  if (lowerName.endsWith('.bmp')) return 'image/bmp'
  if (lowerName.endsWith('.svg')) return 'image/svg+xml'
  if (lowerName.endsWith('.ico')) return 'image/x-icon'
  return 'image/png'
}

export const resolveLocalPathFromSourceUrl = (sourceUrl: string): string | null => {
  const normalized = normalizeLocalMediaUrl(sourceUrl).trim()
  if (!normalized) {
    return null
  }

  if (normalized.startsWith('local-media:///')) {
    return decodeURIComponent(normalized.slice('local-media:///'.length))
  }

  if (normalized.startsWith('local-media://')) {
    return decodeURIComponent(normalized.slice('local-media://'.length).replace(/^\/+/, ''))
  }

  if (normalized.startsWith('file:///')) {
    return decodeURIComponent(normalized.slice('file:///'.length))
  }

  if (normalized.startsWith('file://')) {
    return decodeURIComponent(normalized.slice('file://'.length).replace(/^\/+/, ''))
  }

  return null
}

export const readBlobAsUint8Array = async (blob: Blob): Promise<Uint8Array> =>
  new Uint8Array(await blob.arrayBuffer())

export const readFileAsUint8Array = async (file: File): Promise<Uint8Array> =>
  readBlobAsUint8Array(file)

export const loadImageBytesFromSource = async (
  sourceUrl: string
): Promise<{ data: Uint8Array; sourcePath?: string; mimeType?: string }> => {
  const sourcePath = resolveLocalPathFromSourceUrl(sourceUrl)
  if (sourcePath && window.api?.svcFs) {
    const { image, filename } = await window.api.svcFs.readImageFromPath({ fullPath: sourcePath })
    return {
      data: image,
      sourcePath,
      mimeType: inferMimeTypeFromName(filename || sourcePath)
    }
  }

  const response = await fetch(normalizeLocalMediaUrl(sourceUrl))
  if (!response.ok) {
    throw new Error(`Failed to load image source (${response.status})`)
  }

  const blob = await response.blob()
  return {
    data: await readBlobAsUint8Array(blob),
    mimeType: blob.type || undefined
  }
}

export const buildClientImageFromFile = async (
  file: File,
  overrides: Partial<DuplicateCheckComparableImage> = {}
): Promise<DuplicateCheckClientImage> => {
  const previewUrl = URL.createObjectURL(file)
  return {
    id: overrides.id || `query:${crypto.randomUUID()}`,
    name: overrides.name || file.name || `image-${Date.now()}.png`,
    data: await readFileAsUint8Array(file),
    mimeType: overrides.mimeType || file.type || inferMimeTypeFromName(file.name || ''),
    sourcePath: overrides.sourcePath,
    sourceUrl: overrides.sourceUrl,
    itemId: overrides.itemId,
    canvasId: overrides.canvasId,
    canvasName: overrides.canvasName,
    originLabel: overrides.originLabel,
    previewUrl
  }
}

export const buildClientImageFromCanvasItem = async (
  item: CanvasImageItem,
  canvasId: string,
  canvasName: string
): Promise<DuplicateCheckClientImage> => {
  const loaded = await loadImageBytesFromSource(item.src)
  return {
    id: `canvas:${canvasId}:${item.id}`,
    name: item.fileName || `canvas-image-${item.id}.png`,
    data: loaded.data,
    mimeType: loaded.mimeType,
    sourcePath: loaded.sourcePath,
    sourceUrl: item.src,
    itemId: item.id,
    canvasId,
    canvasName,
    originLabel: canvasName,
    previewUrl: item.src
  }
}
