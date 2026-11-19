import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_IMAGE_HEADER_READ_BYTES,
  CHAT_IMAGE_HEADER_READ_TIMED_OUT,
  CHAT_IMAGE_HEADER_READ_TIMEOUT_MS,
  parseChatImageHeaderDimensions,
  readChatImageHeaderDimensions
} from './chatImageHeaderDimensions'

const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff
]
const chunk = (type: string, data: number[] = []) => [
  ...u32(data.length),
  ...Array.from(type, (c) => c.charCodeAt(0)),
  ...data,
  0,
  0,
  0,
  0
]
const png = (width: number, height: number, before: number[][] = []) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...before.flat(),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND')
  ])
const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  ((payload.length + 2) >> 8) & 0xff,
  (payload.length + 2) & 0xff,
  ...payload
]
const jpeg = (width: number, height: number, before: number[][] = []) =>
  new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 72, 0, 72, 0, 0]),
    ...before.flat(),
    ...segment(0xdb, new Array(65).fill(1)),
    ...segment(0xc2, [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3]),
    0xff,
    0xda,
    0,
    2,
    0xff,
    0xd9
  ])
const riff = (body: number[]) =>
  new Uint8Array([
    ...Array.from('RIFF', (c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
    ...Array.from('WEBP', (c) => c.charCodeAt(0)),
    ...body,
    ...new Array(16).fill(0)
  ])
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]
const webpVp8x = (width: number, height: number, flags = 0) =>
  riff([
    ...Array.from('VP8X', (c) => c.charCodeAt(0)),
    10,
    0,
    0,
    0,
    flags,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1)
  ])

describe('chat image header dimensions', () => {
  it('reads PNG, baseline/progressive JPEG and WebP sizes from the header', () => {
    expect(parseChatImageHeaderDimensions(png(4096, 3072))).toEqual({
      sourceWidth: 4096,
      sourceHeight: 3072
    })
    // Ancillary chunks before the image data (text, colour profile) are skipped.
    expect(
      parseChatImageHeaderDimensions(png(640, 480, [chunk('tEXt', [65, 0, 66]), chunk('pHYs', new Array(9).fill(0))]))
    ).toEqual({ sourceWidth: 640, sourceHeight: 480 })
    expect(parseChatImageHeaderDimensions(jpeg(1920, 1080))).toEqual({
      sourceWidth: 1920,
      sourceHeight: 1080
    })
    expect(parseChatImageHeaderDimensions(webpVp8x(5000, 20))).toEqual({
      sourceWidth: 5000,
      sourceHeight: 20
    })
    // Lossless WebP: 0x2f signature, 14-bit width-1 and height-1.
    const w = 300 - 1
    const h = 200 - 1
    const bits = w | (h << 14)
    expect(
      parseChatImageHeaderDimensions(
        riff([
          ...Array.from('VP8L', (c) => c.charCodeAt(0)),
          5,
          0,
          0,
          0,
          0x2f,
          bits & 0xff,
          (bits >> 8) & 0xff,
          (bits >> 16) & 0xff,
          (bits >> 24) & 0xff
        ])
      )
    ).toEqual({ sourceWidth: 300, sourceHeight: 200 })
  })

  it('declines whenever the browser could report another size, so the caller decodes', () => {
    // EXIF orientation / density can swap or scale the reported size.
    const exif = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8])
    expect(parseChatImageHeaderDimensions(jpeg(1920, 1080, [exif]))).toBeNull()
    expect(parseChatImageHeaderDimensions(png(10, 20, [chunk('eXIf', [0x4d, 0x4d])]))).toBeNull()
    expect(parseChatImageHeaderDimensions(webpVp8x(10, 20, 0x08))).toBeNull()
    // GIF, BMP, truncated or garbage data.
    expect(parseChatImageHeaderDimensions(new TextEncoder().encode('GIF89a\x10\x00\x10\x00'))).toBeNull()
    expect(parseChatImageHeaderDimensions(new TextEncoder().encode('mock-file'))).toBeNull()
    expect(parseChatImageHeaderDimensions(png(10, 20).slice(0, 40))).toBeNull()
    expect(parseChatImageHeaderDimensions(png(0, 20))).toBeNull()
    expect(parseChatImageHeaderDimensions(jpeg(1920, 1080).slice(0, 30))).toBeNull()
    expect(parseChatImageHeaderDimensions(new Uint8Array())).toBeNull()
  })

  it('reads only the first bytes of the file, never the whole file', async () => {
    const bytes = png(800, 600)
    const big = new Uint8Array(CHAT_IMAGE_HEADER_READ_BYTES * 4)
    big.set(bytes)
    const file = new File([big], 'big.png', { type: 'image/png' })
    const slice = vi.spyOn(file, 'slice')
    await expect(readChatImageHeaderDimensions(file)).resolves.toEqual({
      sourceWidth: 800,
      sourceHeight: 600
    })
    expect(slice).toHaveBeenCalledWith(0, CHAT_IMAGE_HEADER_READ_BYTES)
    await expect(
      readChatImageHeaderDimensions(new File(['mock-file'], 'x.png', { type: 'image/png' }))
    ).resolves.toBeNull()
  })

  it('gives up on a header read that does not finish in time (a stalled mount)', async () => {
    vi.useFakeTimers()
    try {
      const stalled = {
        slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined) })
      }
      let outcome: unknown = 'pending'
      void readChatImageHeaderDimensions(stalled as unknown as Blob).then((value) => {
        outcome = value
      })
      await vi.advanceTimersByTimeAsync(CHAT_IMAGE_HEADER_READ_TIMEOUT_MS - 1)
      expect(outcome).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toBe(CHAT_IMAGE_HEADER_READ_TIMED_OUT)
      expect(CHAT_IMAGE_HEADER_READ_TIMEOUT_MS).toBeLessThanOrEqual(3_000)
    } finally {
      vi.useRealTimers()
    }
  })
})
