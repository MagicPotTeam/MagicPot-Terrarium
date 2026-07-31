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

export type ManagedMediaSvc = {
  ensureDerivative(req: EnsureManagedMediaDerivativeReq): Promise<EnsureManagedMediaDerivativeResp>
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

export const managedMediaSvcDef: ServiceDefSheet<ManagedMediaSvc> = {
  ensureDerivative: {
    type: 'unary',
    request: validateEnsureManagedMediaDerivativeReq,
    response: validateEnsureManagedMediaDerivativeResp
  }
}
