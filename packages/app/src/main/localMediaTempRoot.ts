import fs from 'node:fs'
import path from 'node:path'

export type PrivateTempRootDependencies = {
  lstatSync?: (
    target: string
  ) => Pick<fs.Stats, 'isDirectory' | 'isSymbolicLink' | 'uid' | 'mode'> &
    Partial<Pick<fs.Stats, 'dev' | 'ino'>>
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
  /** Monotonic milliseconds, for the periodic identity check. */
  now?: () => number
}

/** A remembered folder is checked again (one lstat) when its last check is this old. */
export const LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS = 60_000

/**
 * Verifies the temp root once and remembers its canonical path and identity, so the
 * local-media requests that consult it do not stat it each time. The remembered canonical
 * path is what callers use (a pinned root, never resolved again): a symlink put in place of
 * the directory later leads every path under it outside that path, so it widens nothing. At
 * most once a minute a read checks that the folder is still the same one (device, inode,
 * owner, private mode, no symlink); if it changed (removed by a temp cleaner and created again
 * by someone else) it is refused and verified afresh at the next use. Writes verify again
 * first (reverify), and so does any use that failed. A refusal is logged once, with its
 * reason and without the path.
 */
export function createLocalMediaTempRootVerifier({
  realpathSync = (target) => fs.realpathSync.native(target),
  warn = (message) => console.warn(message),
  now = () => performance.now(),
  ...dependencies
}: LocalMediaTempRootVerifierDependencies = {}): {
  get(root: string): string | null
  reverify(root: string): string | null
  forget(): void
} {
  const lstatSync = dependencies.lstatSync ?? ((target: string) => fs.lstatSync(target))
  const getuid =
    dependencies.getuid === undefined
      ? typeof process.getuid === 'function'
        ? () => process.getuid!()
        : null
      : dependencies.getuid
  type Accepted = { canonical: string; dev?: number; ino?: number; checkedAt: number }
  const accepted = new Map<string, Accepted>()
  let refusalLogged = false
  const refuse = (root: string, reason: string): null => {
    accepted.delete(root)
    if (!refusalLogged) {
      refusalLogged = true
      warn(`[LocalMedia] The temporary media folder is not used: it is not private (${reason})`)
    }
    return null
  }
  const verify = (root: string): string | null => {
    let verdict = checkPrivateLocalMediaTempRoot(root, dependencies)
    if (verdict === 'ok') {
      try {
        const canonical = path.resolve(realpathSync(root))
        const identity = lstatSync(root)
        accepted.set(root, {
          canonical,
          dev: identity.dev,
          ino: identity.ino,
          checkedAt: now()
        })
        refusalLogged = false
        return canonical
      } catch {
        verdict = 'unavailable'
      }
    }
    return refuse(root, verdict)
  }
  const recheck = (root: string, entry: Accepted): string | null => {
    let stat: ReturnType<typeof lstatSync> | null = null
    try {
      stat = lstatSync(root)
    } catch {
      stat = null
    }
    const same =
      stat !== null &&
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      stat.dev === entry.dev &&
      stat.ino === entry.ino &&
      (!getuid || (stat.uid === getuid() && (stat.mode & 0o077) === 0))
    if (!same) return refuse(root, 'changed')
    entry.checkedAt = now()
    return entry.canonical
  }
  return {
    get: (root) => {
      const entry = accepted.get(root)
      if (!entry) return verify(root)
      return now() - entry.checkedAt < LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS
        ? entry.canonical
        : recheck(root, entry)
    },
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
