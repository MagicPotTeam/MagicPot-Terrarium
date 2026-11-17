import fs from 'node:fs'

export type PrivateTempRootDependencies = {
  lstatSync?: (target: string) => Pick<fs.Stats, 'isDirectory' | 'isSymbolicLink' | 'uid' | 'mode'>
  mkdirSync?: (target: string, options: { recursive: true; mode: number }) => unknown
  chmodSync?: (target: string, mode: number) => void
  /** null on Windows, where the temp directory is per user and has no POSIX owner. */
  getuid?: (() => number) | null
}

const PRIVATE_DIRECTORY_MODE = 0o700

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
export function ensurePrivateLocalMediaTempRoot(
  root: string,
  {
    lstatSync = (target) => fs.lstatSync(target),
    mkdirSync = (target, options) => fs.mkdirSync(target, options),
    chmodSync = (target, mode) => fs.chmodSync(target, mode),
    getuid = typeof process.getuid === 'function' ? () => process.getuid!() : null
  }: PrivateTempRootDependencies = {}
): boolean {
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
      if (!stat) return false
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    if (!getuid) return true
    if (stat.uid !== getuid()) return false
    if ((stat.mode & 0o077) === 0) return true
    chmodSync(root, PRIVATE_DIRECTORY_MODE)
    const tightened = inspect()
    return Boolean(
      tightened &&
      !tightened.isSymbolicLink() &&
      tightened.isDirectory() &&
      tightened.uid === getuid() &&
      (tightened.mode & 0o077) === 0
    )
  } catch {
    return false
  }
}
