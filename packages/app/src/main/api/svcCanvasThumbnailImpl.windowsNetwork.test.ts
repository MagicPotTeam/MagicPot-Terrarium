import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The thumbnail service with Windows path rules: node:path is path.win32 here, and node:fs and
// node:fs/promises are in-memory stand-ins that record every call. Each recorded call on a
// network spelling is one that, on Windows, makes main contact that host (SMB, with the user's
// NTLM credentials). Board content (an item's saved source identity) can name any of them.
const disk = vi.hoisted(() => ({
  files: new Map<string, { size: number; mtimeMs: number }>(),
  calls: [] as string[]
}))

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual.win32, default: actual.win32, win32: actual.win32, posix: actual.posix }
})

vi.mock('node:fs', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path')
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const realpath = (value: string): string => {
    disk.calls.push(`realpath ${value}`)
    const resolved = win32.resolve(value)
    if (!disk.files.has(resolved.toLowerCase())) throw missing()
    return resolved
  }
  const stat = (value: string) => {
    disk.calls.push(`stat ${value}`)
    const file = disk.files.get(win32.resolve(value).toLowerCase())
    if (!file) throw missing()
    return { isDirectory: () => false, isFile: () => true, ...file }
  }
  const record =
    (name: string) =>
    async (value: unknown): Promise<never> => {
      disk.calls.push(`${name} ${String(value)}`)
      throw missing()
    }
  const promises = {
    realpath: async (value: string) => realpath(value),
    stat: async (value: string) => stat(value),
    access: record('access'),
    readFile: record('readFile'),
    writeFile: record('writeFile'),
    rename: record('rename'),
    mkdir: async (value: string) => void disk.calls.push(`mkdir ${value}`)
  }
  const { constants } = await vi.importActual<typeof import('node:fs')>('node:fs')
  const fake = {
    constants,
    realpathSync: Object.assign(realpath, { native: realpath }),
    statSync: stat,
    promises
  }
  return { ...fake, default: fake }
})

vi.mock('node:fs/promises', async () => {
  const { default: fs } = await import('node:fs')
  const promises = (fs as unknown as { promises: Record<string, unknown> }).promises
  return { ...promises, default: promises }
})

const native = vi.hoisted(() => ({
  createThumbnailFromPath: vi.fn(),
  createFromPath: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => `C:\\Users\\u\\AppData\\Roaming\\MagicPot\\${name}` },
  nativeImage: native
}))
vi.mock('../config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    projectRoot: 'C:\\Users\\u\\MagicPot\\Projects',
    autoSaveRoot: 'C:\\Users\\u\\MagicPot\\AutoSave'
  })
}))
vi.mock('../localMediaTempRoot', () => ({ getVerifiedLocalMediaTempRoot: () => null }))

import { CanvasThumbnailSvcImpl } from './svcCanvasThumbnailImpl'
import {
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest
} from '../localMediaAccess'

const HOST_PATTERN = /attacker|nas|[?]{2}/i
const NETWORK_SPELLINGS = [
  '\\\\attacker\\share\\x.png',
  '//attacker/share/x.png',
  '/\\attacker\\share\\x.png',
  '\\/attacker/share/x.png',
  '\\\\?\\UNC\\attacker\\share\\x.png',
  '//?/UNC/attacker/share/x.png',
  '\\??\\UNC\\attacker\\share\\x.png',
  '/??/UNC/attacker/share/x.png'
]
const CACHE_KEY = 'thumb-0123456789abcdef'

let platform: PropertyDescriptor
beforeAll(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
})

const sidecar = vi.fn()
let service: CanvasThumbnailSvcImpl

beforeEach(() => {
  clearScopedLocalMediaPathsForTest()
  disk.files.clear()
  disk.calls.length = 0
  native.createThumbnailFromPath.mockReset()
  native.createFromPath.mockReset()
  sidecar.mockReset()
  service = new CanvasThumbnailSvcImpl({ generateViaSidecar: sidecar })
})
afterEach(() => {
  clearScopedLocalMediaPathsForTest()
})

const manifestFor = (canonicalPath: string) => ({
  version: 1 as const,
  cacheKey: CACHE_KEY,
  canonicalPath,
  sourceSizeBytes: 4,
  sourceLastModifiedMs: 1,
  levels: [
    {
      maxSide: 128,
      filename: '128.png',
      src: '',
      mimeType: 'image/png' as const,
      width: 1,
      height: 1,
      sizeBytes: 1
    }
  ],
  createdAt: 'x',
  updatedAt: 'x'
})

describe('canvas thumbnails with Windows path rules', () => {
  it('leaves a granted source above the byte budget to the worker', async () => {
    const huge = 'C:\\Users\\u\\Pictures\\huge.png'
    disk.files.set(huge.toLowerCase(), { size: 512 * 1024 * 1024 + 1, mtimeMs: 1 })
    expect(authorizeScopedLocalMediaPath(huge)).toBe(true)
    await expect(service.createNativeThumbnail({ fullPath: huge, maxSide: 128 })).rejects.toThrow(
      /byte budget/
    )
    expect(native.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('never touches a network source, cache root or manifest source the user did not grant', async () => {
    for (const spelling of NETWORK_SPELLINGS) {
      await expect(service.getSourceFileMetadata({ fullPath: spelling })).resolves.toMatchObject({
        exists: false,
        sizeBytes: 0,
        lastModifiedMs: 0
      })
      await expect(
        service.createNativeThumbnail({ fullPath: spelling, maxSide: 128 })
      ).rejects.toThrow()
      await expect(service.generateThumbnailSet({ fullPath: spelling })).resolves.toMatchObject({
        manifest: null,
        status: 'failed'
      })
      await expect(
        service.createNativeRegion({ fullPath: spelling, x: 0, y: 0, width: 1, height: 1 })
      ).rejects.toThrow(/not authorized/)
      await expect(service.getThumbnailCacheRoot({ cacheRootDir: spelling })).rejects.toThrow(
        /Unsafe canvas thumbnail cache root/
      )
      await expect(
        service.readThumbnailManifest({ cacheKey: CACHE_KEY, cacheRootDir: spelling })
      ).rejects.toThrow(/Unsafe canvas thumbnail cache root/)
      await expect(
        service.writeThumbnailSet({
          cacheKey: CACHE_KEY,
          manifest: manifestFor(spelling),
          files: [{ filename: '128.png', data: new Uint8Array([1]) }]
        })
      ).rejects.toThrow(/not authorized/)
    }
    expect(native.createThumbnailFromPath).not.toHaveBeenCalled()
    expect(native.createFromPath).not.toHaveBeenCalled()
    expect(sidecar).not.toHaveBeenCalled()
    expect(disk.calls.filter((call) => HOST_PATTERN.test(call))).toEqual([])
  })

  it('makes thumbnails of a granted network file, and none once its grant is evicted', async () => {
    // A file the user dropped from a share: main contacts that host only while the grant lives.
    const granted = '\\\\nas\\photos\\board\\x.png'
    disk.files.set(granted.toLowerCase(), { size: 4, mtimeMs: 1 })
    expect(authorizeScopedLocalMediaPath(granted)).toBe(true)
    native.createThumbnailFromPath.mockResolvedValue({
      getSize: () => ({ width: 2, height: 1 }),
      isEmpty: () => false,
      toPNG: () => Buffer.from([1])
    })

    // The renderer names it as the board keeps it (its normalized identity path).
    await expect(
      service.getSourceFileMetadata({ fullPath: '//nas/photos/board/x.png' })
    ).resolves.toMatchObject({ exists: true, canonicalPath: granted, sizeBytes: 4 })
    await expect(
      service.createNativeThumbnail({ fullPath: '//nas/photos/board/x.png', maxSide: 128 })
    ).resolves.toMatchObject({ width: 2, height: 1 })
    expect(native.createThumbnailFromPath).toHaveBeenCalledWith(granted, {
      width: 128,
      height: 128
    })

    // Evicted (more than 1000 newer grants): a missing thumbnail, and no contact with the host.
    clearScopedLocalMediaPathsForTest()
    disk.calls.length = 0
    native.createThumbnailFromPath.mockClear()
    await expect(
      service.getSourceFileMetadata({ fullPath: '//nas/photos/board/x.png' })
    ).resolves.toMatchObject({ exists: false })
    await expect(
      service.createNativeThumbnail({ fullPath: '//nas/photos/board/x.png', maxSide: 128 })
    ).rejects.toThrow()
    await expect(
      service.generateThumbnailSet({ fullPath: '//nas/photos/board/x.png' })
    ).resolves.toMatchObject({ manifest: null, status: 'failed' })
    expect(native.createThumbnailFromPath).not.toHaveBeenCalled()
    expect(sidecar).not.toHaveBeenCalled()
    expect(disk.calls.filter((call) => HOST_PATTERN.test(call))).toEqual([])
  })
})
