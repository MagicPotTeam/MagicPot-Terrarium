import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectSessionAssetImage } from './sessionAssetImage'

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
const pngChunk = (type: string, data: Buffer) => {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}
const png = () => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
// All-black 2x1 fixtures encoded locally with Pillow, not captured user pixels.
const jpeg = () =>
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP7//2Q==',
    'base64'
  )
const webp = () =>
  Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v02aAA=', 'base64')
const tiff = (value: number, little = true, duplicate = false) => {
  const count = duplicate ? 2 : 1
  const bytes = Buffer.alloc(8 + 2 + 12 * count + 4)
  bytes.write(little ? 'II' : 'MM', 0, 'ascii')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint16(2, 42, little)
  view.setUint32(4, 8, little)
  view.setUint16(8, count, little)
  for (let index = 0; index < count; index++) {
    const at = 10 + index * 12
    view.setUint16(at, 0x112, little)
    view.setUint16(at + 2, 3, little)
    view.setUint32(at + 4, 1, little)
    view.setUint16(at + 8, value, little)
  }
  return bytes
}
const jpegSegment = (type: number, bytes: Buffer) => {
  const header = Buffer.alloc(4)
  header[0] = 255
  header[1] = type
  header.writeUInt16BE(bytes.length + 2, 2)
  return Buffer.concat([header, bytes])
}
const webpChunk = (type: string, bytes: Buffer) => {
  const chunk = Buffer.alloc(8 + bytes.length + (bytes.length & 1))
  chunk.write(type, 0, 4, 'ascii')
  chunk.writeUInt32LE(bytes.length, 4)
  bytes.copy(chunk, 8)
  return chunk
}
const riff = (chunks: Buffer[]) => {
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  header.write('WEBP', 8, 'ascii')
  return Buffer.concat([header, ...chunks])
}
const extendedWebpHeader = () => {
  const header = Buffer.alloc(10)
  header[0] = 8
  header[4] = 1
  return header
}
const fixtures = [
  {
    mimeType: 'image/png',
    bytes: png,
    withExif: (data: Buffer, duplicate = false) => {
      const bytes = png()
      const exif = pngChunk('eXIf', data)
      return Buffer.concat([
        bytes.subarray(0, 33),
        exif,
        ...(duplicate ? [exif] : []),
        bytes.subarray(33)
      ])
    }
  },
  {
    mimeType: 'image/jpeg',
    bytes: jpeg,
    withExif: (data: Buffer, duplicate = false) => {
      const bytes = jpeg()
      const exif = jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), data]))
      return Buffer.concat([
        bytes.subarray(0, 2),
        exif,
        ...(duplicate ? [exif] : []),
        bytes.subarray(2)
      ])
    }
  },
  {
    mimeType: 'image/webp',
    bytes: webp,
    withExif: (data: Buffer, duplicate = false) => {
      const exif = webpChunk('EXIF', data)
      return riff([
        webpChunk('VP8X', extendedWebpHeader()),
        webp().subarray(12),
        exif,
        ...(duplicate ? [exif] : [])
      ])
    }
  }
]

describe.each(fixtures)(
  '$mimeType bounded structural and orientation preflight',
  ({ mimeType, bytes, withExif }) => {
    it('recognizes genuine static dimensions without rewriting the original encoded bytes', () => {
      const source = bytes()
      const snapshot = Buffer.from(source)
      expect(inspectSessionAssetImage(source)).toEqual({ mimeType, width: 2, height: 1 })
      expect(source).toEqual(snapshot)
      const backing = Buffer.concat([Buffer.alloc(9, 42), source, Buffer.alloc(13, 43)])
      expect(inspectSessionAssetImage(backing.subarray(9, 9 + source.length))).toEqual({
        mimeType,
        width: 2,
        height: 1
      })
    })

    it('uses all eight TIFF orientations with either byte order to bind decoder-visible dimensions', () => {
      for (const little of [true, false]) {
        for (let orientation = 1; orientation <= 8; orientation++) {
          const source = withExif(tiff(orientation, little))
          const snapshot = Buffer.from(source)
          expect(inspectSessionAssetImage(source)).toEqual({
            mimeType,
            width: orientation < 5 ? 2 : 1,
            height: orientation < 5 ? 1 : 2
          })
          expect(source).toEqual(snapshot)
        }
      }
    })

    it('rejects duplicate, invalid, mis-typed or out-of-bounds orientation metadata', () => {
      const badMagic = tiff(1)
      badMagic.writeUInt16LE(43, 2)
      const badOffset = tiff(1)
      badOffset.writeUInt32LE(0xffffffff, 4)
      const badType = tiff(1)
      badType.writeUInt16LE(4, 12)
      const badCount = tiff(1)
      badCount.writeUInt32LE(2, 14)
      const tooManyEntries = tiff(1)
      tooManyEntries.writeUInt16LE(4097, 8)
      for (const data of [
        Buffer.alloc(7),
        tiff(0),
        tiff(9),
        tiff(1, true, true),
        badMagic,
        badOffset,
        badType,
        badCount,
        tooManyEntries
      ])
        expect(() => inspectSessionAssetImage(withExif(data))).toThrow('INVALID_SESSION_IMAGE')
      expect(() => inspectSessionAssetImage(withExif(tiff(1), true))).toThrow(
        'INVALID_SESSION_IMAGE'
      )
    })
  }
)

describe('malformed and animated session image preflight', () => {
  it('checks PNG CRCs, complete IEND and forbidden animation chunks even with plausible dimensions', () => {
    const bytes = png()
    const corrupted = Buffer.from(bytes)
    corrupted[29] ^= 1
    const ihdr = bytes.subarray(8, 33)
    for (const source of [
      corrupted,
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.concat([bytes.subarray(0, 33), ihdr, bytes.subarray(33)]),
      ...['acTL', 'fcTL', 'fdAT'].map((type) =>
        Buffer.concat([bytes.subarray(0, 33), pngChunk(type, Buffer.alloc(8)), bytes.subarray(33)])
      )
    ])
      expect(() => inspectSessionAssetImage(source)).toThrow('INVALID_SESSION_IMAGE')
  })

  it('requires a bounded JPEG frame, scan and terminal marker instead of trusting SOI or an EXIF label', () => {
    const bytes = jpeg()
    const sof = bytes.indexOf(Buffer.from([255, 192]))
    const sofLength = bytes.readUInt16BE(sof + 2) + 2
    const scan = bytes.indexOf(Buffer.from([255, 218]))
    const duplicate = Buffer.concat([
      bytes.subarray(0, scan),
      bytes.subarray(sof, sof + sofLength),
      bytes.subarray(scan)
    ])
    const oversized = Buffer.from(bytes)
    oversized.writeUInt16BE(4097, sof + 7)
    for (const source of [
      bytes.subarray(0, -2),
      Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.concat([bytes.subarray(0, sof), bytes.subarray(sof + sofLength)]),
      Buffer.concat([bytes.subarray(0, scan), Buffer.from([255, 217])]),
      duplicate,
      oversized
    ])
      expect(() => inspectSessionAssetImage(source)).toThrow('INVALID_SESSION_IMAGE')
  })

  it('requires exact static WebP chunk structure with one frame and no animation flags or chunks', () => {
    const frame = webp().subarray(12)
    const animationHeader = extendedWebpHeader()
    animationHeader[0] = 2
    const mismatchedHeader = extendedWebpHeader()
    mismatchedHeader[4] = 2
    const badLength = webp()
    badLength.writeUInt32LE(badLength.length, 4)
    for (const source of [
      badLength,
      webp().subarray(0, -1),
      Buffer.concat([webp(), Buffer.from([0])]),
      riff([frame, frame]),
      riff([webpChunk('VP8X', animationHeader), frame]),
      riff([webpChunk('VP8X', mismatchedHeader), frame]),
      riff([webpChunk('VP8 ', Buffer.alloc(9))]),
      riff([frame, webpChunk('ANIM', Buffer.alloc(6))]),
      riff([frame, webpChunk('ANMF', Buffer.alloc(16))])
    ])
      expect(() => inspectSessionAssetImage(source)).toThrow('INVALID_SESSION_IMAGE')
  })

  it('fails closed on absent bytes, arbitrary binary formats and PNG dimensions outside the pixel budget', () => {
    const oversizedHeader = Buffer.from(png().subarray(16, 29))
    oversizedHeader.writeUInt32BE(4097)
    const oversized = Buffer.concat([
      png().subarray(0, 8),
      pngChunk('IHDR', oversizedHeader),
      png().subarray(33)
    ])
    for (const source of [
      undefined,
      [],
      new Uint8Array(),
      Buffer.alloc(12),
      Buffer.from('<svg width="2" height="1"/>'),
      oversized
    ])
      expect(() => inspectSessionAssetImage(source as never)).toThrow('INVALID_SESSION_IMAGE')
  })
})
