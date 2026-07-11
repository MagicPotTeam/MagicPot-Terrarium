import { vol } from 'memfs'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasThumbnailManifest } from '@shared/api/svcCanvasThumbnail'
import type { CanvasThumbnailSidecarBatchThumbnailRequest } from './canvasThumbnailSidecarAdapter'
import {
  CanvasThumbnailSvcImpl,
  type CanvasThumbnailSvcImplOptions
} from './svcCanvasThumbnailImpl'

const electronMock = vi.hoisted(() => ({
  userDataRoot: '',
  createThumbnailFromPath: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name !== 'userData') {
        throw new Error(`Unexpected app path request: ${name}`)
      }
      return electronMock.userDataRoot
    })
  },
  nativeImage: {
    createThumbnailFromPath: electronMock.createThumbnailFromPath
  }
}))

function getDesktopTrashRoot(): string {
  if (process.env.MAGICPOT_TEST_TRASH_ROOT) {
    return process.env.MAGICPOT_TEST_TRASH_ROOT
  }

  return path.join(process.cwd(), '.magicpot-trash', 'cache-ipc-worker')
}

function normalizeIdentityPath(canonicalPath: string): string {
  return canonicalPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function buildCacheKey(input: {
  canonicalPath: string
  sizeBytes: number
  lastModifiedMs: number
}): string {
  const identity = [
    normalizeIdentityPath(input.canonicalPath),
    Math.max(0, Math.floor(input.sizeBytes)),
    Math.max(0, Math.floor(input.lastModifiedMs))
  ].join('\n')
  return `thumb-${fnv1a32(identity, 0x811c9dc5)}${fnv1a32(identity, 0x9e3779b9)}`
}

function createManifest({
  sourcePath,
  src = 'renderer-supplied-src'
}: {
  sourcePath: string
  src?: string
}): CanvasThumbnailManifest {
  const canonicalPath = fs.realpathSync.native(sourcePath)
  const stats = fs.statSync(canonicalPath)
  const sourceSizeBytes = Math.floor(stats.size)
  const sourceLastModifiedMs = Math.floor(stats.mtimeMs)
  const cacheKey = buildCacheKey({
    canonicalPath,
    sizeBytes: sourceSizeBytes,
    lastModifiedMs: sourceLastModifiedMs
  })
  return {
    version: 1,
    cacheKey,
    canonicalPath: normalizeIdentityPath(canonicalPath),
    sourceSizeBytes,
    sourceLastModifiedMs,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    levels: [
      {
        maxSide: 128,
        filename: 'thumb-128.webp',
        src,
        mimeType: 'image/webp',
        width: 128,
        height: 64,
        sizeBytes: 4
      },
      {
        maxSide: 256,
        filename: 'thumb-256.png',
        src,
        mimeType: 'image/png',
        width: 256,
        height: 128,
        sizeBytes: 4
      }
    ]
  }
}

describe('CanvasThumbnailSvcImpl', () => {
  let testRoot: string
  let service: CanvasThumbnailSvcImpl

  beforeEach(() => {
    vol.reset()
    testRoot = path.join(getDesktopTrashRoot(), `${Date.now()}-${process.pid}-${Math.random()}`)
    electronMock.userDataRoot = path.join(testRoot, 'userData')
    fs.mkdirSync(testRoot, { recursive: true })
    service = new CanvasThumbnailSvcImpl()
    electronMock.createThumbnailFromPath.mockReset()
  })

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true })
    vol.reset()
  })

  async function createSourceFile(filename = 'source.png'): Promise<string> {
    const sourcePath = path.join(testRoot, filename)
    await fsp.writeFile(sourcePath, Buffer.from([1, 2, 3, 4]))
    const mtime = new Date('2026-05-02T00:00:00.000Z')
    await fsp.utimes(sourcePath, mtime, mtime)
    return sourcePath
  }

  function createServiceWithSidecar(
    generateViaSidecar: CanvasThumbnailSvcImplOptions['generateViaSidecar']
  ): CanvasThumbnailSvcImpl {
    return new CanvasThumbnailSvcImpl({ generateViaSidecar })
  }

  function createSidecarManifest(manifest: CanvasThumbnailManifest, cacheRoot: string) {
    const entryDir = path.join(cacheRoot, manifest.cacheKey)
    const thumbnail = manifest.levels[manifest.levels.length - 1]
    return {
      schemaVersion: 1,
      version: 1,
      id: manifest.cacheKey,
      cacheKey: manifest.cacheKey,
      canonicalPath: manifest.canonicalPath,
      sourceSizeBytes: manifest.sourceSizeBytes,
      sourceLastModifiedMs: manifest.sourceLastModifiedMs,
      sourceWidth: 256,
      sourceHeight: 128,
      sourceIdentity: {
        kind: 'local-file' as const,
        canonicalPath: manifest.canonicalPath,
        sizeBytes: manifest.sourceSizeBytes,
        lastModifiedMs: manifest.sourceLastModifiedMs,
        cacheKey: manifest.cacheKey,
        cacheRootDir: cacheRoot
      },
      source: {
        path: manifest.canonicalPath,
        canonicalPath: manifest.canonicalPath,
        byteLength: manifest.sourceSizeBytes,
        sizeBytes: manifest.sourceSizeBytes,
        lastModifiedMs: manifest.sourceLastModifiedMs,
        width: 256,
        height: 128,
        colorType: 'Rgba8',
        format: 'png'
      },
      hash: { algorithm: 'sha256' as const, hex: 'abc123' },
      levels: manifest.levels.map((level) => ({
        maxSide: level.maxSide,
        width: level.width,
        height: level.height,
        filename: level.filename,
        path: path.join(entryDir, level.filename),
        src: 'local-media://sidecar-src-is-not-trusted-by-main',
        mimeType: level.mimeType,
        sizeBytes: level.sizeBytes
      })),
      thumbnail: {
        maxSide: thumbnail.maxSide,
        path: path.join(entryDir, thumbnail.filename),
        width: thumbnail.width,
        height: thumbnail.height,
        filename: thumbnail.filename,
        mimeType: thumbnail.mimeType,
        sizeBytes: thumbnail.sizeBytes,
        format: thumbnail.mimeType === 'image/webp' ? ('webp' as const) : ('png' as const)
      },
      manifestPath: path.join(entryDir, 'manifest.json'),
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt
    }
  }

  async function writeManifestSet(
    manifest: CanvasThumbnailManifest,
    cacheRootDir?: string
  ): Promise<Awaited<ReturnType<CanvasThumbnailSvcImpl['writeThumbnailSet']>>> {
    return service.writeThumbnailSet({
      cacheKey: manifest.cacheKey,
      ...(cacheRootDir ? { cacheRootDir } : {}),
      manifest,
      files: [
        {
          filename: 'thumb-128.webp',
          data: new Uint8Array([1, 2, 3, 4])
        },
        {
          filename: 'thumb-256.png',
          data: new Uint8Array([5, 6, 7, 8])
        }
      ]
    })
  }

  it('returns canonical source metadata for existing and missing files', async () => {
    const sourcePath = await createSourceFile()
    const stats = fs.statSync(sourcePath)

    const metadata = await service.getSourceFileMetadata({ fullPath: sourcePath })

    expect(metadata.exists).toBe(true)
    expect(metadata.canonicalPath).toBe(fs.realpathSync.native(sourcePath))
    expect(metadata.sizeBytes).toBe(4)
    expect(metadata.lastModifiedMs).toBe(stats.mtimeMs)

    const missingPath = path.join(testRoot, 'missing.png')
    const missing = await service.getSourceFileMetadata({ fullPath: missingPath })
    expect(missing).toMatchObject({
      exists: false,
      canonicalPath: path.resolve(missingPath),
      sizeBytes: 0,
      lastModifiedMs: 0
    })
  })

  it('allows the default app userData cache root', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })
    const response = await writeManifestSet(manifest)

    const cacheRoot = path.join(electronMock.userDataRoot, 'project-canvas-thumbnail-cache')
    const manifestPath = path.join(cacheRoot, manifest.cacheKey, 'manifest.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    expect(response.manifest.cacheKey).toBe(manifest.cacheKey)
    expect(response.manifest.canonicalPath).toBe(manifest.canonicalPath)
    expect(response.manifest.levels.every((level) => level.src.startsWith('local-media:'))).toBe(
      true
    )

    const read = await service.readThumbnailManifest({ cacheKey: manifest.cacheKey })
    expect(read.manifest?.cacheKey).toBe(manifest.cacheKey)
    expect(read.manifest?.levels.map((file) => file.filename)).toEqual([
      'thumb-128.webp',
      'thumb-256.png'
    ])
    expect(read.manifest?.levels.every((level) => level.src.startsWith('local-media:'))).toBe(true)
  })

  it('rejects unsafe arbitrary explicit cache roots outside allowed test roots', async () => {
    const unsafeRoot = path.join(os.tmpdir(), 'not-a-magicpot-thumbnail-cache')

    await expect(service.getThumbnailCacheRoot({ cacheRootDir: unsafeRoot })).rejects.toThrow(
      /Unsafe canvas thumbnail cache root/
    )
    expect(fs.existsSync(unsafeRoot)).toBe(false)
  })

  it('allows an explicit app-owned project canvas cache root under userData', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })
    const cacheRoot = path.join(
      electronMock.userDataRoot,
      'renderer-state',
      'project-canvas',
      '.canvas-id__canvas-id',
      '.cache',
      'canvas-thumbnails'
    )

    await writeManifestSet(manifest, cacheRoot)
    expect(fs.existsSync(path.join(cacheRoot, manifest.cacheKey, 'manifest.json'))).toBe(true)

    const read = await service.readThumbnailManifest({
      cacheRootDir: cacheRoot,
      cacheKey: manifest.cacheKey
    })
    expect(read.manifest?.cacheKey).toBe(manifest.cacheKey)
  })

  it('allows an explicit cache root under the repo test trash root', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })
    const cacheRoot = path.join(getDesktopTrashRoot(), 'thumbnail-cache-artifacts')

    const rootResponse = await service.getThumbnailCacheRoot({ cacheRootDir: cacheRoot })
    expect(path.normalize(rootResponse.cacheRoot)).toBe(
      path.normalize(fs.realpathSync.native(cacheRoot))
    )

    await writeManifestSet(manifest, cacheRoot)
    const read = await service.readThumbnailManifest({
      cacheRootDir: cacheRoot,
      cacheKey: manifest.cacheKey
    })
    expect(read.manifest?.cacheKey).toBe(manifest.cacheKey)
  })

  it('allows an explicit magicpot temp cache root', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })
    const cacheRoot = path.join(os.tmpdir(), 'magicpot-canvas-thumbnail-vitest', 'cache')

    await writeManifestSet(manifest, cacheRoot)
    expect(fs.existsSync(path.join(cacheRoot, manifest.cacheKey, 'manifest.json'))).toBe(true)
  })

  it('rejects cache entries that resolve outside the authorized cache root through symlinks', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })
    const cacheRoot = path.join(getDesktopTrashRoot(), 'thumbnail-cache-symlink-root')
    const escapedEntryRoot = path.join(getDesktopTrashRoot(), 'thumbnail-cache-symlink-escaped')
    await fsp.mkdir(cacheRoot, { recursive: true })
    await fsp.mkdir(escapedEntryRoot, { recursive: true })
    fs.symlinkSync(escapedEntryRoot, path.join(cacheRoot, manifest.cacheKey), 'dir')

    await expect(writeManifestSet(manifest, cacheRoot)).rejects.toThrow(/cache path escaped root/)
    expect(fs.existsSync(path.join(escapedEntryRoot, 'manifest.json'))).toBe(false)
  })

  it('rejects unsafe cache keys, cache filenames, and unreferenced thumbnail writes', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })

    await expect(
      service.readThumbnailManifest({ cacheKey: '../outside-cache-root' })
    ).rejects.toThrow(/Invalid canvas thumbnail cache key/)

    await expect(
      service.writeThumbnailSet({
        cacheKey: manifest.cacheKey,
        manifest: {
          ...manifest,
          levels: [{ ...manifest.levels[0], filename: '../escape.png' }]
        },
        files: [
          {
            filename: '../escape.png',
            data: new Uint8Array([1])
          }
        ]
      })
    ).rejects.toThrow(/Invalid canvas thumbnail filename/)

    await expect(
      service.writeThumbnailSet({
        cacheKey: manifest.cacheKey,
        manifest,
        files: [
          {
            filename: 'other.png',
            data: new Uint8Array([1])
          }
        ]
      })
    ).rejects.toThrow(/not referenced by manifest/)
  })

  it('strips renderer src values before persisting and returns normalized local-media src values', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath, src: 'https://renderer.invalid/thumbnail.webp' })

    const response = await writeManifestSet(manifest)
    expect(response.manifest.levels.every((level) => level.src.startsWith('local-media:'))).toBe(
      true
    )
    expect(response.manifest.levels.some((level) => level.src.includes('renderer.invalid'))).toBe(
      false
    )

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(
          electronMock.userDataRoot,
          'project-canvas-thumbnail-cache',
          manifest.cacheKey,
          'manifest.json'
        ),
        'utf8'
      )
    ) as CanvasThumbnailManifest
    expect(persisted.levels.map((level) => level.src)).toEqual(['', ''])
  })

  it('rejects missing files referenced by the manifest', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })

    await expect(
      service.writeThumbnailSet({
        cacheKey: manifest.cacheKey,
        manifest,
        files: [
          {
            filename: 'thumb-128.webp',
            data: new Uint8Array([1, 2, 3, 4])
          }
        ]
      })
    ).rejects.toThrow(/Missing canvas thumbnail file/)
  })

  it('rejects manifests whose source identity does not match the source file', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })

    await expect(
      writeManifestSet({
        ...manifest,
        sourceSizeBytes: manifest.sourceSizeBytes + 1
      })
    ).rejects.toThrow(/source identity does not match/)

    await expect(
      writeManifestSet({
        ...manifest,
        cacheKey: 'thumb-0123456789abcdef'
      })
    ).rejects.toThrow(/cache key does not match/)
  })

  it('returns null for stale or incomplete manifests on read', async () => {
    const sourcePath = await createSourceFile()
    const manifest = createManifest({ sourcePath })
    await writeManifestSet(manifest)

    const entryDir = path.join(
      electronMock.userDataRoot,
      'project-canvas-thumbnail-cache',
      manifest.cacheKey
    )
    await fsp.writeFile(
      path.join(entryDir, 'manifest.json'),
      JSON.stringify({ ...manifest, sourceSizeBytes: manifest.sourceSizeBytes + 1 })
    )
    await expect(service.readThumbnailManifest({ cacheKey: manifest.cacheKey })).resolves.toEqual({
      manifest: null
    })

    await writeManifestSet(manifest)
    await fsp.rm(path.join(entryDir, 'thumb-256.png'))
    await expect(service.readThumbnailManifest({ cacheKey: manifest.cacheKey })).resolves.toEqual({
      manifest: null
    })
  })

  it('generates a sidecar thumbnail set through the authorized cache root and returns normalized local-media manifest', async () => {
    const sourcePath = await createSourceFile('sidecar-source.png')
    const manifest = createManifest({ sourcePath })
    const cacheRoot = path.join(getDesktopTrashRoot(), 'sidecar-generate-cache')
    const sidecarCalls: CanvasThumbnailSidecarBatchThumbnailRequest[] = []
    const serviceWithSidecar = createServiceWithSidecar(async (request) => {
      sidecarCalls.push(request)
      const entryDir = path.join(request.cacheRoot, manifest.cacheKey)
      await fsp.mkdir(entryDir, { recursive: true })
      for (const level of manifest.levels) {
        await fsp.writeFile(path.join(entryDir, level.filename), Buffer.from([1, 2, 3, 4]))
      }
      await fsp.writeFile(
        path.join(entryDir, 'manifest.json'),
        JSON.stringify(createSidecarManifest(manifest, request.cacheRoot), null, 2),
        'utf8'
      )
      return {
        ok: true,
        response: {
          ok: true,
          cacheRoot: fs.realpathSync.native(request.cacheRoot),
          results: [
            {
              id: manifest.cacheKey,
              ok: true,
              manifest: createSidecarManifest(manifest, request.cacheRoot)
            }
          ]
        },
        binaryPath: 'sidecar.exe',
        args: [],
        stderr: '',
        stderrTruncated: false
      }
    })

    const response = await serviceWithSidecar.generateThumbnailSet({
      fullPath: sourcePath,
      cacheRootDir: cacheRoot,
      levels: [256, 128, 128],
      format: 'image/webp',
      maxConcurrency: 3,
      maxDecodedPixels: 123456,
      timeoutMs: 2500
    })

    expect(sidecarCalls).toHaveLength(1)
    expect(sidecarCalls[0]).toMatchObject({
      cacheRoot: fs.realpathSync.native(cacheRoot),
      items: [{ id: manifest.cacheKey, path: fs.realpathSync.native(sourcePath) }],
      thumbnail: { levels: [128, 256], format: 'webp', allowUpscale: false },
      maxConcurrency: 3,
      maxDecodedPixels: 123456,
      hash: 'sha256'
    })
    expect(response.status).toBe('generated')
    expect(response.sidecar).toEqual({ used: true, fallback: false })
    expect(response.manifest?.cacheKey).toBe(manifest.cacheKey)
    expect(response.manifest?.levels.map((level) => level.filename)).toEqual([
      'thumb-128.webp',
      'thumb-256.png'
    ])
    expect(response.manifest?.levels.every((level) => level.src.startsWith('local-media:'))).toBe(
      true
    )
    expect(response.manifest?.levels.some((level) => level.src.includes('sidecar-src'))).toBe(false)
  })

  it('rejects sidecar-generated manifests that omit requested thumbnail levels', async () => {
    const sourcePath = await createSourceFile('sidecar-missing-level.png')
    const manifest = createManifest({ sourcePath })
    const cacheRoot = path.join(getDesktopTrashRoot(), 'sidecar-missing-level-cache')
    const manifestMissingRequestedLevel: CanvasThumbnailManifest = {
      ...manifest,
      levels: manifest.levels.filter((level) => level.maxSide !== 256)
    }
    const serviceWithSidecar = createServiceWithSidecar(async (request) => {
      const entryDir = path.join(request.cacheRoot, manifest.cacheKey)
      await fsp.mkdir(entryDir, { recursive: true })
      for (const level of manifestMissingRequestedLevel.levels) {
        await fsp.writeFile(path.join(entryDir, level.filename), Buffer.from([1, 2, 3, 4]))
      }
      await fsp.writeFile(
        path.join(entryDir, 'manifest.json'),
        JSON.stringify(
          createSidecarManifest(manifestMissingRequestedLevel, request.cacheRoot),
          null,
          2
        ),
        'utf8'
      )
      return {
        ok: true,
        response: {
          ok: true,
          cacheRoot: fs.realpathSync.native(request.cacheRoot),
          results: [
            {
              id: manifest.cacheKey,
              ok: true,
              manifest: createSidecarManifest(manifestMissingRequestedLevel, request.cacheRoot)
            }
          ]
        },
        binaryPath: 'sidecar.exe',
        args: [],
        stderr: '',
        stderrTruncated: false
      }
    })

    const response = await serviceWithSidecar.generateThumbnailSet({
      fullPath: sourcePath,
      cacheRootDir: cacheRoot,
      levels: [128, 256]
    })

    expect(response).toMatchObject({
      manifest: null,
      status: 'failed',
      error: 'Canvas thumbnail sidecar output did not include all requested levels.',
      sidecar: { used: true, fallback: false }
    })
  })

  it('returns a safe fallback when the sidecar is disabled or unavailable', async () => {
    const sourcePath = await createSourceFile('sidecar-disabled.png')
    const serviceWithSidecar = createServiceWithSidecar(async () => ({
      ok: false,
      fallback: true,
      reason: 'feature-disabled',
      message: 'disabled'
    }))

    const response = await serviceWithSidecar.generateThumbnailSet({ fullPath: sourcePath })

    expect(response).toMatchObject({
      manifest: null,
      status: 'fallback',
      error: 'disabled',
      sidecar: {
        used: false,
        fallback: true,
        reason: 'feature-disabled',
        message: 'disabled'
      }
    })
  })

  it('creates native PNG thumbnails with Electron nativeImage fallback', async () => {
    const sourcePath = await createSourceFile()

    electronMock.createThumbnailFromPath.mockResolvedValue({
      getSize: () => ({ width: 128, height: 96 }),
      isEmpty: () => false,
      toPNG: () => Buffer.from([9, 8, 7])
    })

    const response = await service.createNativeThumbnail({
      fullPath: sourcePath,
      maxSide: 128
    })

    expect(electronMock.createThumbnailFromPath).toHaveBeenCalledWith(
      fs.realpathSync.native(sourcePath),
      {
        width: 128,
        height: 128
      }
    )
    expect(response.mimeType).toBe('image/png')
    expect(response.width).toBe(128)
    expect(response.height).toBe(96)
    expect(Array.from(response.data)).toEqual([9, 8, 7])
  })
})
