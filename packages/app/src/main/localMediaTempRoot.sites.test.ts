import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real filesystem: a folder planted in the shared temp directory is what these tests are about.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)

const roots = vi.hoisted(() => ({ temp: '', base: '' }))
vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) =>
      name === 'temp' ? roots.temp : `${roots.base}/electron-${name}`
    )
  },
  nativeImage: {}
}))
vi.mock('./config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    autoSaveRoot: `${roots.base}/AutoSave`,
    projectRoot: `${roots.base}/Projects`
  })
}))

import { FsSvcImpl } from './api/svcFsImpl'
import { CanvasThumbnailSvcImpl } from './api/svcCanvasThumbnailImpl'
import {
  clearScopedLocalMediaPathsForTest,
  countLocalMediaImportGrantsForTest,
  LOCAL_MEDIA_IMPORT_GRANT_TTL_MS,
  recordLocalMediaImportGrant
} from './localMediaAccess'
import { forgetLocalMediaTempRootVerification } from './localMediaTempRoot'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const posixOnly = it.skipIf(process.platform === 'win32')

/**
 * readImageFromPath, copyCanvasMirrorAsset and createNativeRegion take paths from the renderer.
 * They allow main's temp media folder only once it is verified as main's own private folder.
 */
describe('the temp media folder at every renderer-facing reader', () => {
  let victim: string
  let tempRoot: string

  beforeEach(() => {
    roots.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-temp-sites-')))
    roots.temp = path.join(roots.base, 'shared-tmp')
    fs.mkdirSync(roots.temp, { mode: 0o1777 })
    victim = path.join(roots.base, 'victim-home')
    fs.mkdirSync(victim, { mode: 0o700 })
    fs.writeFileSync(path.join(victim, 'secret.png'), PNG)
    tempRoot = path.join(roots.temp, 'magicpot-local-media')
    forgetLocalMediaTempRootVerification()
    clearScopedLocalMediaPathsForTest()
  })

  afterEach(() => {
    forgetLocalMediaTempRootVerification()
    fs.rmSync(roots.base, { recursive: true, force: true })
  })

  const readers = (filePath: string) => {
    const fsService = new FsSvcImpl()
    const thumbnails = new CanvasThumbnailSvcImpl()
    return {
      readImage: () => fsService.readImageFromPath({ fullPath: filePath }),
      copyMirror: () =>
        fsService.copyCanvasMirrorAsset({
          projectDirName: 'project',
          assetFileName: `b-${'a'.repeat(40)}.png`,
          sourcePath: filePath
        }),
      nativeRegion: () =>
        thumbnails.createNativeRegion({ fullPath: filePath, x: 0, y: 0, width: 1, height: 1 })
    }
  }

  posixOnly('refuses a symlink planted at the folder name, at each reader', async () => {
    fs.symlinkSync(victim, tempRoot)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const planted = readers(path.join(tempRoot, 'secret.png'))
    await expect(planted.readImage()).rejects.toThrow('not authorized')
    await expect(planted.copyMirror()).rejects.toThrow('not authorized')
    await expect(planted.nativeRegion()).rejects.toThrow('not authorized')
    // One log line with the reason, never the path; the planted link is left as it is.
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('symlink')
    expect(String(warn.mock.calls[0][0])).not.toContain(roots.base)
    expect(fs.lstatSync(tempRoot).isSymbolicLink()).toBe(true)
  })

  posixOnly(
    'refuses a folder another user left open (0777) only until it is tightened',
    async () => {
      // main's own folder with a loose mode: tightened, then used.
      fs.mkdirSync(tempRoot)
      fs.chmodSync(tempRoot, 0o777)
      fs.writeFileSync(path.join(tempRoot, 'own.png'), PNG)
      const own = readers(path.join(tempRoot, 'own.png'))
      await expect(own.readImage()).resolves.toMatchObject({ filename: 'own.png' })
      expect(fs.lstatSync(tempRoot).mode & 0o777).toBe(0o700)
    }
  )

  posixOnly('keeps refusing paths under the folder after it is swapped for a symlink', async () => {
    fs.mkdirSync(tempRoot, { mode: 0o700 })
    fs.writeFileSync(path.join(tempRoot, 'own.png'), PNG)
    await expect(readers(path.join(tempRoot, 'own.png')).readImage()).resolves.toMatchObject({
      filename: 'own.png'
    })
    // Accepted and remembered; then the folder goes and a symlink takes its name.
    fs.rmSync(tempRoot, { recursive: true })
    fs.symlinkSync(victim, tempRoot)
    const planted = readers(path.join(tempRoot, 'secret.png'))
    await expect(planted.readImage()).rejects.toThrow('not authorized')
    await expect(planted.copyMirror()).rejects.toThrow('not authorized')
    await expect(planted.nativeRegion()).rejects.toThrow('not authorized')
  })

  it('reads a file dropped from a mapped network drive once, under its one-use read grant', async () => {
    // Outside every root, like a file on a mapped drive (Z:\ resolving to a UNC path).
    const dropped = path.join(victim, 'secret.png')
    const reader = readers(dropped)
    await expect(reader.readImage()).rejects.toThrow('not authorized')
    recordLocalMediaImportGrant(fs.realpathSync(dropped), undefined, 'read')
    await expect(reader.readImage()).resolves.toMatchObject({ filename: 'secret.png' })
    await expect(reader.readImage()).rejects.toThrow('not authorized')
  })

  it('hands the turn to the next file of the drop once a mapped-drive read is over', async () => {
    const dropped = path.join(victim, 'secret.png')
    const ttl = LOCAL_MEDIA_IMPORT_GRANT_TTL_MS
    // Two files of one drop, granted half a time to live ago: this one is read now, the other
    // waits for its turn (left alone, it would expire half a time to live from now).
    const grantedAt = { now: performance.now() - ttl / 2, wallNow: Date.now() - ttl / 2 }
    recordLocalMediaImportGrant(fs.realpathSync(dropped), grantedAt.now, 'read', {
      wallNow: grantedAt.wallNow,
      batch: 'drop-9-z'
    })
    recordLocalMediaImportGrant('/elsewhere/next.png', grantedAt.now, 'import', {
      wallNow: grantedAt.wallNow,
      batch: 'drop-9-z'
    })
    const startedAt = { now: performance.now(), wallNow: Date.now() }
    await expect(readers(dropped).readImage()).resolves.toMatchObject({ filename: 'secret.png' })
    const endedAt = { now: performance.now(), wallNow: Date.now() }
    // The read is over: the next file lives a whole time to live from then...
    expect(
      countLocalMediaImportGrantsForTest(
        startedAt.now + ttl - 1_000,
        startedAt.wallNow + ttl - 1_000
      )
    ).toBe(1)
    // ...and no longer.
    expect(
      countLocalMediaImportGrantsForTest(endedAt.now + ttl + 1_000, endedAt.wallNow + ttl + 1_000)
    ).toBe(0)
  })
})
