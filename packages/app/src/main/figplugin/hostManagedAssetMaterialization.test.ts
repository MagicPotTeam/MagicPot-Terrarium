import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { vol } from 'memfs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FigPluginBridgeError } from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_MAX_BYTES, type FigPluginAssetMime } from '@shared/figplugin/hostAssets'
import {
  figPluginManagedAssetReferenceSchema,
  type FigPluginManagedAssetReference
} from '@shared/figplugin/managedSessionAsset'
import * as mediaStore from '../llmProxy/managedMediaStore'
import { materializeManagedSessionAsset } from './hostAssetMaterialization'

const boundary = vi.hoisted(() => ({
  getMediaDir: vi.fn(),
  decode: vi.fn()
}))
vi.mock('../llmProxy/chatMediaDir', () => ({ getChatMediaDir: boundary.getMediaDir }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: boundary.decode } }))

const root = path.resolve('owned-managed-output-fixture', 'userData', '.chat_media')
const outside = path.resolve('owned-managed-output-fixture', 'outside')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const options = () => ({
  check: vi.fn(),
  signal: new AbortController().signal,
  maxBytes: FIGPLUGIN_ASSET_MAX_BYTES
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
// These envelopes test real store integrity and static-format preflight. Electron
// compressed-pixel decoding is the explicit mock, not a real-codec acceptance claim.
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

beforeEach(async () => {
  vi.restoreAllMocks()
  vol.reset()
  boundary.getMediaDir.mockReset().mockReturnValue(root)
  boundary.decode.mockReset().mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 })
  })
  await fs.mkdir(root, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vol.reset()
})

const publish = async (
  namespace = '',
  bytes = png(),
  mimeType: FigPluginAssetMime = 'image/png'
) => {
  const storeRoot = path.join(root, ...namespace.split('/'))
  const imported = await mediaStore.importManagedMedia(
    storeRoot,
    {
      bytes,
      mimeType,
      originalFileName: `synthetic.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)}`,
      provenance: { source: 'synthetic-completed-output' }
    },
    { authorizedRoot: root }
  )
  const reference = figPluginManagedAssetReferenceSchema.parse({
    ...imported.reference,
    relativePath: path.relative(root, imported.absolutePath).split(path.sep).join('/')
  })
  return { ...imported, reference, bytes }
}

describe('main-owned completed managed image materialization', () => {
  it.each([
    ['PNG', png(), 'image/png'],
    ['JPEG', jpeg, 'image/jpeg'],
    ['WebP', webp(), 'image/webp']
  ] as const)(
    'reads exact %s original bytes through the real store and leaves all stored state unchanged',
    async (_label, bytes, mimeType) => {
      const source = await publish('', bytes, mimeType)
      const before = vol.toJSON()
      const result = await materializeManagedSessionAsset(source.reference, options())
      expect(result).toEqual({ bytes, mimeType, width: 1, height: 1, sha256: hash(bytes) })
      expect(boundary.decode).toHaveBeenCalledWith(result.bytes)
      expect(vol.toJSON()).toEqual(before)
      result.bytes.fill(0)
      expect(await fs.readFile(source.absolutePath)).toEqual(bytes)
    }
  )

  it.each([
    'task/run-1',
    'model/model-1',
    'user-output/output-1',
    'codex-images-run-1',
    'comfy-outputs/tasks/run-1'
  ])('resolves the actual scoped original store for %s', async (namespace) => {
    const source = await publish(namespace)
    const read = vi.spyOn(mediaStore, 'readManagedMediaBytes')
    const result = await materializeManagedSessionAsset(source.reference, options())
    expect(result.bytes).toEqual(source.bytes)
    expect(read).toHaveBeenCalledWith(
      await fs.realpath(path.join(root, ...namespace.split('/'))),
      expect.objectContaining({ sha256: source.reference.sha256 }),
      { authorizedRoot: root, maxBytes: FIGPLUGIN_ASSET_MAX_BYTES }
    )
  })

  it.each([0, -1, 1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid signed byte limit %s before resolution or allocation',
    async (maxBytes) => {
      const source = await publish()
      const resolve = vi.spyOn(mediaStore, 'resolveManagedMediaReference')
      const read = vi.spyOn(mediaStore, 'readManagedMediaBytes')
      await expect(
        materializeManagedSessionAsset(source.reference, { ...options(), maxBytes })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(resolve).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(boundary.decode).not.toHaveBeenCalled()
    }
  )

  it('enforces request size against the signed ceiling and global 8 MiB before streaming resolution', async () => {
    const source = await publish()
    const resolve = vi.spyOn(mediaStore, 'resolveManagedMediaReference')
    for (const [reference, maxBytes] of [
      [source.reference, source.bytes.length - 1],
      [
        { ...source.reference, sizeBytes: FIGPLUGIN_ASSET_MAX_BYTES + 1 },
        FIGPLUGIN_ASSET_MAX_BYTES * 2
      ]
    ] as const) {
      await expect(
        materializeManagedSessionAsset(reference, { ...options(), maxBytes })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(boundary.getMediaDir).not.toHaveBeenCalled()
    expect(boundary.decode).not.toHaveBeenCalled()
    const read = vi.spyOn(mediaStore, 'readManagedMediaBytes')
    await materializeManagedSessionAsset(source.reference, {
      ...options(),
      maxBytes: FIGPLUGIN_ASSET_MAX_BYTES * 2
    })
    expect(read.mock.calls[0][2].maxBytes).toBe(FIGPLUGIN_ASSET_MAX_BYTES)
  })

  it('requires strict managed source metadata rather than paths, derivative/status fields or client ownership claims', async () => {
    const source = await publish()
    const resolve = vi.spyOn(mediaStore, 'resolveManagedMediaReference')
    const cases = [
      { ...source.reference, sourcePath: source.absolutePath },
      { ...source.reference, originalUrl: source.localMediaUrl },
      { ...source.reference, derivatives: [] },
      { ...source.reference, status: 'ready' },
      { ...source.reference, owner: 'claimed-project' },
      { ...source.reference, kind: 'project-asset' },
      { ...source.reference, mimeType: 'image/gif' },
      { ...source.reference, relativePath: '../outside.png' }
    ]
    for (const reference of cases)
      await expect(
        materializeManagedSessionAsset(reference as FigPluginManagedAssetReference, options())
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(resolve).not.toHaveBeenCalled()
    expect(boundary.decode).not.toHaveBeenCalled()
  })

  it.each(['hash', 'size', 'mime', 'metadata', 'original-bytes', 'missing'] as const)(
    'rejects %s mismatch through the real resolver without leaking file paths',
    async (kind) => {
      const source = await publish()
      const reference = { ...source.reference }
      if (kind === 'hash') reference.sha256 = '9'.repeat(64)
      if (kind === 'size') reference.sizeBytes++
      if (kind === 'mime') reference.mimeType = 'image/jpeg'
      if (kind === 'metadata') await fs.writeFile(source.metadataPath, '{}')
      if (kind === 'original-bytes')
        await fs.writeFile(source.absolutePath, Buffer.alloc(source.bytes.length))
      if (kind === 'missing') await fs.unlink(source.absolutePath)
      const error = await materializeManagedSessionAsset(reference, options()).catch(
        (error) => error
      )
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(String(error)).not.toContain(root)
      expect(String(error)).not.toContain(source.absolutePath)
      expect(boundary.decode).not.toHaveBeenCalled()
    }
  )

  it.each(['root', 'parent', 'namespace'] as const)(
    'does not let a %s symlink redefine the app-owned authorized root',
    async (kind) => {
      const source = await publish(kind === 'namespace' ? 'task/run-1' : '')
      const target =
        kind === 'root'
          ? root
          : kind === 'parent'
            ? path.dirname(root)
            : path.join(root, 'task', 'run-1')
      await fs.mkdir(path.dirname(outside), { recursive: true })
      await fs.rename(target, outside)
      await fs.symlink(outside, target, 'junction')
      await expect(
        materializeManagedSessionAsset(source.reference, options())
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(boundary.decode).not.toHaveBeenCalled()
    }
  )

  it.each(['animated', 'dimension-limit'] as const)(
    'rejects %s image envelopes before Electron decoding',
    async (kind) => {
      const source = await publish('', kind === 'animated' ? png(1, 1, true) : png(4097, 1))
      const read = mediaStore.readManagedMediaBytes
      let retained: Buffer | undefined
      vi.spyOn(mediaStore, 'readManagedMediaBytes').mockImplementation(async (...args) => {
        retained = await read(...args)
        return retained
      })
      await expect(
        materializeManagedSessionAsset(source.reference, options())
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(boundary.decode).not.toHaveBeenCalled()
      expect(retained?.every((value) => value === 0)).toBe(true)
      expect(await fs.readFile(source.absolutePath)).toEqual(source.bytes)
    }
  )

  it.each(['empty', 'wrong-size', 'exception', 'changed-buffer'] as const)(
    'erases retained bytes after decoder %s failure without modifying the source',
    async (kind) => {
      const source = await publish()
      boundary.decode.mockImplementation((bytes: Buffer) => {
        if (kind === 'exception') throw new Error(source.absolutePath)
        if (kind === 'changed-buffer') bytes[bytes.length - 1] ^= 1
        return {
          isEmpty: () => kind === 'empty',
          getSize: () => ({ width: kind === 'wrong-size' ? 2 : 1, height: 1 })
        }
      })
      const error = await materializeManagedSessionAsset(source.reference, options()).catch(
        (error) => error
      )
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(String(error)).not.toContain(source.absolutePath)
      expect(boundary.decode.mock.calls[0][0].every((value: number) => value === 0)).toBe(true)
      expect(await fs.readFile(source.absolutePath)).toEqual(source.bytes)
    }
  )

  it('rejects a pre-aborted operation before root lookup or resolver work', async () => {
    const source = await publish()
    const controller = new AbortController()
    controller.abort('must-not-leak')
    const resolve = vi.spyOn(mediaStore, 'resolveManagedMediaReference')
    await expect(
      materializeManagedSessionAsset(source.reference, { ...options(), signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(boundary.getMediaDir).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not follow a new configured root while the initial canonical-root check awaits', async () => {
    const source = await publish()
    const realpath = fs.realpath.bind(fs)
    const entered = deferred<void>()
    const gate = deferred<void>()
    vi.spyOn(fs, 'realpath').mockImplementationOnce(async (...args) => {
      const result = await realpath(...args)
      entered.resolve()
      await gate.promise
      return result
    })
    const pending = materializeManagedSessionAsset(source.reference, options()).catch(
      (error) => error
    )
    await entered.promise
    boundary.getMediaDir.mockReturnValue(outside)
    gate.resolve()
    expect(await pending).toMatchObject({ code: 'CONFIGURATION_CHANGED' })
    expect(boundary.decode).not.toHaveBeenCalled()
  })

  it.each(['abort', 'root-change', 'source-change', 'input-mutation'] as const)(
    'rechecks authority and immutable selection after real resolution (%s)',
    async (kind) => {
      const source = await publish()
      const selected = { ...source.reference }
      const controller = new AbortController()
      const resolve = mediaStore.resolveManagedMediaReference
      vi.spyOn(mediaStore, 'resolveManagedMediaReference').mockImplementation(async (...args) => {
        const result = await resolve(...args)
        if (kind === 'abort') controller.abort()
        if (kind === 'root-change') boundary.getMediaDir.mockReturnValue(outside)
        if (kind === 'source-change')
          await fs.writeFile(source.absolutePath, Buffer.alloc(source.bytes.length))
        if (kind === 'input-mutation') selected.sha256 = '9'.repeat(64)
        return result
      })
      const result = materializeManagedSessionAsset(selected, {
        ...options(),
        signal: controller.signal
      })
      if (kind === 'input-mutation') {
        expect(await result).toMatchObject({ bytes: source.bytes, sha256: source.reference.sha256 })
      } else {
        await expect(result).rejects.toMatchObject({
          code:
            kind === 'abort'
              ? 'CANCELLED'
              : kind === 'root-change'
                ? 'CONFIGURATION_CHANGED'
                : 'INVALID_REQUEST'
        })
        expect(boundary.decode).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['abort', 'authority-revoked', 'root-change', 'root-replaced'] as const)(
    'erases the owned read buffer when %s occurs before decoding',
    async (kind) => {
      const source = await publish()
      const controller = new AbortController()
      let revoked = false
      let retained: Buffer | undefined
      const read = mediaStore.readManagedMediaBytes
      vi.spyOn(mediaStore, 'readManagedMediaBytes').mockImplementation(async (...args) => {
        retained = await read(...args)
        if (kind === 'abort') controller.abort()
        if (kind === 'authority-revoked') revoked = true
        if (kind === 'root-change') boundary.getMediaDir.mockReturnValue(outside)
        if (kind === 'root-replaced') {
          await fs.rename(root, outside)
          await fs.mkdir(root)
        }
        return retained
      })
      await expect(
        materializeManagedSessionAsset(source.reference, {
          ...options(),
          signal: controller.signal,
          check: () => {
            if (revoked) throw new FigPluginBridgeError('EXPIRED')
          }
        })
      ).rejects.toMatchObject({
        code:
          kind === 'abort'
            ? 'CANCELLED'
            : kind === 'authority-revoked'
              ? 'EXPIRED'
              : 'CONFIGURATION_CHANGED'
      })
      expect(retained?.every((value) => value === 0)).toBe(true)
      expect(boundary.decode).not.toHaveBeenCalled()
    }
  )

  it.each(['abort', 'root-change'] as const)(
    'does not return decoded bytes after final %s',
    async (kind) => {
      const source = await publish()
      const controller = new AbortController()
      boundary.decode.mockImplementation(() => {
        if (kind === 'abort') controller.abort()
        else boundary.getMediaDir.mockReturnValue(outside)
        return { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }
      })
      await expect(
        materializeManagedSessionAsset(source.reference, {
          ...options(),
          signal: controller.signal
        })
      ).rejects.toMatchObject({ code: kind === 'abort' ? 'CANCELLED' : 'CONFIGURATION_CHANGED' })
      expect(boundary.decode.mock.calls[0][0].every((value: number) => value === 0)).toBe(true)
    }
  )
})
