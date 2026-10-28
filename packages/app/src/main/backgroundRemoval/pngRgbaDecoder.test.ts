import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import * as timers from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { decodeBackgroundRemovalRgbaPng } from './pngRgbaDecoder'
import {
  MAX_IMAGE_BYTES,
  validateBackgroundRemovalInput,
  validateBackgroundRemovalOutput
} from './imageValidation'

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>()
  return { ...actual, setImmediate: vi.fn(actual.setImmediate) }
})

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const metadata = { format: 'png' as const, width: 2, height: 2 }
const pixels = Uint8Array.from([1, 2, 3, 0, 140, 250, 80, 255, 200, 130, 20, 255, 4, 30, 255, 120])
function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  result.write(type, 4, 4, 'ascii')
  result.set(data, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
function header(width = 2, height = 2, depth = 8, color = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width)
  data.writeUInt32BE(height, 4)
  data[8] = depth
  data[9] = color
  data[12] = interlace
  return chunk('IHDR', data)
}
function makePng(compressed: Buffer, ihdr = header(), extra: Buffer[] = []): Buffer {
  return Buffer.concat([signature, ihdr, ...extra, chunk('IDAT', compressed), chunk('IEND')])
}
// Hand-computed differences, not the decoder's filter implementation.
const rows = [
  [0, 1, 2, 3, 0, 140, 250, 80, 255, 0, 200, 130, 20, 255, 4, 30, 255, 120],
  [1, 1, 2, 3, 0, 139, 248, 77, 255, 1, 200, 130, 20, 255, 60, 156, 235, 121],
  [2, 1, 2, 3, 0, 140, 250, 80, 255, 2, 199, 128, 17, 255, 120, 36, 175, 121],
  [3, 1, 2, 3, 0, 140, 249, 79, 255, 3, 200, 129, 19, 255, 90, 96, 205, 121],
  [4, 1, 2, 3, 0, 139, 248, 77, 255, 4, 199, 128, 17, 255, 60, 36, 175, 121]
]
const fixture = () => makePng(deflateSync(Buffer.from(rows[0])))

describe('explicit bounded RGBA8 still PNG decoder', () => {
  it.each(rows.map((row, index) => [index, row] as const))(
    'actually inflates and reverses PNG filter %i',
    async (_filter, row) => {
      const encoded = makePng(deflateSync(Buffer.from(row)))
      const before = Buffer.from(encoded)
      const decoded = await decodeBackgroundRemovalRgbaPng(encoded, metadata)
      expect(decoded).toEqual({ width: 2, height: 2, rgba: pixels })
      expect(encoded).toEqual(before)
      decoded.rgba.fill(0)
      expect((await decodeBackgroundRemovalRgbaPng(encoded, metadata)).rgba).toEqual(pixels)
    }
  )

  it.each(rows.flatMap((first, a) => rows.map((second, b) => [a, b, first, second] as const)))(
    'reconstructs mixed row filters %i then %i',
    async (_a, _b, first, second) => {
      const compressed = deflateSync(Buffer.from([...first.slice(0, 9), ...second.slice(9)]))
      expect((await decodeBackgroundRemovalRgbaPng(makePng(compressed), metadata)).rgba).toEqual(
        pixels
      )
    }
  )

  it('integrates as explicit decoder without changing the unavailable default', async () => {
    const bytes = fixture()
    expect(await validateBackgroundRemovalInput(bytes)).toEqual({
      ok: false,
      error: 'DECODER_UNAVAILABLE'
    })
    const options = { decoder: decodeBackgroundRemovalRgbaPng }
    const input = await validateBackgroundRemovalInput(bytes, options)
    expect(input.ok).toBe(true)
    const output = await validateBackgroundRemovalOutput(bytes, metadata, options)
    expect(output.ok).toBe(true)
    if (output.ok) expect(output.image.rgba).toEqual(pixels)
  })

  it('accepts a compressed stream split across consecutive IDAT chunks', async () => {
    const compressed = deflateSync(Buffer.from(rows[0]))
    const encoded = Buffer.concat([
      signature,
      header(),
      chunk('IDAT', compressed.subarray(0, 3)),
      chunk('IDAT', compressed.subarray(3)),
      chunk('IEND')
    ])
    expect((await decodeBackgroundRemovalRgbaPng(encoded, metadata)).rgba).toEqual(pixels)
  })

  it.each([
    'truncated',
    'checksum',
    'trailing',
    'second-stream',
    'too-long',
    'too-short',
    'bad-filter'
  ])('rejects %s compressed image content rather than accepting header/CRC alone', async (kind) => {
    let compressed: Buffer = deflateSync(Buffer.from(rows[0]))
    if (kind === 'truncated') compressed = compressed.subarray(0, -1)
    if (kind === 'checksum') compressed[compressed.length - 1] ^= 0xff
    if (kind === 'trailing') compressed = Buffer.concat([compressed, Buffer.from([0])])
    if (kind === 'second-stream') compressed = Buffer.concat([compressed, compressed])
    if (kind === 'too-long') compressed = deflateSync(Buffer.alloc(1024 * 1024))
    if (kind === 'too-short') compressed = deflateSync(Buffer.from([0]))
    if (kind === 'bad-filter') compressed = deflateSync(Buffer.from([5, ...rows[0].slice(1)]))
    await expect(decodeBackgroundRemovalRgbaPng(makePng(compressed), metadata)).rejects.toThrow(
      'INVALID_IMAGE'
    )
  })

  it.each([
    [16, 6, 0],
    [8, 2, 0],
    [8, 0, 0],
    [8, 6, 1]
  ])('rejects unsupported depth/color/interlace %j/%j/%j', async (depth, color, interlace) => {
    await expect(
      decodeBackgroundRemovalRgbaPng(
        makePng(deflateSync(Buffer.from(rows[0])), header(2, 2, depth, color, interlace)),
        metadata
      )
    ).rejects.toThrow('UNSUPPORTED_IMAGE')
  })

  it.each(['acTL', 'tEXt', 'PLTE'])('rejects the unsupported %s chunk subset', async (type) => {
    await expect(
      decodeBackgroundRemovalRgbaPng(
        makePng(deflateSync(Buffer.from(rows[0])), header(), [chunk(type)]),
        metadata
      )
    ).rejects.toThrow('UNSUPPORTED_IMAGE')
  })

  it('checks direct-call metadata and size bounds before decompressing', async () => {
    await expect(
      decodeBackgroundRemovalRgbaPng(fixture(), { ...metadata, width: 3 })
    ).rejects.toThrow('DIMENSIONS')
    await expect(
      decodeBackgroundRemovalRgbaPng(fixture(), { ...metadata, format: 'jpeg' })
    ).rejects.toThrow('UNSUPPORTED_IMAGE')
    await expect(
      decodeBackgroundRemovalRgbaPng(Buffer.alloc(MAX_IMAGE_BYTES + 1), metadata)
    ).rejects.toThrow('TOO_LARGE')
    await expect(
      decodeBackgroundRemovalRgbaPng(makePng(Buffer.from([0]), header(4096, 4096)), {
        ...metadata,
        width: 4096,
        height: 4096
      })
    ).rejects.toThrow('DIMENSIONS')
  })

  it('rejects malformed structure and CRC independently of validator', async () => {
    const crc = fixture()
    crc[crc.length - 1] ^= 0xff
    for (const bytes of [
      Buffer.from('not png'),
      fixture().subarray(0, -1),
      crc,
      Buffer.concat([fixture(), fixture()])
    ]) {
      await expect(decodeBackgroundRemovalRgbaPng(bytes, metadata)).rejects.toThrow('INVALID_IMAGE')
    }
  })

  it('takes a detached byte snapshot before asynchronous inflate', async () => {
    const bytes = fixture()
    const result = decodeBackgroundRemovalRgbaPng(bytes, metadata)
    bytes.fill(0)
    expect((await result).rgba).toEqual(pixels)
  })

  it('rejects cancellation before entry and after native work was dispatched', async () => {
    const pre = new AbortController()
    pre.abort()
    await expect(decodeBackgroundRemovalRgbaPng(fixture(), metadata, pre.signal)).rejects.toThrow(
      'CANCELLED'
    )
    const controller = new AbortController()
    const work = decodeBackgroundRemovalRgbaPng(fixture(), metadata, controller.signal)
    controller.abort()
    await expect(work).rejects.toThrow('CANCELLED')
    expect((await decodeBackgroundRemovalRgbaPng(fixture(), metadata)).rgba).toEqual(pixels)
  })

  it('rejects unsafe Buffer storage without relying on shadowable lengths', async () => {
    const shared = Buffer.from(new SharedArrayBuffer(8))
    const detached = Buffer.alloc(8)
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    const proxied = new Proxy(fixture(), {
      get() {
        throw Error('unexpected Proxy access')
      }
    })
    for (const bytes of [shared, detached, proxied]) {
      await expect(decodeBackgroundRemovalRgbaPng(bytes, metadata)).rejects.toThrow('INVALID_IMAGE')
    }
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    Object.defineProperty(oversized, 'byteLength', { value: 1 })
    Object.defineProperty(oversized, 'length', { value: 1 })
    await expect(decodeBackgroundRemovalRgbaPng(oversized, metadata)).rejects.toThrow('TOO_LARGE')
  })

  it('rejects duplicate IHDR even with valid CRC and compressed pixels', async () => {
    await expect(
      decodeBackgroundRemovalRgbaPng(
        makePng(deflateSync(Buffer.from(rows[0])), header(), [header()]),
        metadata
      )
    ).rejects.toThrow('INVALID_IMAGE')
  })

  it('handles many empty IDATs without treating them as extra images', async () => {
    const emptyIdats = Array.from({ length: 4096 }, () => chunk('IDAT'))
    expect(
      (
        await decodeBackgroundRemovalRgbaPng(
          makePng(deflateSync(Buffer.from(rows[0])), header(), emptyIdats),
          metadata
        )
      ).rgba
    ).toEqual(pixels)
  })

  it('enforces alpha using decoded pixels, including fully opaque/transparent output', async () => {
    for (const alpha of [0, 255]) {
      const row = Buffer.from(rows[0])
      for (const index of [4, 8, 13, 17]) row[index] = alpha
      expect(
        await validateBackgroundRemovalOutput(makePng(deflateSync(row)), metadata, {
          decoder: decodeBackgroundRemovalRgbaPng
        })
      ).toEqual({ ok: false, error: 'INVALID_ALPHA' })
    }
  })

  it('actually decodes the maximum pixel budget with bounded row reconstruction', async () => {
    const width = 2048,
      height = 2048
    const encoded = makePng(
      deflateSync(Buffer.alloc((width * 4 + 1) * height)),
      header(width, height)
    )
    const result = await decodeBackgroundRemovalRgbaPng(encoded, { format: 'png', width, height })
    expect(result.rgba.length).toBe(width * height * 4)
    expect(result.rgba[0]).toBe(0)
    expect(result.rgba[result.rgba.length - 1]).toBe(0)
  })

  it('cancels at the row-reconstruction yield and releases capacity after settlement', async () => {
    const width = 2,
      height = 65
    const controller = new AbortController()
    const yieldSpy = vi
      .mocked(timers.setImmediate)
      .mockClear()
      .mockImplementationOnce(async () => {
        controller.abort()
      })
    try {
      const bytes = makePng(
        deflateSync(Buffer.alloc((width * 4 + 1) * height)),
        header(width, height)
      )
      await expect(
        decodeBackgroundRemovalRgbaPng(bytes, { format: 'png', width, height }, controller.signal)
      ).rejects.toThrow('CANCELLED')
      expect(yieldSpy).toHaveBeenCalledTimes(1)
    } finally {
      yieldSpy.mockReset()
    }
    const results = await Promise.all([
      decodeBackgroundRemovalRgbaPng(fixture(), metadata),
      decodeBackgroundRemovalRgbaPng(fixture(), metadata)
    ])
    expect(results.every((result) => result.rgba.length === pixels.length)).toBe(true)
  })

  it('bounds concurrent decode work, retaining slots until native settlement', async () => {
    const controller = new AbortController()
    const first = decodeBackgroundRemovalRgbaPng(fixture(), metadata, controller.signal)
    const second = decodeBackgroundRemovalRgbaPng(fixture(), metadata)
    controller.abort()
    await expect(decodeBackgroundRemovalRgbaPng(fixture(), metadata)).rejects.toThrow(
      'DECODER_BUSY'
    )
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
    expect((await decodeBackgroundRemovalRgbaPng(fixture(), metadata)).rgba).toEqual(pixels)
  })
})
