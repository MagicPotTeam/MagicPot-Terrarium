import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import {
  validateBinaryChunkFrameSet,
  validateBinaryChunkReference,
  type BinaryChunkFrame,
  type BinaryChunkReference
} from '../binaryChunkProtocol'
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

export type MaterializeManagedMediaForRequestReq =
  | { reference: MediaReference; transport: 'request-data-url' }
  | { reference: MediaReference; transport: 'chunked-binary-v1' }

export type MaterializeManagedMediaForRequestResp =
  | {
      transport: 'request-data-url'
      dataUrl: string
      mimeType: string
      sizeBytes: number
    }
  | {
      transport: 'chunked-binary-v1'
      reference: BinaryChunkReference
      chunks: BinaryChunkFrame[]
    }

export const MANAGED_MEDIA_STORAGE_NAMESPACES = ['task', 'model', 'user-output'] as const
export type ManagedMediaStorageNamespace = (typeof MANAGED_MEDIA_STORAGE_NAMESPACES)[number]
export type ManagedMediaStorage = {
  namespace: ManagedMediaStorageNamespace
  /** Canonical lower-case scope; never sanitized or lower-cased implicitly. */
  scope: string
}

export type ImportManagedMediaFileReq = {
  sourcePath: string
  mimeType: string
  originalFileName: string
  /** Optional physical lifecycle namespace. Omitted requests retain legacy storage. */
  storage?: ManagedMediaStorage
}

export type ImportManagedMediaDataUrlReq = {
  dataUrl: string
  originalFileName: string
  /** Optional physical lifecycle namespace. Omitted requests retain legacy storage. */
  storage?: ManagedMediaStorage
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
  /** Optional physical lifecycle namespace; omitted requests stay legacy-compatible. */
  storage?: ManagedMediaStorage
}

export type MigrateLegacyManagedMediaResp = ImportManagedMediaResp & {
  checkpoint: {
    version: 1
    reclaim: { reference: MediaReference }
  }
}

export type ReclaimLegacyManagedMediaReq = MigrateLegacyManagedMediaResp['checkpoint']

export type UpdateManagedMediaReferenceSnapshotReq = {
  version: 1
  complete: boolean
  ids: string[]
  /** Number of durable records currently referring to each managed media ID. */
  referenceCounts?: Record<string, number>
}
export type UpdateManagedMediaReferenceSnapshotResp = { version: 1; accepted: true }
export type ReclaimLegacyManagedMediaResp = { queued: true }

export type ManagedMediaSvc = {
  importFile(req: ImportManagedMediaFileReq): Promise<ImportManagedMediaResp>
  importDataUrl(req: ImportManagedMediaDataUrlReq): Promise<ImportManagedMediaResp>
  migrateLegacyDataUrl(req: MigrateLegacyManagedMediaReq): Promise<MigrateLegacyManagedMediaResp>
  reclaimLegacyMigration(req: ReclaimLegacyManagedMediaReq): Promise<ReclaimLegacyManagedMediaResp>
  updateReferenceSnapshot(
    req: UpdateManagedMediaReferenceSnapshotReq
  ): Promise<UpdateManagedMediaReferenceSnapshotResp>
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

const MANAGED_MEDIA_STORAGE_SCOPE_PATTERN = /^[a-z0-9_](?:[a-z0-9._-]{0,126}[a-z0-9_])?$/u
const isManagedMediaStorageNamespace = (value: unknown): value is ManagedMediaStorageNamespace =>
  typeof value === 'string' &&
  (MANAGED_MEDIA_STORAGE_NAMESPACES as readonly string[]).includes(value)
const isManagedMediaStorageScope = (value: unknown): value is string =>
  typeof value === 'string' && MANAGED_MEDIA_STORAGE_SCOPE_PATTERN.test(value)
const hasAllowedKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean => {
  const keys = Object.keys(value)
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}
const validateManagedMediaStorage = (value: unknown): ManagedMediaStorage | undefined => {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['namespace', 'scope']) ||
    !isManagedMediaStorageNamespace(value.namespace) ||
    !isManagedMediaStorageScope(value.scope)
  ) {
    throw new ServiceValidationError('svcManagedMedia storage')
  }
  return { namespace: value.namespace, scope: value.scope }
}

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
  if (typeof value !== 'string') return false
  const match =
    /^data:([-!#$%&'*+.^_`|~0-9A-Za-z]+\/[-!#$%&'*+.^_`|~0-9A-Za-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value
    )
  if (!match) return false
  const payload = match[2]
  if (payload.length % 4 !== 0) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const decodedBytes = (payload.length / 4) * 3 - padding
  return decodedBytes > 0
}

export const validateImportManagedMediaFileReq = (value: unknown): ImportManagedMediaFileReq => {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['sourcePath', 'mimeType', 'originalFileName'], ['storage']) ||
    !isCanonicalAbsoluteFileSource(value.sourcePath) ||
    typeof value.mimeType !== 'string' ||
    !MIME_TYPE_PATTERN.test(value.mimeType) ||
    !isSafeOriginalFileName(value.originalFileName)
  ) {
    throw new ServiceValidationError('svcManagedMedia.importFile request')
  }
  const storage = validateManagedMediaStorage(value.storage)
  return {
    sourcePath: value.sourcePath,
    mimeType: value.mimeType.toLowerCase(),
    originalFileName: value.originalFileName,
    ...(storage ? { storage } : {})
  }
}

export const validateImportManagedMediaDataUrlReq = (
  value: unknown
): ImportManagedMediaDataUrlReq => {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ['dataUrl', 'originalFileName'], ['storage']) ||
    !validImportDataUrl(value.dataUrl) ||
    !isSafeOriginalFileName(value.originalFileName)
  ) {
    throw new ServiceValidationError('svcManagedMedia.importDataUrl request')
  }
  const storage = validateManagedMediaStorage(value.storage)
  return {
    dataUrl: value.dataUrl,
    originalFileName: value.originalFileName,
    ...(storage ? { storage } : {})
  }
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
    !hasAllowedKeys(value, ['dataUrl', 'metadata'], ['storage']) ||
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
  const storage = validateManagedMediaStorage(value.storage)
  return {
    dataUrl: value.dataUrl,
    metadata: {
      originalFileName: metadata.originalFileName,
      ...(metadata.sourceWidth !== undefined ? { sourceWidth: metadata.sourceWidth } : {}),
      ...(metadata.sourceHeight !== undefined ? { sourceHeight: metadata.sourceHeight } : {})
    },
    ...(storage ? { storage } : {})
  }
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
  if (
    !reference ||
    reference.kind !== 'managed' ||
    (value.transport !== 'request-data-url' && value.transport !== 'chunked-binary-v1')
  ) {
    throw new ServiceValidationError('svcManagedMedia.materializeForRequest request')
  }
  // Preserve the caller's selected transport through IPC validation. Collapsing
  // chunked requests to the legacy data-url variant silently defeats the bounded
  // binary transport and makes the response shape disagree with the request.
  return {
    reference,
    transport: value.transport as MaterializeManagedMediaForRequestReq['transport']
  }
}

export const validateMaterializeManagedMediaForRequestResp = (
  value: unknown
): MaterializeManagedMediaForRequestResp => {
  if (!isRecord(value) || typeof value.transport !== 'string') {
    throw new ServiceValidationError('svcManagedMedia.materializeForRequest response')
  }
  if (value.transport === 'request-data-url') {
    if (
      !hasExactKeys(value, ['transport', 'dataUrl', 'mimeType', 'sizeBytes']) ||
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
  if (value.transport === 'chunked-binary-v1') {
    if (
      !hasExactKeys(value, ['transport', 'reference', 'chunks']) ||
      !Array.isArray(value.chunks)
    ) {
      throw new ServiceValidationError('svcManagedMedia.materializeForRequest response')
    }
    try {
      const reference = validateBinaryChunkReference(value.reference)
      const chunks = validateBinaryChunkFrameSet(reference, value.chunks)
      return { transport: 'chunked-binary-v1', reference, chunks }
    } catch {
      throw new ServiceValidationError('svcManagedMedia.materializeForRequest response')
    }
  }
  throw new ServiceValidationError('svcManagedMedia.materializeForRequest response')
}

const validateUpdateReferenceSnapshotReq = (
  value: unknown
): UpdateManagedMediaReferenceSnapshotReq => {
  const hasCounts =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'referenceCounts')
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, ['version', 'complete', 'ids']) ||
      hasExactKeys(value, ['version', 'complete', 'ids', 'referenceCounts'])
    ) ||
    value.version !== 1 ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.ids) ||
    value.ids.length > 100_000 ||
    value.ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) ||
    (hasCounts &&
      (!isRecord(value.referenceCounts) ||
        Object.keys(value.referenceCounts).length > 100_000 ||
        Object.entries(value.referenceCounts).some(
          ([id, count]) =>
            !/^[a-f0-9]{64}$/u.test(id) ||
            typeof count !== 'number' ||
            !Number.isSafeInteger(count) ||
            count <= 0
        ) ||
        Object.keys(value.referenceCounts).some((id) => !(value.ids as string[]).includes(id))))
  ) {
    throw new ServiceValidationError('svcManagedMedia.updateReferenceSnapshot request')
  }
  const ids = [...new Set(value.ids as string[])]
  if (!hasCounts) return { version: 1, complete: value.complete, ids }
  const referenceCounts: Record<string, number> = {}
  for (const id of ids)
    referenceCounts[id] = (value.referenceCounts as Record<string, number>)[id] ?? 1
  return { version: 1, complete: value.complete, ids, referenceCounts }
}

const validateUpdateReferenceSnapshotResp = (
  value: unknown
): UpdateManagedMediaReferenceSnapshotResp => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'accepted']) ||
    value.version !== 1 ||
    value.accepted !== true
  ) {
    throw new ServiceValidationError('svcManagedMedia.updateReferenceSnapshot response')
  }
  return value as UpdateManagedMediaReferenceSnapshotResp
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
  },
  updateReferenceSnapshot: {
    type: 'unary',
    request: validateUpdateReferenceSnapshotReq,
    response: validateUpdateReferenceSnapshotResp
  }
}
