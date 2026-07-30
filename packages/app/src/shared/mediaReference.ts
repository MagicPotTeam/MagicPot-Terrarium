export const MEDIA_REFERENCE_VERSION = 1 as const
export const MEDIA_REFERENCE_MIME_TYPE_MAX_LENGTH = 255
export const MEDIA_REFERENCE_ORIGINAL_FILE_NAME_MAX_LENGTH = 255
export const MEDIA_REFERENCE_RELATIVE_PATH_MAX_LENGTH = 1_024

export type MediaReferenceKind = 'managed' | 'project-asset'

export type MediaReference = {
  version: typeof MEDIA_REFERENCE_VERSION
  kind: MediaReferenceKind
  /** A canonical, decoded POSIX-style relative identifier; never a URL or filesystem path. */
  relativePath: string
  sha256?: string
  sizeBytes?: number
  mimeType?: string
  originalFileName?: string
}

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const MEDIA_TYPE_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks for a canonical, decoded POSIX-style relative identifier. Percent-encoded input is
 * rejected rather than normalized so every accepted identifier has exactly one representation.
 */
export function isNormalizedMediaRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MEDIA_REFERENCE_RELATIVE_PATH_MAX_LENGTH
  )
    return false
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes(':') ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false
  }

  if (value.includes('%')) {
    try {
      if (decodeURIComponent(value) !== value) return false
    } catch {
      return false
    }
  }

  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function normalizeMimeType(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MEDIA_REFERENCE_MIME_TYPE_MAX_LENGTH ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    return undefined
  }
  return value.toLowerCase()
}

function isValidOriginalFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MEDIA_REFERENCE_ORIGINAL_FILE_NAME_MAX_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  )
}

function isWindowsSafeManagedFileName(value: string): boolean {
  const stem = value.split('.')[0].toUpperCase()
  return (
    !/[. ]$/u.test(value) &&
    !/[<>:"|?*]/u.test(value) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
  )
}

/** Returns a canonical media reference, or undefined when the input is not valid version 1 data. */
export function normalizeMediaReference(value: unknown): MediaReference | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== MEDIA_REFERENCE_VERSION) return undefined
  if (value.kind !== 'managed' && value.kind !== 'project-asset') return undefined
  if (!isNormalizedMediaRelativePath(value.relativePath)) return undefined
  if (
    value.kind === 'managed' &&
    (value.sha256 === undefined ||
      value.sizeBytes === undefined ||
      value.mimeType === undefined ||
      value.originalFileName === undefined)
  ) {
    return undefined
  }

  if (
    value.sha256 !== undefined &&
    (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256))
  ) {
    return undefined
  }
  if (
    value.sizeBytes !== undefined &&
    (typeof value.sizeBytes !== 'number' ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes <= 0)
  ) {
    return undefined
  }

  const mimeType = value.mimeType === undefined ? undefined : normalizeMimeType(value.mimeType)
  if (value.mimeType !== undefined && mimeType === undefined) return undefined
  if (value.originalFileName !== undefined && !isValidOriginalFileName(value.originalFileName)) {
    return undefined
  }
  if (
    value.kind === 'managed' &&
    value.originalFileName !== undefined &&
    !isWindowsSafeManagedFileName(value.originalFileName)
  ) {
    return undefined
  }

  return {
    version: MEDIA_REFERENCE_VERSION,
    kind: value.kind,
    relativePath: value.relativePath,
    ...(value.sha256 !== undefined ? { sha256: value.sha256.toLowerCase() } : {}),
    ...(value.sizeBytes !== undefined ? { sizeBytes: value.sizeBytes } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(value.originalFileName !== undefined ? { originalFileName: value.originalFileName } : {})
  }
}

export function isMediaReference(value: unknown): value is MediaReference {
  return normalizeMediaReference(value) !== undefined
}
