import { z } from 'zod'

export const HOST_CONTEXT_IMAGE_MAX_BYTES = 24 * 1024
export const HOST_CONTEXT_IMAGE_MAX_DIMENSION = 256
export const HOST_CONTEXT_IMAGE_TOKEN_BUDGET = 4096
const MAX_BASE64_LENGTH = 32 * 1024
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const decodeCanonicalBase64 = (value: string): Uint8Array | undefined => {
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/.test(value)
  )
    return undefined
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const last = BASE64_ALPHABET.indexOf(value[value.length - padding - 1])
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return undefined
  const bytes = new Uint8Array((value.length / 4) * 3 - padding)
  let cursor = 0
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset])
    const b = BASE64_ALPHABET.indexOf(value[offset + 1])
    const c = BASE64_ALPHABET.indexOf(value[offset + 2])
    const d = BASE64_ALPHABET.indexOf(value[offset + 3])
    bytes[cursor++] = (a << 2) | (b >> 4)
    if (cursor < bytes.length) bytes[cursor++] = (b << 4) | (c >> 2)
    if (cursor < bytes.length) bytes[cursor++] = (c << 6) | d
  }
  return bytes
}

// Validate bounded PNG structure and checksums here, never decode pixels in the shared boundary.
const pngDimensions = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes.length < 57 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value))
    return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let dimensions: { width: number; height: number } | undefined
  let imageData = false
  let endedImageData = false
  let palette = false
  let colorType = -1
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const end = offset + length + 12
    if (end > bytes.length) return undefined
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) !== 0) return undefined
    let crc = 0xffffffff
    for (let index = offset + 4; index < end - 4; index++) {
      crc ^= bytes[index]
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end - 4, false)) return undefined
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) return undefined
      const width = view.getUint32(offset + 8, false)
      const height = view.getUint32(offset + 12, false)
      const depth = bytes[offset + 16]
      colorType = bytes[offset + 17]
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
      }
      if (
        width < 1 ||
        height < 1 ||
        width > HOST_CONTEXT_IMAGE_MAX_DIMENSION ||
        height > HOST_CONTEXT_IMAGE_MAX_DIMENSION ||
        !depths[colorType]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] > 1
      )
        return undefined
      dimensions = { width, height }
    } else if (type === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) {
      return undefined
    } else if (type === 'PLTE') {
      if (
        palette ||
        imageData ||
        colorType === 0 ||
        colorType === 4 ||
        length < 3 ||
        length > 768 ||
        length % 3 !== 0
      )
        return undefined
      palette = true
    } else if (type === 'IDAT') {
      if (endedImageData || (colorType === 3 && !palette)) return undefined
      if (length > 0) imageData = true
    } else if (type === 'IEND') {
      return length === 0 && imageData && end === bytes.length ? dimensions : undefined
    } else {
      if ((bytes[offset + 4] & 32) === 0) return undefined
      if (imageData) endedImageData = true
    }
    offset = end
  }
  return undefined
}

export const hostContextImageSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('host-context-image'),
    captureId: z
      .string()
      .length(32)
      .regex(/^[a-f0-9]{32}$/),
    targetId: z.string().min(1).max(128),
    mimeType: z.literal('image/png'),
    width: z.number().int().min(1).max(HOST_CONTEXT_IMAGE_MAX_DIMENSION),
    height: z.number().int().min(1).max(HOST_CONTEXT_IMAGE_MAX_DIMENSION),
    sizeBytes: z.number().int().min(1).max(HOST_CONTEXT_IMAGE_MAX_BYTES),
    sha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    bytesBase64: z.string().min(1).max(MAX_BASE64_LENGTH)
  })
  .strict()
  .superRefine((image, ctx) => {
    const bytes = decodeCanonicalBase64(image.bytesBase64)
    const dimensions = bytes && pngDimensions(bytes)
    if (
      !bytes ||
      bytes.length !== image.sizeBytes ||
      !dimensions ||
      dimensions.width !== image.width ||
      dimensions.height !== image.height
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded context PNG' })
  })

export type HostContextImage = z.output<typeof hostContextImageSchema>
export type HostContextImageSummary = Omit<HostContextImage, 'bytesBase64'>

/** Metadata only; image bytes belong solely to the separately approved input attachment. */
export function contextImageSummary(image: HostContextImage): HostContextImageSummary {
  return {
    version: image.version,
    kind: image.kind,
    captureId: image.captureId,
    targetId: image.targetId,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    sizeBytes: image.sizeBytes,
    sha256: image.sha256
  }
}
