export const MEDIA_REFERENCE_VERSION = 1 as const
export const MEDIA_REFERENCE_MIME_TYPE_MAX_LENGTH = 255
export const MEDIA_REFERENCE_ORIGINAL_FILE_NAME_MAX_LENGTH = 255
export const MEDIA_REFERENCE_RELATIVE_PATH_MAX_LENGTH = 1_024
export const MEDIA_REFERENCE_MEDIA_ID_MAX_LENGTH = 255
export const MEDIA_REFERENCE_ORIGINAL_URL_MAX_LENGTH = 8_192
export const MEDIA_REFERENCE_MAX_DIMENSION = 1_000_000
export const MEDIA_REFERENCE_MAX_DERIVATIVES = 16

export type MediaReferenceKind = 'managed' | 'project-asset'
export type MediaReferenceStatus = 'pending' | 'ready' | 'missing' | 'corrupt'
export type MediaDerivativeDescriptor = {
  maxEdge: 256 | 512 | 1024 | 2048
  relativePath: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
  sha256: string
}

export type MediaReference = {
  version: typeof MEDIA_REFERENCE_VERSION
  kind: MediaReferenceKind
  /** A canonical, decoded POSIX-style relative identifier; never a URL or filesystem path. */
  relativePath: string
  sha256?: string
  sizeBytes?: number
  mimeType?: string
  originalFileName?: string
  /** Stable opaque identity. Existing references may omit it. */
  mediaId?: string
  /** The source URL retained for lazy migration or recovery. */
  originalUrl?: string
  width?: number
  height?: number
  status?: MediaReferenceStatus
  derivatives?: MediaDerivativeDescriptor[]
}

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/
const MEDIA_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const MEDIA_TYPE_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MEDIA_REFERENCE_STATUSES: readonly MediaReferenceStatus[] = [
  'pending',
  'ready',
  'missing',
  'corrupt'
]
const DERIVATIVE_MAX_EDGES = [256, 512, 1024, 2048] as const
const ALLOWED_ORIGINAL_URL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'data:',
  'blob:',
  'file:',
  'local-media:'
])

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

function isPositiveBoundedInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER
): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function isValidOriginalUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MEDIA_REFERENCE_ORIGINAL_URL_MAX_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false
  }
  try {
    const url = new URL(value)
    return ALLOWED_ORIGINAL_URL_PROTOCOLS.has(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

function normalizeDerivative(value: unknown): MediaDerivativeDescriptor | undefined {
  if (!isRecord(value)) return undefined
  if (!DERIVATIVE_MAX_EDGES.includes(value.maxEdge as (typeof DERIVATIVE_MAX_EDGES)[number])) {
    return undefined
  }
  if (!isNormalizedMediaRelativePath(value.relativePath)) return undefined
  const mimeType = normalizeMimeType(value.mimeType)
  if (mimeType === undefined) return undefined
  if (!isPositiveBoundedInteger(value.sizeBytes)) return undefined
  if (!isPositiveBoundedInteger(value.width, MEDIA_REFERENCE_MAX_DIMENSION)) return undefined
  if (!isPositiveBoundedInteger(value.height, MEDIA_REFERENCE_MAX_DIMENSION)) return undefined
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) return undefined

  return {
    maxEdge: value.maxEdge as MediaDerivativeDescriptor['maxEdge'],
    relativePath: value.relativePath,
    mimeType,
    sizeBytes: value.sizeBytes,
    width: value.width,
    height: value.height,
    sha256: value.sha256.toLowerCase()
  }
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
  if (value.sizeBytes !== undefined && !isPositiveBoundedInteger(value.sizeBytes)) {
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

  if (
    value.mediaId !== undefined &&
    (typeof value.mediaId !== 'string' ||
      value.mediaId.length > MEDIA_REFERENCE_MEDIA_ID_MAX_LENGTH ||
      !MEDIA_ID_PATTERN.test(value.mediaId))
  ) {
    return undefined
  }
  if (value.originalUrl !== undefined && !isValidOriginalUrl(value.originalUrl)) return undefined
  if (
    value.width !== undefined &&
    !isPositiveBoundedInteger(value.width, MEDIA_REFERENCE_MAX_DIMENSION)
  ) {
    return undefined
  }
  if (
    value.height !== undefined &&
    !isPositiveBoundedInteger(value.height, MEDIA_REFERENCE_MAX_DIMENSION)
  ) {
    return undefined
  }
  if (
    value.status !== undefined &&
    !MEDIA_REFERENCE_STATUSES.includes(value.status as MediaReferenceStatus)
  ) {
    return undefined
  }

  let derivatives: MediaDerivativeDescriptor[] | undefined
  if (value.derivatives !== undefined) {
    if (
      !Array.isArray(value.derivatives) ||
      value.derivatives.length > MEDIA_REFERENCE_MAX_DERIVATIVES
    ) {
      return undefined
    }
    derivatives = []
    const paths = new Set<string>()
    for (const item of value.derivatives) {
      const derivative = normalizeDerivative(item)
      if (derivative === undefined || paths.has(derivative.relativePath)) return undefined
      paths.add(derivative.relativePath)
      derivatives.push(derivative)
    }
  }

  return {
    version: MEDIA_REFERENCE_VERSION,
    kind: value.kind,
    relativePath: value.relativePath,
    ...(value.sha256 !== undefined ? { sha256: value.sha256.toLowerCase() } : {}),
    ...(value.sizeBytes !== undefined ? { sizeBytes: value.sizeBytes } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(value.originalFileName !== undefined ? { originalFileName: value.originalFileName } : {}),
    ...(value.mediaId !== undefined ? { mediaId: value.mediaId } : {}),
    ...(value.originalUrl !== undefined ? { originalUrl: value.originalUrl } : {}),
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.status !== undefined ? { status: value.status as MediaReferenceStatus } : {}),
    ...(derivatives !== undefined ? { derivatives } : {})
  }
}

export function isMediaReference(value: unknown): value is MediaReference {
  return normalizeMediaReference(value) !== undefined
}
