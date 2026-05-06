import { pathToFileURL } from 'node:url'

const FILE_URL_PREFIX = 'file://'
const LOCAL_MEDIA_URL_PREFIX = 'local-media://'
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/
const WINDOWS_DRIVE_HOST_PATTERN = /^[A-Za-z]$/

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const normalizeSchemePath = (value: string): string => {
  const decoded = safeDecodeURIComponent(value)
  return decoded.replace(/^\/(?=[A-Za-z]:[\\/])/, '')
}

const toWindowsFileUrl = (value: string): string => {
  const normalized = value.replace(/\\/g, '/')
  const drive = normalized.slice(0, 1).toUpperCase()
  const pathname = normalized
    .slice(2)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `file:///${drive}:/${pathname}`
}

const normalizeSchemeUrlPath = (value: string): string | null => {
  try {
    const parsed = new URL(value)
    const decodedPathname = safeDecodeURIComponent(parsed.pathname || '')

    if (!parsed.host) {
      return normalizeSchemePath(decodedPathname)
    }

    if (WINDOWS_DRIVE_HOST_PATTERN.test(parsed.hostname)) {
      const normalizedPathname = decodedPathname.startsWith('/')
        ? decodedPathname
        : `/${decodedPathname}`
      return `${parsed.hostname.toUpperCase()}:${normalizedPathname}`
    }

    return `//${safeDecodeURIComponent(parsed.host)}${decodedPathname}`
  } catch {
    return null
  }
}

export function normalizeLocalFilePath(value: string): string {
  if (value.startsWith(LOCAL_MEDIA_URL_PREFIX)) {
    return (
      normalizeSchemeUrlPath(value) ??
      normalizeSchemePath(value.slice(LOCAL_MEDIA_URL_PREFIX.length))
    )
  }

  if (value.startsWith(FILE_URL_PREFIX)) {
    return normalizeSchemeUrlPath(value) ?? normalizeSchemePath(value.slice(FILE_URL_PREFIX.length))
  }

  return value
}

export function isLocalFileSource(value: string): boolean {
  const normalized = normalizeLocalFilePath(value)
  return (
    value.startsWith(LOCAL_MEDIA_URL_PREFIX) ||
    value.startsWith(FILE_URL_PREFIX) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized) ||
    normalized.startsWith('/')
  )
}

export function toFileUrl(value: string): string {
  const normalized = normalizeLocalFilePath(value)
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalized)) {
    return toWindowsFileUrl(normalized)
  }

  return pathToFileURL(normalized).toString()
}
