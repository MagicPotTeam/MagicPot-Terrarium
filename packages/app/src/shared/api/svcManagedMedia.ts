import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import {
  isNormalizedMediaRelativePath,
  normalizeMediaReference,
  type MediaReference
} from '../mediaReference'

export const MANAGED_MEDIA_DERIVATIVE_MAX_EDGES = [256, 512, 1024, 2048] as const
export type ManagedMediaDerivativeMaxEdge = (typeof MANAGED_MEDIA_DERIVATIVE_MAX_EDGES)[number]

export type ManagedMediaDerivativeDescriptor = {
  maxEdge: ManagedMediaDerivativeMaxEdge
  relativePath: string
  mimeType: 'image/webp' | 'image/png'
  sizeBytes: number
  width: number
  height: number
  sha256: string
  localMediaUrl: string
}

export type EnsureManagedMediaDerivativeReq = {
  reference: MediaReference
  maxEdge: ManagedMediaDerivativeMaxEdge
}

export type EnsureManagedMediaDerivativeResp =
  | { status: 'ready'; descriptor: ManagedMediaDerivativeDescriptor }
  | { status: 'fallbackOriginal'; reason: 'animated-gif'; localMediaUrl: string }

export type MaterializeManagedMediaForRequestReq = {
  reference: MediaReference
  transport: 'request-data-url'
}

export type MaterializeManagedMediaForRequestResp = {
  transport: 'request-data-url'
  dataUrl: string
  mimeType: string
  sizeBytes: number
}

export type ImportManagedMediaFileReq = {
  sourcePath: string
  mimeType: string
  originalFileName: string
}

export type ImportManagedMediaDataUrlReq = {
  dataUrl: string
  originalFileName: string
}

export type ImportManagedMediaResp = {
  reference: MediaReference
  localMediaUrl: string
}

export type MigrateLegacyManagedMediaReq = {
  dataUrl: string
  metadata: {
    originalFileName: string
    sourceWidth?: number
    sourceHeight?: number
  }
}

export type MigrateLegacyManagedMediaResp = ImportManagedMediaResp & {
  checkpoint: {
    version: 1
    reclaim: { reference: MediaReference }
  }
}

export type ReclaimLegacyManagedMediaReq = MigrateLegacyManagedMediaResp['checkpoint']
export type ReclaimLegacyManagedMediaResp = { queued: true }

export type ManagedMediaSvc = {
  importFile(req: ImportManagedMediaFileReq): Promise<ImportManagedMediaResp>
  importDataUrl(req: ImportManagedMediaDataUrlReq): Promise<ImportManagedMediaResp>
  migrateLegacyDataUrl(req: MigrateLegacyManagedMediaReq): Promise<MigrateLegacyManagedMediaResp>
  reclaimLegacyMigration(req: ReclaimLegacyManagedMediaReq): Promise<ReclaimLegacyManagedMediaResp>
  ensureDerivative(req: EnsureManagedMediaDerivativeReq): Promise<EnsureManagedMediaDerivativeResp>
  materializeForRequest(
    req: MaterializeManagedMediaForRequestReq
  ): Promise<MaterializeManagedMediaForRequestResp>
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Validates an absolute, hostless local-media URL and returns its decoded canonical path. */
function decodedLocalMediaPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'local-media:' ||
      url.username ||
      url.password ||
      url.host ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
    const decoded = decodeURIComponent(url.pathname)
    if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0'))
      return undefined
    const segments = decoded.split('/').slice(1)
    if (segments.some((segment) => !segment || segment === '.' || segment === '..'))
      return undefined
    return decoded
  } catch {
    return undefined
  }
}

function localMediaUrlMatchesRelativePath(url: unknown, relativePath: string): boolean {
  const pathname = decodedLocalMediaPath(url)
  return pathname !== undefined && pathname.endsWith(`/${relativePath}`)
}

const MIME_TYPE_PATTERN = /^[-!#$%&'*+.^_`|~0-9A-Za-z]+\/[-!#$%&'*+.^_`|~0-9A-Za-z]+$/
const MAX_IMPORT_DATA_URL_LENGTH = 35 * 1024 * 1024
export const MAX_MANAGED_MEDIA_IMPORT_BYTES = 25 * 1024 * 1024
const isSafeOriginalFileName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 255 &&
  value !== '.' &&
  value !== '..' &&
  !value.includes('/') &&
  !value.includes('\\') &&
  !/[\p{Cc}<>:"|?*]/u.test(value) &&
  !/[. ]$/u.test(value) &&
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value)

/**
 * This validates transport syntax only. importFile is intentionally fed from a user-selected
 * Electron File path; the main-owned store remains the authority for canonical/symlink/root checks.
 */
const isCanonicalAbsoluteFileSource = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) {
    return false
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    try {
      const url = new URL(value)
      if (
        url.protocol !== 'file:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.host && url.host !== 'localhost')
      ) {
        return false
      }
      const decoded = decodeURIComponent(url.pathname)
      return (
        decoded.startsWith('/') &&
        !decoded.includes('\\') &&
        !decoded.split('/').some((segment) => segment === '.' || segment === '..')
      )
    } catch {
      return false
    }
  }
  const normalized = value.replace(/\\/g, '/')
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
  return (
    absolute &&
    !normalized.includes('//') &&
    !normalized.split('/').some((segment) => segment === '.' || segment === '..')
  )
}

const validImportDataUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MAX_IMPORT_DATA_URL_LENGTH) return false
  const match =
    /^data:([-!#$%&'*+.^_`|~0-9A-Za-z]+\/[-!#$%&'*+.^_`|~0-9A-Za-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value
    )
  if (!match) return false
  const payload = match[2]
  if (payload.length % 4 !== 0) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const decodedBytes = (payload.length / 4) * 3 - padding
  return decodedBytes > 0 && decodedBytes <= MAX_MANAGED_MEDIA_IMPORT_BYTES
}

export const validateImportManagedMediaFileReq = (value: unknown): ImportManagedMediaFileReq => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['sourcePath', 'mimeType', 'originalFileName']) ||
    !isCanonicalAbsoluteFileSource(value.sourcePath) ||
    typeof value.mimeType !== 'string' ||
    !MIME_TYPE_PATTERN.test(value.mimeType) ||
    !isSafeOriginalFileName(value.originalFileName)
  ) {
    throw new ServiceValidationError('svcManagedMedia.importFile request')
  }
  return {
    sourcePath: value.sourcePath,
    mimeType: value.mimeType.toLowerCase(),
    originalFileName: value.originalFileName
  }
}

export const validateImportManagedMediaDataUrlReq = (
  value: unknown
): ImportManagedMediaDataUrlReq => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['dataUrl', 'originalFileName']) ||
    !validImportDataUrl(value.dataUrl) ||
    !isSafeOriginalFileName(value.originalFileName)
  ) {
    throw new ServiceValidationError('svcManagedMedia.importDataUrl request')
  }
  return value as ImportManagedMediaDataUrlReq
}

export const validateImportManagedMediaResp = (value: unknown): ImportManagedMediaResp => {
  if (!isRecord(value) || !hasExactKeys(value, ['reference', 'localMediaUrl'])) {
    throw new ServiceValidationError('svcManagedMedia import response')
  }
  const reference = normalizeMediaReference(value.reference)
  if (
    !reference ||
    reference.kind !== 'managed' ||
    !localMediaUrlMatchesRelativePath(value.localMediaUrl, reference.relativePath)
  ) {
    throw new ServiceValidationError('svcManagedMedia import response')
  }
  return { reference, localMediaUrl: value.localMediaUrl as string }
}

export const validateMigrateLegacyManagedMediaReq = (
  value: unknown
): MigrateLegacyManagedMediaReq => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['dataUrl', 'metadata']) ||
    !validImportDataUrl(value.dataUrl)
  ) {
    throw new ServiceValidationError('svcManagedMedia.migrateLegacyDataUrl request')
  }
  const metadata = value.metadata
  const allowed = ['originalFileName', 'sourceWidth', 'sourceHeight']
  if (
    !isRecord(metadata) ||
    !isSafeOriginalFileName(metadata.originalFileName) ||
    !Object.keys(metadata).every((key) => allowed.includes(key)) ||
    (metadata.sourceWidth !== undefined && !isPositiveSafeInteger(metadata.sourceWidth)) ||
    (metadata.sourceHeight !== undefined && !isPositiveSafeInteger(metadata.sourceHeight))
  ) {
    throw new ServiceValidationError('svcManagedMedia.migrateLegacyDataUrl request')
  }
  return value as MigrateLegacyManagedMediaReq
}

export const validateMigrateLegacyManagedMediaResp = (
  value: unknown
): MigrateLegacyManagedMediaResp => {
  if (!isRecord(value) || !hasExactKeys(value, ['reference', 'localMediaUrl', 'checkpoint'])) {
    throw new ServiceValidationError('svcManagedMedia.migrateLegacyDataUrl response')
  }
  const imported = validateImportManagedMediaResp({
    reference: value.reference,
    localMediaUrl: value.localMediaUrl
  })
  const checkpoint = value.checkpoint
  const reclaim = isRecord(checkpoint) ? checkpoint.reclaim : undefined
  const reclaimReference = isRecord(reclaim)
    ? normalizeMediaReference(reclaim.reference)
    : undefined
  if (
    !isRecord(checkpoint) ||
    !hasExactKeys(checkpoint, ['version', 'reclaim']) ||
    checkpoint.version !== 1 ||
    !isRecord(reclaim) ||
    !hasExactKeys(reclaim, ['reference']) ||
    !reclaimReference ||
    reclaimReference.kind !== 'managed' ||
    reclaimReference.relativePath !== imported.reference.relativePath
  ) {
    throw new ServiceValidationError('svcManagedMedia.migrateLegacyDataUrl response')
  }
  return { ...imported, checkpoint: { version: 1, reclaim: { reference: reclaimReference } } }
}

export const validateReclaimLegacyManagedMediaReq = (
  value: unknown
): ReclaimLegacyManagedMediaReq => {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'reclaim']) || value.version !== 1) {
    throw new ServiceValidationError('svcManagedMedia.reclaimLegacyMigration request')
  }
  const reclaim = value.reclaim
  const reference = isRecord(reclaim) ? normalizeMediaReference(reclaim.reference) : undefined
  if (
    !isRecord(reclaim) ||
    !hasExactKeys(reclaim, ['reference']) ||
    !reference ||
    reference.kind !== 'managed'
  ) {
    throw new ServiceValidationError('svcManagedMedia.reclaimLegacyMigration request')
  }
  return { version: 1, reclaim: { reference } }
}

export const validateReclaimLegacyManagedMediaResp = (
  value: unknown
): ReclaimLegacyManagedMediaResp => {
  if (!isRecord(value) || !hasExactKeys(value, ['queued']) || value.queued !== true) {
    throw new ServiceValidationError('svcManagedMedia.reclaimLegacyMigration response')
  }
  return { queued: true }
}

export const validateEnsureManagedMediaDerivativeReq = (
  value: unknown
): EnsureManagedMediaDerivativeReq => {
  if (!isRecord(value) || !hasExactKeys(value, ['reference', 'maxEdge'])) {
    throw new ServiceValidationError('svcManagedMedia.ensureDerivative request')
  }
  const reference = normalizeMediaReference(value.reference)
  if (!reference || reference.kind !== 'managed') {
    throw new ServiceValidationError('svcManagedMedia.ensureDerivative request', undefined, [
      { path: ['reference'], message: 'Expected a valid managed media reference' }
    ])
  }
  if (
    typeof value.maxEdge !== 'number' ||
    !MANAGED_MEDIA_DERIVATIVE_MAX_EDGES.includes(value.maxEdge as ManagedMediaDerivativeMaxEdge)
  ) {
    throw new ServiceValidationError('svcManagedMedia.ensureDerivative request', undefined, [
      { path: ['maxEdge'], message: 'Expected one of 256, 512, 1024, or 2048' }
    ])
  }
  return { reference, maxEdge: value.maxEdge as ManagedMediaDerivativeMaxEdge }
}

export const validateEnsureManagedMediaDerivativeResp = (
  value: unknown
): EnsureManagedMediaDerivativeResp => {
  if (!isRecord(value)) {
    throw new ServiceValidationError('svcManagedMedia.ensureDerivative response')
  }

  if (value.status === 'fallbackOriginal') {
    if (
      !hasExactKeys(value, ['status', 'reason', 'localMediaUrl']) ||
      value.reason !== 'animated-gif' ||
      decodedLocalMediaPath(value.localMediaUrl) === undefined
    ) {
      throw new ServiceValidationError('svcManagedMedia.ensureDerivative response')
    }
    return value as EnsureManagedMediaDerivativeResp
  }

  if (
    value.status !== 'ready' ||
    !hasExactKeys(value, ['status', 'descriptor']) ||
    !isRecord(value.descriptor)
  ) {
    throw new ServiceValidationError('svcManagedMedia.ensureDerivative response')
  }

  const descriptor = value.descriptor
  const descriptorKeys = [
    'maxEdge',
    'relativePath',
    'mimeType',
    'sizeBytes',
    'width',
    'height',
    'sha256',
    'localMediaUrl'
  ] as const
  if (
    !hasExactKeys(descriptor, descriptorKeys) ||
    !MANAGED_MEDIA_DERIVATIVE_MAX_EDGES.includes(
      descriptor.maxEdge as ManagedMediaDerivativeMaxEdge
    ) ||
    !isNormalizedMediaRelativePath(descriptor.relativePath) ||
    (descriptor.mimeType !== 'image/png' && descriptor.mimeType !== 'image/webp') ||
    !isPositiveSafeInteger(descriptor.sizeBytes) ||
    !isPositiveSafeInteger(descriptor.width) ||
    !isPositiveSafeInteger(descriptor.height) ||
    typeof descriptor.sha256 !== 'string' ||
    !SHA256_PATTERN.test(descriptor.sha256) ||
    !localMediaUrlMatchesRelativePath(descriptor.localMediaUrl, descriptor.relativePath)
  ) {
    throw new ServiceValidationError('svcManagedMedia.ensureDerivative response')
  }

  return value as EnsureManagedMediaDerivativeResp
}

export const validateMaterializeManagedMediaForRequestReq = (
  value: unknown
): MaterializeManagedMediaForRequestReq => {
  if (!isRecord(value) || !hasExactKeys(value, ['reference', 'transport'])) {
    throw new ServiceValidationError('svcManagedMedia.materializeForRequest request')
  }
  const reference = normalizeMediaReference(value.reference)
  if (!reference || reference.kind !== 'managed' || value.transport !== 'request-data-url') {
    throw new ServiceValidationError('svcManagedMedia.materializeForRequest request')
  }
  return { reference, transport: 'request-data-url' }
}

export const validateMaterializeManagedMediaForRequestResp = (
  value: unknown
): MaterializeManagedMediaForRequestResp => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['transport', 'dataUrl', 'mimeType', 'sizeBytes']) ||
    value.transport !== 'request-data-url' ||
    typeof value.mimeType !== 'string' ||
    !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+\/[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(value.mimeType) ||
    !isPositiveSafeInteger(value.sizeBytes) ||
    typeof value.dataUrl !== 'string' ||
    !value.dataUrl.startsWith(`data:${value.mimeType};base64,`)
  ) {
    throw new ServiceValidationError('svcManagedMedia.materializeForRequest response')
  }
  return value as MaterializeManagedMediaForRequestResp
}

export const managedMediaSvcDef: ServiceDefSheet<ManagedMediaSvc> = {
  importFile: {
    type: 'unary',
    request: validateImportManagedMediaFileReq,
    response: validateImportManagedMediaResp
  },
  importDataUrl: {
    type: 'unary',
    request: validateImportManagedMediaDataUrlReq,
    response: validateImportManagedMediaResp
  },
  migrateLegacyDataUrl: {
    type: 'unary',
    request: validateMigrateLegacyManagedMediaReq,
    response: validateMigrateLegacyManagedMediaResp
  },
  reclaimLegacyMigration: {
    type: 'unary',
    request: validateReclaimLegacyManagedMediaReq,
    response: validateReclaimLegacyManagedMediaResp
  },
  ensureDerivative: {
    type: 'unary',
    request: validateEnsureManagedMediaDerivativeReq,
    response: validateEnsureManagedMediaDerivativeResp
  },
  materializeForRequest: {
    type: 'unary',
    request: validateMaterializeManagedMediaForRequestReq,
    response: validateMaterializeManagedMediaForRequestResp
  }
}
