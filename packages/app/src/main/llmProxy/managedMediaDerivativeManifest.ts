import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The durable derivative manifest is shared by its producer and the cleanup
 * planner.  Keep the version and generation policies in one place so a new
 * producer cannot silently make a cleanup pass reject every derivative.
 */
export const MANAGED_MEDIA_DERIVATIVE_SCHEMA = 'magicpot.managed-media-derivative/v4' as const
export const MANAGED_MEDIA_DERIVATIVE_ENCODER_VERSION = 'canvas-thumbnail-sidecar/v2' as const
export const MANAGED_MEDIA_DERIVATIVE_ORIENTATION_POLICY = 'apply-exif-before-resize/v1' as const
export const MANAGED_MEDIA_DERIVATIVE_CROP_POLICY = 'crop-meaningful-transparent-border/v1' as const
export const MANAGED_MEDIA_DERIVATIVE_MAX_GENERATED_BYTES = 25 * 1024 * 1024

export const MANAGED_MEDIA_DERIVATIVE_MAX_EDGES = [256, 512, 1024, 2048] as const
export type ManagedMediaDerivativeMaxEdge = (typeof MANAGED_MEDIA_DERIVATIVE_MAX_EDGES)[number]
export type ManagedMediaDerivativeFormat = 'png' | 'webp' | 'jpeg'
export type ManagedMediaDerivativeMimeType = 'image/png' | 'image/webp' | 'image/jpeg'

export type ManagedMediaDerivativeManifest = Readonly<{
  schema: typeof MANAGED_MEDIA_DERIVATIVE_SCHEMA
  purpose: 'managed-media-derivative'
  identity: string
  originalSha256: string
  format: ManagedMediaDerivativeFormat
  maxEdge: ManagedMediaDerivativeMaxEdge
  relativePath: string
  mimeType: ManagedMediaDerivativeMimeType
  sizeBytes: number
  width: number
  height: number
  sha256: string
  localMediaUrl: string
  encoderVersion: typeof MANAGED_MEDIA_DERIVATIVE_ENCODER_VERSION
  orientationPolicy: typeof MANAGED_MEDIA_DERIVATIVE_ORIENTATION_POLICY
  cropPolicy: typeof MANAGED_MEDIA_DERIVATIVE_CROP_POLICY
}>

const MEDIA_ID = /^[a-f0-9]{64}$/u
const HASH = /^[a-f0-9]{64}$/u
const MAX_MANIFEST_BYTES = MANAGED_MEDIA_DERIVATIVE_MAX_GENERATED_BYTES

function extensionFor(format: ManagedMediaDerivativeFormat): 'png' | 'webp' | 'jpg' {
  return format === 'jpeg' ? 'jpg' : format
}

function expectedMime(format: ManagedMediaDerivativeFormat): ManagedMediaDerivativeMimeType {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}

function expectedRelativePath(
  originalSha256: string,
  identity: string,
  format: ManagedMediaDerivativeFormat
): string {
  return `derivatives/${originalSha256.slice(0, 2)}/${originalSha256}/${identity}/committed/image.${extensionFor(format)}`
}

function expectedLocalMediaUrl(root: string, relativePath: string): string {
  const absolute = path.resolve(root, ...relativePath.split('/'))
  return `local-media://${pathToFileURL(absolute).toString().slice('file://'.length)}`
}

/** The identity is content-addressed over every generation policy input. */
export function managedMediaDerivativeIdentityFor(
  originalSha256: string,
  maxEdge: ManagedMediaDerivativeMaxEdge,
  format: ManagedMediaDerivativeFormat
): string {
  return createHash('sha256')
    .update(
      `${originalSha256}\0${maxEdge}\0${format}\0${MANAGED_MEDIA_DERIVATIVE_ENCODER_VERSION}\0${MANAGED_MEDIA_DERIVATIVE_ORIENTATION_POLICY}\0${MANAGED_MEDIA_DERIVATIVE_CROP_POLICY}`
    )
    .digest('hex')
}

function fail(message: string): never {
  throw new Error(`invalid managed-media derivative manifest: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
}

/**
 * Parse the complete current producer record.  Unknown keys and legacy
 * versions are rejected deliberately: cleanup must leave an entire record in
 * place when it cannot establish that every field belongs to this producer.
 */
export function parseManagedMediaDerivativeManifest(
  value: unknown,
  options: Readonly<{ root: string; originalSha256: string; identity: string }>
): ManagedMediaDerivativeManifest {
  if (!isRecord(value)) fail('record must be a JSON object')
  const expectedKeys = [
    'schema',
    'purpose',
    'identity',
    'originalSha256',
    'format',
    'maxEdge',
    'relativePath',
    'mimeType',
    'sizeBytes',
    'width',
    'height',
    'sha256',
    'localMediaUrl',
    'encoderVersion',
    'orientationPolicy',
    'cropPolicy'
  ]
  const keys = Object.keys(value).sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys.slice().sort()[index])
  )
    fail('record has missing or unknown fields')

  const format = value.format
  if (format !== 'png' && format !== 'webp' && format !== 'jpeg') fail('format is unsupported')
  const maxEdge = value.maxEdge
  if (!MANAGED_MEDIA_DERIVATIVE_MAX_EDGES.includes(maxEdge as ManagedMediaDerivativeMaxEdge))
    fail('maxEdge is unsupported')
  if (!MEDIA_ID.test(options.originalSha256)) fail('original ID is invalid')
  if (value.originalSha256 !== options.originalSha256) fail('original ID does not match')
  if (typeof value.identity !== 'string' || !MEDIA_ID.test(value.identity))
    fail('identity is invalid')
  if (value.identity !== options.identity) fail('identity does not match its directory')
  if (
    managedMediaDerivativeIdentityFor(
      options.originalSha256,
      maxEdge as ManagedMediaDerivativeMaxEdge,
      format
    ) !== value.identity
  )
    fail('identity does not match generation policy')
  if (value.schema !== MANAGED_MEDIA_DERIVATIVE_SCHEMA) fail('schema is unsupported')
  if (value.purpose !== 'managed-media-derivative') fail('purpose is unsupported')
  if (value.encoderVersion !== MANAGED_MEDIA_DERIVATIVE_ENCODER_VERSION)
    fail('encoder version is unsupported')
  if (value.orientationPolicy !== MANAGED_MEDIA_DERIVATIVE_ORIENTATION_POLICY)
    fail('orientation policy is unsupported')
  if (value.cropPolicy !== MANAGED_MEDIA_DERIVATIVE_CROP_POLICY) fail('crop policy is unsupported')

  const relativePath = value.relativePath
  const expectedPath = expectedRelativePath(options.originalSha256, options.identity, format)
  if (
    typeof relativePath !== 'string' ||
    relativePath !== expectedPath ||
    relativePath.includes('\\') ||
    path.isAbsolute(relativePath)
  )
    fail('relative path is invalid')
  if (value.mimeType !== expectedMime(format)) fail('MIME type does not match format')
  if (!isPositiveSafeInteger(value.sizeBytes, MAX_MANIFEST_BYTES)) fail('size is invalid')
  if (!isPositiveSafeInteger(value.width, maxEdge as number)) fail('width is invalid')
  if (!isPositiveSafeInteger(value.height, maxEdge as number)) fail('height is invalid')
  if (typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) fail('content hash is invalid')
  if (
    typeof value.localMediaUrl !== 'string' ||
    value.localMediaUrl !== expectedLocalMediaUrl(options.root, relativePath)
  )
    fail('local media URL does not match path')

  return Object.freeze(value as ManagedMediaDerivativeManifest)
}
