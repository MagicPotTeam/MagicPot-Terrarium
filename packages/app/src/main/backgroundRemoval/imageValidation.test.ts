import { Buffer } from 'node:buffer'
import { deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  validateBackgroundRemovalInput,
  validateBackgroundRemovalOutput,
  type DecodedImage,
  type ImageDimensions,
  type TrustedImageDecoder
} from './imageValidation'

// In-memory fixtures only. This decoder is a tiny test adapter, not a production decoder.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const expectedSize = { width: 2, height: 1 }
const mixed = Uint8Array.from([10, 20, 30, 0, 40, 50, 60, 255])

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length)
  result.write(type, 4, 4, 'ascii')
  result.set(data, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function ihdr(width = 2, height = 1, color = 6, depth = 8, methods = [0, 0, 0]): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width)
  data.writeUInt32BE(height, 4)
  data[8] = depth
  data[9] = color
  data.set(methods, 10)
  return chunk('IHDR', data)
}

function png(...chunks: Buffer[]): Buffer {
  return Buffer.concat([signature, ...chunks])
}

function pngImage(rgba = mixed): Buffer {
  return png(ihdr(), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND'))
}

const decodePng: TrustedImageDecoder = async (bytes, metadata) => {
  expect(metadata).toEqual({ format: 'png', ...expectedSize })
  const compressed: Buffer[] = []
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length))
    }
    offset += 12 + length
  }
  const row = inflateSync(Buffer.concat(compressed))
  if (row.length !== 9 || row[0] !== 0) throw new Error('fixture decode failure')
  return { ...expectedSize, rgba: Uint8Array.from(row.subarray(1)) }
}

function segment(marker: number, data: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([header, data])
}

function jpegFrame(width = 2, height = 1): Buffer {
  const data = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  data.writeUInt16BE(height, 1)
  data.writeUInt16BE(width, 3)
  return segment(0xc0, data)
}

const quantization = segment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)]))
const huffman = segment(
  0xc4,
  Buffer.from([0, 1, ...Array<number>(15).fill(0), 0, 0x10, 1, ...Array<number>(15).fill(0), 0])
)
const scan = segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))
const entropyAndEnd = Buffer.from([0x3f, 0xff, 0xd9])

function jpeg(...headers: Buffer[]): Buffer {
  // One grayscale MCU: zero DC difference and EOB, followed by one-bit padding.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...headers,
    quantization,
    huffman,
    scan,
    entropyAndEnd
  ])
}

function jpegWithScan(tail: Buffer, ...headers: Buffer[]): Buffer {
  return Buffer.concat([jpeg(jpegFrame(), ...headers).subarray(0, -3), tail])
}

function decoded(rgba: Uint8Array = mixed): DecodedImage {
  return { ...expectedSize, rgba }
}

const fail = (error: string) => ({ ok: false, error })

describe('background removal image validation', () => {
  it('pins the media limits', () => {
    expect([MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS]).toEqual([
      4 * 1024 * 1024,
      4096,
      4_194_304
    ])
  })

  it('requires an injected decoder even for a complete valid image', async () => {
    expect(await validateBackgroundRemovalInput(pngImage())).toEqual(fail('DECODER_UNAVAILABLE'))
    expect(await validateBackgroundRemovalOutput(pngImage(), expectedSize)).toEqual(
      fail('DECODER_UNAVAILABLE')
    )
  })

  it('decodes real small PNG data and preserves and detaches the source bytes', async () => {
    const source = pngImage()
    const original = Buffer.from(source)
    const decoder = vi.fn(decodePng)
    const result = await validateBackgroundRemovalInput(source, { decoder })
    expect(decoder).toHaveBeenCalledOnce()
    expect(source).toEqual(original)
    expect(result).toMatchObject({ ok: true, image: { format: 'png', ...expectedSize } })
    if (!result.ok) throw new Error('expected success')
    expect(result.image.rgba).toEqual(mixed)
    expect(result.image.bytes).toEqual(original)
    expect(result.image.bytes.buffer).not.toBe(source.buffer)
    expect(decoder.mock.calls[0][0].buffer).not.toBe(source.buffer)
    result.image.bytes.fill(0)
    expect(source).toEqual(original)
  })

  it('rejects byte overflow before decoding or inspecting image data', async () => {
    const decoder = vi.fn(decodePng)
    expect(
      await validateBackgroundRemovalInput(Buffer.alloc(MAX_IMAGE_BYTES + 1), { decoder })
    ).toEqual(fail('TOO_LARGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it('does not mistake a large backing buffer for the bounded image view', async () => {
    const original = pngImage()
    const backing = Buffer.alloc(MAX_IMAGE_BYTES + 10)
    backing.set(original, 7)
    const source = backing.subarray(7, 7 + original.length)
    const result = await validateBackgroundRemovalInput(source, { decoder: decodePng })
    expect(result).toMatchObject({ ok: true, image: { bytes: original } })
    expect(source).toEqual(original)
  })

  it.each([
    ['zero width', 0, 1],
    ['zero height', 1, 0],
    ['wide', 4097, 1],
    ['tall', 1, 4097],
    ['pixel count', 2049, 2048],
    ['uint32 width', 0xffffffff, 1]
  ])('rejects PNG dimensions before decode: %s', async (_label, width, height) => {
    const decoder = vi.fn(decodePng)
    const source = png(ihdr(width, height), chunk('IDAT', Buffer.from([1])), chunk('IEND'))
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(fail('DIMENSIONS'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it('permits the exact dimension/pixel limit only after an injected decode succeeds', async () => {
    const rows = Buffer.alloc(MAX_IMAGE_PIXELS * 4 + 1024)
    const source = png(ihdr(4096, 1024), chunk('IDAT', deflateSync(rows)), chunk('IEND'))
    const decoder = vi.fn(async () => ({
      width: 4096,
      height: 1024,
      rgba: new Uint8Array(MAX_IMAGE_PIXELS * 4)
    }))
    expect(await validateBackgroundRemovalInput(source, { decoder })).toMatchObject({ ok: true })
    expect(decoder).toHaveBeenCalledOnce()
  })

  it.each([
    ['signature', Buffer.from([137, 80, 78, 71, 0, 0, 0, 0])],
    ['truncated', pngImage().subarray(0, -1)],
    ['trailing', Buffer.concat([pngImage(), Buffer.from([0])])],
    ['concatenated', Buffer.concat([pngImage(), pngImage()])],
    ['duplicate IHDR', png(ihdr(), ihdr(), chunk('IDAT'), chunk('IEND'))],
    ['empty IDAT', png(ihdr(), chunk('IDAT'), chunk('IEND'))],
    ['missing IDAT', png(ihdr(), chunk('IEND'))],
    ['bad chunk name', png(ihdr(), chunk('abca'), chunk('IDAT'), chunk('IEND'))],
    ['bad color type', png(ihdr(2, 1, 1), chunk('IDAT'), chunk('IEND'))],
    ['bad bit depth', png(ihdr(2, 1, 6, 4), chunk('IDAT'), chunk('IEND'))],
    ['compression method', png(ihdr(2, 1, 6, 8, [1, 0, 0]), chunk('IDAT'), chunk('IEND'))],
    ['filter method', png(ihdr(2, 1, 6, 8, [0, 1, 0]), chunk('IDAT'), chunk('IEND'))],
    ['interlace method', png(ihdr(2, 1, 6, 8, [0, 0, 2]), chunk('IDAT'), chunk('IEND'))],
    ['missing palette', png(ihdr(2, 1, 3), chunk('IDAT', Buffer.from([1])), chunk('IEND'))],
    [
      'bad palette',
      png(ihdr(2, 1, 3), chunk('PLTE', Buffer.from([1])), chunk('IDAT'), chunk('IEND'))
    ],
    ['forbidden tRNS', png(ihdr(), chunk('tRNS', Buffer.from([0])), chunk('IDAT'), chunk('IEND'))],
    [
      'late palette',
      png(
        ihdr(),
        chunk('IDAT', Buffer.from([1])),
        chunk('PLTE', Buffer.from([0, 0, 0])),
        chunk('IEND')
      )
    ],
    [
      'duplicate palette',
      png(
        ihdr(),
        chunk('PLTE', Buffer.from([0, 0, 0])),
        chunk('PLTE', Buffer.from([0, 0, 0])),
        chunk('IDAT'),
        chunk('IEND')
      )
    ],
    [
      'duplicate tRNS',
      png(
        ihdr(2, 1, 0),
        chunk('tRNS', Buffer.from([0, 0])),
        chunk('tRNS', Buffer.from([0, 0])),
        chunk('IDAT'),
        chunk('IEND')
      )
    ],
    [
      'out of range tRNS',
      png(ihdr(2, 1, 0), chunk('tRNS', Buffer.from([1, 0])), chunk('IDAT'), chunk('IEND'))
    ],
    [
      'nonconsecutive IDAT',
      png(
        ihdr(2, 1, 0),
        chunk('IDAT', Buffer.from([1])),
        chunk('tRNS', Buffer.from([0, 0])),
        chunk('IDAT', Buffer.from([2])),
        chunk('IEND')
      )
    ]
  ])('rejects malformed PNG before decode: %s', async (_label, source) => {
    const decoder = vi.fn(decodePng)
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(fail('INVALID_IMAGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it('reuses full CRC validation instead of trusting the PNG header', async () => {
    const source = pngImage()
    source[40] ^= 1
    const decoder = vi.fn(decodePng)
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(fail('INVALID_IMAGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each(['acTL', 'fcTL', 'fdAT'])('rejects APNG %s before decoding', async (type) => {
    const source = png(ihdr(), chunk(type), chunk('IDAT', Buffer.from([1])), chunk('IEND'))
    const decoder = vi.fn(decodePng)
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(
      fail('UNSUPPORTED_IMAGE')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it('fails closed on unsupported PNG metadata rather than claiming to validate it', async () => {
    const source = png(ihdr(), chunk('iCCP'), chunk('IDAT', Buffer.from([1])), chunk('IEND'))
    const decoder = vi.fn(decodePng)
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(
      fail('UNSUPPORTED_IMAGE')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it('permits consecutive IDAT chunks', async () => {
    const data = deflateSync(Buffer.from([0, ...mixed]))
    const source = png(
      ihdr(),
      chunk('IDAT', data.subarray(0, 2)),
      chunk('IDAT', data.subarray(2)),
      chunk('IEND')
    )
    expect(await validateBackgroundRemovalInput(source, { decoder: decodePng })).toMatchObject({
      ok: true
    })
  })

  it('fails closed when actual PNG inflation/decoding fails', async () => {
    const source = png(ihdr(), chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND'))
    expect(await validateBackgroundRemovalInput(source, { decoder: decodePng })).toEqual(
      fail('INVALID_IMAGE')
    )
  })

  it('statically reads JPEG dimensions and still requires a decoder', async () => {
    const source = jpeg(jpegFrame())
    const decoder = vi.fn(async (bytes, metadata) => {
      expect(bytes).toEqual(source)
      expect(bytes.buffer).not.toBe(source.buffer)
      expect(metadata).toEqual({ format: 'jpeg', ...expectedSize })
      return decoded()
    })
    expect(await validateBackgroundRemovalInput(source, { decoder })).toMatchObject({
      ok: true,
      image: { format: 'jpeg', ...expectedSize }
    })
    expect(decoder).toHaveBeenCalledOnce()
    expect(await validateBackgroundRemovalInput(source)).toEqual(fail('DECODER_UNAVAILABLE'))
  })

  it.each([
    [0, 1],
    [4097, 1],
    [1, 4097],
    [2049, 2048]
  ])('bounds JPEG %i x %i before decoding', async (width, height) => {
    const decoder = vi.fn(async () => decoded())
    expect(
      await validateBackgroundRemovalInput(jpeg(jpegFrame(width, height)), { decoder })
    ).toEqual(fail('DIMENSIONS'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated segment', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 20, 0])],
    ['short segment length', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])],
    ['missing frame', jpeg()],
    ['duplicate frame', jpeg(jpegFrame(), jpegFrame())],
    ['malformed frame', jpeg(segment(0xc0, Buffer.from([8, 0, 1, 0, 2, 3])))],
    ['missing EOI', jpeg(jpegFrame()).subarray(0, -2)],
    ['empty scan', jpegWithScan(Buffer.from([0xff, 0xd9]))],
    ['trailing bytes', Buffer.concat([jpeg(jpegFrame()), Buffer.from([0])])],
    ['concatenated JPEG', Buffer.concat([jpeg(jpegFrame()), jpeg(jpegFrame())])],
    ['standalone restart', jpeg(Buffer.from([0xff, 0xd0]), jpegFrame())],
    ['invalid DQT', jpeg(jpegFrame(), segment(0xdb, Buffer.from([0, 1])))],
    ['invalid DHT', jpeg(jpegFrame(), segment(0xc4, Buffer.from([0, 1])))],
    ['invalid DRI', jpeg(jpegFrame(), segment(0xdd, Buffer.from([0])))],
    ['unterminated marker', jpegWithScan(Buffer.from([0x3f, 0xff, 0xff]))],
    ['multiple scans', jpegWithScan(Buffer.concat([Buffer.from([0x3f]), scan, entropyAndEnd]))],
    ['unconfigured restart', jpegWithScan(Buffer.from([0x3f, 0xff, 0xd0, 0x3f, 0xff, 0xd9]))],
    ['invalid stuffing', jpegWithScan(Buffer.from([0x3f, 0xff, 0xff, 0, 0xff, 0xd9]))],
    [
      'wrong restart sequence',
      jpegWithScan(
        Buffer.from([0x3f, 0xff, 0xd1, 0x3f, 0xff, 0xd9]),
        segment(0xdd, Buffer.from([0, 1]))
      )
    ]
  ])('rejects malformed JPEG before decode: %s', async (_label, source) => {
    const decoder = vi.fn(async () => decoded())
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(fail('INVALID_IMAGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it('rejects unsupported JPEG coding rather than skipping its frame header', async () => {
    const frame = jpegFrame()
    frame[1] = 0xc2
    const decoder = vi.fn(async () => decoded())
    expect(await validateBackgroundRemovalInput(jpeg(frame), { decoder })).toEqual(
      fail('UNSUPPORTED_IMAGE')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it('requires the JPEG adapter to reject invalid entropy despite a complete EOI', async () => {
    const source = jpegWithScan(Buffer.from([0, 0xff, 0xd9]))
    const decoder = vi.fn(async () => {
      throw new Error('invalid entropy/padding')
    })
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(fail('INVALID_IMAGE'))
    expect(decoder).toHaveBeenCalledOnce()
  })

  it('rejects MPO even when its first JPEG has valid dimensions', async () => {
    const source = jpeg(jpegFrame(), segment(0xe2, Buffer.from('MPF\0test', 'ascii')))
    const decoder = vi.fn(async () => decoded())
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(
      fail('UNSUPPORTED_IMAGE')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each([
    jpeg(...Array.from({ length: 5 }, () => segment(0xe1, Buffer.alloc(60_000))), jpegFrame()),
    jpeg(...Array.from({ length: 1025 }, () => segment(0xfe, Buffer.alloc(0))), jpegFrame()),
    jpeg(Buffer.alloc(256 * 1024, 0xff), jpegFrame())
  ])('bounds JPEG header bytes, segments and marker fill independently', async (source) => {
    const decoder = vi.fn(async () => decoded())
    expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(fail('TOO_LARGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each([Buffer.alloc(0), new Uint8Array([1]), 'image.png', null])(
    'rejects invalid/non-Buffer inputs without coercion',
    async (source) => {
      const decoder = vi.fn(decodePng)
      expect(await validateBackgroundRemovalInput(source as Buffer, { decoder })).toEqual(
        fail('INVALID_IMAGE')
      )
      expect(decoder).not.toHaveBeenCalled()
    }
  )

  it('rejects unsupported formats without consulting a decoder', async () => {
    const decoder = vi.fn(decodePng)
    expect(await validateBackgroundRemovalInput(Buffer.from('GIF89a'), { decoder })).toEqual(
      fail('UNSUPPORTED_IMAGE')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it('rejects direct, revoked and prototype proxies without invoking traps', async () => {
    const trap = vi.fn(() => {
      throw new Error('must not inspect proxy properties')
    })
    const proxy = new Proxy(pngImage(), { get: trap, getPrototypeOf: trap })
    const inherited = Object.setPrototypeOf(pngImage(), new Proxy(Buffer.prototype, { get: trap }))
    const revoked = Proxy.revocable(pngImage(), {})
    revoked.revoke()
    for (const source of [proxy, revoked.proxy, inherited, Object.create(Buffer.prototype)]) {
      expect(await validateBackgroundRemovalInput(source, { decoder: decodePng })).toEqual(
        fail('INVALID_IMAGE')
      )
    }
    expect(trap).not.toHaveBeenCalled()
  })

  it('rejects shared and detached input storage', async () => {
    const shared = Buffer.from(new SharedArrayBuffer(80))
    const detached = Buffer.alloc(80)
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    for (const source of [shared, detached]) {
      expect(await validateBackgroundRemovalInput(source, { decoder: decodePng })).toEqual(
        fail('INVALID_IMAGE')
      )
    }
  })

  it('does not use shadowed Buffer accessors during snapshotting', async () => {
    const source = pngImage()
    const trap = vi.fn(() => {
      throw new Error('shadowed property')
    })
    for (const name of ['buffer', 'byteOffset', 'byteLength', 'length']) {
      Object.defineProperty(source, name, { get: trap })
    }
    expect(await validateBackgroundRemovalInput(source, { decoder: decodePng })).toMatchObject({
      ok: true
    })
    expect(trap).not.toHaveBeenCalled()
  })

  it('checks cancellation before and after asynchronous decoding, including rejection', async () => {
    const controller = new AbortController()
    controller.abort()
    const decoder = vi.fn(decodePng)
    expect(
      await validateBackgroundRemovalInput(pngImage(), { decoder, signal: controller.signal })
    ).toEqual(fail('CANCELLED'))
    expect(decoder).not.toHaveBeenCalled()
    for (const reject of [false, true]) {
      const during = new AbortController()
      const delayed: TrustedImageDecoder = async (_bytes, _metadata, signal) => {
        expect(signal).toBe(during.signal)
        await Promise.resolve()
        during.abort()
        if (reject) throw new Error('private decoder error')
        return decoded()
      }
      expect(
        await validateBackgroundRemovalInput(pngImage(), {
          decoder: delayed,
          signal: during.signal
        })
      ).toEqual(fail('CANCELLED'))
    }
  })

  it('isolates caller mutation while a decoder is awaiting', async () => {
    const source = pngImage()
    const original = Buffer.from(source)
    const decoder: TrustedImageDecoder = async (bytes, metadata) => {
      expect(Object.isFrozen(metadata)).toBe(true)
      await Promise.resolve()
      source.fill(0)
      expect(bytes).toEqual(original)
      return decodePng(bytes, metadata)
    }
    const result = await validateBackgroundRemovalInput(source, { decoder })
    expect(result).toMatchObject({ ok: true, image: { bytes: original } })
  })

  it('rejects an adapter that changes or detaches its encoded input copy', async () => {
    for (const detach of [false, true]) {
      const source = pngImage()
      const original = Buffer.from(source)
      const decoder: TrustedImageDecoder = async (bytes) => {
        if (detach) structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
        else bytes.fill(0)
        return decoded()
      }
      expect(await validateBackgroundRemovalInput(source, { decoder })).toEqual(
        fail('INVALID_IMAGE')
      )
      expect(source).toEqual(original)
    }
  })

  it.each([
    ['changed width', { width: 1, height: 1, rgba: mixed }, 'DIMENSIONS'],
    ['changed height', { width: 2, height: 2, rgba: mixed }, 'DIMENSIONS'],
    ['noninteger width', { width: 2.1, height: 1, rgba: mixed }, 'DIMENSIONS'],
    ['wrong RGBA size', decoded(new Uint8Array(7)), 'INVALID_IMAGE'],
    ['non-Uint8 RGBA', { ...expectedSize, rgba: [0, 0, 0, 0] }, 'INVALID_IMAGE'],
    ['shared RGBA', decoded(new Uint8Array(new SharedArrayBuffer(8))), 'INVALID_IMAGE'],
    ['missing data', null, 'INVALID_IMAGE']
  ])('validates decoder result: %s', async (_label, value, error) => {
    const decoder = async () => value as DecodedImage
    expect(await validateBackgroundRemovalInput(pngImage(), { decoder })).toEqual(fail(error))
  })

  it('rejects detached or proxied decoded pixels without inspecting proxy properties', async () => {
    const detached = new Uint8Array(8)
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    const trap = vi.fn(() => {
      throw new Error('must not read pixels through proxy')
    })
    const proxy = new Proxy(mixed, { get: trap, getPrototypeOf: trap })
    for (const rgba of [detached, proxy]) {
      expect(
        await validateBackgroundRemovalInput(pngImage(), { decoder: async () => decoded(rgba) })
      ).toEqual(fail('INVALID_IMAGE'))
    }
    expect(trap).not.toHaveBeenCalled()
  })

  it('returns only a stable code when decoding throws sensitive errors', async () => {
    expect(
      await validateBackgroundRemovalInput(pngImage(), {
        decoder: async () => {
          throw new Error('secret-user-path and raw provider failure')
        }
      })
    ).toEqual(fail('INVALID_IMAGE'))
  })
})

describe('background removal output validation', () => {
  it('requires PNG, not JPEG', async () => {
    const decoder = vi.fn(async () => decoded())
    expect(
      await validateBackgroundRemovalOutput(jpeg(jpegFrame()), expectedSize, { decoder })
    ).toEqual(fail('UNSUPPORTED_IMAGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it('rejects output size overflow before decoding', async () => {
    const decoder = vi.fn(decodePng)
    expect(
      await validateBackgroundRemovalOutput(Buffer.alloc(MAX_IMAGE_BYTES + 1), expectedSize, {
        decoder
      })
    ).toEqual(fail('TOO_LARGE'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each([
    { width: 1, height: 1 },
    { width: 2, height: 2 },
    { width: 0, height: 1 },
    { width: 4097, height: 1 },
    { width: NaN, height: 1 }
  ])('rejects cropping/resizing or invalid expected dimensions: %j', async (expected) => {
    const decoder = vi.fn(decodePng)
    expect(await validateBackgroundRemovalOutput(pngImage(), expected, { decoder })).toEqual(
      fail('DIMENSIONS')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it('rejects missing expected dimensions instead of becoming input validation', async () => {
    const decoder = vi.fn(decodePng)
    expect(
      await validateBackgroundRemovalOutput(pngImage(), undefined as unknown as ImageDimensions, {
        decoder
      })
    ).toEqual(fail('DIMENSIONS'))
    expect(decoder).not.toHaveBeenCalled()
  })

  it('requires encoded alpha capability, not just a fabricated RGBA result', async () => {
    const source = png(
      ihdr(2, 1, 2),
      chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 4, 5, 6]))),
      chunk('IEND')
    )
    const decoder = vi.fn(async () => decoded())
    expect(await validateBackgroundRemovalOutput(source, expectedSize, { decoder })).toEqual(
      fail('INVALID_ALPHA')
    )
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each([0, 255])('rejects output whose alpha is uniformly %i', async (alpha) => {
    const rgba = Uint8Array.from(mixed)
    rgba[3] = alpha
    rgba[7] = alpha
    expect(
      await validateBackgroundRemovalOutput(pngImage(rgba), expectedSize, { decoder: decodePng })
    ).toEqual(fail('INVALID_ALPHA'))
  })

  it('checks decoded output dimensions and RGBA length, not only the PNG header', async () => {
    for (const value of [decoded(new Uint8Array(4)), { ...decoded(), width: 1 }]) {
      const decoder = async () => value
      expect(await validateBackgroundRemovalOutput(pngImage(), expectedSize, { decoder })).toEqual(
        fail(value.width === 1 ? 'DIMENSIONS' : 'INVALID_IMAGE')
      )
    }
  })

  it('discards output cancelled during decode', async () => {
    const controller = new AbortController()
    const decoder: TrustedImageDecoder = async (bytes, metadata) => {
      const result = await decodePng(bytes, metadata)
      controller.abort()
      return result
    }
    expect(
      await validateBackgroundRemovalOutput(pngImage(), expectedSize, {
        decoder,
        signal: controller.signal
      })
    ).toEqual(fail('CANCELLED'))
  })

  it('accepts mixed alpha and returns detached encoded and pixel bytes', async () => {
    const source = pngImage()
    const original = Buffer.from(source)
    let pixels: Uint8Array = new Uint8Array()
    const decoder: TrustedImageDecoder = async (bytes, metadata) => {
      const result = await decodePng(bytes, metadata)
      pixels = result.rgba
      return result
    }
    const result = await validateBackgroundRemovalOutput(source, expectedSize, { decoder })
    expect(result).toMatchObject({ ok: true, image: { bytes: original, rgba: mixed } })
    if (!result.ok) throw new Error('expected success')
    expect(result.image.rgba.buffer).not.toBe(pixels.buffer)
    expect(result.image.bytes.buffer).not.toBe(source.buffer)
    pixels.fill(0)
    source.fill(0)
    expect(result.image.rgba).toEqual(mixed)
    expect(result.image.bytes).toEqual(original)
  })

  it('allows partial alpha without claiming semantic segmentation quality', async () => {
    const rgba = Uint8Array.from([10, 20, 30, 127, 40, 50, 60, 127])
    expect(
      await validateBackgroundRemovalOutput(pngImage(rgba), expectedSize, { decoder: decodePng })
    ).toMatchObject({ ok: true })
  })
})
