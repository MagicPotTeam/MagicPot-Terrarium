import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real filesystem: canonical paths, directories and symlinks are what these tests are about.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  ipcMain: { handle: vi.fn() }
}))

import {
  LOCAL_MEDIA_IMPORT_GRANT_TTL_MS,
  authorizeLocalMediaImportSourcePathAsync,
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  consumeLocalMediaImportGrant,
  countLocalMediaImportGrantsForTest,
  flushLocalMediaAccessGrants,
  initializeLocalMediaAccess,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'
import { pathToFileURL } from 'node:url'
import { normalizeExternalImageFileUrl } from '@shared/externalImageDrop'
import { createExternalImageDropAuthorization } from '../preload/externalImageDropLease'
import { grantLocalMediaImportFile, grantLocalMediaImportPath } from './localMediaFileIntakeIpc'

const cleanupPaths: string[] = []

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
  cleanupPaths.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
})

/** What main's importFile does with the policy: authorize, then spend an import grant. */
async function authorizeImport(
  filePath: string,
  roots: readonly string[],
  now?: number
): Promise<string | null> {
  const authorized = await authorizeLocalMediaImportSourcePathAsync(
    filePath,
    roots,
    now === undefined ? {} : { now: () => now }
  )
  if (!authorized) return null
  if (!authorized.viaImportGrant) return authorized.canonicalPath
  return consumeLocalMediaImportGrant(authorized.canonicalPath, now)
    ? authorized.canonicalPath
    : null
}

function makeTempDir(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanupPaths.push(directory)
  return directory
}

describe('short-lived local media import grants', () => {
  it('leaves a persisted canvas grant resolvable after 1000 chat imports', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const grantsPath = path.join(root, 'grants.json')
    initializeLocalMediaAccess(grantsPath)
    const canvasVideo = path.join(root, 'canvas-video.mp4')
    fs.writeFileSync(canvasVideo, 'video')
    expect(authorizeScopedLocalMediaPath(canvasVideo)).toBe(true)

    const picks = path.join(root, 'picks')
    fs.mkdirSync(picks)
    for (let index = 0; index < 1000; index += 1) {
      const picked = path.join(picks, `chat-${index}.png`)
      fs.writeFileSync(picked, 'png')
      const canonical = await grantLocalMediaImportPath(picked, 'image/png')
      expect(canonical).toBe(picked)
      // main's importFile uses the grant up.
      expect(await authorizeImport(canonical, [])).toBe(picked)
    }

    expect(resolveAuthorizedLocalMediaPath(canvasVideo, [])).toBe(canvasVideo)
    flushLocalMediaAccessGrants()
    const persisted = JSON.parse(fs.readFileSync(grantsPath, 'utf8')) as { files: string[] }
    // Import grants are never written to disk.
    expect(persisted.files).toEqual([canvasVideo])
    expect(countLocalMediaImportGrantsForTest()).toBe(0)
  })

  it('leaves a persisted canvas grant resolvable after 1000 URL-only chat drops', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const grantsPath = path.join(root, 'grants.json')
    initializeLocalMediaAccess(grantsPath)
    const canvasVideo = path.join(root, 'canvas-video.mp4')
    fs.writeFileSync(canvasVideo, 'video')
    expect(authorizeScopedLocalMediaPath(canvasVideo)).toBe(true)
    // The preload's private drop lease, wired as in production.
    const listeners = new Map<string, EventListener>()
    const lease = createExternalImageDropAuthorization({
      target: {
        addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
        removeEventListener: () => undefined
      } as unknown as Window,
      authorizePath: async (filePath) => authorizeScopedLocalMediaPath(filePath),
      authorizeImportPath: (filePath, mimeType) => grantLocalMediaImportFile(filePath, mimeType)
    })

    const drops = path.join(root, 'drops')
    fs.mkdirSync(drops)
    for (let index = 0; index < 1000; index += 1) {
      const dropped = path.join(drops, `drop-${index}.png`)
      fs.writeFileSync(dropped, 'png')
      const url = normalizeExternalImageFileUrl(pathToFileURL(dropped).href)!
      listeners.get('drop')?.({
        isTrusted: true,
        dataTransfer: { getData: (type: string) => (type === 'text/uri-list' ? url : '') }
      } as unknown as Event)
      const granted = await lease.authorizeDroppedLocalImageForImport(url, 'image/png')
      expect(granted).toEqual({ path: dropped, sizeBytes: 3 })
      // main's importFile spends it.
      expect(await authorizeImport(granted!.path, [])).toBe(dropped)
    }

    expect(resolveAuthorizedLocalMediaPath(canvasVideo, [])).toBe(canvasVideo)
    flushLocalMediaAccessGrants()
    const persisted = JSON.parse(fs.readFileSync(grantsPath, 'utf8')) as { files: string[] }
    expect(persisted.files).toEqual([canvasVideo])
    expect(countLocalMediaImportGrantsForTest()).toBe(0)
  })

  it('cannot be used twice or after its time to live', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const picked = path.join(root, 'picked.png')
    fs.writeFileSync(picked, 'png')
    let now = 1_000_000
    const clock = { now: () => now }

    expect(await grantLocalMediaImportPath(picked, 'image/png', clock)).toBe(picked)
    expect(await authorizeImport(picked, [], now)).toBe(picked)
    expect(await authorizeImport(picked, [], now)).toBeNull()

    expect(await grantLocalMediaImportPath(picked, 'image/png', clock)).toBe(picked)
    now += LOCAL_MEDIA_IMPORT_GRANT_TTL_MS - 1
    expect(await authorizeImport(picked, [], now)).toBe(picked)

    expect(await grantLocalMediaImportPath(picked, 'image/png', clock)).toBe(picked)
    now += LOCAL_MEDIA_IMPORT_GRANT_TTL_MS
    expect(await authorizeImport(picked, [], now)).toBeNull()
    expect(countLocalMediaImportGrantsForTest(now)).toBe(0)
  })

  it('counts two picks of the same file as two one-use grants', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const picked = path.join(root, 'twice.png')
    fs.writeFileSync(picked, 'png')
    await grantLocalMediaImportPath(picked, 'image/png')
    await grantLocalMediaImportPath(picked, 'image/png')
    expect(await authorizeImport(picked, [])).toBe(picked)
    expect(await authorizeImport(picked, [])).toBe(picked)
    expect(await authorizeImport(picked, [])).toBeNull()
  })

  it('keeps at most 256 import grants in memory', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const files = Array.from({ length: 300 }, (_, index) => path.join(root, `f-${index}.png`))
    for (const file of files) {
      fs.writeFileSync(file, 'png')
      await grantLocalMediaImportPath(file, 'image/png')
    }
    expect(countLocalMediaImportGrantsForTest()).toBe(256)
    // The oldest went first.
    expect(await authorizeImport(files[0], [])).toBeNull()
    expect(await authorizeImport(files[299], [])).toBe(files[299])
  })

  it('records no grant for a type main refuses, a directory, a missing file or a refused path', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const video = path.join(root, 'clip.mp4')
    fs.writeFileSync(video, 'video')
    const directory = path.join(root, 'folder.png')
    fs.mkdirSync(directory)
    const realpath = vi.fn(async (value: string) => fs.promises.realpath(value))

    expect(await grantLocalMediaImportPath(video, 'video/mp4', { realpath })).toBe('')
    expect(await grantLocalMediaImportPath(video, 'image/jpg', { realpath })).toBe('')
    expect(realpath).not.toHaveBeenCalled()
    expect(await grantLocalMediaImportPath(directory, 'image/png')).toBe('')
    expect(await grantLocalMediaImportPath(path.join(root, 'missing.png'), 'image/png')).toBe('')
    expect(await grantLocalMediaImportPath('relative/a.png', 'image/png')).toBe('')
    expect(await grantLocalMediaImportPath(42, 'image/png')).toBe('')
    expect(await grantLocalMediaImportPath(video, undefined)).toBe('')

    // A UNC path is refused before any filesystem access (main never contacts the host).
    for (const unc of ['//server/share/a.png', '\\\\server\\share\\a.png']) {
      expect(await grantLocalMediaImportPath(unc, 'image/png', { realpath })).toBe('')
    }
    expect(realpath).not.toHaveBeenCalled()

    // A mapped network drive resolves to a UNC canonical form, which importFile refuses.
    const mapped = path.join(root, 'mapped.png')
    fs.writeFileSync(mapped, 'png')
    expect(
      await grantLocalMediaImportPath(mapped, 'image/png', {
        realpath: async () => '//server/share/mapped.png'
      })
    ).toBe('')
    expect(countLocalMediaImportGrantsForTest()).toBe(0)
  })

  it('does not let an import grant authorize a different file', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const picked = path.join(root, 'picked.png')
    const other = path.join(root, 'other.png')
    fs.writeFileSync(picked, 'png')
    fs.writeFileSync(other, 'png')
    await grantLocalMediaImportPath(picked, 'image/png')
    expect(await authorizeImport(other, [])).toBeNull()
    if (process.platform !== 'win32') {
      // A symlink to the granted file resolves to it: the canonical path is what importFile
      // compares with the request, so the link itself is still refused there (and spends
      // nothing: the policy only reports the grant).
      const link = path.join(root, 'link.png')
      fs.symlinkSync(picked, link)
      expect(await authorizeLocalMediaImportSourcePathAsync(link, [])).toEqual({
        canonicalPath: picked,
        viaImportGrant: true
      })
      expect(countLocalMediaImportGrantsForTest()).toBe(1)
    }
  })

  it('expires on a monotonic clock: setting the wall clock back does not extend a grant', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const picked = path.join(root, 'clock.png')
    fs.writeFileSync(picked, 'png')
    vi.useFakeTimers({ toFake: ['performance'] })
    // The wall clock stands still (as if set back): only the monotonic clock moves.
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      expect(await grantLocalMediaImportPath(picked, 'image/png')).toBe(picked)
      expect(await grantLocalMediaImportPath(picked, 'image/png')).toBe(picked)
      vi.advanceTimersByTime(LOCAL_MEDIA_IMPORT_GRANT_TTL_MS - 1)
      expect(consumeLocalMediaImportGrant(picked)).toBe(true)
      vi.advanceTimersByTime(2)
      expect(consumeLocalMediaImportGrant(picked)).toBe(false)
    } finally {
      wallClock.mockRestore()
      vi.useRealTimers()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'refuses the double-slash form of an application-root file as an import source',
    async () => {
      const root = makeTempDir('magicpot-import-grants-')
      const file = path.join(root, 'in-root.png')
      fs.writeFileSync(file, 'png')
      // The single-slash form is an application-root file ...
      expect(await authorizeLocalMediaImportSourcePathAsync(file, [root])).toBe(file)
      // ... but importFile keeps refusing every network-looking spelling without a grant.
      expect(await authorizeLocalMediaImportSourcePathAsync(`/${file}`, [root])).toBeNull()
    }
  )
})
