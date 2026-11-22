import { vi } from 'vitest'

/**
 * installedCatalogReader.test.ts builds its fixtures on the real disk and refuses to run unless
 * MAGICPOT_STORAGE_ROOT is an absolute path containing "studio-catalog-storage" (its own guard
 * against writing into a real profile).
 *
 * The same variable selects the storage root of the real application (config/portablePaths.ts), so
 * it must never be set for the whole suite. It is provided to the listed test files only, and only
 * when the caller has not already supplied a confined root: a fresh directory under the OS
 * temporary directory, removed again (with the variable) by the returned release function.
 */
export const CATALOG_STORAGE_ROOT_ENV = 'MAGICPOT_STORAGE_ROOT'
export const CATALOG_STORAGE_MARKER = 'studio-catalog-storage'
export const CATALOG_STORAGE_PREFIX = `magicpot-${CATALOG_STORAGE_MARKER}-`
const FILES_NEEDING_CONFINED_STORAGE = [/[\\/]magicAgentRuntime[\\/]installedCatalogReader\.test\.ts$/]

export async function provideConfinedCatalogStorage(
  testPath: string,
  env: Record<string, string | undefined> = process.env
): Promise<() => void> {
  if (!FILES_NEEDING_CONFINED_STORAGE.some((pattern) => pattern.test(testPath))) return () => {}
  const path = await vi.importActual<typeof import('node:path')>('node:path')
  const previous = env[CATALOG_STORAGE_ROOT_ENV]
  if (previous && path.isAbsolute(previous) && previous.includes(CATALOG_STORAGE_MARKER)) return () => {}
  // memfs.setup.ts replaces node:fs for the suite; the fixtures need the real one.
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const os = await vi.importActual<typeof import('node:os')>('node:os')
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), CATALOG_STORAGE_PREFIX))
  env[CATALOG_STORAGE_ROOT_ENV] = root
  let released = false
  return () => {
    if (released) return
    released = true
    // Only undo our own value: a test that replaced it is responsible for its own cleanup.
    if (env[CATALOG_STORAGE_ROOT_ENV] === root) {
      if (previous === undefined) delete env[CATALOG_STORAGE_ROOT_ENV]
      else env[CATALOG_STORAGE_ROOT_ENV] = previous
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}
