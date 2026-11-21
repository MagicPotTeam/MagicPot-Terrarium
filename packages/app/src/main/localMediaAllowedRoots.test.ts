import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { appGetPathMock, verifiedTempRootMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn((name: string) => path.join(os.tmpdir(), `magicpot-${name}`)),
  // The canonical path the verifier recorded, or null when the folder is refused.
  verifiedTempRootMock: vi.fn((root: string): string | null => `${root}-canonical`)
}))

vi.mock('./localMediaTempRoot', () => ({
  getVerifiedLocalMediaTempRoot: verifiedTempRootMock
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock }
}))

vi.mock('./config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    projectRoot: path.join(os.tmpdir(), 'magicpot-projects'),
    autoSaveRoot: path.join(os.tmpdir(), 'magicpot-autosave')
  })
}))

import { getLocalMediaAllowedRoots } from './localMediaAllowedRoots'

const userData = path.resolve(path.join(os.tmpdir(), 'magicpot-userData'))
/** The app's media folders, never its data folder itself. */
const userDataMediaRoots = [
  '.chat_media',
  'project-canvas-thumbnail-cache',
  'qapp-input-images',
  '.report_bundles',
  'report-bundles'
].map((name) => path.join(userData, name))

describe('local media allowed roots', () => {
  afterEach(() => {
    verifiedTempRootMock.mockReset()
    verifiedTempRootMock.mockImplementation((root: string) => `${root}-canonical`)
    delete process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK
    delete process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT
    delete process.env.MAGICPOT_TEST_ARTIFACT_ROOT
  })

  it('keeps normal application roots and excludes benchmark roots when disabled', () => {
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = path.join(
      os.tmpdir(),
      'shared-thumbnail-cache'
    )
    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = path.join(os.tmpdir(), 'artifacts')

    const roots = getLocalMediaAllowedRoots()

    expect(roots).toEqual([
      ...userDataMediaRoots,
      {
        pinnedCanonicalPath: `${path.resolve(path.join(os.tmpdir(), 'magicpot-temp', 'magicpot-local-media'))}-canonical`
      },
      path.resolve(path.join(os.tmpdir(), 'magicpot-projects')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-autosave'))
    ])
    expect(roots).not.toContain(process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT)
    expect(roots).not.toContain(process.env.MAGICPOT_TEST_ARTIFACT_ROOT)
  })

  it('serves the media folders of the app data folder, never the data folder itself', () => {
    const roots = getLocalMediaAllowedRoots()
    expect(roots).not.toContain(userData)
    // Nothing that holds config.json, the grants file, custom skills or Chromium's profile.
    for (const root of roots) {
      const folder = typeof root === 'string' ? root : root.pinnedCanonicalPath
      for (const secret of [
        'config.json',
        'local-media-grants.json',
        path.join('customSkills', 'cat', 'cat.skill.json'),
        'Cookies',
        path.join('Local Storage', 'leveldb', '000003.log')
      ]) {
        const relative = path.relative(folder, path.join(userData, secret))
        expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(true)
      }
    }
  })

  it('adds only the explicitly configured absolute shared-thumbnail cache when enabled', () => {
    const cacheRoot = path.join(os.tmpdir(), 'shared-thumbnail-cache')
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = `  ${cacheRoot}  `
    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = path.join(os.tmpdir(), 'artifacts')

    const roots = getLocalMediaAllowedRoots()

    expect(roots).toContain(path.resolve(cacheRoot))
    expect(roots).toContain(path.resolve(process.env.MAGICPOT_TEST_ARTIFACT_ROOT!))
    expect(roots).toHaveLength(userDataMediaRoots.length + 5)
  })

  it('ignores blank and relative benchmark cache configuration', () => {
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = '   '
    expect(getLocalMediaAllowedRoots()).toHaveLength(userDataMediaRoots.length + 3)

    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = 'relative/cache'
    expect(getLocalMediaAllowedRoots()).toHaveLength(userDataMediaRoots.length + 3)

    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = 'relative/artifacts'
    expect(getLocalMediaAllowedRoots()).toHaveLength(userDataMediaRoots.length + 3)
  })

  it('trusts the temp root only when it is verified, by the canonical path recorded then', () => {
    const tempRoot = path.resolve(path.join(os.tmpdir(), 'magicpot-temp', 'magicpot-local-media'))
    expect(getLocalMediaAllowedRoots()).toContainEqual({
      pinnedCanonicalPath: `${tempRoot}-canonical`
    })
    expect(verifiedTempRootMock).toHaveBeenLastCalledWith(tempRoot)

    // Planted as a symlink or owned by someone else: not an allowed root.
    verifiedTempRootMock.mockReturnValue(null)
    const roots = getLocalMediaAllowedRoots()
    expect(roots).toEqual([
      ...userDataMediaRoots,
      path.resolve(path.join(os.tmpdir(), 'magicpot-projects')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-autosave'))
    ])
  })
})
