import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeLocalPath(value: string): string {
  const decoded = decodePathPart(value).replace(/\\/g, '/')
  if (/^\/[a-zA-Z]:($|\/)/.test(decoded)) {
    return decoded.slice(1)
  }

  return decoded.replace(/^\/+/, '')
}

export function resolveCanvasLocalFilePathFromSource(sourceUrl: string): string | null {
  const normalized = sourceUrl.trim()
  if (!normalized) {
    return null
  }

  try {
    const url = new URL(normalized)
    if (url.protocol !== 'local-media:' && url.protocol !== 'file:') {
      return null
    }

    if (url.hostname) {
      const hostname = decodePathPart(url.hostname)
      const pathname = normalizeLocalPath(url.pathname)
      if (/^[a-zA-Z]$/.test(hostname)) {
        return `${hostname}:/${pathname}`
      }

      return `//${hostname}${url.pathname ? `/${pathname}` : ''}`
    }

    return normalizeLocalPath(url.pathname)
  } catch {
    // Fall through to prefix handling for partially escaped legacy URLs.
  }

  if (normalized.startsWith('local-media:///')) {
    return normalizeLocalPath(normalized.slice('local-media:///'.length))
  }

  if (normalized.startsWith('local-media://')) {
    const rest = normalizeLocalPath(normalized.slice('local-media://'.length))
    const driveMatch = rest.match(/^([a-zA-Z])\/(.+)$/)
    if (driveMatch) {
      return `${driveMatch[1]}:/${driveMatch[2]}`
    }

    return rest
  }

  if (normalized.startsWith('file:///')) {
    return normalizeLocalPath(normalized.slice('file:///'.length))
  }

  if (normalized.startsWith('file://')) {
    const rest = normalizeLocalPath(normalized.slice('file://'.length))
    const driveMatch = rest.match(/^([a-zA-Z])\/(.+)$/)
    if (driveMatch) {
      return `${driveMatch[1]}:/${driveMatch[2]}`
    }

    return rest
  }

  return null
}

export function canReadCanvasLocalImageSource(sourceUrl: string): boolean {
  return Boolean(
    resolveCanvasLocalFilePathFromSource(sourceUrl) &&
    typeof window !== 'undefined' &&
    window.api?.svcFs?.readImageFromPath
  )
}

export async function readCanvasLocalImageBlobFromSource(
  sourceUrl: string,
  fileName?: string
): Promise<Blob | null> {
  const fullPath = resolveCanvasLocalFilePathFromSource(sourceUrl)
  if (!fullPath || typeof window === 'undefined' || !window.api?.svcFs?.readImageFromPath) {
    return null
  }

  try {
    const { image, filename } = await window.api.svcFs.readImageFromPath({ fullPath })
    const mimeType = normalizeFileMimeType(fileName ?? filename ?? fullPath, undefined, 'image/png')
    return new Blob([image as BlobPart], { type: mimeType })
  } catch (error) {
    console.warn('[Canvas] Failed to read local image source:', fullPath, error)
    return null
  }
}

export async function createCanvasLocalImageObjectUrl(
  sourceUrl: string,
  fileName?: string
): Promise<string | null> {
  const blob = await readCanvasLocalImageBlobFromSource(sourceUrl, fileName)
  return blob ? URL.createObjectURL(blob) : null
}
