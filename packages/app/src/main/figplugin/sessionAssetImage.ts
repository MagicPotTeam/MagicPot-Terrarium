import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  type FigPluginAssetMime
} from '@shared/figplugin/hostAssets'

const invalid = (): never => {
  throw new Error('INVALID_SESSION_IMAGE')
}
const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// Read only the bounded TIFF orientation tag. It affects the dimensions seen by
// image decoders, but is not permission to rewrite or strip the original bytes.
const orientation = (data: Uint8Array): number => {
  if (data.length < 8) return invalid()
  const little = data[0] === 0x49 && data[1] === 0x49
  if (!little && !(data[0] === 0x4d && data[1] === 0x4d)) return invalid()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint16(2, little) !== 42) return invalid()
  const offset = view.getUint32(4, little)
  if (offset < 8 || offset > data.length - 2) return invalid()
  const entries = view.getUint16(offset, little)
  if (entries > 4096 || offset + 2 + entries * 12 + 4 > data.length) return invalid()
  let result = 1
  let found = false
  for (let index = 0; index < entries; index++) {
    const at = offset + 2 + index * 12
    if (view.getUint16(at, little) !== 0x112) continue
    if (found || view.getUint16(at + 2, little) !== 3 || view.getUint32(at + 4, little) !== 1)
      return invalid()
    result = view.getUint16(at + 8, little)
    if (result < 1 || result > 8) return invalid()
    found = true
  }
  return result
}

/** Structural/dimension preflight, not a claim that compressed pixels decoded.
 * Desktop must also decode these same bytes before granting a session lease.
 */
export function inspectSessionAssetImage(bytes: Uint8Array): {
  mimeType: FigPluginAssetMime
  width: number
  height: number
} {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 12 ||
    bytes.byteLength > FIGPLUGIN_ASSET_MAX_BYTES
  )
    return invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length))
  let mimeType: FigPluginAssetMime
  let width = 0
  let height = 0
  let displayOrientation = 1
  if (bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n') {
    mimeType = 'image/png'
    let offset = 8
    let count = 0
    let idat = false
    let end = false
    let exif = false
    while (offset + 12 <= bytes.length) {
      if (++count > 16_384) return invalid()
      const length = view.getUint32(offset)
      const next = offset + 12 + length
      if (next > bytes.length) return invalid()
      const kind = text(offset + 4, 4)
      if (
        !/^[A-Za-z]{4}$/.test(kind) ||
        crc32(bytes.subarray(offset + 4, next - 4)) !== view.getUint32(next - 4)
      )
        return invalid()
      if (count === 1) {
        if (kind !== 'IHDR' || length !== 13) return invalid()
        width = view.getUint32(offset + 8)
        height = view.getUint32(offset + 12)
      } else if (kind === 'IHDR') return invalid()
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) return invalid()
      if (kind === 'IDAT') idat = true
      if (kind === 'eXIf') {
        if (exif) return invalid()
        exif = true
        displayOrientation = orientation(bytes.subarray(offset + 8, next - 4))
      }
      if (kind === 'IEND') {
        if (length !== 0 || next !== bytes.length || !idat) return invalid()
        end = true
        break
      }
      offset = next
    }
    if (!end) return invalid()
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg'
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return invalid()
    let offset = 2
    let count = 0
    let scan = false
    let exif = false
    while (offset < bytes.length - 2) {
      if (++count > 16_384 || bytes[offset++] !== 0xff) return invalid()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (!marker || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7))
        return invalid()
      if (marker === 0x01) continue
      if (offset + 2 > bytes.length) return invalid()
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length - 2) return invalid()
      if (marker === 0xe1 && length >= 8 && text(offset + 2, 6) === 'Exif\0\0') {
        if (exif) return invalid()
        exif = true
        displayOrientation = orientation(bytes.subarray(offset + 8, offset + length))
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (width || length < 8) return invalid()
        height = view.getUint16(offset + 3)
        width = view.getUint16(offset + 5)
      }
      if (marker === 0xda) {
        scan = true
        break
      }
      offset += length
    }
    if (!scan) return invalid()
  } else if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    mimeType = 'image/webp'
    if (view.getUint32(4, true) + 8 !== bytes.length) return invalid()
    let offset = 12
    let count = 0
    let picture = false
    let extended = false
    let exif = false
    let frameWidth = 0
    let frameHeight = 0
    while (offset + 8 <= bytes.length) {
      if (++count > 16_384) return invalid()
      const kind = text(offset, 4)
      const length = view.getUint32(offset + 4, true)
      const next = offset + 8 + length + (length & 1)
      if (next > bytes.length) return invalid()
      const at = offset + 8
      if (kind === 'ANIM' || kind === 'ANMF') return invalid()
      if (kind === 'VP8X') {
        if (extended || count !== 1 || length !== 10 || (bytes[at] & 0xc3) !== 0) return invalid()
        extended = true
        width = 1 + bytes[at + 4] + (bytes[at + 5] << 8) + (bytes[at + 6] << 16)
        height = 1 + bytes[at + 7] + (bytes[at + 8] << 8) + (bytes[at + 9] << 16)
      }
      if (kind === 'VP8 ' || kind === 'VP8L') {
        if (picture) return invalid()
        picture = true
        if (kind === 'VP8 ') {
          if (length < 10 || (bytes[at] & 1) !== 0 || text(at + 3, 3) !== '\x9d\x01\x2a')
            return invalid()
          frameWidth = view.getUint16(at + 6, true) & 0x3fff
          frameHeight = view.getUint16(at + 8, true) & 0x3fff
        } else {
          if (length < 5 || bytes[at] !== 0x2f || (bytes[at + 4] & 0xe0) !== 0) return invalid()
          const bits = view.getUint32(at + 1, true)
          frameWidth = 1 + (bits & 0x3fff)
          frameHeight = 1 + ((bits >>> 14) & 0x3fff)
        }
      }
      if (kind === 'EXIF') {
        if (exif) return invalid()
        exif = true
        const start = text(at, Math.min(6, length)) === 'Exif\0\0' ? at + 6 : at
        displayOrientation = orientation(bytes.subarray(start, at + length))
      }
      offset = next
    }
    if (offset !== bytes.length || !picture) return invalid()
    if (extended && (width !== frameWidth || height !== frameHeight)) return invalid()
    if (!extended) {
      width = frameWidth
      height = frameHeight
    }
  } else return invalid()
  if (
    width < 1 ||
    height < 1 ||
    width > FIGPLUGIN_ASSET_MAX_EDGE ||
    height > FIGPLUGIN_ASSET_MAX_EDGE ||
    width * height > FIGPLUGIN_ASSET_MAX_PIXELS
  )
    return invalid()
  return displayOrientation >= 5
    ? { mimeType, width: height, height: width }
    : { mimeType, width, height }
}
