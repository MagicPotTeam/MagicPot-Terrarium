import { Buffer } from 'node:buffer'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { types } from 'node:util'
import { inflate } from 'node:zlib'
import { inspectPng } from '../comfy/batchPng'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  type DecodedImage,
  type ImageMetadata,
  type TrustedImageDecoder
} from './imageValidation'

// Explicit main-only decoder, not automatically enabled by imageValidation or any service.
// Narrow implementation: RGBA8/non-interlaced PNG with IHDR/IDAT/IEND only. JPEG,
// palette, color profiles and other ancillary chunks are rejected, not approximated.
export const MAX_INFLIGHT_PNG_DECODES = 2
let activeDecodes = 0
const invalid = (): Error => new Error('INVALID_IMAGE')
const checkCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error('CANCELLED')
}
const prototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferOf = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!
const lengthOf = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!
const offsetOf = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')!.get!

function snapshot(input: Buffer): Buffer {
  if (
    types.isProxy(input) ||
    !types.isUint8Array(input) ||
    Object.getPrototypeOf(input) !== Buffer.prototype
  ) {
    throw invalid()
  }
  const storage: unknown = bufferOf.call(input)
  if (!types.isArrayBuffer(storage)) throw invalid()
  let view: Uint8Array
  try {
    view = new Uint8Array(storage, offsetOf.call(input), lengthOf.call(input))
  } catch {
    throw invalid()
  }
  if (!view.byteLength) throw invalid()
  if (view.byteLength > MAX_IMAGE_BYTES) throw new Error('TOO_LARGE')
  const bytes = Buffer.alloc(view.byteLength)
  bytes.set(view)
  return bytes
}

function compressedImage(bytes: Buffer, metadata: Readonly<ImageMetadata>): Buffer {
  if (metadata.format !== 'png') throw new Error('UNSUPPORTED_IMAGE')
  if (!inspectPng(bytes).valid) throw invalid()
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS ||
    width !== metadata.width ||
    height !== metadata.height
  ) {
    throw new Error('DIMENSIONS')
  }
  if (bytes[26] !== 0 || bytes[27] !== 0) throw invalid()
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0) {
    throw new Error('UNSUPPORTED_IMAGE')
  }
  // One bounded allocation; a file full of zero/tiny IDATs must not allocate a view per chunk.
  const compressed = Buffer.alloc(bytes.length)
  let compressedLength = 0
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const kind = bytes.toString('latin1', offset + 4, offset + 8)
    if (kind === 'IDAT') {
      bytes.copy(compressed, compressedLength, offset + 8, offset + 8 + length)
      compressedLength += length
    } else if (kind === 'IHDR') {
      if (offset !== 8) throw invalid()
    } else if (kind !== 'IEND') {
      throw new Error('UNSUPPORTED_IMAGE')
    }
    offset += length + 12
  }
  if (!compressedLength) throw invalid()
  return compressed.subarray(0, compressedLength)
}

function inflateExactly(compressed: Buffer, expectedLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // FINISH (the default) is intentional: do not permit truncated streams via SYNC_FLUSH.
    // info also proves the one zlib stream consumed all IDAT bytes: no suffix/second stream.
    inflate(compressed, { maxOutputLength: expectedLength, info: true }, (error, result) => {
      if (error) {
        reject(invalid())
        return
      }
      // Node's overload types do not distinguish info:true; both fields come from node:zlib.
      const decoded = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      if (
        !Buffer.isBuffer(decoded.buffer) ||
        decoded.buffer.length !== expectedLength ||
        decoded.engine.bytesWritten !== compressed.length
      ) {
        reject(invalid())
        return
      }
      resolve(decoded.buffer)
    })
  })
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft
  const a = Math.abs(prediction - left)
  const b = Math.abs(prediction - up)
  const c = Math.abs(prediction - upperLeft)
  return a <= b && a <= c ? left : b <= c ? up : upperLeft
}

/**
 * Real bounded zlib decode and PNG reconstruction, not header attestation. No file/network/
 * model access. Native zlib runs in the threadpool, not a process sandbox. A cancellation
 * discards the result but retains the module-wide capacity slot until zlib has settled.
 * The caller must still impose its overall operation deadline and provenance/consent.
 */
export const decodeBackgroundRemovalRgbaPng: TrustedImageDecoder = async (
  input,
  metadata,
  signal
): Promise<DecodedImage> => {
  checkCancelled(signal)
  if (activeDecodes >= MAX_INFLIGHT_PNG_DECODES) throw new Error('DECODER_BUSY')
  activeDecodes++
  try {
    const width = metadata.width
    const height = metadata.height
    const compressed = compressedImage(snapshot(input), { format: metadata.format, width, height })
    const stride = width * 4
    const inflated = await inflateExactly(compressed, (stride + 1) * height)
    checkCancelled(signal)
    const rgba = new Uint8Array(stride * height)
    for (let row = 0; row < height; row++) {
      if (row > 0 && row % 32 === 0) {
        await yieldToLoop()
        checkCancelled(signal)
      }
      const rowStart = row * stride
      const inputStart = row * (stride + 1)
      const filter = inflated[inputStart]
      if (filter > 4) throw invalid()
      for (let column = 0; column < stride; column++) {
        const left = column >= 4 ? rgba[rowStart + column - 4] : 0
        const up = row > 0 ? rgba[rowStart + column - stride] : 0
        const upperLeft = row > 0 && column >= 4 ? rgba[rowStart + column - stride - 4] : 0
        const prediction =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : paeth(left, up, upperLeft)
        rgba[rowStart + column] = (inflated[inputStart + 1 + column] + prediction) & 0xff
      }
    }
    checkCancelled(signal)
    return { width, height, rgba }
  } finally {
    activeDecodes--
  }
}
