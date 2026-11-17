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
  countLocalMediaImportGrantsForTest,
  flushLocalMediaAccessGrants,
  initializeLocalMediaAccess,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'
import { grantLocalMediaImportPath } from './localMediaFileIntakeIpc'

const cleanupPaths: string[] = []

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
  cleanupPaths.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
})

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
      expect(await authorizeLocalMediaImportSourcePathAsync(canonical, [])).toBe(picked)
    }

    expect(resolveAuthorizedLocalMediaPath(canvasVideo, [])).toBe(canvasVideo)
    flushLocalMediaAccessGrants()
    const persisted = JSON.parse(fs.readFileSync(grantsPath, 'utf8')) as { files: string[] }
    // Import grants are never written to disk.
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
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [], { now })).toBe(picked)
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [], { now })).toBeNull()

    expect(await grantLocalMediaImportPath(picked, 'image/png', clock)).toBe(picked)
    now += LOCAL_MEDIA_IMPORT_GRANT_TTL_MS - 1
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [], { now })).toBe(picked)

    expect(await grantLocalMediaImportPath(picked, 'image/png', clock)).toBe(picked)
    now += LOCAL_MEDIA_IMPORT_GRANT_TTL_MS
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [], { now })).toBeNull()
    expect(countLocalMediaImportGrantsForTest(now)).toBe(0)
  })

  it('counts two picks of the same file as two one-use grants', async () => {
    const root = makeTempDir('magicpot-import-grants-')
    const picked = path.join(root, 'twice.png')
    fs.writeFileSync(picked, 'png')
    await grantLocalMediaImportPath(picked, 'image/png')
    await grantLocalMediaImportPath(picked, 'image/png')
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [])).toBe(picked)
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [])).toBe(picked)
    expect(await authorizeLocalMediaImportSourcePathAsync(picked, [])).toBeNull()
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
    expect(await authorizeLocalMediaImportSourcePathAsync(files[0], [])).toBeNull()
    expect(await authorizeLocalMediaImportSourcePathAsync(files[299], [])).toBe(files[299])
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
    expect(await authorizeLocalMediaImportSourcePathAsync(other, [])).toBeNull()
    if (process.platform !== 'win32') {
      // A symlink to the granted file resolves to it: the canonical path is what importFile
      // compares with the request, so the link itself is still refused there.
      const link = path.join(root, 'link.png')
      fs.symlinkSync(picked, link)
      expect(await authorizeLocalMediaImportSourcePathAsync(link, [])).toBe(picked)
    }
  })
})
