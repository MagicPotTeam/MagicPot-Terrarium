/**
 * Image dimensions read from the first bytes of a file, so the composer does not decode a
 * whole picked image only to learn its size. It answers only where the header gives exactly
 * what the browser would report as naturalWidth / naturalHeight; anything that could make
 * them differ (EXIF orientation or density in JPEG, an eXIf chunk in PNG, EXIF in WebP, GIF
 * frames larger than the screen) returns null and the caller decodes as before.
 */

export type ChatImageHeaderDimensions = { sourceWidth: number; sourceHeight: number }

/** Enough for a JPEG whose start-of-frame follows large metadata segments. */
export const CHAT_IMAGE_HEADER_READ_BYTES = 256 * 1024

const MAX_DIMENSION = 0x7fffffff

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (offset < 0 || offset + text.length > bytes.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

const u32be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) >>> 0) +
  (bytes[offset + 1] << 16) +
  (bytes[offset + 2] << 8) +
  bytes[offset + 3]

const result = (width: number, height: number): ChatImageHeaderDimensions | null =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_DIMENSION &&
  height <= MAX_DIMENSION
    ? { sourceWidth: width, sourceHeight: height }
    : null

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const parsePng = (bytes: Uint8Array): ChatImageHeaderDimensions | null => {
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return null
  }
  if (u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return null
  const dimensions = result(u32be(bytes, 16), u32be(bytes, 20))
  // Walk the chunks before the image data: an eXIf chunk may carry an orientation.
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset)
    if (ascii(bytes, offset + 4, 'eXIf')) return null
    if (ascii(bytes, offset + 4, 'IDAT')) return dimensions
    offset += 12 + length
  }
  // The image data was not reached within the bytes read: not sure, decode instead.
  return null
}

const parseJpeg = (bytes: Uint8Array): ChatImageHeaderDimensions | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2) return null
    // EXIF can carry an orientation or a density the browser applies: decode instead.
    if (marker === 0xe1 && ascii(bytes, offset + 4, 'Exif')) return null
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length || length < 7) return null
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6]
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8]
      return result(width, height)
    }
    offset += 2 + length
  }
  return null
}

const parseWebp = (bytes: Uint8Array): ChatImageHeaderDimensions | null => {
  if (bytes.length < 30 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null
  if (ascii(bytes, 12, 'VP8X')) {
    // Flags: 0x08 = EXIF metadata present.
    if (bytes[20] & 0x08) return null
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    return result(width, height)
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const b0 = bytes[21]
    const b1 = bytes[22]
    const b2 = bytes[23]
    const b3 = bytes[24]
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return result(width, height)
  }
  if (ascii(bytes, 12, 'VP8 ')) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff
    return result(width, height)
  }
  return null
}

/** Dimensions from the header bytes, or null when they may differ from the decoded image. */
export const parseChatImageHeaderDimensions = (
  bytes: Uint8Array
): ChatImageHeaderDimensions | null => parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes)

const readSlice = (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('Failed to read the image header.'))
    reader.onerror = () => reject(reader.error || new Error('Failed to read the image header.'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Reads at most CHAT_IMAGE_HEADER_READ_BYTES of the file; null when the caller must decode. */
export const readChatImageHeaderDimensions = async (
  file: Blob
): Promise<ChatImageHeaderDimensions | null> => {
  try {
    const bytes = new Uint8Array(await readSlice(file.slice(0, CHAT_IMAGE_HEADER_READ_BYTES)))
    return parseChatImageHeaderDimensions(bytes)
  } catch {
    return null
  }
}
