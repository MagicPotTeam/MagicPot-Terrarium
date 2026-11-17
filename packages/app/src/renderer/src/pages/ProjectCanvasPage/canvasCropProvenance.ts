// packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasCropProvenance.ts
// Crop source records: which bytes a crop was measured on, and the one reader
// that may attest them. Size hints (sourceWidth/Height, the in-memory image)
// never prove anything on their own; only a record whose byte size, SHA-256
// and decoded pixel size match the source does.
import { loadImageFromSrc } from './canvasAssetIntakeHelpers'
import { getCanvasImageAssetSize, isCanvasImagePlaceholderAsset } from './canvasImageAssetUtils'
import { resolveAuthorizedCanvasLocalMediaSourceUrl } from './canvasLocalFileSource'
import { resolveCanvasLocalFilePathFromSource } from './canvasLocalImageSource'
import { sha256Hex } from './canvasSha256'
import type { CanvasImageCropSource, CanvasImageItem } from './types'

/** Encoded bytes above this are refused: bytes, decode and hash state are held at once. */
export const CANVAS_CROP_SOURCE_EVIDENCE_MAX_BYTES = 128 * 1024 * 1024

export type CanvasImageSourceEvidence = {
  sizeBytes: number
  sha256: string
  width: number
  height: number
  /** Decoded from the hashed bytes, never from the original URL. */
  image: HTMLImageElement
}

export type CanvasImageSourceEvidenceOptions = {
  maxBytes: number
}

type CanvasCrop = NonNullable<CanvasImageItem['crop']>

const CROP_SOURCE_RECORD_KEYS = ['height', 'origin', 'sha256', 'sizeBytes', 'version', 'width']
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isCropSourceRecordValid(value: unknown): value is CanvasImageCropSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Object.keys(value).sort()
  if (
    keys.length !== CROP_SOURCE_RECORD_KEYS.length ||
    keys.some((key, index) => key !== CROP_SOURCE_RECORD_KEYS[index])
  ) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record.version === 1 &&
    (record.origin === 'confirm' || record.origin === 'reopen') &&
    isPositiveSafeInteger(record.width) &&
    isPositiveSafeInteger(record.height) &&
    isPositiveSafeInteger(record.sizeBytes) &&
    typeof record.sha256 === 'string' &&
    SHA256_HEX_PATTERN.test(record.sha256)
  )
}

/**
 * Drops a `cropSource` that does not have the exact record shape. The crop
 * itself is kept and stays unverified: sinks refuse it until a record proves it.
 * Stored and imported items pass through here, since the import preflight has
 * no allow-list on item keys.
 */
export function dropMalformedCropSource<T extends object>(item: T): T {
  if (!Object.prototype.hasOwnProperty.call(item, 'cropSource')) return item
  const { cropSource, ...rest } = item as T & { cropSource?: unknown }
  return isCropSourceRecordValid(cropSource) ? item : (rest as T)
}

/**
 * The persisted form of an image's crop: a full-image crop confirmed on
 * recorded bytes (isConfirmedIdentityCrop) is dropped together with its
 * record; any other crop is kept verbatim, with its record only when the
 * record has the exact shape. Size hints alone never remove a crop.
 */
export function toPersistedCropFields<T extends CanvasImageItem>(item: T): T {
  if (isConfirmedIdentityCrop(item)) {
    const { crop: _identityCrop, cropSource: _identityCropSource, ...uncropped } = item
    return uncropped as T
  }
  return dropMalformedCropSource(item)
}

function isCropInsideRecord(crop: CanvasCrop | undefined, record: CanvasImageCropSource): boolean {
  if (!crop) return false
  const { x, y, width, height } = crop
  if (
    ![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return false
  }
  return (
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= record.width &&
    y + height <= record.height
  )
}

function isSourceSizeAbsentOrEqual(item: CanvasImageItem, record: CanvasImageCropSource): boolean {
  return (
    (item.sourceWidth === undefined || item.sourceWidth === record.width) &&
    (item.sourceHeight === undefined || item.sourceHeight === record.height)
  )
}

/** A crop that a sink may verify against its source: never proof by itself. */
export function hasVerifiableCrop(item: CanvasImageItem): boolean {
  const record = item.cropSource
  return (
    isCropSourceRecordValid(record) &&
    isSourceSizeAbsentOrEqual(item, record) &&
    isCropInsideRecord(item.crop, record)
  )
}

/** Byte size, hash and decoded pixel size of the evidence all equal the record. */
export function matchesCropSource(
  item: CanvasImageItem,
  evidence: Pick<CanvasImageSourceEvidence, 'sizeBytes' | 'sha256' | 'width' | 'height'>
): boolean {
  const record = item.cropSource
  return (
    isCropSourceRecordValid(record) &&
    record.sizeBytes === evidence.sizeBytes &&
    record.sha256 === evidence.sha256 &&
    record.width === evidence.width &&
    record.height === evidence.height
  )
}

/**
 * A full-image crop confirmed on recorded bytes. The explicit source size must
 * be present and equal: without it the display reads the crop in the space of
 * the loaded (possibly thumbnail) image, so removing the crop could widen it.
 */
export function isConfirmedIdentityCrop(item: CanvasImageItem): boolean {
  const record = item.cropSource
  if (!isCropSourceRecordValid(record) || record.origin !== 'confirm') return false
  if (item.sourceWidth !== record.width || item.sourceHeight !== record.height) return false
  const crop = item.crop
  return Boolean(
    crop &&
    crop.x === 0 &&
    crop.y === 0 &&
    crop.width === record.width &&
    crop.height === record.height
  )
}

/** The pixel space the crop overlay measured in: explicit source size, else the in-memory image. */
export function getCanvasCropOverlaySpace(
  item: CanvasImageItem
): { width: number; height: number } | null {
  const imageSize = getCanvasImageAssetSize(item.image)
  const width = item.sourceWidth || imageSize.width
  const height = item.sourceHeight || imageSize.height
  return isPositiveSafeInteger(width) && isPositiveSafeInteger(height) ? { width, height } : null
}

/**
 * A confirmed crop in the pixel space of the attested source. The overlay
 * measured it in getCanvasCropOverlaySpace(item). When that space equals the
 * source, the crop is returned as it is. When there is no stored source size
 * and the in-memory image is a smaller copy of the source with the same aspect
 * (a thumbnail the board was hydrated from), the crop is scaled into the
 * source space and rounded to whole source pixels: once the source size is
 * stored with it, every display path reads it against that size and shows the
 * same region of the thumbnail. Null when the two spaces cannot be related, so
 * the crop gets no record.
 */
export function resolveCanvasCropInSourceSpace(
  item: CanvasImageItem,
  crop: CanvasCrop,
  cropSpace: { width: number; height: number },
  source: { width: number; height: number }
): { crop: CanvasCrop; scaled: boolean } | null {
  if (source.width === cropSpace.width && source.height === cropSpace.height) {
    return { crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, scaled: false }
  }
  // An explicit source size is what the overlay measured in: it must match.
  if (item.sourceWidth !== undefined || item.sourceHeight !== undefined) return null
  if (!item.image || isCanvasImagePlaceholderAsset(item.image)) return null
  const imageSize = getCanvasImageAssetSize(item.image)
  if (imageSize.width !== cropSpace.width || imageSize.height !== cropSpace.height) return null
  if (
    !isPositiveSafeInteger(source.width) ||
    !isPositiveSafeInteger(source.height) ||
    source.width < cropSpace.width ||
    source.height < cropSpace.height
  ) {
    return null
  }
  // A thumbnail keeps the aspect up to the rounding of its own pixel size.
  if (
    Math.abs(source.width * cropSpace.height - cropSpace.width * source.height) >
    Math.max(source.width, source.height)
  ) {
    return null
  }
  const values = [crop.x, crop.y, crop.width, crop.height]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  const scaleX = source.width / cropSpace.width
  const scaleY = source.height / cropSpace.height
  const toSource = (value: number, scale: number, max: number) =>
    Math.min(max, Math.max(0, Math.round(value * scale)))
  const left = toSource(crop.x, scaleX, source.width)
  const top = toSource(crop.y, scaleY, source.height)
  const right = toSource(crop.x + crop.width, scaleX, source.width)
  const bottom = toSource(crop.y + crop.height, scaleY, source.height)
  if (right <= left || bottom <= top) return null
  return { crop: { x: left, y: top, width: right - left, height: bottom - top }, scaled: true }
}

export function createCropSourceRecord(
  evidence: Pick<CanvasImageSourceEvidence, 'sizeBytes' | 'sha256' | 'width' | 'height'>,
  origin: CanvasImageCropSource['origin']
): CanvasImageCropSource | null {
  const record: CanvasImageCropSource = {
    version: 1,
    origin,
    width: evidence.width,
    height: evidence.height,
    sizeBytes: evidence.sizeBytes,
    sha256: evidence.sha256
  }
  return isCropSourceRecordValid(record) ? record : null
}

type SourceBytes = { blob: Blob; bytes?: Uint8Array }

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function decodeBase64DataUrl(src: string, maxBytes: number): SourceBytes | null {
  const comma = src.indexOf(',')
  if (comma < 0) return null
  const header = src.slice('data:'.length, comma)
  if (!/;base64$/i.test(header)) return null
  const payload = src.slice(comma + 1)
  if (Math.floor((payload.length * 3) / 4) > maxBytes + 2) return null
  let binary: string
  try {
    binary = atob(payload)
  } catch {
    return null
  }
  if (binary.length === 0 || binary.length > maxBytes) return null
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const mimeType = header.slice(0, -';base64'.length).split(';')[0]?.trim() || ''
  return { blob: new Blob([bytes], { type: mimeType }), bytes }
}

async function fetchBoundedBlob(
  url: string,
  maxBytes: number,
  isCurrent: () => boolean
): Promise<Blob | null> {
  if (typeof fetch !== 'function') return null
  const response = await fetch(url)
  if (!isCurrent()) return null
  if (!response.ok && response.status !== 0) return null
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null
  const blob = await response.blob()
  if (!isCurrent() || blob.size === 0 || blob.size > maxBytes) return null
  return blob
}

async function readSourceBytes(
  src: string,
  isCurrent: () => boolean,
  maxBytes: number
): Promise<SourceBytes | null> {
  const normalized = src.trim()
  if (/^data:/i.test(normalized)) return decodeBase64DataUrl(normalized, maxBytes)
  if (/^blob:/i.test(normalized)) {
    const blob = await fetchBoundedBlob(normalized, maxBytes, isCurrent)
    return blob ? { blob } : null
  }
  if (
    /^(local-media|file):/i.test(normalized) &&
    resolveCanvasLocalFilePathFromSource(normalized)
  ) {
    // Files the user did not ask to send: only the authorized local-media path, and no path logs.
    const authorized = await resolveAuthorizedCanvasLocalMediaSourceUrl(normalized)
    if (!authorized || !isCurrent()) return null
    const blob = await fetchBoundedBlob(authorized, maxBytes, isCurrent)
    return blob ? { blob } : null
  }
  return null
}

/**
 * Reads the source bytes once, hashes them and decodes those same bytes (object
 * URL of the bytes, never the original URL). The decode starts before the hash
 * settles. Resolves null on any failure, refusal or when isCurrent() turns false.
 */
export async function readCanvasImageSourceEvidence(
  src: string,
  isCurrent: () => boolean,
  { maxBytes }: CanvasImageSourceEvidenceOptions
): Promise<CanvasImageSourceEvidence | null> {
  if (typeof src !== 'string' || !isCurrent()) return null
  let source: SourceBytes | null
  try {
    source = await readSourceBytes(src, isCurrent, maxBytes)
  } catch {
    return null
  }
  if (!source || !isCurrent()) return null

  let objectUrl: string
  try {
    objectUrl = URL.createObjectURL(source.blob)
  } catch {
    return null
  }
  try {
    const decoded = loadImageFromSrc(objectUrl)
    const sourceBlob = source.blob
    const knownBytes = source.bytes
    const hashed = (async () =>
      sha256Hex(knownBytes ?? new Uint8Array(await readBlobArrayBuffer(sourceBlob))))()
    const [decodeResult, hashResult] = await Promise.allSettled([decoded, hashed])
    if (!isCurrent()) return null
    if (decodeResult.status !== 'fulfilled' || hashResult.status !== 'fulfilled') return null
    const { img, width, height } = decodeResult.value
    const sizeBytes = source.blob.size
    if (
      !isPositiveSafeInteger(width) ||
      !isPositiveSafeInteger(height) ||
      !isPositiveSafeInteger(sizeBytes) ||
      !SHA256_HEX_PATTERN.test(hashResult.value)
    ) {
      return null
    }
    return { sizeBytes, sha256: hashResult.value, width, height, image: img }
  } finally {
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      // A failed revoke leaves nothing to release here.
    }
  }
}
