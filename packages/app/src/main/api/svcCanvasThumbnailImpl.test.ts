import * as fs from 'fs'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasThumbnailManifest } from '@shared/api/svcCanvasThumbnail'
import { CanvasThumbnailSvcImpl } from './svcCanvasThumbnailImpl'

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

const SAFE_CACHE_KEY = 'thumb_0123456789abcdef'

function getDesktopTrashRoot(): string {
  if (process.env.MAGICPOT_TEST_TRASH_ROOT) {
    return process.env.MAGICPOT_TEST_TRASH_ROOT
  }

  return path.join(process.cwd(), '.magicpot-trash', 'cache-ipc-worker')
}

function createManifest(cacheKey = SAFE_CACHE_KEY): CanvasThumbnailManifest {
  return {
    version: 1,
    cacheKey,
    canonicalPath: 'C:\\source\\image.png',
    sourceSizeBytes: 1024,
    sourceLastModifiedMs: 1234,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    levels: [
      {
        maxSide: 128,
        filename: 'thumb-128.webp',
        src: '',
        mimeType: 'image/webp',
        width: 128,
        height: 64,
        sizeBytes: 4
      },
      {
        maxSide: 256,
        filename: 'thumb-256.png',
        src: '',
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
    testRoot = path.join(getDesktopTrashRoot(), `${Date.now()}-${process.pid}-${Math.random()}`)
    electronMock.userDataRoot = path.join(testRoot, 'userData')
    fs.mkdirSync(testRoot, { recursive: true })
    service = new CanvasThumbnailSvcImpl()
    electronMock.createThumbnailFromPath.mockReset()
  })

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it('returns canonical source metadata for existing and missing files', async () => {
    const sourcePath = path.join(testRoot, 'source.png')
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3, 4]))
    const stats = fs.statSync(sourcePath)

    const metadata = await service.getSourceFileMetadata({ fullPath: sourcePath })

    expect(metadata.exists).toBe(true)
    expect(metadata.canonicalPath).toBe(fs.realpathSync.native(sourcePath))
    expect(metadata.sizeBytes).toBe(4)
    expect(metadata.lastModifiedMs).toBe(stats.mtimeMs)

    const missing = await service.getSourceFileMetadata({
      fullPath: path.join(testRoot, 'missing.png')
    })
    expect(missing.exists).toBe(false)
    expect(missing.sizeBytes).toBe(0)
  })

  it('writes and reads thumbnail manifests only under the app userData cache root', async () => {
    const manifest = createManifest()
    const response = await service.writeThumbnailSet({
      cacheKey: SAFE_CACHE_KEY,
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

    const cacheRoot = path.join(electronMock.userDataRoot, 'project-canvas-thumbnail-cache')
    const manifestPath = path.join(cacheRoot, SAFE_CACHE_KEY, 'manifest.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    expect(response.manifest.cacheKey).toBe(SAFE_CACHE_KEY)
    expect(response.manifest.levels.every((level) => level.src.startsWith('local-media:'))).toBe(
      true
    )

    const read = await service.readThumbnailManifest({ cacheKey: SAFE_CACHE_KEY })
    expect(read.manifest?.cacheKey).toBe(SAFE_CACHE_KEY)
    expect(read.manifest?.levels.map((file) => file.filename)).toEqual([
      'thumb-128.webp',
      'thumb-256.png'
    ])
    expect(read.manifest?.levels.every((level) => level.src.startsWith('local-media:'))).toBe(true)
  })

  it('rejects unsafe cache keys and thumbnail filenames', async () => {
    await expect(
      service.readThumbnailManifest({ cacheKey: '../outside-cache-root' })
    ).rejects.toThrow(/Invalid canvas thumbnail cache key/)

    const manifest = createManifest()
    await expect(
      service.writeThumbnailSet({
        cacheKey: SAFE_CACHE_KEY,
        manifest,
        files: [
          {
            filename: '../escape.png',
            data: new Uint8Array([1])
          }
        ]
      })
    ).rejects.toThrow(/Invalid canvas thumbnail filename/)
  })

  it('creates native PNG thumbnails with Electron nativeImage fallback', async () => {
    const sourcePath = path.join(testRoot, 'source.png')
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3, 4]))

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
