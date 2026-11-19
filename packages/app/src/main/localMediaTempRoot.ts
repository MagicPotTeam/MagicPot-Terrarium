import fs from 'node:fs'
import path from 'node:path'

export type PrivateTempRootDependencies = {
  lstatSync?: (target: string) => Pick<fs.Stats, 'isDirectory' | 'isSymbolicLink' | 'uid' | 'mode'>
  mkdirSync?: (target: string, options: { recursive: true; mode: number }) => unknown
  chmodSync?: (target: string, mode: number) => void
  /** null on Windows, where the temp directory is per user and has no POSIX owner. */
  getuid?: (() => number) | null
}

const PRIVATE_DIRECTORY_MODE = 0o700

/** Why the temp root is refused, for the log; 'ok' when it is trusted. */
export type PrivateTempRootVerdict =
  'ok' | 'symlink' | 'not-a-directory' | 'other-owner' | 'open-mode' | 'unavailable'

/**
 * Whether `root` (a directory under the OS temp directory, which on Linux is the shared,
 * world-writable /tmp) is main's own private directory and may be trusted as a local-media
 * root. Another local user could pre-create the expected name as a symlink to a directory
 * they choose, or as their own directory, and that target would become an allowed root. So
 * main creates the directory itself (mode 0700) when it is missing, and trusts it only when
 * it is a real directory (not a symlink or junction), owned by the current user, with no
 * group or other permissions; a looser mode on main's own directory is tightened. Anything
 * else is refused (and not repaired: main never deletes what another user created).
 */
export function checkPrivateLocalMediaTempRoot(
  root: string,
  {
    lstatSync = (target) => fs.lstatSync(target),
    mkdirSync = (target, options) => fs.mkdirSync(target, options),
    chmodSync = (target, mode) => fs.chmodSync(target, mode),
    getuid = typeof process.getuid === 'function' ? () => process.getuid!() : null
  }: PrivateTempRootDependencies = {}
): PrivateTempRootVerdict {
  const inspect = () => {
    try {
      return lstatSync(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  try {
    let stat = inspect()
    if (!stat) {
      mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      // Checked again: a symlink planted between the check and the mkdir is caught here.
      stat = inspect()
      if (!stat) return 'unavailable'
    }
    if (stat.isSymbolicLink()) return 'symlink'
    if (!stat.isDirectory()) return 'not-a-directory'
    if (!getuid) return 'ok'
    if (stat.uid !== getuid()) return 'other-owner'
    if ((stat.mode & 0o077) === 0) return 'ok'
    chmodSync(root, PRIVATE_DIRECTORY_MODE)
    const tightened = inspect()
    if (!tightened) return 'unavailable'
    if (tightened.isSymbolicLink()) return 'symlink'
    if (!tightened.isDirectory()) return 'not-a-directory'
    if (tightened.uid !== getuid()) return 'other-owner'
    return (tightened.mode & 0o077) === 0 ? 'ok' : 'open-mode'
  } catch {
    return 'unavailable'
  }
}

export function ensurePrivateLocalMediaTempRoot(
  root: string,
  dependencies: PrivateTempRootDependencies = {}
): boolean {
  return checkPrivateLocalMediaTempRoot(root, dependencies) === 'ok'
}

export type LocalMediaTempRootVerifierDependencies = PrivateTempRootDependencies & {
  realpathSync?: (target: string) => string
  warn?: (message: string) => void
}

/**
 * Verifies the temp root once and remembers its canonical path, so the local-media requests
 * that consult it do not stat it each time. The remembered canonical path is what callers
 * use (a pinned root, never resolved again): a symlink put in place of the directory later
 * leads every path under it outside that path, so it widens nothing. Writes verify again
 * first (reverify), and so does any use that failed. A refusal is logged once, with its
 * reason and without the path.
 */
export function createLocalMediaTempRootVerifier({
  realpathSync = (target) => fs.realpathSync.native(target),
  warn = (message) => console.warn(message),
  ...dependencies
}: LocalMediaTempRootVerifierDependencies = {}): {
  get(root: string): string | null
  reverify(root: string): string | null
  forget(): void
} {
  const accepted = new Map<string, string>()
  let refusalLogged = false
  const verify = (root: string): string | null => {
    let verdict = checkPrivateLocalMediaTempRoot(root, dependencies)
    if (verdict === 'ok') {
      try {
        const canonical = path.resolve(realpathSync(root))
        accepted.set(root, canonical)
        refusalLogged = false
        return canonical
      } catch {
        verdict = 'unavailable'
      }
    }
    accepted.delete(root)
    if (!refusalLogged) {
      refusalLogged = true
      warn(`[LocalMedia] The temporary media folder is not used: it is not private (${verdict})`)
    }
    return null
  }
  return {
    get: (root) => accepted.get(root) ?? verify(root),
    reverify: verify,
    forget: () => accepted.clear()
  }
}

const defaultTempRootVerifier = createLocalMediaTempRootVerifier()

/** The canonical path of the verified private temp root (verified once), or null. */
export function getVerifiedLocalMediaTempRoot(root: string): string | null {
  return defaultTempRootVerifier.get(root)
}

/** Verifies the temp root again now: before writing into it, or after a use failed. */
export function reverifyLocalMediaTempRoot(root: string): string | null {
  return defaultTempRootVerifier.reverify(root)
}

/** A use of the folder failed: it is verified again at the next use. */
export function forgetLocalMediaTempRootVerification(): void {
  defaultTempRootVerifier.forget()
}
