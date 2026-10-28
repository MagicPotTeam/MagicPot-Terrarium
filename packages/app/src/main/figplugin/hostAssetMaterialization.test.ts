import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'
import { materializeSessionAsset } from './hostAssetMaterialization'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const decode = vi.hoisted(() => ({ createFromBuffer: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: decode.createFromBuffer } }))

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
function chunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([size, body, crc])
}
function png(width = 1, height = 1, animation = false): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(animation ? [chunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
// Compressed-pixel decoding is the explicit mocked Electron boundary. These small
// envelopes exercise real ManagedMedia and predecode format checks, not a real codec.
function jpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63,
    0, 0, 0xff, 0xd9
  ])
}
function webp(animation = false): Buffer {
  const frame = Buffer.alloc(18)
  frame.write('VP8 ')
  frame.writeUInt32LE(10, 4)
  frame[11] = 0x9d
  frame[12] = 1
  frame[13] = 0x2a
  frame.writeUInt16LE(1, 14)
  frame.writeUInt16LE(1, 16)
  const extension = Buffer.alloc(18)
  extension.write('VP8X')
  extension.writeUInt32LE(10, 4)
  if (animation) extension[8] = 2
  const riff = Buffer.alloc(12)
  riff.write('RIFF')
  riff.write('WEBP', 8)
  const bytes = Buffer.concat([riff, extension, frame])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return bytes
}

let root: string
let staged: string[]
beforeEach(async () => {
  vi.restoreAllMocks()
  decode.createFromBuffer.mockReset().mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 })
  })
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'asset-materialization-test-')))
  staged = []
  const make = fs.mkdtemp.bind(fs)
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args) => {
    const created = await make(...args)
    staged.push(String(created))
    return created
  })
})
afterEach(async () => {
  for (const temporary of staged)
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  vi.restoreAllMocks()
  const absolute = path.resolve(root)
  if (absolute !== root || !path.basename(root).startsWith('asset-materialization-test-'))
    throw new Error('Unexpected test cleanup root')
  await fs.rm(absolute, { recursive: true, force: true })
})

const options = () => ({
  signal: new AbortController().signal,
  check: vi.fn(),
  maxBytes: FIGPLUGIN_ASSET_MAX_BYTES
})
async function source(bytes: Buffer, extension = 'png'): Promise<string> {
  const filename = path.join(root, `synthetic.${extension}`)
  await fs.writeFile(filename, bytes)
  return filename
}

describe('temporary local-preview image materialization (real filesystem)', () => {
  it.each([
    ['png', png(), 'image/png'],
    ['jpeg', jpeg(), 'image/jpeg'],
    ['webp', webp(), 'image/webp']
  ] as const)(
    'preserves exact %s bytes, hashes them, and removes the temporary ManagedMedia copy',
    async (extension, bytes, mimeType) => {
      const filename = await source(bytes, extension)
      const result = await materializeSessionAsset(filename, options())
      expect(result).toEqual({
        bytes,
        mimeType,
        width: 1,
        height: 1,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      expect(await fs.readFile(filename)).toEqual(bytes)
      expect(decode.createFromBuffer).toHaveBeenCalledWith(bytes)
      expect(staged).toHaveLength(1)
    }
  )

  it.each([
    ['oversized file', () => Buffer.alloc(FIGPLUGIN_ASSET_MAX_BYTES + 1)],
    ['oversized dimension', () => png(4097, 1)],
    ['pixel budget', () => png(4096, 4097)],
    ['animated PNG', () => png(1, 1, true)],
    ['truncated', () => png().subarray(0, 32)],
    ['bad signature', () => Buffer.alloc(64)],
    [
      'bad CRC',
      () => {
        const bytes = png()
        bytes[29] ^= 1
        return bytes
      }
    ]
  ] as const)('rejects %s before invoking the decoder', async (_label, make) => {
    const filename = await source(make())
    await expect(materializeSessionAsset(filename, options())).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it('rejects WebP animation before decoding', async () => {
    await expect(
      materializeSessionAsset(await source(webp(true), 'webp'), options())
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it.each(['empty', 'wrong dimensions', 'decoder exception'] as const)(
    'rejects %s without sharing or altering the source',
    async (failure) => {
      const bytes = png()
      const filename = await source(bytes)
      if (failure === 'empty')
        decode.createFromBuffer.mockReturnValue({
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 })
        })
      if (failure === 'wrong dimensions')
        decode.createFromBuffer.mockReturnValue({
          isEmpty: () => false,
          getSize: () => ({ width: 2, height: 1 })
        })
      if (failure === 'decoder exception')
        decode.createFromBuffer.mockImplementation(() => {
          throw new Error(filename)
        })
      const error = await materializeSessionAsset(filename, options()).catch((value) => value)
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(String(error)).not.toContain(filename)
      expect(decode.createFromBuffer.mock.calls[0][0].every((byte: number) => byte === 0)).toBe(
        true
      )
      expect(await fs.readFile(filename)).toEqual(bytes)
    }
  )

  it('does not accept an extension in place of the actual image format', async () => {
    await expect(materializeSessionAsset(await source(jpeg()), options())).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it('applies a signed plugin ceiling lower than the global image budget before decoding', async () => {
    await expect(
      materializeSessionAsset(await source(png()), {
        ...options(),
        maxBytes: 32
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid materialization ceiling %s',
    async (maxBytes) => {
      await expect(
        materializeSessionAsset(await source(png()), {
          ...options(),
          maxBytes
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(staged).toHaveLength(0)
    }
  )

  it.each([
    '../synthetic.png',
    '\\\\server\\share\\synthetic.png',
    'source.png\0',
    'https://invalid.example/image.png'
  ])('rejects non-native or malformed path %s without reading it', async (filename) => {
    await expect(materializeSessionAsset(filename, options())).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(staged).toHaveLength(0)
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it('aborts a selected import and removes its operation-owned temporary store', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      materializeSessionAsset(await source(png()), {
        signal: controller.signal,
        maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
        check: () => {}
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it('rechecks authority after creating a temporary store and cleans it on invalidation', async () => {
    const check = vi.fn().mockImplementation(() => {
      if (check.mock.calls.length >= 3) throw new Error('selection invalidated')
    })
    await expect(
      materializeSessionAsset(await source(png()), {
        signal: new AbortController().signal,
        maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
        check
      })
    ).rejects.toThrow()
    expect(staged).toHaveLength(1)
    expect(decode.createFromBuffer).not.toHaveBeenCalled()
  })

  it('erases retained bytes if the final cleanup recheck invalidates an otherwise decoded result', async () => {
    const check = vi.fn().mockImplementation(() => {
      if (check.mock.calls.length >= 8) throw new Error('selection invalidated after cleanup')
    })
    await expect(
      materializeSessionAsset(await source(png()), {
        signal: new AbortController().signal,
        maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
        check
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(decode.createFromBuffer).toHaveBeenCalledOnce()
    expect(decode.createFromBuffer.mock.calls[0][0].every((byte: number) => byte === 0)).toBe(true)
  })
})
