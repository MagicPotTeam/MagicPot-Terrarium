import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'

/** Parent owns one private operation directory. Pass only this path to the child;
 * invoke cleanup only after confirmed child exit (or a spawn that created no child).
 * Never derive this root from renderer/model arguments or selected source paths.
 */
export function createSqlitePreviewScratchOwner(trustedPrivateRoot: string) {
  if (!path.isAbsolute(trustedPrivateRoot)) throw new Error('Private scratch root must be absolute.')
  const root = realpathSync.native(trustedPrivateRoot)
  const info = lstatSync(trustedPrivateRoot)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Private scratch root unavailable.')
  const directory = mkdtempSync(path.join(root, 'sqlite-operation-'))
  let removed = false
  return Object.freeze({
    directory,
    cleanupAfterExit() {
      if (removed) return
      rmSync(directory, { recursive: true, force: true })
      removed = true
    }
  })
}
