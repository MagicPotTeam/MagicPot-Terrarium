import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  resolveAuthorizedLocalMediaPath
} from '../localMediaAccess'
import { importManagedMediaFile } from '../llmProxy/managedMediaStore'
import { ManagedMediaSvcImpl, toImportSourceLocalPath } from './svcManagedMediaImpl'

// Real filesystem: symlinks, FIFOs, /proc and devices are what these tests are about.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/magicpot-test-user-data') }
}))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const win32 = (value: string, refuseNetworkAndDevicePaths?: boolean): string =>
  toImportSourceLocalPath(value, {
    pathApi: path.win32,
    toPath: (url) => fileURLToPath(url, { windows: true }),
    refuseNetworkAndDevicePaths
  })
const posix = (value: string): string =>
  toImportSourceLocalPath(value, {
    pathApi: path.posix,
    toPath: (url) => fileURLToPath(url, { windows: false })
  })

describe('toImportSourceLocalPath (no filesystem access)', () => {
  it('accepts canonical Windows drive-letter paths, long paths and file URIs', () => {
    const longPath = `C:\\${'nested-folder\\'.repeat(24)}image.png`
    expect(longPath.length).toBeGreaterThan(260)
    expect(win32('C:\\Users\\artist\\Pictures\\a.png')).toBe('C:\\Users\\artist\\Pictures\\a.png')
    expect(win32('d:\\Art Work\\a b.png')).toBe('d:\\Art Work\\a b.png')
    expect(win32(longPath)).toBe(longPath)
    expect(win32('file:///C:/Users/artist/a.png')).toBe('C:\\Users\\artist\\a.png')
    expect(posix('/home/artist/a.png')).toBe('/home/artist/a.png')
    expect(posix('/home/artist/a:b.png')).toBe('/home/artist/a:b.png')
    expect(posix('file:///home/artist/a.png')).toBe('/home/artist/a.png')
  })

  it('refuses UNC, device and long-path namespace, relative, aliased and stream paths', () => {
    const refused = [
      '\\\\server\\share\\a.png',
      '\\\\?\\C:\\Users\\a.png',
      '\\\\?\\UNC\\server\\share\\a.png',
      '\\\\.\\PhysicalDrive0',
      '\\\\.\\pipe\\x',
      '//server/share/a.png',
      '/\\server\\share\\a.png',
      'file://server/share/a.png',
      'file:////server/share/a.png',
      'C:\\Users\\a.png:hidden',
      'C:\\Users\\a.png::$DATA',
      'C:a.png',
      'C:\\Users\\..\\a.png',
      'C:/Users/a.png',
      'relative\\a.png',
      'https://example.com/a.png',
      'smb://server/share/a.png',
      ''
    ]
    for (const value of refused) {
      expect(() => win32(value), value).toThrow(
        expect.objectContaining({ code: 'MANAGED_MEDIA_IMPORT_INVALID' })
      )
    }
    for (const value of ['//server/share/a.png', '/a/../b.png', 'a.png', '/a//b.png', '/a\0b']) {
      expect(() => posix(value), value).toThrow(
        expect.objectContaining({ code: 'MANAGED_MEDIA_IMPORT_INVALID' })
      )
    }
  })

  it('refuses NT object-namespace, root-relative and device-name paths on Windows', () => {
    for (const value of [
      '\\??\\UNC\\attacker-host\\share\\a.png',
      '\\??\\C:\\Users\\a.png',
      '/??/UNC/attacker-host/share/a.png',
      'file:///%3F%3F/UNC/attacker-host/share/a.png',
      '\\Users\\artist\\a.png',
      '\\Users\\artist\\a.png:hidden',
      'C:\\Users\\artist\\CON',
      'C:\\Users\\artist\\com1.png',
      'C:\\Users\\artist\\NUL .txt',
      'C:\\Users\\artist\\CONOUT$',
      'C:\\Users\\artist\\lpt¹.png',
      'file:///C:/Users/artist/aux.png'
    ]) {
      expect(() => win32(value), value).toThrow(
        expect.objectContaining({ code: 'MANAGED_MEDIA_IMPORT_INVALID' })
      )
    }
    expect(win32('C:\\Users\\console\\a.png')).toBe('C:\\Users\\console\\a.png')
    expect(win32('C:\\Users\\artist\\com10.png')).toBe('C:\\Users\\artist\\com10.png')
    // POSIX: '/??/' is refused as well; reserved Windows names are ordinary file names.
    expect(() => posix('/??/UNC/attacker-host/share/a.png')).toThrow(
      expect.objectContaining({ code: 'MANAGED_MEDIA_IMPORT_INVALID' })
    )
    expect(posix('/home/artist/con.png')).toBe('/home/artist/con.png')
  })

  it('keeps UNC paths for main-owned callers that confine paths themselves', () => {
    expect(win32('\\\\server\\share\\a.png', false)).toBe('\\\\server\\share\\a.png')
    expect(win32('file://server/share/a.png', false)).toBe('\\\\server\\share\\a.png')
    expect(() => win32('C:\\a\\..\\b.png', false)).toThrow(
      expect.objectContaining({ code: 'MANAGED_MEDIA_IMPORT_INVALID' })
    )
  })

  it('never puts the refused path into the error message', () => {
    try {
      win32('\\\\attacker-host\\share\\secret-name.png')
      expect.unreachable()
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/attacker-host|secret-name/)
    }
  })
})

describe('ManagedMediaSvcImpl.importFile with the renderer source-path policy', () => {
  let root: string
  let allowed: string
  let outside: string
  let media: string

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mp-import-by-path-')))
    allowed = path.join(root, 'allowed')
    outside = path.join(root, 'outside')
    media = path.join(allowed, 'media')
    await fs.mkdir(media, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    clearScopedLocalMediaPathsForTest()
  })

  afterEach(async () => {
    clearScopedLocalMediaPathsForTest()
    await fs.rm(root, { recursive: true, force: true })
  })

  const create = (overrides: ConstructorParameters<typeof ManagedMediaSvcImpl>[0] = {}) => {
    const authorize = vi.fn((sourcePath: string) =>
      resolveAuthorizedLocalMediaPath(sourcePath, [allowed])
    )
    const importFile = vi.fn(importManagedMediaFile)
    const service = new ManagedMediaSvcImpl({
      getMediaDir: () => media,
      authorizeImportSourcePath: authorize,
      importFile,
      maxImportFileBytes: 1024 * 1024,
      ensureDerivative: vi.fn(async () => {
        throw new Error('not needed')
      }),
      ...overrides
    })
    return { service, authorize, importFile }
  }
  const request = (sourcePath: string, mimeType = 'image/png') => ({
    sourcePath,
    mimeType,
    originalFileName: 'picked.png'
  })
  const expectNoPathInError = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => expect.unreachable('import should be refused'),
      (reason: unknown) => reason as { code?: string; message?: string }
    )
    expect(error).toMatchObject({ code })
    expect(String(error.message)).not.toContain(root)
    return error
  }
  const stagingIsEmpty = async () => {
    const staging = path.join(media, '.staging')
    expect(await fs.readdir(staging).catch(() => [])).toEqual([])
  }

  it('imports a file under an allowed root and a file outside it once the user picked it', async () => {
    const inside = path.join(allowed, 'inside.png')
    const picked = path.join(outside, 'picked.png')
    await fs.writeFile(inside, PNG)
    await fs.writeFile(picked, PNG)
    const { service } = create()

    await expect(service.importFile(request(inside))).resolves.toMatchObject({
      reference: { kind: 'managed', mimeType: 'image/png', sizeBytes: PNG.length }
    })
    await expectNoPathInError(service.importFile(request(picked)), 'MANAGED_MEDIA_IMPORT_FORBIDDEN')
    // The composer records the pick (preload: webUtils path -> local-media:authorize-picker-path).
    expect(authorizeScopedLocalMediaPath(picked)).toBe(true)
    await expect(service.importFile(request(picked))).resolves.toMatchObject({
      reference: { kind: 'managed', sizeBytes: PNG.length }
    })
  })

  it('refuses a path outside the allowed roots before the store opens it', async () => {
    const secret = path.join(outside, 'secret.png')
    await fs.writeFile(secret, PNG)
    const { service, importFile } = create()
    await expectNoPathInError(service.importFile(request(secret)), 'MANAGED_MEDIA_IMPORT_FORBIDDEN')
    expect(importFile).not.toHaveBeenCalled()
  })

  it('refuses a UNC or device path before any authorisation or filesystem access', async () => {
    const { service, authorize, importFile } = create()
    for (const sourcePath of ['//attacker/share/a.png', '//./pipe/x']) {
      await expectNoPathInError(
        service.importFile(request(sourcePath)),
        'MANAGED_MEDIA_IMPORT_INVALID'
      )
    }
    expect(authorize).not.toHaveBeenCalled()
    expect(importFile).not.toHaveBeenCalled()
  })

  it('refuses an unsupported type before touching the file', async () => {
    const video = path.join(allowed, 'clip.mp4')
    await fs.writeFile(video, Buffer.alloc(64))
    const { service, authorize, importFile } = create()
    await expectNoPathInError(
      service.importFile(request(video, 'video/mp4')),
      'MANAGED_MEDIA_UNSUPPORTED'
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(importFile).not.toHaveBeenCalled()
  })

  it('refuses a directory inside an allowed root', async () => {
    const directory = path.join(allowed, 'folder.png')
    await fs.mkdir(directory)
    const { service } = create()
    await expectNoPathInError(service.importFile(request(directory)), 'MANAGED_MEDIA_IMPORT_FAILED')
    await stagingIsEmpty()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink to an outside file and a symlink to an allowed file',
    async () => {
      const secret = path.join(outside, 'secret.png')
      const inside = path.join(allowed, 'inside.png')
      await fs.writeFile(secret, PNG)
      await fs.writeFile(inside, PNG)
      const toOutside = path.join(allowed, 'to-outside.png')
      const toInside = path.join(allowed, 'to-inside.png')
      await fs.symlink(secret, toOutside)
      await fs.symlink(inside, toInside)
      // A symlinked directory inside the allowed root that points outside.
      const dirLink = path.join(allowed, 'linked-dir')
      await fs.symlink(outside, dirLink)
      const { service, importFile } = create()

      for (const sourcePath of [toOutside, toInside, path.join(dirLink, 'secret.png')]) {
        await expectNoPathInError(
          service.importFile(request(sourcePath)),
          'MANAGED_MEDIA_IMPORT_FORBIDDEN'
        )
      }
      expect(importFile).not.toHaveBeenCalled()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink that replaces the file after the authorisation, without following it',
    async () => {
      const secret = path.join(outside, 'secret.png')
      const swapped = path.join(allowed, 'swapped.png')
      await fs.writeFile(secret, PNG)
      await fs.writeFile(swapped, PNG)
      const { service } = create({
        authorizeImportSourcePath: (sourcePath) => {
          const authorized = resolveAuthorizedLocalMediaPath(sourcePath, [allowed])
          // Swap the checked file for a symlink to an outside file before the copy.
          execFileSync('ln', ['-sf', secret, swapped])
          return authorized
        }
      })
      await expectNoPathInError(service.importFile(request(swapped)), 'MANAGED_MEDIA_IMPORT_FAILED')
      await stagingIsEmpty()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO and a /proc file without blocking',
    async () => {
      const fifo = path.join(allowed, 'pipe.png')
      execFileSync('mkfifo', [fifo])
      const { service } = create()
      await expectNoPathInError(service.importFile(request(fifo)), 'MANAGED_MEDIA_IMPORT_FAILED')
      await expectNoPathInError(
        service.importFile(request('/proc/self/environ')),
        'MANAGED_MEDIA_IMPORT_FORBIDDEN'
      )
      // Even when a device or /proc path is inside an allowed root it is not a regular file.
      const procOpen = create({
        authorizeImportSourcePath: (sourcePath) =>
          resolveAuthorizedLocalMediaPath(sourcePath, ['/'])
      })
      for (const sourcePath of [`/proc/${process.pid}/environ`, '/dev/zero', '/dev/null']) {
        await expect(procOpen.service.importFile(request(sourcePath))).rejects.toMatchObject({
          code: 'MANAGED_MEDIA_IMPORT_FAILED'
        })
      }
      await stagingIsEmpty()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a file swapped for a FIFO between the checks and the open, without blocking',
    async () => {
      const swapped = path.join(allowed, 'swapped-fifo.png')
      await fs.writeFile(swapped, PNG)
      let swappedForFifo = false
      const { service } = create({
        importFile: (input, dependencies) =>
          importManagedMediaFile(input, {
            ...dependencies,
            fs: {
              ...fs,
              open: (async (...args: Parameters<typeof fs.open>) => {
                if (!swappedForFifo && String(args[0]) === swapped) {
                  // The lstat / realpath checks saw a regular file; a FIFO takes its place
                  // before the open. A blocking open would wait for a writer forever.
                  swappedForFifo = true
                  await fs.unlink(swapped)
                  execFileSync('mkfifo', [swapped])
                }
                return fs.open(...args)
              }) as typeof fs.open
            }
          })
      })
      await expectNoPathInError(service.importFile(request(swapped)), 'MANAGED_MEDIA_IMPORT_FAILED')
      expect(swappedForFifo).toBe(true)
      await stagingIsEmpty()
    },
    5000
  )

  it('refuses a file that changes size during the copy and removes the partial copy', async () => {
    const growing = path.join(allowed, 'growing.png')
    await fs.writeFile(growing, PNG)
    let grown = false
    const { service } = create({
      importFile: (input, dependencies) =>
        importManagedMediaFile(input, {
          ...dependencies,
          fs: {
            ...fs,
            open: (async (...args: Parameters<typeof fs.open>) => {
              const handle = await fs.open(...args)
              if (!grown && String(args[0]).includes(`${path.sep}.staging${path.sep}`)) {
                grown = true
                await fs.appendFile(growing, Buffer.alloc(4096))
              }
              return handle
            }) as typeof fs.open
          }
        })
    })
    await expectNoPathInError(service.importFile(request(growing)), 'MANAGED_MEDIA_IMPORT_FAILED')
    expect(grown).toBe(true)
    await stagingIsEmpty()
  })

  it('applies the size cap to the stat and to the bytes actually copied', async () => {
    const large = path.join(allowed, 'large.png')
    await fs.writeFile(large, Buffer.concat([PNG, Buffer.alloc(2048)]))
    const { service, importFile } = create({ maxImportFileBytes: 1024 })
    await expectNoPathInError(service.importFile(request(large)), 'MANAGED_MEDIA_IMPORT_FAILED')
    expect(importFile).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 1024 }), {
      authorizedRoot: media
    })
    await stagingIsEmpty()

    // A file that grows past the cap after its stat is cut off by the copy itself.
    const small = path.join(allowed, 'small.png')
    await fs.writeFile(small, PNG)
    const staged = create({
      maxImportFileBytes: PNG.length + 10,
      importFile: async (input, dependencies) => {
        const stat = await fs.stat(input.sourcePath)
        expect(stat.size).toBe(PNG.length)
        return importManagedMediaFile(input, {
          ...dependencies,
          fs: {
            ...fs,
            lstat: (async (...args: Parameters<typeof fs.lstat>) => {
              const result = await fs.lstat(...args)
              if (String(args[0]) === small) await fs.appendFile(small, Buffer.alloc(64))
              return result
            }) as typeof fs.lstat
          }
        })
      }
    })
    await expectNoPathInError(
      staged.service.importFile(request(small)),
      'MANAGED_MEDIA_IMPORT_FAILED'
    )
    await stagingIsEmpty()
  })

  it('checks the image type on the copied bytes, not on the declared type or name', async () => {
    const fake = path.join(allowed, 'fake.png')
    await fs.writeFile(fake, Buffer.from('not an image at all'))
    const { service } = create()
    await expectNoPathInError(service.importFile(request(fake)), 'MANAGED_MEDIA_INVALID')
    await stagingIsEmpty()
  })
})
