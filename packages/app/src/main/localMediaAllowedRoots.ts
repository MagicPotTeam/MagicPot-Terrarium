import path from 'node:path'
import { app } from 'electron'
import { getCurrentUserDataDirectoryState } from './config/userDataDirectory'
import type { LocalMediaRoot, PinnedLocalMediaRoot } from './localMediaAccess'
import { getVerifiedLocalMediaTempRoot } from './localMediaTempRoot'

function isAbsoluteLocalMediaRoot(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value)
}

function normalizeLocalMediaRoot(value: string): string {
  // Electron tests can mock Windows app paths while running on Linux CI. Preserve
  // those paths as Windows paths instead of resolving them under the CI checkout.
  if (path.win32.isAbsolute(value) && !path.isAbsolute(value)) {
    return path.win32.normalize(value)
  }
  return path.resolve(value)
}

/** Where main's private temp media folder belongs (under the OS temp directory). */
export function getLocalMediaTempRootPath(): string {
  return normalizeLocalMediaRoot(path.join(app.getPath('temp'), 'magicpot-local-media'))
}

/**
 * The private temp media folder as a pinned root once it is verified as main's own private
 * directory (verified once, see getVerifiedLocalMediaTempRoot), otherwise nothing: the OS
 * temp directory may be shared with other users (/tmp).
 */
export function getVerifiedLocalMediaTempRoots(): PinnedLocalMediaRoot[] {
  const canonical = getVerifiedLocalMediaTempRoot(getLocalMediaTempRootPath())
  return canonical ? [{ pinnedCanonicalPath: canonical }] : []
}

/** Returns the application-owned roots plus the narrowly scoped benchmark cache root. */
export function getLocalMediaAllowedRoots(): LocalMediaRoot[] {
  const storageState = getCurrentUserDataDirectoryState()
  const roots: string[] = [
    app.getPath('userData'),
    storageState.projectRoot,
    storageState.autoSaveRoot
  ]

  const benchmarkCacheRoot = process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT?.trim()
  if (
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK === '1' &&
    benchmarkCacheRoot &&
    isAbsoluteLocalMediaRoot(benchmarkCacheRoot)
  ) {
    roots.push(benchmarkCacheRoot)
  }

  const benchmarkArtifactRoot = process.env.MAGICPOT_TEST_ARTIFACT_ROOT?.trim()
  if (
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK === '1' &&
    benchmarkArtifactRoot &&
    isAbsoluteLocalMediaRoot(benchmarkArtifactRoot)
  ) {
    roots.push(benchmarkArtifactRoot)
  }

  const [userData, ...rest] = roots.map(normalizeLocalMediaRoot)
  return [userData, ...getVerifiedLocalMediaTempRoots(), ...rest]
}
