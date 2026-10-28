import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatResp } from '@shared/api/svcLLMProxy'
import { FigPluginBridgeError } from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_MAX_BYTES } from '@shared/figplugin/hostAssets'
import * as mediaStore from '../llmProxy/managedMediaStore'
import {
  materializeProviderImageOutput,
  type ProviderImageOutputMaterializer
} from './providerImageOutput'

const boundary = vi.hoisted(() => ({
  getMediaDir: vi.fn(),
  decode: vi.fn(),
  download: vi.fn()
}))
vi.mock('../llmProxy/chatMediaDir', () => ({ getChatMediaDir: boundary.getMediaDir }))
vi.mock('../api/safeRemoteDownload', () => ({ safeRemoteDownload: boundary.download }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: boundary.decode } }))

const root = path.resolve('owned-provider-output-fixture', 'userData', '.chat_media')
const outside = path.resolve('owned-provider-output-fixture', 'outside')
const runId = '318ff54d-c910-4fbb-b54b-4cf07d35bf11'
const otherRunId = '318ff54d-c910-4fbb-b54b-4cf07d35bf12'
const scopeFor = (id = runId) => path.join(root, 'user-output', `figplugin-${id}`)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const options = (): Parameters<ProviderImageOutputMaterializer>[1] => ({
  runId,
  check: vi.fn(),
  signal: new AbortController().signal,
  maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
  deadlineAt: Date.now() + 60_000
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const chunk = (type: string, bytes: Buffer) => {
  const output = Buffer.alloc(bytes.length + 12)
  output.writeUInt32BE(bytes.length)
  output.write(type, 4, 4, 'ascii')
  bytes.copy(output, 8)
  let crc = 0xffffffff
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}
const png = (width = 1, height = 1, animated = false) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(animated ? [chunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, 128, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
// Store integrity and static-format checks are real. These tiny JPEG/WebP
// envelopes do not claim native compressed-pixel decoding, which is mocked.
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
  0, 0xff, 0xd9
])
const webp = () => {
  const header = Buffer.alloc(12)
  header.write('RIFF')
  header.write('WEBP', 8)
  const frame = Buffer.alloc(18)
  frame.write('VP8 ')
  frame.writeUInt32LE(10, 4)
  frame[11] = 0x9d
  frame[12] = 1
  frame[13] = 0x2a
  frame.writeUInt16LE(1, 14)
  frame.writeUInt16LE(1, 16)
  const bytes = Buffer.concat([header, frame])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return bytes
}
const dataUrl = (bytes = png(), mimeType = 'image/png') =>
  `data:${mimeType};base64,${bytes.toString('base64')}`
const response = (url = dataUrl()): LLMChatResp => ({
  content: 'Generated image.',
  imageUrl: url,
  attachments: [{ type: 'image', url }]
})
const storedPath = (relativePath: string) => path.join(root, ...relativePath.split('/'))
const exists = async (target: string) =>
  fs.lstat(target).then(
    () => true,
    () => false
  )
const expectScopeGone = async (id = runId) => expect(await exists(scopeFor(id))).toBe(false)

beforeEach(async () => {
  vi.restoreAllMocks()
  vol.reset()
  boundary.getMediaDir.mockReset().mockReturnValue(root)
  boundary.decode.mockReset().mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 })
  })
  boundary.download.mockReset().mockImplementation(async () => ({
    buffer: png(),
    contentType: 'image/png',
    finalUrl: new URL('https://cdn.example.com/image.png')
  }))
  await fs.mkdir(root, { recursive: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vol.reset()
})

describe('bounded Provider image output ingestion', () => {
  it.each([
    ['PNG', png(), 'image/png'],
    ['JPEG', jpeg, 'image/jpeg'],
    ['WebP', webp(), 'image/webp']
  ] as const)(
    'imports exact %s bytes through the real stream store and verified read',
    async (_label, bytes, mimeType) => {
      const streamImport = vi.spyOn(mediaStore, 'importManagedMediaStream')
      const resolve = vi.spyOn(mediaStore, 'resolveManagedMediaReference')
      const read = vi.spyOn(mediaStore, 'readManagedMediaBytes')
      const output = await materializeProviderImageOutput(
        response(dataUrl(bytes, mimeType)),
        options()
      )
      expect(output).toMatchObject({
        width: 1,
        height: 1,
        reference: { kind: 'managed', sha256: hash(bytes), sizeBytes: bytes.length, mimeType }
      })
      expect(output.reference.relativePath).toMatch(
        new RegExp(`^user-output/figplugin-${runId}/originals/`)
      )
      expect(output.localMediaUrl).toMatch(/^local-media:/)
      expect(await fs.readFile(storedPath(output.reference.relativePath))).toEqual(bytes)
      expect(streamImport).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
      expect(boundary.download).not.toHaveBeenCalled()
      expect(boundary.decode.mock.calls[0][0].every((value: number) => value === 0)).toBe(true)
      await output.discard()
      await expectScopeGone()
    }
  )

  it.each([undefined, 'stop'] as const)(
    'accepts successful finishReason %s and exact duplicate output URLs once',
    async (finishReason) => {
      const value = response()
      value.finishReason = finishReason
      value.attachments!.push({ ...value.attachments![0] })
      const output = await materializeProviderImageOutput(value, options())
      expect(output.reference.sizeBytes).toBe(png().length)
      expect(boundary.decode).toHaveBeenCalledTimes(1)
      await output.discard()
    }
  )

  it.each(['primary-only', 'attachment-only'] as const)('accepts one %s source', async (kind) => {
    const value = response()
    if (kind === 'primary-only') delete value.attachments
    else delete value.imageUrl
    const output = await materializeProviderImageOutput(value, options())
    await output.discard()
  })

  it('uses main-owned names/provenance and never persists source URL or Provider metadata', async () => {
    const source = 'https://images.example.com/output.png?secret=must-not-persist'
    const value = response(source)
    value.metadata = { claimedOwner: 'fake-project', sourceUrl: source }
    value.attachments![0].fileName = '../../user-source.png'
    const streamImport = vi.spyOn(mediaStore, 'importManagedMediaStream')
    const output = await materializeProviderImageOutput(value, options())
    expect(streamImport.mock.calls[0][0]).toMatchObject({
      chatMediaRoot: scopeFor(),
      originalFileName: 'generated.png',
      provenance: { source: 'figplugin-provider-image', runId },
      maxBytes: FIGPLUGIN_ASSET_MAX_BYTES
    })
    expect(streamImport.mock.calls[0][0].provenance).toEqual({
      source: 'figplugin-provider-image',
      runId
    })
    expect(JSON.stringify(vol.toJSON())).not.toContain('must-not-persist')
    expect(JSON.stringify(output.reference)).not.toContain('fake-project')
    await output.discard()
  })

  it.each([5000, 60_000])(
    'passes exact bounded HTTPS downloader policy with %s ms remaining',
    async (remaining) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
      const output = await materializeProviderImageOutput(
        response('https://images.example.com/output.png'),
        {
          ...options(),
          maxBytes: 1024,
          deadlineAt: Date.now() + remaining
        }
      )
      expect(boundary.download).toHaveBeenCalledWith('https://images.example.com/output.png', {
        allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp'],
        maxBytes: 1024,
        maxRedirects: 3,
        timeoutMs: Math.min(30_000, remaining),
        signal: expect.any(AbortSignal),
        errorLabel: 'generated image'
      })
      expect(boundary.download.mock.calls[0][1]).not.toHaveProperty('headers')
      await output.discard()
    }
  )

  it('clamps the signed budget to 8 MiB for remote download and real store', async () => {
    const streamImport = vi.spyOn(mediaStore, 'importManagedMediaStream')
    const output = await materializeProviderImageOutput(
      response('https://images.example.com/output.png'),
      {
        ...options(),
        maxBytes: FIGPLUGIN_ASSET_MAX_BYTES * 2
      }
    )
    expect(boundary.download.mock.calls[0][1].maxBytes).toBe(FIGPLUGIN_ASSET_MAX_BYTES)
    expect(streamImport.mock.calls[0][0].maxBytes).toBe(FIGPLUGIN_ASSET_MAX_BYTES)
    await output.discard()
  })

  it.each(['length', 'tool_call', 'cancelled', 'error', 'unknown'])(
    'rejects explicit incomplete outcome %s before filesystem/network work',
    async (finishReason) => {
      await expect(
        materializeProviderImageOutput({ ...response(), finishReason } as LLMChatResp, options())
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(boundary.getMediaDir).not.toHaveBeenCalled()
      expect(boundary.download).not.toHaveBeenCalled()
    }
  )

  it.each([
    'empty',
    'different-primary',
    'two-attachments',
    'video',
    'file',
    'managed',
    'binary',
    'relative-path',
    'tool-fields',
    'tool-history',
    'partial-attachment',
    'too-many-duplicates'
  ] as const)('rejects ambiguous/non-image response %s', async (kind) => {
    const value = response()
    if (kind === 'empty') {
      delete value.imageUrl
      value.attachments = []
    }
    if (kind === 'different-primary') value.imageUrl = 'https://images.example.com/other.png'
    if (kind === 'two-attachments')
      value.attachments!.push({ type: 'image', url: 'https://images.example.com/other.png' })
    if (kind === 'video' || kind === 'file') value.attachments![0].type = kind
    if (kind === 'managed') Object.assign(value.attachments![0], { media: { kind: 'managed' } })
    if (kind === 'binary') Object.assign(value.attachments![0], { binary: {} })
    if (kind === 'relative-path') value.attachments![0].relativePath = 'user-source.png'
    if (kind === 'tool-fields') Object.assign(value, { toolCalls: [{ name: 'read_file' }] })
    if (kind === 'tool-history') value.metadata = { toolHistory: [{ status: 'completed' }] }
    if (kind === 'partial-attachment') value.attachments![0].finishReason = 'length'
    if (kind === 'too-many-duplicates') value.attachments = Array(17).fill(value.attachments![0])
    await expect(materializeProviderImageOutput(value, options())).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(boundary.getMediaDir).not.toHaveBeenCalled()
    expect(boundary.download).not.toHaveBeenCalled()
  })

  it.each([
    'file:///C:/private.png',
    'local-media:///C:/private.png',
    'C:\\private.png',
    '/private.png',
    'blob:generated',
    'http://images.example.com/image.png',
    'https://user:secret@images.example.com/a',
    'https://images.example.com/a#fragment',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://192.168.1.1/a',
    'https://images.example.com/../a\n',
    ' https://images.example.com/a',
    'https://images.example.com\\@localhost/a',
    `https://images.example.com/${'a'.repeat(8192)}`
  ])('rejects non-public/unsafe URL %s without calling the downloader', async (url) => {
    await expect(materializeProviderImageOutput(response(url), options())).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(boundary.download).not.toHaveBeenCalled()
    expect(boundary.decode).not.toHaveBeenCalled()
    await expectScopeGone()
  })

  it.each([
    'data:image/gif;base64,R0lGODlh',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,',
    'data:image/png;base64,AA',
    'data:image/png;base64,AB==',
    'data:image/png;base64,AA===',
    'data:image/png;base64,AA==\n',
    'data:image/png;name=a;base64,AA==',
    'data:image/png;base64,_A==',
    'DATA:image/png;base64,AA=='
  ])('rejects noncanonical data URL %s', async (url) => {
    await expect(materializeProviderImageOutput(response(url), options())).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect(boundary.decode).not.toHaveBeenCalled()
    expect(boundary.download).not.toHaveBeenCalled()
    await expectScopeGone()
  })

  it('rejects signed/global encoded size overflows before base64 decoding or store work', async () => {
    for (const [encoded, maxBytes] of [
      [png().toString('base64'), png().length - 1],
      [
        'A'.repeat(Math.ceil((FIGPLUGIN_ASSET_MAX_BYTES + 1) / 3) * 4),
        FIGPLUGIN_ASSET_MAX_BYTES * 2
      ]
    ] as const) {
      const allocate = vi.spyOn(Buffer, 'from')
      await expect(
        materializeProviderImageOutput(response(`data:image/png;base64,${encoded}`), {
          ...options(),
          maxBytes
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(allocate.mock.calls.some((args) => args[0] === encoded)).toBe(false)
      allocate.mockRestore()
    }
    expect(boundary.decode).not.toHaveBeenCalled()
    await expectScopeGone()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid budget %s before work',
    async (maxBytes) => {
      await expect(
        materializeProviderImageOutput(response(), { ...options(), maxBytes })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(boundary.getMediaDir).not.toHaveBeenCalled()
    }
  )

  it.each([
    '',
    '../other-job',
    runId.toUpperCase(),
    `${runId}\n`,
    '318ff54d-c910-4fbb-054b-4cf07d35bf11'
  ])('requires a canonical main run UUID: %s', async (id) => {
    await expect(
      materializeProviderImageOutput(response(), { ...options(), runId: id })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(boundary.getMediaDir).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid deadline %s',
    async (deadlineAt) => {
      await expect(
        materializeProviderImageOutput(response(), { ...options(), deadlineAt })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(boundary.getMediaDir).not.toHaveBeenCalled()
    }
  )

  it.each(['animated', 'dimension-limit', 'bad-crc', 'wrong-mime'] as const)(
    'rejects %s before native decoding or publication',
    async (kind) => {
      const bytes =
        kind === 'animated' ? png(1, 1, true) : kind === 'dimension-limit' ? png(4097, 1) : png()
      if (kind === 'bad-crc') bytes[bytes.length - 1] ^= 1
      await expect(
        materializeProviderImageOutput(
          response(dataUrl(bytes, kind === 'wrong-mime' ? 'image/jpeg' : 'image/png')),
          options()
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(boundary.decode).not.toHaveBeenCalled()
      await expectScopeGone()
    }
  )

  it.each(['empty', 'dimensions', 'exception', 'mutated-bytes'] as const)(
    'rejects decoder %s and wipes its buffer',
    async (kind) => {
      boundary.decode.mockImplementation((bytes: Buffer) => {
        if (kind === 'exception') throw new Error('private-provider-source')
        if (kind === 'mutated-bytes') bytes[bytes.length - 1] ^= 1
        return {
          isEmpty: () => kind === 'empty',
          getSize: () => ({ width: kind === 'dimensions' ? 2 : 1, height: 1 })
        }
      })
      const error = await materializeProviderImageOutput(response(), options()).catch(
        (error) => error
      )
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(String(error)).not.toContain('private-provider-source')
      expect(boundary.decode.mock.calls[0][0].every((value: number) => value === 0)).toBe(true)
      await expectScopeGone()
    }
  )

  it.each([
    'oversize',
    'content-type',
    'content-mismatch',
    'declared-mime',
    'unsafe-final-url',
    'network-error'
  ] as const)('validates downloader output and sanitizes %s failure', async (kind) => {
    const value = response('https://images.example.com/private-output.png')
    if (kind === 'declared-mime') value.attachments![0].mimeType = 'image/jpeg'
    const downloaded = {
      buffer: kind === 'oversize' ? Buffer.alloc(129) : png(),
      contentType:
        kind === 'content-type'
          ? 'image/gif'
          : kind === 'content-mismatch'
            ? 'image/jpeg'
            : 'image/png',
      finalUrl: new URL(
        kind === 'unsafe-final-url' ? 'https://127.0.0.1/a' : 'https://cdn.example.com/a'
      )
    }
    if (kind === 'network-error') boundary.download.mockRejectedValue(new Error(value.imageUrl))
    else boundary.download.mockResolvedValue(downloaded)
    const error = await materializeProviderImageOutput(value, {
      ...options(),
      maxBytes: 128
    }).catch((error) => error)
    expect(error).toMatchObject({
      code: kind === 'network-error' ? 'UPSTREAM_FAILED' : 'INVALID_REQUEST'
    })
    expect(String(error)).not.toContain('private-output')
    if (kind !== 'network-error') expect(downloaded.buffer.every((byte) => byte === 0)).toBe(true)
    await expectScopeGone()
  })
})

describe('owned scope lifetime and late-result rejection', () => {
  it.each(['abort', 'deadline', 'authority'] as const)(
    'rejects pre-existing %s before IO',
    async (kind) => {
      const controller = new AbortController()
      if (kind === 'abort') controller.abort()
      await expect(
        materializeProviderImageOutput(response(), {
          ...options(),
          signal: controller.signal,
          ...(kind === 'deadline' ? { deadlineAt: Date.now() - 1 } : {}),
          check: () => {
            if (kind === 'authority') throw new FigPluginBridgeError('EXPIRED')
          }
        })
      ).rejects.toMatchObject({
        code: kind === 'abort' ? 'CANCELLED' : kind === 'deadline' ? 'TIMEOUT' : 'EXPIRED'
      })
      expect(boundary.getMediaDir).not.toHaveBeenCalled()
    }
  )

  it.each(['abort', 'root-change', 'deadline', 'response-mutation'] as const)(
    'rechecks %s after an in-flight remote download',
    async (kind) => {
      const controller = new AbortController()
      const entered = deferred<void>()
      const gate = deferred<void>()
      const value = response('https://images.example.com/selected.png')
      const opts = { ...options(), signal: controller.signal }
      const downloaded = png()
      boundary.download.mockImplementation(async () => {
        entered.resolve()
        await gate.promise
        return {
          buffer: downloaded,
          contentType: 'image/png',
          finalUrl: new URL('https://cdn.example.com/image.png')
        }
      })
      const pending = materializeProviderImageOutput(value, opts).catch((error) => error)
      await entered.promise
      if (kind === 'abort') controller.abort()
      if (kind === 'root-change') boundary.getMediaDir.mockReturnValue(outside)
      if (kind === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(opts.deadlineAt + 1)
      if (kind === 'response-mutation') {
        value.imageUrl = 'file:///private.png'
        value.attachments![0].url = 'file:///private.png'
      }
      gate.resolve()
      const result = await pending
      if (kind === 'response-mutation') {
        expect(result.reference.sha256).toBe(hash(png()))
        await result.discard()
      } else
        expect(result).toMatchObject({
          code:
            kind === 'abort'
              ? 'CANCELLED'
              : kind === 'deadline'
                ? 'TIMEOUT'
                : 'CONFIGURATION_CHANGED'
        })
      expect(downloaded.every((byte) => byte === 0)).toBe(true)
      await expectScopeGone()
    }
  )

  it('forwards the absolute deadline to an actively pending download signal', async () => {
    vi.useFakeTimers()
    const entered = deferred<void>()
    boundary.download.mockImplementation(
      (_url, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })
          entered.resolve()
        })
    )
    const pending = materializeProviderImageOutput(response('https://images.example.com/a'), {
      ...options(),
      deadlineAt: Date.now() + 100
    }).catch((error) => error)
    await entered.promise
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toMatchObject({ code: 'TIMEOUT' })
    expect(boundary.download.mock.calls[0][1].signal.aborted).toBe(true)
    await expectScopeGone()
  })

  it.each(['root', 'parent', 'user-output'] as const)(
    'refuses an initial %s symlink without deleting its target',
    async (kind) => {
      const target =
        kind === 'root'
          ? root
          : kind === 'parent'
            ? path.dirname(root)
            : path.join(root, 'user-output')
      if (kind === 'user-output') await fs.mkdir(target)
      await fs.rename(target, outside)
      await fs.symlink(outside, target, 'junction')
      const snapshot = vol.toJSON()
      await expect(materializeProviderImageOutput(response(), options())).rejects.toMatchObject({
        code: 'CONFIGURATION_CHANGED'
      })
      expect(vol.toJSON()).toEqual(snapshot)
    }
  )

  it('refuses a previously existing run scope and never claims its contents', async () => {
    await fs.mkdir(scopeFor(), { recursive: true })
    const sentinel = path.join(scopeFor(), 'pre-existing-user-output.txt')
    await fs.writeFile(sentinel, 'not-owned')
    const snapshot = vol.toJSON()
    await expect(materializeProviderImageOutput(response(), options())).rejects.toMatchObject({
      code: 'UPSTREAM_FAILED'
    })
    expect(vol.toJSON()).toEqual(snapshot)
  })

  it.each(['abort', 'authority', 'root-change', 'deadline', 'store-throws'] as const)(
    'cleans a late real publication after %s without changing adjacent output',
    async (kind) => {
      const sentinel = path.join(root, 'unrelated-user-source.png')
      await fs.writeFile(sentinel, png())
      const controller = new AbortController()
      let revoked = false
      const opts = {
        ...options(),
        signal: controller.signal,
        check: () => {
          if (revoked) throw new FigPluginBridgeError('EXPIRED')
        }
      }
      const importReal = mediaStore.importManagedMediaStream
      vi.spyOn(mediaStore, 'importManagedMediaStream').mockImplementation(async (...args) => {
        const result = await importReal(...args)
        if (kind === 'abort') controller.abort()
        if (kind === 'authority') revoked = true
        if (kind === 'root-change') boundary.getMediaDir.mockReturnValue(outside)
        if (kind === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(opts.deadlineAt + 1)
        if (kind === 'store-throws') throw new Error(result.absolutePath)
        return result
      })
      const error = await materializeProviderImageOutput(response(), opts).catch((error) => error)
      expect(error).toMatchObject({
        code:
          kind === 'abort'
            ? 'CANCELLED'
            : kind === 'authority'
              ? 'EXPIRED'
              : kind === 'deadline'
                ? 'TIMEOUT'
                : kind === 'root-change'
                  ? 'CONFIGURATION_CHANGED'
                  : 'UPSTREAM_FAILED'
      })
      expect(String(error)).not.toContain(root)
      await expectScopeGone()
      expect(await fs.readFile(sentinel)).toEqual(png())
    }
  )

  it('captures an exclusively created scope before observing cancellation and rolls it back', async () => {
    const controller = new AbortController()
    const mkdir = fs.mkdir.bind(fs)
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      const result = await mkdir(...args)
      if (String(args[0]) === scopeFor()) controller.abort()
      return result
    })
    await expect(
      materializeProviderImageOutput(response(), { ...options(), signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    await expectScopeGone()
  })

  it.each(['abort', 'hash-mismatch'] as const)(
    'checks final verified bytes after %s and erases both read/decoded buffers',
    async (kind) => {
      const controller = new AbortController()
      const readReal = mediaStore.readManagedMediaBytes
      let readBytes: Buffer | undefined
      vi.spyOn(mediaStore, 'readManagedMediaBytes').mockImplementation(async (...args) => {
        readBytes = await readReal(...args)
        if (kind === 'abort') controller.abort()
        else readBytes[readBytes.length - 1] ^= 1
        return readBytes
      })
      await expect(
        materializeProviderImageOutput(response(), { ...options(), signal: controller.signal })
      ).rejects.toMatchObject({ code: kind === 'abort' ? 'CANCELLED' : 'INVALID_REQUEST' })
      expect(readBytes?.every((byte) => byte === 0)).toBe(true)
      expect(boundary.decode.mock.calls[0][0].every((byte: number) => byte === 0)).toBe(true)
      await expectScopeGone()
    }
  )

  it('isolates identical bytes in different jobs and makes discard concurrent/idempotent', async () => {
    const first = await materializeProviderImageOutput(response(), options())
    const second = await materializeProviderImageOutput(response(), {
      ...options(),
      runId: otherRunId
    })
    const unlink = vi.spyOn(fs, 'unlink')
    const remove = vi.spyOn(fs, 'rm')
    await Promise.all([first.discard(), first.discard()])
    expect(unlink).toHaveBeenCalledTimes(2)
    expect(remove).not.toHaveBeenCalled()
    await expectScopeGone()
    expect(await fs.readFile(storedPath(second.reference.relativePath))).toEqual(png())
    await fs.mkdir(scopeFor())
    await fs.writeFile(path.join(scopeFor(), 'later-owner.txt'), 'preserve')
    await first.discard()
    expect(await fs.readFile(path.join(scopeFor(), 'later-owner.txt'), 'utf8')).toBe('preserve')
    await second.discard()
  })

  it('can discard its original scope after the configured root changes without touching the new root', async () => {
    const output = await materializeProviderImageOutput(response(), options())
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'preserve.txt'), 'new root')
    boundary.getMediaDir.mockReturnValue(outside)
    await output.discard()
    await expectScopeGone()
    expect(await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8')).toBe('new root')
  })

  it.each(['root', 'namespace', 'scope', 'descendant'] as const)(
    'refuses cleanup after a %s directory identity replacement',
    async (kind) => {
      const output = await materializeProviderImageOutput(response(), options())
      const target =
        kind === 'root'
          ? root
          : kind === 'namespace'
            ? path.join(root, 'user-output')
            : kind === 'scope'
              ? scopeFor()
              : path.join(scopeFor(), 'metadata')
      await fs.rename(target, outside)
      await fs.mkdir(target)
      const sentinel = path.join(target, 'unowned.txt')
      await fs.writeFile(sentinel, 'not owned')
      const snapshot = vol.toJSON()
      await expect(output.discard()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
      expect(vol.toJSON()).toEqual(snapshot)
    }
  )

  it.each(['file-replaced', 'file-symlink', 'descendant-symlink'] as const)(
    'does not remove an unowned %s during discard',
    async (kind) => {
      const output = await materializeProviderImageOutput(response(), options())
      await fs.mkdir(outside)
      const external = path.join(outside, 'external.png')
      await fs.writeFile(external, png())
      const filename = storedPath(output.reference.relativePath)
      if (kind === 'descendant-symlink') {
        await fs.rename(path.join(scopeFor(), 'metadata'), path.join(outside, 'saved-metadata'))
        await fs.symlink(outside, path.join(scopeFor(), 'metadata'), 'junction')
      } else {
        await fs.rename(filename, path.join(outside, 'original.png'))
        if (kind === 'file-symlink') await fs.symlink(external, filename)
        else await fs.writeFile(filename, Buffer.alloc(png().length))
      }
      const snapshot = vol.toJSON()
      await expect(output.discard()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
      expect(vol.toJSON()).toEqual(snapshot)
    }
  )

  it('leaves unexpected files rather than recursively deleting an owned scope', async () => {
    const output = await materializeProviderImageOutput(response(), options())
    const unknown = path.join(scopeFor(), 'user-file.txt')
    await fs.writeFile(unknown, 'do not delete')
    const remove = vi.spyOn(fs, 'rm')
    await expect(output.discard()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(await fs.readFile(unknown, 'utf8')).toBe('do not delete')
    expect(remove).not.toHaveBeenCalled()
  })

  it('fails closed on root replacement during import, preserving both displaced and replacement trees', async () => {
    const importReal = mediaStore.importManagedMediaStream
    vi.spyOn(mediaStore, 'importManagedMediaStream').mockImplementation(async (...args) => {
      const result = await importReal(...args)
      await fs.rename(root, outside)
      await fs.mkdir(root)
      await fs.writeFile(path.join(root, 'not-owned.txt'), 'preserve')
      return result
    })
    await expect(materializeProviderImageOutput(response(), options())).rejects.toMatchObject({
      code: 'CONFIGURATION_CHANGED'
    })
    expect(await fs.readFile(path.join(root, 'not-owned.txt'), 'utf8')).toBe('preserve')
    expect(await exists(path.join(outside, 'user-output', `figplugin-${runId}`))).toBe(true)
  })
})
