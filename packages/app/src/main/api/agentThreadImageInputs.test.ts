import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBinaryChunkTransport } from '@shared/binaryChunkProtocol'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import {
  captureThreadRecentImages,
  prepareThreadImageBytes,
  prepareThreadInlineImage,
  THREAD_IMAGE_INPUT_MAX_BYTES
} from './agentThreadImageInputs'

const codec = vi.hoisted(() => ({ decode: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: codec.decode } }))
const chunk = (kind: string, data: Buffer) => {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(kind, 4)
  data.copy(bytes, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4)
  return bytes
}
// Deterministic RGBA fixture. Large header cases intentionally do not contain all
// pixels: codec is mocked; these prove preflight and transformation plumbing only.
const png = (width = 1, height = 1, extras: Buffer[] = []) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    ...extras,
    chunk('IDAT', deflateSync(Buffer.from([0, 12, 34, 56, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const attachment = (bytes = png()): ChatAttachment => ({
  type: 'image',
  url: `data:image/png;base64,${bytes.toString('base64')}`,
  mimeType: 'image/png'
})
const decoded = (width = 1, height = 1) => ({
  isEmpty: () => false,
  getSize: () => ({ width, height }),
  resize: vi.fn()
})
beforeEach(() => {
  codec.decode.mockReset().mockImplementation(() => decoded())
})
afterEach(() => vi.restoreAllMocks())

it('snapshots at most five actually supplied images newest-first, ignoring text, system and tool references', () => {
  const images = Array.from(
    { length: 7 },
    (_, n) => ({ type: 'image', url: `data:fixture-${n}` }) as ChatAttachment
  )
  const messages: ChatMessage[] = [
    { role: 'user', content: 'local-media://not-authority', attachments: images.slice(0, 3) },
    { role: 'assistant', content: 'old', attachments: images.slice(3, 5) },
    { role: 'system', content: 'hidden', attachments: [images[6]] },
    { role: 'user', content: '[image] C:/secret.png', attachments: images.slice(5) },
    {
      role: 'tool',
      content: JSON.stringify({ images }),
      attachments: [images[6]]
    } as unknown as ChatMessage
  ]
  const captured = captureThreadRecentImages(messages)
  expect(captured.map((image) => image!.url)).toEqual(
    [6, 5, 4, 3, 2].map((n) => `data:fixture-${n}`)
  )
  images[6].url = 'file:///different'
  expect(captured[0]!.url).toBe('data:fixture-6')
  expect(codec.decode).not.toHaveBeenCalled()
})

it('preserves a malformed newest image as a failing slot instead of silently selecting an older input', async () => {
  const captured = captureThreadRecentImages([
    {
      role: 'user',
      content: '',
      attachments: [
        attachment(),
        { type: 'image', url: 'x'.repeat(Math.ceil(THREAD_IMAGE_INPUT_MAX_BYTES / 3) * 4 + 100) }
      ]
    }
  ])
  expect(captured[0]).toBeUndefined()
  expect(captured).toHaveLength(2)
  await expect(prepareThreadInlineImage(captured[0], () => {})).rejects.toThrow('Recent image')
  expect(codec.decode).not.toHaveBeenCalled()
})

it('does not turn an untrusted managed reference into tool authority or fall back to an older image', async () => {
  const older = attachment()
  const newest = {
    type: 'image' as const,
    url: 'local-media://forged/image.png',
    mimeType: 'image/png',
    media: {
      version: 1 as const, kind: 'managed' as const,
      relativePath: `originals/00/${'0'.repeat(64)}.png`,
      sha256: '0'.repeat(64), sizeBytes: 1, mimeType: 'image/png'
    }
  }
  const captured = captureThreadRecentImages([{ role: 'user', content: '', attachments: [older, newest] }])
  newest.media.relativePath = 'originals/changed.png'
  expect(captured).toHaveLength(2)
  expect(captured[0]?.url).toBe('local-media://forged/image.png')
  expect(captured[0]?.media).toBeUndefined()
  const fetch = vi.spyOn(globalThis, 'fetch')
  await expect(prepareThreadInlineImage(captured[0], () => {})).rejects.toThrow('Recent image')
  expect(fetch).not.toHaveBeenCalled()
  expect(codec.decode).not.toHaveBeenCalled()
})

it('retains bytes below 2048 and returns exact source/upload hashes without pixels in receipt', async () => {
  const bytes = png(),
    image = attachment(bytes),
    check = vi.fn()
  const result = await prepareThreadInlineImage(image, check)
  expect(codec.decode).toHaveBeenCalledWith(bytes)
  expect(result.dataUrl).toBe(image.url)
  expect(result.receipt).toEqual({
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceSizeBytes: bytes.length,
    sourceMimeType: 'image/png',
    sourceWidth: 1,
    sourceHeight: 1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    resized: false
  })
  expect(JSON.stringify(result.receipt)).not.toContain('base64')
  expect(check.mock.calls.length).toBeGreaterThan(3)
})

it('validates chunked binary bytes/hash and snapshots frames before the caller can change them', async () => {
  const binary = await createBinaryChunkTransport(png(), { mimeType: 'image/png', chunkSize: 32 })
  const image: ChatAttachment = {
    type: 'image',
    url: 'binary:reference-not-a-path',
    binary: { transport: 'chunked-binary-v1', ...binary }
  }
  const captured = captureThreadRecentImages([{ role: 'user', content: '', attachments: [image] }])
  image.binary!.chunks[0] = { ...image.binary!.chunks[0], bytesBase64: 'AAAA' }
  const result = await prepareThreadInlineImage(captured[0], () => {})
  expect(result.dataUrl).toBe(attachment().url)
  codec.decode.mockClear()
  await expect(prepareThreadInlineImage(image, () => {})).rejects.toThrow()
  expect(codec.decode).not.toHaveBeenCalled()
})

it('rejects byte-corrupt valid-length frames before native decode', async () => {
  const binary = await createBinaryChunkTransport(png(), { mimeType: 'image/png' })
  const bad = Buffer.from(binary.chunks[0].bytesBase64, 'base64')
  bad[bad.length - 1] ^= 1
  binary.chunks[0] = { ...binary.chunks[0], bytesBase64: bad.toString('base64') }
  await expect(
    prepareThreadInlineImage(
      { type: 'image', url: '', binary: { transport: 'chunked-binary-v1', ...binary } },
      () => {}
    )
  ).rejects.toThrow('integrity')
  expect(codec.decode).not.toHaveBeenCalled()
})

it.each([
  'https://foreign.invalid/selected.png',
  'file:///secret.png',
  'local-media://foreign/image.png',
  'data:image/svg+xml;base64,PHN2Zz4=',
  'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAEAAUAmJaQAA3AA/v02aAA=',
  'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=',
  'data:image/png;base64,AAA=',
  'data:image/png;base64,\nAAAA',
  'data:image/png;base64,AAAA____'
])('never fetches or opens unsupported/invalid input %s', async (url) => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  await expect(
    prepareThreadInlineImage(
      { type: 'image', url, media: { relativePath: 'C:/forged' } as never },
      () => {}
    )
  ).rejects.toThrow()
  expect(codec.decode).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  { bytes: () => Buffer.alloc(THREAD_IMAGE_INPUT_MAX_BYTES + 1), mime: 'image/png' },
  { bytes: () => png(16385, 1), mime: 'image/png' },
  { bytes: () => png(10000, 10000), mime: 'image/png' },
  { bytes: () => png(0, 1), mime: 'image/png' },
  { bytes: () => png(1, 1, [chunk('acTL', Buffer.alloc(8))]), mime: 'image/png' },
  {
    bytes: () => {
      const bytes = png()
      bytes[29] ^= 1
      return bytes
    },
    mime: 'image/png'
  },
  { bytes: () => png(), mime: 'image/jpeg' }
])('rejects structure/MIME/pixel/byte violations before decode %#', async ({ bytes, mime }) => {
  await expect(prepareThreadImageBytes(bytes(), mime, () => {})).rejects.toThrow()
  expect(codec.decode).not.toHaveBeenCalled()
})

it('refuses unsupported EXIF orientation before decode rather than silently uploading a wrongly rotated image', async () => {
  const tiff = Buffer.from('49492a0008000000010012010300010000000600000000000000', 'hex')
  await expect(
    prepareThreadImageBytes(png(2, 1, [chunk('eXIf', tiff)]), 'image/png', () => {})
  ).rejects.toThrow('Recent image')
  expect(codec.decode).not.toHaveBeenCalled()
})

it.each([
  [4096, 2048, 2048, 1024],
  [1024, 4096, 512, 2048],
  [3001, 1500, 2048, 1024]
])('downscales %sx%s to %sx%s without crop', async (width, height, outWidth, outHeight) => {
  const source = decoded(width, height),
    output = png(outWidth, outHeight)
  source.resize.mockReturnValue({ ...decoded(outWidth, outHeight), toPNG: () => output })
  codec.decode.mockReturnValue(source)
  const result = await prepareThreadImageBytes(png(width, height), 'image/png', () => {})
  expect(source.resize).toHaveBeenCalledWith({
    width: outWidth,
    height: outHeight,
    quality: 'best'
  })
  expect(result.dataUrl).toBe(attachment(output).url)
  expect(result.receipt).toMatchObject({
    sourceMimeType: 'image/png',
    sourceWidth: width,
    sourceHeight: height,
    width: outWidth,
    height: outHeight,
    resized: true,
    sha256: createHash('sha256').update(output).digest('hex')
  })
  expect(result.receipt.sourceSha256).not.toBe(result.receipt.sha256)
})

it.each(['empty', 'dimensions', 'throw', 'invalid-resize', 'bad-png'] as const)(
  'decoder %s fails closed',
  async (kind) => {
    if (kind === 'empty') codec.decode.mockReturnValue({ ...decoded(), isEmpty: () => true })
    if (kind === 'dimensions') codec.decode.mockReturnValue(decoded(2, 1))
    if (kind === 'throw')
      codec.decode.mockImplementation(() => {
        throw Error('codec failed')
      })
    if (kind === 'invalid-resize' || kind === 'bad-png') {
      const image = decoded(4096, 2048)
      image.resize.mockReturnValue({
        ...decoded(kind === 'invalid-resize' ? 2047 : 2048, 1024),
        toPNG: () => Buffer.from('invalid')
      })
      codec.decode.mockReturnValue(image)
    }
    await expect(
      prepareThreadImageBytes(
        png(
          kind.endsWith('resize') || kind === 'bad-png' ? 4096 : 1,
          kind.endsWith('resize') || kind === 'bad-png' ? 2048 : 1
        ),
        'image/png',
        () => {}
      )
    ).rejects.toThrow()
  }
)

it.each(['before', 'during-decode', 'during-resize', 'during-encode'] as const)(
  'drops pixels on revocation %s',
  async (phase) => {
    const controller = new AbortController(),
      reason = Error('scope revoked'),
      check = () => controller.signal.throwIfAborted()
    const image = decoded(4096, 2048)
    image.resize.mockImplementation(() => {
      if (phase === 'during-resize') controller.abort(reason)
      return {
        ...decoded(2048, 1024),
        toPNG: () => {
          if (phase === 'during-encode') controller.abort(reason)
          return png(2048, 1024)
        }
      }
    })
    codec.decode.mockImplementation(() => {
      if (phase === 'during-decode') controller.abort(reason)
      return image
    })
    if (phase === 'before') controller.abort(reason)
    await expect(prepareThreadImageBytes(png(4096, 2048), 'image/png', check)).rejects.toBe(reason)
    if (phase === 'before') expect(codec.decode).not.toHaveBeenCalled()
  }
)
