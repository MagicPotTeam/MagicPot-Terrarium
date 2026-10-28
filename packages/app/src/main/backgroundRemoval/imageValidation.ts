import { Buffer } from 'node:buffer'
import { types } from 'node:util'
import { inspectPng } from '../comfy/batchPng'

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 4096
export const MAX_IMAGE_PIXELS = 4_194_304
const MAX_JPEG_HEADER_BYTES = 256 * 1024
const MAX_JPEG_SEGMENTS = 1024

export type ImageValidationError =
  | 'INVALID_IMAGE'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_IMAGE'
  | 'DIMENSIONS'
  | 'INVALID_ALPHA'
  | 'CANCELLED'
  | 'DECODER_UNAVAILABLE'

export type ImageDimensions = { width: number; height: number }
export type ImageMetadata = ImageDimensions & { format: 'png' | 'jpeg' }
export type DecodedImage = ImageDimensions & { rgba: Uint8Array }

/**
 * Trusted main-process adapter, never a renderer/provider-supplied callback. It must
 * fully decode one still image, reject corrupt/truncated compressed data, and return
 * unrotated, unresized, 8-bit RGBA pixels. Metadata is a bound, not a decode result.
 * There is deliberately no default decoder. This is not a sandbox for hostile codecs
 * or arbitrary in-process objects; codec resource limits/isolation belong to the adapter.
 * In particular, promise settlement and decoded result properties must be trustworthy.
 */
export type TrustedImageDecoder = (
  bytes: Buffer,
  metadata: Readonly<ImageMetadata>,
  signal?: AbortSignal
) => Promise<DecodedImage>

export type ImageValidationOptions = {
  decoder?: TrustedImageDecoder
  signal?: AbortSignal
}

export type ValidatedImage = ImageMetadata & { bytes: Buffer; rgba: Uint8Array }
type Failure = { ok: false; error: ImageValidationError }
type Checked<T> = { ok: true; value: T } | Failure
export type ImageValidationResult = { ok: true; image: ValidatedImage } | Failure
type StaticImage = ImageMetadata & { hasAlpha: boolean }

const failure = (error: ImageValidationError): Failure => ({ ok: false, error })
const invalid = (): Failure => failure('INVALID_IMAGE')

function validDimensions(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  )
}

// Use intrinsic accessors, not shadowable Buffer properties or user coercion hooks.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const storageOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!

function ordinaryView(value: Uint8Array): Uint8Array | undefined {
  if (types.isProxy(value) || !types.isUint8Array(value)) return undefined
  const storage: unknown = storageOf.call(value)
  if (!types.isArrayBuffer(storage)) return undefined // Includes SharedArrayBuffer rejection.
  return new Uint8Array(storage, offsetOf.call(value), lengthOf.call(value))
}

function copyBuffer(view: Uint8Array): Buffer {
  // Unpooled storage also prevents unrelated buffers sharing the returned ArrayBuffer.
  const copy = Buffer.alloc(view.byteLength)
  copy.set(view)
  return copy
}

function snapshotInput(bytes: Buffer): Checked<Buffer> {
  try {
    // Only ordinary main Buffers: do not traverse arbitrary/proxied prototype chains.
    if (
      types.isProxy(bytes) ||
      !types.isUint8Array(bytes) ||
      Object.getPrototypeOf(bytes) !== Buffer.prototype ||
      !Buffer.isBuffer(bytes)
    ) {
      return invalid()
    }
    const view = ordinaryView(bytes)
    if (!view || view.byteLength === 0) return invalid()
    if (view.byteLength > MAX_IMAGE_BYTES) return failure('TOO_LARGE')
    return { ok: true, value: copyBuffer(view) }
  } catch {
    return invalid()
  }
}

/**
 * Conservative PNG subset: IHDR, optional PLTE/tRNS, consecutive IDAT, IEND.
 * Other ancillary/extension chunks fail closed rather than relying on an incomplete
 * metadata parser (including APNG). inspectPng supplies bounded chunk walking + CRC;
 * the checks below add IHDR semantics, uniqueness, ordering and palette/alpha rules.
 * Decompression, filters, interlacing and sample validity still require the decoder.
 */
function inspectStillPng(bytes: Buffer): Checked<StaticImage> {
  if (!inspectPng(bytes).valid) return invalid()
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!validDimensions(width, height)) return failure('DIMENSIONS')
  const depth = bytes[24]
  const color = bytes[25]
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  }
  if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
    return invalid()
  }
  let paletteEntries = 0
  let transparency = false
  let hasIdat = false
  let compressedLength = 0
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const start = offset + 8
    const type = bytes.toString('latin1', offset + 4, start)
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return invalid()
    switch (type) {
      case 'IHDR':
        if (offset !== 8) return invalid()
        break
      case 'PLTE':
        if (
          paletteEntries ||
          transparency ||
          hasIdat ||
          color === 0 ||
          color === 4 ||
          length === 0 ||
          length % 3 !== 0 ||
          length > 768 ||
          (color === 3 && length / 3 > 2 ** depth)
        ) {
          return invalid()
        }
        paletteEntries = length / 3
        break
      case 'tRNS': {
        if (transparency || hasIdat) return invalid()
        if (color === 3) {
          if (!paletteEntries || length === 0 || length > paletteEntries) return invalid()
        } else if (color === 0 || color === 2) {
          if (length !== (color === 0 ? 2 : 6)) return invalid()
          for (let index = start; index < start + length; index += 2) {
            if (bytes.readUInt16BE(index) >= 2 ** depth) return invalid()
          }
        } else {
          return invalid()
        }
        transparency = true
        break
      }
      case 'IDAT':
        if (color === 3 && !paletteEntries) return invalid()
        hasIdat = true
        compressedLength += length
        break
      case 'IEND':
        if (!compressedLength) return invalid()
        return {
          ok: true,
          value: {
            format: 'png',
            width,
            height,
            hasAlpha: color === 4 || color === 6 || transparency
          }
        }
      default:
        return failure('UNSUPPORTED_IMAGE')
    }
    offset = start + length + 4
  }
  return invalid()
}

type JpegComponent = { id: number; quantization: number }

function readQuantization(bytes: Buffer, start: number, end: number, tables: Set<number>): boolean {
  if (start === end) return false
  while (start < end) {
    const table = bytes[start++]
    // Only 8-bit baseline quantization tables are supported.
    if (table > 3 || start + 64 > end) return false
    for (let index = start; index < start + 64; index++) {
      if (bytes[index] === 0) return false
    }
    tables.add(table)
    start += 64
  }
  return start === end
}

function readHuffman(bytes: Buffer, start: number, end: number, tables: Set<number>): boolean {
  if (start === end) return false
  while (start < end) {
    const table = bytes[start++]
    if ((table & 0xee) !== 0 || start + 16 > end) return false
    let count = 0
    let available = 1
    for (let index = start; index < start + 16; index++) {
      count += bytes[index]
      available = available * 2 - bytes[index]
      if (available < 0) return false
    }
    start += 16
    // JPEG reserves the all-ones code; an exactly full tree is invalid as well.
    if (!count || count > 256 || !available || start + count > end) return false
    const symbols = new Set<number>()
    for (let index = start; index < start + count; index++) {
      const symbol = bytes[index]
      if (symbols.has(symbol)) return false
      symbols.add(symbol)
      if (table < 0x10) {
        if (symbol > 11) return false
      } else if ((symbol & 15) > 10 || ((symbol & 15) === 0 && symbol !== 0 && symbol !== 0xf0)) {
        return false
      }
    }
    tables.add(table)
    start += count
  }
  return start === end
}

function completeJpegScan(bytes: Buffer, offset: number, restartInterval: number): boolean {
  let dataSinceRestart = 0
  let nextRestart = 0
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) {
      dataSinceRestart++
      continue
    }
    const markerStart = offset
    while (bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return false
    const marker = bytes[offset++]
    if (marker === 0) {
      if (offset !== markerStart + 1) return false
      dataSinceRestart++
    } else if (marker >= 0xd0 && marker <= 0xd7) {
      if (!restartInterval || !dataSinceRestart || marker !== 0xd0 + nextRestart) return false
      nextRestart = (nextRestart + 1) % 8
      dataSinceRestart = 0
    } else {
      // Exactly one scan/image, EOI at EOF: no concatenation, late metadata or DNL.
      return marker === 0xd9 && offset === bytes.length && dataSinceRestart > 0
    }
  }
  return false
}

/**
 * Bounded single-scan, 8-bit baseline Huffman JPEG subset (one or three components).
 * Progressive, arithmetic, hierarchical and multi-scan JPEG are not accepted here.
 * APP/COM payloads are opaque bounded metadata; MPF APP2 is explicitly forbidden.
 * Entropy marker framing is checked, but only the trusted decoder can validate MCUs.
 */
function inspectStillJpeg(bytes: Buffer): Checked<StaticImage> {
  let offset = 2
  let headerBytes = 2
  let segmentCount = 0
  let dimensions: ImageDimensions | undefined
  let components: JpegComponent[] = []
  let restartInterval = 0
  let hasRestartInterval = false
  const quantization = new Set<number>()
  const huffman = new Set<number>()
  while (offset < bytes.length) {
    const markerStart = offset
    if (++segmentCount > MAX_JPEG_SEGMENTS) return failure('TOO_LARGE')
    if (bytes[offset++] !== 0xff) return invalid()
    while (bytes[offset] === 0xff) {
      offset++
      if (headerBytes + offset - markerStart > MAX_JPEG_HEADER_BYTES) return failure('TOO_LARGE')
    }
    const marker = bytes[offset++]
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 1 ||
      (marker >= 0xd0 && marker <= 0xd9) ||
      offset + 2 > bytes.length
    ) {
      return invalid()
    }
    const length = bytes.readUInt16BE(offset)
    const start = offset + 2
    const end = offset + length
    if (length < 2 || end > bytes.length) return invalid()
    headerBytes += end - markerStart
    if (headerBytes > MAX_JPEG_HEADER_BYTES) return failure('TOO_LARGE')
    if (marker === 0xc0) {
      if (dimensions || end - start < 6) return invalid()
      const height = bytes.readUInt16BE(start + 1)
      const width = bytes.readUInt16BE(start + 3)
      if (!validDimensions(width, height)) return failure('DIMENSIONS')
      const count = bytes[start + 5]
      if (end - start !== 6 + 3 * count || bytes[start] !== 8) return invalid()
      if (count !== 1 && count !== 3) return failure('UNSUPPORTED_IMAGE')
      const ids = new Set<number>()
      let blocks = 0
      components = []
      for (let index = start + 6; index < end; index += 3) {
        const id = bytes[index]
        const horizontal = bytes[index + 1] >>> 4
        const vertical = bytes[index + 1] & 15
        const table = bytes[index + 2]
        if (
          ids.has(id) ||
          !horizontal ||
          horizontal > 4 ||
          !vertical ||
          vertical > 4 ||
          table > 3
        ) {
          return invalid()
        }
        ids.add(id)
        blocks += horizontal * vertical
        components.push({ id, quantization: table })
      }
      if (blocks > 10) return invalid()
      dimensions = { width, height }
    } else if (marker === 0xdb) {
      if (!readQuantization(bytes, start, end, quantization)) return invalid()
    } else if (marker === 0xc4) {
      if (!readHuffman(bytes, start, end, huffman)) return invalid()
    } else if (marker === 0xdd) {
      if (hasRestartInterval || end - start !== 2) return invalid()
      hasRestartInterval = true
      restartInterval = bytes.readUInt16BE(start)
    } else if (marker === 0xda) {
      if (!dimensions || end - start !== 4 + 2 * components.length) return invalid()
      if (bytes[start] !== components.length) return invalid()
      const ids = new Set<number>()
      for (let index = start + 1; index < end - 3; index += 2) {
        const id = bytes[index]
        const component = components.find((item) => item.id === id)
        const dc = bytes[index + 1] >>> 4
        const ac = bytes[index + 1] & 15
        if (
          !component ||
          ids.has(id) ||
          !quantization.has(component.quantization) ||
          dc > 1 ||
          ac > 1 ||
          !huffman.has(dc) ||
          !huffman.has(0x10 | ac)
        ) {
          return invalid()
        }
        ids.add(id)
      }
      if (bytes[end - 3] !== 0 || bytes[end - 2] !== 63 || bytes[end - 1] !== 0) return invalid()
      if (!completeJpegScan(bytes, end, restartInterval)) return invalid()
      return { ok: true, value: { format: 'jpeg', ...dimensions, hasAlpha: false } }
    } else if (marker >= 0xe0 && marker <= 0xef) {
      if (
        marker === 0xe2 &&
        end - start >= 4 &&
        bytes.toString('latin1', start, start + 4) === 'MPF\0'
      ) {
        return failure('UNSUPPORTED_IMAGE')
      }
    } else if (marker !== 0xfe) {
      return failure('UNSUPPORTED_IMAGE')
    }
    offset = end
  }
  return invalid()
}

function inspectStillImage(bytes: Buffer): Checked<StaticImage> {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return inspectStillPng(bytes)
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectStillJpeg(bytes)
  return failure('UNSUPPORTED_IMAGE')
}

async function validate(
  input: Buffer,
  options: ImageValidationOptions,
  expected?: ImageDimensions
): Promise<ImageValidationResult> {
  const { decoder, signal } = options
  if (signal?.aborted) return failure('CANCELLED')
  const snapshot = snapshotInput(input)
  if (!snapshot.ok) return snapshot
  const bytes = snapshot.value
  const inspection = inspectStillImage(bytes)
  if (!inspection.ok) return inspection
  const { format, width, height, hasAlpha } = inspection.value
  if (expected) {
    if (format !== 'png') return failure('UNSUPPORTED_IMAGE')
    if (
      !validDimensions(expected.width, expected.height) ||
      width !== expected.width ||
      height !== expected.height
    ) {
      return failure('DIMENSIONS')
    }
    if (!hasAlpha) return failure('INVALID_ALPHA')
  }
  if (typeof decoder !== 'function' || types.isProxy(decoder)) return failure('DECODER_UNAVAILABLE')
  try {
    const decoderBytes = copyBuffer(bytes)
    const metadata = Object.freeze({ format, width, height })
    const decoded = await decoder(decoderBytes, metadata, signal)
    if (signal?.aborted) return failure('CANCELLED')
    if (!bytes.equals(decoderBytes)) return invalid()
    if (!decoded || typeof decoded !== 'object' || types.isProxy(decoded)) return invalid()
    if (decoded.width !== width || decoded.height !== height) return failure('DIMENSIONS')
    const view = ordinaryView(decoded.rgba)
    if (!view || view.byteLength !== width * height * 4) return invalid()
    const rgba = new Uint8Array(view)
    if (expected) {
      let nonzero = false
      let nonopaque = false
      for (let index = 3; index < rgba.length; index += 4) {
        nonzero ||= rgba[index] > 0
        nonopaque ||= rgba[index] < 255
      }
      if (!nonzero || !nonopaque) return failure('INVALID_ALPHA')
    }
    return { ok: true, image: { format, width, height, bytes, rgba } }
  } catch {
    return signal?.aborted ? failure('CANCELLED') : invalid()
  }
}

/**
 * Call only with a main-owned Buffer obtained via a separately authorized read.
 * Byte ownership/provenance, file integrity, receipts and IPC are not established here.
 * Successful encoded and RGBA bytes are detached copies; callers own their mutability.
 * Options/signals/expected dimensions are trusted main objects. Cancellation discards
 * late decode results, but cannot interrupt a decoder that ignores its signal or blocks.
 */
export function validateBackgroundRemovalInput(
  bytes: Buffer,
  options: ImageValidationOptions = {}
): Promise<ImageValidationResult> {
  return validate(bytes, options)
}

/** Exact input dimensions, no crop/resize. Alpha checks do NOT establish segmentation quality. */
export function validateBackgroundRemovalOutput(
  bytes: Buffer,
  expected: ImageDimensions,
  options: ImageValidationOptions = {}
): Promise<ImageValidationResult> {
  if (!expected || typeof expected !== 'object' || types.isProxy(expected)) {
    return Promise.resolve(failure('DIMENSIONS'))
  }
  // Capture the main-owned dimensions before any asynchronous decoder work.
  return validate(bytes, options, { width: expected.width, height: expected.height })
}
