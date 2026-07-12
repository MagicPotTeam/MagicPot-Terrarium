import type { CanvasImageItem } from './types'

function hasGifExtension(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return false
  }

  try {
    return new URL(normalized).pathname.toLowerCase().endsWith('.gif')
  } catch {
    return normalized.split(/[?#]/, 1)[0].toLowerCase().endsWith('.gif')
  }
}

export function isAnimatedGifCanvasImage(
  item: Pick<CanvasImageItem, 'src' | 'fileName' | 'sourceFile' | 'provenance'>
): boolean {
  const normalizedSrc = item.src.trim().toLowerCase()
  const sourceMimeType = item.sourceFile?.type?.trim().toLowerCase()

  return (
    normalizedSrc.startsWith('data:image/gif') ||
    sourceMimeType === 'image/gif' ||
    hasGifExtension(item.fileName) ||
    hasGifExtension(item.provenance?.sourceFileName) ||
    hasGifExtension(item.src)
  )
}
