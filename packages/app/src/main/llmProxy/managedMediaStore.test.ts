import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import {
  importManagedMedia,
  importManagedMediaFile,
  importManagedMediaStream,
  resolveManagedMediaReference
} from './managedMediaStore'

function png(width = 1, height = 1): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([signature, ihdr, iend])
}
const pngBytes = png()

function input(overrides: Record<string, unknown> = {}) {
  return {
    bytes: pngBytes,
    mimeType: 'image/png',
    originalFileName: 'capture.png',
    provenance: { source: 'unit-test', requestId: 'request-1' },
    ...overrides
  }
}

describe('managedMediaStore', () => {
  let tempRoot = ''
  let authorizedRoot = ''
  let storeRoot = ''

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('managed-media-store')
    authorizedRoot = path.join(tempRoot, 'userData', '.chat_media')
    storeRoot = path.join(authorizedRoot, 'managed')
    await fs.mkdir(authorizedRoot, { recursive: true })
  })
  afterEach(async () => fs.rm(tempRoot, { recursive: true, force: true }))

  const importMedia = (overrides: Record<string, unknown> = {}, dependencies = {}) =>
    importManagedMedia(storeRoot, input(overrides), { authorizedRoot, ...dependencies })
  const streamInput = (overrides: Record<string, unknown> = {}) => ({
    chatMediaRoot: storeRoot,
    stream: Readable.from([pngBytes.subarray(0, 10), pngBytes.subarray(10)]),
    mimeType: 'image/png',
    originalFileName: 'capture.png',
    provenance: { source: 'unit-test' },
    ...overrides
  })

  it('imports beneath the authorized chat-media root and returns an authorized display URL', async () => {
    const result = await importMedia({}, { now: () => new Date('2026-01-02T03:04:05.000Z') })
    const sha256 = createHash('sha256').update(pngBytes).digest('hex')
    expect(result.reference).toEqual({
      version: 1,
      kind: 'managed',
      relativePath: `originals/${sha256.slice(0, 2)}/${sha256}.png`,
      sha256,
      sizeBytes: pngBytes.length,
      mimeType: 'image/png',
      originalFileName: 'capture.png'
    })
    expect(result.localMediaUrl).toMatch(/^local-media:/)
    expect(path.relative(authorizedRoot, result.absolutePath)).not.toMatch(/^\.\./)
  })

  it('rejects arbitrary or noncanonical authorization roots', async () => {
    await expect(
      importManagedMedia(path.join(tempRoot, 'arbitrary'), input(), { authorizedRoot })
    ).rejects.toThrow('not authorized')
    await expect(
      importManagedMedia(storeRoot, input(), { authorizedRoot: path.join(tempRoot, 'missing') })
    ).rejects.toThrow('canonical')
  })

  it('is idempotent across concurrent imports', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => importMedia()))
    expect(new Set(results.map((result) => result.absolutePath))).toHaveLength(1)
    expect(await fs.readFile(results[0].absolutePath)).toEqual(pngBytes)
    expect(
      (await fs.readdir(path.dirname(results[0].absolutePath))).filter((name) =>
        name.includes('.tmp')
      )
    ).toEqual([])
  })

  it.each([
    ['truncated PNG', pngBytes.subarray(0, 30)],
    ['zero dimensions', png(0, 1)],
    ['huge dimensions', png(70_000, 1)],
    ['signature only', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]
  ])('rejects structurally invalid %s', async (_label, bytes) => {
    await expect(importMedia({ bytes })).rejects.toThrow('structurally invalid')
  })

  it.each(['CON.png', 'name. ', 'bad?.png', '../escape.png', 'folder/file.png'])(
    'rejects Windows-unsafe filename %s',
    async (originalFileName) =>
      expect(importMedia({ originalFileName })).rejects.toThrow('filename')
  )

  it('keeps content metadata immutable across filename and provenance aliases', async () => {
    const first = await importMedia({}, { now: () => new Date('2026-01-02T03:04:05.000Z') })
    const before = await fs.readFile(first.metadataPath, 'utf8')
    const second = await importMedia({
      originalFileName: 'replacement.png',
      provenance: { source: 'different-import', requestId: 'request-2' }
    })
    expect(second.absolutePath).toBe(first.absolutePath)
    expect(await fs.readFile(first.metadataPath, 'utf8')).toBe(before)
    await expect(
      resolveManagedMediaReference(storeRoot, first.reference, { authorizedRoot })
    ).resolves.toMatchObject({ integrityVerified: true })
    await expect(
      resolveManagedMediaReference(storeRoot, second.reference, { authorizedRoot })
    ).resolves.toMatchObject({ integrityVerified: true })
  })

  it('does not rewrite corrupt immutable content metadata', async () => {
    const result = await importMedia()
    await fs.writeFile(result.metadataPath, '{"schema":"bad"}\n')
    await expect(importMedia()).rejects.toThrow('metadata conflicts')
    expect(await fs.readFile(result.metadataPath, 'utf8')).toContain('bad')
  })

  it('fails when existing original is invalid', async () => {
    const result = await importMedia()
    await fs.writeFile(result.absolutePath, Buffer.alloc(pngBytes.length, 1))
    await expect(importMedia()).rejects.toThrow('conflicts')
  })

  it('uses an exclusive-copy Windows fallback when hard links are unsupported', async () => {
    const link = vi.fn(async () => {
      const error = new Error('simulated Windows policy') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    const result = await importMedia({}, { fs: { ...fs, link } as typeof fs })
    expect(link).toHaveBeenCalled()
    expect(await fs.readFile(result.absolutePath)).toEqual(pngBytes)
  })

  it('cleans original, metadata, and temporary files when metadata publication fails', async () => {
    let links = 0
    const failingFs = {
      ...fs,
      link: async (...args: Parameters<typeof fs.link>) => {
        links += 1
        if (links === 2) {
          const error = new Error('metadata failure') as NodeJS.ErrnoException
          error.code = 'EIO'
          throw error
        }
        return fs.link(...args)
      }
    } as typeof fs
    await expect(importMedia({}, { fs: failingFs })).rejects.toThrow('metadata failure')
    const files = await fs.readdir(storeRoot, { recursive: true })
    expect(files.some((name) => String(name).endsWith('.tmp'))).toBe(false)
    expect(files.some((name) => String(name).endsWith('.json'))).toBe(false)
    expect(files.some((name) => String(name).endsWith('.png'))).toBe(false)
  })

  it('rejects symlinked managed directories', async () => {
    const outside = path.join(tempRoot, 'outside')
    await fs.mkdir(path.join(storeRoot, 'originals'), { recursive: true })
    await fs.mkdir(outside)
    const prefix = createHash('sha256').update(pngBytes).digest('hex').slice(0, 2)
    try {
      await fs.symlink(
        outside,
        path.join(storeRoot, 'originals', prefix),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    await expect(importMedia()).rejects.toThrow('safely contained')
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('imports streams and files through the same deduplicating pipeline', async () => {
    const sourcePath = path.join(tempRoot, 'source.png')
    await fs.writeFile(sourcePath, pngBytes)
    const [streamed, filed] = await Promise.all([
      importManagedMediaStream(streamInput(), { authorizedRoot }),
      importManagedMediaFile(
        {
          chatMediaRoot: storeRoot,
          sourcePath,
          mimeType: 'image/png',
          originalFileName: 'source.png',
          provenance: { source: 'file-test' }
        },
        { authorizedRoot }
      )
    ])
    expect(streamed.absolutePath).toBe(filed.absolutePath)
  })

  it.each([
    ['empty', Readable.from([]), 100, 'empty'],
    ['oversize', Readable.from([pngBytes]), pngBytes.length - 1, 'exceeds']
  ])('rejects %s streams and cleans staging', async (_label, stream, maxBytes, message) => {
    await expect(
      importManagedMediaStream(streamInput({ stream, maxBytes }), { authorizedRoot })
    ).rejects.toThrow(message)
    expect(await fs.readdir(path.join(storeRoot, '.staging'))).toEqual([])
  })

  it('cleans staging after stream errors and aborts', async () => {
    async function* failing(): AsyncGenerator<Buffer> {
      yield pngBytes.subarray(0, 10)
      throw new Error('source failed')
    }
    await expect(
      importManagedMediaStream(streamInput({ stream: failing() }), { authorizedRoot })
    ).rejects.toThrow('source failed')
    const controller = new AbortController()
    async function* aborted(): AsyncGenerator<Buffer> {
      yield pngBytes.subarray(0, 10)
      controller.abort()
      yield pngBytes.subarray(10)
    }
    await expect(
      importManagedMediaStream(streamInput({ stream: aborted(), signal: controller.signal }), {
        authorizedRoot
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await fs.readdir(path.join(storeRoot, '.staging'))).toEqual([])
  })

  it('aborts stalled stream iteration and returns the iterator', async () => {
    const controller = new AbortController()
    let returned = false
    const stream: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Buffer>>(() => undefined),
          return: async () => {
            returned = true
            return { done: true, value: undefined }
          }
        }
      }
    }
    const pending = importManagedMediaStream(streamInput({ stream, signal: controller.signal }), {
      authorizedRoot
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'MANAGED_MEDIA_ABORTED'
    })
    expect(returned).toBe(true)
    expect(await fs.readdir(path.join(storeRoot, '.staging'))).toEqual([])
  })

  it('rejects a huge single chunk before copying it', async () => {
    const huge = new Uint8Array(pngBytes.length + 1)
    await expect(
      importManagedMediaStream(
        streamInput({ stream: Readable.from([huge]), maxBytes: pngBytes.length }),
        {
          authorizedRoot
        }
      )
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_TOO_LARGE' })
  })

  it('cleans newly published content after post-publication validation failure', async () => {
    let originalPath = ''
    const lstat = async (...args: Parameters<typeof fs.lstat>) => {
      const result = await fs.lstat(...args)
      const candidate = String(args[0])
      if (candidate.endsWith('.png')) {
        originalPath = candidate
        return new Proxy(result, {
          get(target, property, receiver) {
            if (property === 'size') {
              return typeof target.size === 'bigint' ? target.size + 1n : target.size + 1
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
      return result
    }
    await expect(importMedia({}, { fs: { ...fs, lstat } as typeof fs })).rejects.toThrow('unsafe')
    if (originalPath) await expect(fs.access(originalPath)).rejects.toThrow()
  })

  it('rejects resolver intermediate symlink or junction paths', async () => {
    const imported = await importMedia()
    const prefixDirectory = path.dirname(imported.absolutePath)
    const outside = path.join(tempRoot, 'resolver-outside')
    await fs.mkdir(outside)
    await fs.rename(prefixDirectory, `${prefixDirectory}.real`)
    try {
      await fs.symlink(outside, prefixDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    await expect(
      resolveManagedMediaReference(storeRoot, imported.reference, { authorizedRoot })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
  })

  it('uses typed unsupported and corrupt errors', async () => {
    await expect(importMedia({ mimeType: 'text/plain' })).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_UNSUPPORTED'
    })
    await expect(importMedia({ bytes: Buffer.alloc(pngBytes.length) })).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_INVALID'
    })
  })

  it('imports files without readFile and rejects source symlinks or managed sources', async () => {
    const sourcePath = path.join(tempRoot, 'source.png')
    await fs.writeFile(sourcePath, pngBytes)
    const readFile = vi.fn(fs.readFile)
    const result = await importManagedMediaFile(
      {
        chatMediaRoot: storeRoot,
        sourcePath,
        mimeType: 'image/png',
        originalFileName: 'source.png',
        provenance: { source: 'file-test' }
      },
      { authorizedRoot, fs: { ...fs, readFile } as typeof fs }
    )
    expect(readFile).not.toHaveBeenCalled()
    await expect(
      importManagedMediaFile(
        { ...streamInput(), sourcePath: result.absolutePath },
        { authorizedRoot }
      )
    ).rejects.toThrow('managed target')
    const linkPath = path.join(tempRoot, 'source-link.png')
    try {
      await fs.symlink(sourcePath, linkPath, 'file')
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    await expect(
      importManagedMediaFile({ ...streamInput(), sourcePath: linkPath }, { authorizedRoot })
    ).rejects.toThrow('non-symlink')
  })

  it('detects file mutation during import and cleans staging', async () => {
    const sourcePath = path.join(tempRoot, 'mutable.png')
    await fs.writeFile(sourcePath, pngBytes)
    let mutated = false
    const open = async (...args: Parameters<typeof fs.open>) => {
      if (!mutated && String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
        mutated = true
        await fs.appendFile(sourcePath, Buffer.from([0]))
      }
      return fs.open(...args)
    }
    await expect(
      importManagedMediaFile(
        { ...streamInput(), sourcePath },
        { authorizedRoot, fs: { ...fs, open } as typeof fs }
      )
    ).rejects.toThrow('changed during import')
    expect(await fs.readdir(path.join(storeRoot, '.staging'))).toEqual([])
  })

  it('resolves references after restart and reports forged, missing, and corrupt data', async () => {
    const imported = await importMedia()
    const resolved = await resolveManagedMediaReference(storeRoot, imported.reference, {
      authorizedRoot
    })
    expect(resolved.absolutePath).toBe(imported.absolutePath)
    expect(resolved.metadata.sha256).toBe(imported.reference.sha256)
    await expect(
      resolveManagedMediaReference(
        storeRoot,
        { ...imported.reference, relativePath: `originals/aa/${imported.reference.sha256}.png` },
        { authorizedRoot }
      )
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
    await fs.unlink(imported.absolutePath)
    await expect(
      resolveManagedMediaReference(storeRoot, imported.reference, { authorizedRoot })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_MISSING' })
    await fs.writeFile(imported.absolutePath, Buffer.alloc(pngBytes.length, 1))
    await expect(
      resolveManagedMediaReference(storeRoot, imported.reference, { authorizedRoot })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
  })
})
