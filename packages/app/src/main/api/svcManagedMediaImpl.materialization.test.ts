import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import {
  importManagedMedia,
  readManagedMediaBytes,
  type ImportedManagedMedia
} from '../llmProxy/managedMediaStore'
import { ManagedMediaSvcImpl } from './svcManagedMediaImpl'

// These races exercise Windows handles/reparse points, not memfs behavior.
vi.mock('./canvasThumbnailSidecarAdapter', () => ({
  generateCanvasThumbnailsViaSidecar: vi.fn(() => {
    throw new Error('No native image processing is permitted in this fixture')
  })
}))

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
const webp = Buffer.alloc(30)
webp.write('RIFF')
webp.writeUInt32LE(22, 4)
webp.write('WEBPVP8X', 8)
webp.writeUInt32LE(10, 16)

function localUrl(file: string): string {
  return `local-media://${new URL(`file://${file}`).toString().slice('file://'.length)}`
}

describe('managed media request materialization races (real filesystem)', () => {
  let temp: string
  let root: string
  beforeEach(async () => {
    temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-materialize-')))
    root = path.join(temp, 'media')
    await fs.mkdir(root)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(temp, { recursive: true, force: true })
  })

  async function fixture(kind: 'original' | 'derivative') {
    const imported = await importManagedMedia(
      root,
      {
        bytes: kind === 'original' ? gif : png,
        mimeType: kind === 'original' ? 'image/gif' : 'image/png',
        originalFileName: kind === 'original' ? 'fixture.gif' : 'fixture.png',
        provenance: { source: 'synthetic-materialization-test' }
      },
      { authorizedRoot: root }
    )
    if (kind === 'original') return { imported, target: imported.absolutePath, bytes: gif }
    const originalSha256 = imported.reference.sha256!
    const identity = sha(
      Buffer.from(
        `${originalSha256}\0${2048}\0webp\0canvas-thumbnail-sidecar/v2\0apply-exif-before-resize/v1\0crop-meaningful-transparent-border/v1`
      )
    )
    const relativePath = `derivatives/${originalSha256.slice(0, 2)}/${originalSha256}/${identity}/committed/image.webp`
    const target = path.join(root, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, webp)
    await fs.writeFile(
      path.join(path.dirname(target), 'manifest.json'),
      JSON.stringify({
        schema: 'magicpot.managed-media-derivative/v4',
        identity,
        originalSha256,
        format: 'webp',
        encoderVersion: 'canvas-thumbnail-sidecar/v2',
        orientationPolicy: 'apply-exif-before-resize/v1',
        cropPolicy: 'crop-meaningful-transparent-border/v1',
        purpose: 'managed-media-derivative',
        maxEdge: 2048,
        relativePath,
        mimeType: 'image/webp',
        sizeBytes: webp.length,
        width: 1,
        height: 1,
        sha256: sha(webp),
        localMediaUrl: localUrl(target)
      })
    )
    return { imported, target, bytes: webp }
  }

  function request(imported: ImportedManagedMedia) {
    return { reference: imported.reference, transport: 'request-data-url' as const }
  }

  it('materializes the resolved original and does not invoke derivative generation', async () => {
    const { imported, bytes } = await fixture('original')
    const ensureDerivative = vi.fn()
    const service = new ManagedMediaSvcImpl({ getMediaDir: () => root, ensureDerivative })
    const result = await service.materializeForRequest(request(imported))
    expect(Buffer.from(result.dataUrl.split(',')[1], 'base64')).toEqual(bytes)
    expect(result.sizeBytes).toBe(bytes.length)
    expect(result.mimeType).toBe('image/gif')
    expect(ensureDerivative).not.toHaveBeenCalled()
  })

  it('does not use an existing derivative when the request reference resolves to the original', async () => {
    const { imported, bytes } = await fixture('original')
    const ensureDerivative = vi.fn(async () => ({
      purpose: 'managed-media-derivative' as const,
      maxEdge: 2048 as const,
      relativePath: 'derivatives/fixture.webp',
      mimeType: 'image/webp' as const,
      sizeBytes: webp.length,
      width: 1,
      height: 1,
      sha256: sha(webp),
      localMediaUrl: localUrl(path.join(root, 'derivatives/fixture.webp'))
    }))
    const service = new ManagedMediaSvcImpl({ getMediaDir: () => root, ensureDerivative })
    const result = await service.materializeForRequest(request(imported))
    expect(Buffer.from(result.dataUrl.split(',')[1], 'base64')).toEqual(bytes)
    expect(result.mimeType).toBe('image/gif')
    expect(result.sizeBytes).toBe(bytes.length)
    expect(ensureDerivative).not.toHaveBeenCalled()
  })

  it('revalidates original bytes before materialization', async () => {
    const { imported, target, bytes } = await fixture('original')
    const service = new ManagedMediaSvcImpl({
      getMediaDir: () => root,
      readMediaBytes: async (authorizedRoot, selected, options) => {
        await fs.writeFile(target, Buffer.alloc(bytes.length))
        return readManagedMediaBytes(authorizedRoot, selected, options)
      }
    })
    await expect(service.materializeForRequest(request(imported))).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_CORRUPT'
    })
  })

  it.for(['same-size overwrite', 'same-size replacement', 'file symlink', 'parent reparse'])(
    'rejects original %s mutation before materialization',
    async (mutation, context) => {
      const { imported, target, bytes } = await fixture('original')
      const replacement = Buffer.from(bytes)
      replacement[replacement.length - 1] ^= 1
      expect(sha(replacement)).not.toBe(sha(bytes))
      const outside = path.join(temp, 'outside')
      await fs.mkdir(outside)
      const outsideFile = path.join(outside, path.basename(target))
      await fs.writeFile(outsideFile, replacement)
      const preparedLink = path.join(temp, 'prepared-link')
      if (mutation === 'file symlink' || mutation === 'parent reparse') {
        try {
          await fs.symlink(
            mutation === 'file symlink' ? outsideFile : outside,
            preparedLink,
            mutation === 'file symlink' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir'
          )
        } catch (error) {
          if (
            ['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
          ) {
            context.skip(`Filesystem link unavailable: ${(error as NodeJS.ErrnoException).code}`)
            return
          }
          throw error
        }
      }
      let verified = false
      let mutated = false
      const service = new ManagedMediaSvcImpl({
        getMediaDir: () => root,
        readMediaBytes: async (authorizedRoot, selected, options) => {
          verified = true
          if (mutation === 'same-size overwrite') await fs.writeFile(target, replacement)
          else if (mutation === 'parent reparse') {
            await fs.rename(path.dirname(target), `${path.dirname(target)}-old`)
            await fs.rename(preparedLink, path.dirname(target))
          } else {
            await fs.rename(target, `${target}.old`)
            await fs.rename(mutation === 'file symlink' ? preparedLink : outsideFile, target)
          }
          mutated = true
          return readManagedMediaBytes(authorizedRoot, selected, options)
        }
      })
      await expect(service.materializeForRequest(request(imported))).rejects.toMatchObject({
        code: 'MANAGED_MEDIA_CORRUPT',
        message: 'Managed media is corrupt'
      })
      expect(verified).toBe(true)
      expect(mutated).toBe(true)
    }
  )
})
