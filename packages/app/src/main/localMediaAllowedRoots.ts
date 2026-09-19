import path from 'node:path'
import { app } from 'electron'
import { getCurrentUserDataDirectoryState } from './config/userDataDirectory'

/** Returns the application-owned roots plus the narrowly scoped benchmark cache root. */
export function getLocalMediaAllowedRoots(): string[] {
  const storageState = getCurrentUserDataDirectoryState()
  const roots: string[] = [
    app.getPath('userData'),
    path.join(app.getPath('temp'), 'magicpot-local-media'),
    storageState.projectRoot,
    storageState.autoSaveRoot
  ]

  const benchmarkCacheRoot = process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT?.trim()
  if (
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK === '1' &&
    benchmarkCacheRoot &&
    path.isAbsolute(benchmarkCacheRoot)
  ) {
    roots.push(benchmarkCacheRoot)
  }

  const benchmarkArtifactRoot = process.env.MAGICPOT_TEST_ARTIFACT_ROOT?.trim()
  if (
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK === '1' &&
    benchmarkArtifactRoot &&
    path.isAbsolute(benchmarkArtifactRoot)
  ) {
    roots.push(benchmarkArtifactRoot)
  }

  return roots.map((root) => path.resolve(root))
}
