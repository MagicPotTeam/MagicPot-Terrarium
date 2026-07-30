import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { importManagedMedia, type ManagedMediaMetadata } from './managedMediaStore'

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

  it('repairs inconsistent metadata only after revalidating matching original content', async () => {
    const first = await importMedia({}, { now: () => new Date('2026-01-02T03:04:05.000Z') })
    await fs.writeFile(first.metadataPath, '{"schema":"bad"}\n')
    const repaired = await importMedia(
      { originalFileName: 'replacement.png', provenance: { source: 'repair' } },
      { now: () => new Date('2026-02-03T04:05:06.000Z') }
    )
    const metadata = JSON.parse(
      await fs.readFile(repaired.metadataPath, 'utf8')
    ) as ManagedMediaMetadata
    expect(metadata.originalFileName).toBe('replacement.png')
    expect(metadata.provenance).toEqual({ source: 'repair' })
    expect(metadata.createdAt).toBe('2026-02-03T04:05:06.000Z')
  })

  it('fails instead of repairing metadata when existing original is invalid', async () => {
    const result = await importMedia()
    await fs.writeFile(result.absolutePath, Buffer.alloc(pngBytes.length, 1))
    await fs.writeFile(result.metadataPath, '{"schema":"bad"}\n')
    await expect(importMedia()).rejects.toThrow('conflicts')
    expect(await fs.readFile(result.metadataPath, 'utf8')).toContain('bad')
  })

  it.each([
    'sha256',
    'sizeBytes',
    'mimeType',
    'extension',
    'relativePath',
    'provenance',
    'createdAt',
    'originalFileName'
  ])('repairs metadata with inconsistent %s', async (field) => {
    const result = await importMedia()
    const metadata = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'))
    metadata[field] = field === 'sizeBytes' ? 9 : 'bad'
    await fs.writeFile(result.metadataPath, JSON.stringify(metadata))
    await importMedia()
    const repaired = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'))
    expect(repaired[field]).not.toEqual(metadata[field])
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
})
