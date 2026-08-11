import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'
import { resolveAuthorizedCanvasLocalMediaSourceUrl } from './canvasLocalFileSource'

const inFlightLocalImageBlobReads = new Map<string, Promise<Blob | null>>()

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
    typeof fetch === 'function' &&
    window.electronFile?.resolveAuthorizedLocalMediaPath
  )
}

export async function readCanvasLocalImageBlobFromSource(
  sourceUrl: string,
  fileName?: string,
  options: { signal?: AbortSignal } = {}
): Promise<Blob | null> {
  if (options.signal?.aborted) {
    throw new DOMException('Local image read aborted.', 'AbortError')
  }
  const authorizedSource = await resolveAuthorizedCanvasLocalMediaSourceUrl(sourceUrl)
  if (options.signal?.aborted) {
    throw new DOMException('Local image read aborted.', 'AbortError')
  }
  if (!authorizedSource || typeof fetch !== 'function') {
    return null
  }

  try {
    const response = await fetch(authorizedSource, { signal: options.signal })
    if (!response.ok && response.status !== 0) {
      throw new Error(`Failed to fetch local image source: ${response.status}`)
    }

    const blob = await response.blob()
    if (options.signal?.aborted) {
      throw new DOMException('Local image read aborted.', 'AbortError')
    }
    if (blob.type) return blob

    const fullPath = resolveCanvasLocalFilePathFromSource(authorizedSource) ?? authorizedSource
    const mimeType = normalizeFileMimeType(fileName ?? fullPath, undefined, 'image/png')
    return blob.slice(0, blob.size, mimeType)
  } catch (error) {
    if (options.signal?.aborted || (error as { name?: unknown } | null)?.name === 'AbortError') {
      throw error
    }
    console.warn('[Canvas] Failed to read local image source:', authorizedSource, error)
    return null
  }
}

export function readCanvasLocalImageBlobFromSourceShared(
  sourceUrl: string,

  fileName?: string
): Promise<Blob | null> {
  const fullPath = resolveCanvasLocalFilePathFromSource(sourceUrl)

  if (!fullPath) {
    return Promise.resolve(null)
  }

  const key = `${fullPath}\n${fileName ?? ''}`

  const existing = inFlightLocalImageBlobReads.get(key)

  if (existing) {
    return existing
  }

  const pending = readCanvasLocalImageBlobFromSource(sourceUrl, fileName).finally(() => {
    if (inFlightLocalImageBlobReads.get(key) === pending) {
      inFlightLocalImageBlobReads.delete(key)
    }
  })

  inFlightLocalImageBlobReads.set(key, pending)

  return pending
}

export async function createCanvasLocalImageObjectUrl(
  sourceUrl: string,
  fileName?: string
): Promise<string | null> {
  const blob = await readCanvasLocalImageBlobFromSourceShared(sourceUrl, fileName)
  return blob ? URL.createObjectURL(blob) : null
}
