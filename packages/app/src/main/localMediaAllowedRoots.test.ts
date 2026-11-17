import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { appGetPathMock, ensurePrivateTempRootMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn((name: string) => path.join(os.tmpdir(), `magicpot-${name}`)),
  ensurePrivateTempRootMock: vi.fn((_root: string) => true)
}))

vi.mock('./localMediaTempRoot', () => ({
  ensurePrivateLocalMediaTempRoot: ensurePrivateTempRootMock
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

describe('local media allowed roots', () => {
  afterEach(() => {
    ensurePrivateTempRootMock.mockReset()
    ensurePrivateTempRootMock.mockReturnValue(true)
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
      path.resolve(path.join(os.tmpdir(), 'magicpot-userData')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-temp', 'magicpot-local-media')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-projects')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-autosave'))
    ])
    expect(roots).not.toContain(process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT)
    expect(roots).not.toContain(process.env.MAGICPOT_TEST_ARTIFACT_ROOT)
  })

  it('adds only the explicitly configured absolute shared-thumbnail cache when enabled', () => {
    const cacheRoot = path.join(os.tmpdir(), 'shared-thumbnail-cache')
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = `  ${cacheRoot}  `
    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = path.join(os.tmpdir(), 'artifacts')

    const roots = getLocalMediaAllowedRoots()

    expect(roots).toContain(path.resolve(cacheRoot))
    expect(roots).toContain(path.resolve(process.env.MAGICPOT_TEST_ARTIFACT_ROOT!))
    expect(roots).toHaveLength(6)
  })

  it('ignores blank and relative benchmark cache configuration', () => {
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = '   '
    expect(getLocalMediaAllowedRoots()).toHaveLength(4)

    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = 'relative/cache'
    expect(getLocalMediaAllowedRoots()).toHaveLength(4)

    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = 'relative/artifacts'
    expect(getLocalMediaAllowedRoots()).toHaveLength(4)
  })

  it('trusts the temp root only when it is verified as main\'s own private directory', () => {
    const tempRoot = path.resolve(path.join(os.tmpdir(), 'magicpot-temp', 'magicpot-local-media'))
    expect(getLocalMediaAllowedRoots()).toContain(tempRoot)
    expect(ensurePrivateTempRootMock).toHaveBeenLastCalledWith(tempRoot)

    // Planted as a symlink or owned by someone else: not an allowed root.
    ensurePrivateTempRootMock.mockReturnValue(false)
    const roots = getLocalMediaAllowedRoots()
    expect(roots).not.toContain(tempRoot)
    expect(roots).toEqual([
      path.resolve(path.join(os.tmpdir(), 'magicpot-userData')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-projects')),
      path.resolve(path.join(os.tmpdir(), 'magicpot-autosave'))
    ])
  })
})
