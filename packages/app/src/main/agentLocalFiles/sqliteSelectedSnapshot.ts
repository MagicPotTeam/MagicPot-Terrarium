import {
  constants,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  realpathSync
} from 'node:fs'
import path from 'node:path'
import { SQLITE_PREVIEW_MAX_SNAPSHOT_BYTES } from './sqlitePreviewProtocol'

/** MAIN-only, immediately after native chooser selection. Not an IPC path reader.
 * Caller must bind selection to live renderer/document scope and retain authority
 * through worker exit. No generic-reader policy is modified by this dedicated path.
 */
export function readExplicitlySelectedSqliteSnapshot(
  selectedPath: string,
  assertCurrent: () => void
): Buffer {
  assertCurrent()
  if (
    !path.isAbsolute(selectedPath) ||
    /^[\\/]{2}/.test(selectedPath) ||
    selectedPath.includes('\0') ||
    !/\.(?:db|sqlite|sqlite3)$/i.test(selectedPath)
  )
    throw new Error('Invalid selected SQLite file.')
  const root = path.parse(selectedPath).root
  const parts = selectedPath.slice(root.length).split(/[\\/]/)
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid selected SQLite path.')
  let current = root
  const chain = parts.map((part, index) => {
    current = path.join(current, part)
    const stat = lstatSync(current, { bigint: true })
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory()) ||
      (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1n))
    )
      throw new Error('Linked SQLite selection denied.')
    return { path: current, stat }
  })
  const original = chain.at(-1)!.stat
  if (original.size < 100n || original.size > BigInt(SQLITE_PREVIEW_MAX_SNAPSHOT_BYTES))
    throw new Error('Selected SQLite snapshot size denied.')
  const canonical = realpathSync.native(selectedPath)
  if (
    process.platform === 'win32'
      ? canonical.toLowerCase() !== path.resolve(selectedPath).toLowerCase()
      : canonical !== path.resolve(selectedPath)
  )
    throw new Error('Changed SQLite selection denied.')
  const fd = openSync(
    selectedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (
      opened.dev !== original.dev ||
      opened.ino !== original.ino ||
      opened.size !== original.size ||
      opened.nlink !== 1n ||
      !opened.isFile()
    )
      throw new Error('SQLite selection changed on open.')
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      assertCurrent()
      const read = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset)
      if (!read) throw new Error('SQLite selection changed while reading.')
      offset += read
    }
    assertCurrent()
    const after = fstatSync(fd, { bigint: true })
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.nlink !== 1n
    )
      throw new Error('SQLite selection changed while reading.')
    for (const entry of chain) {
      const latest = lstatSync(entry.path, { bigint: true })
      if (latest.isSymbolicLink() || latest.dev !== entry.stat.dev || latest.ino !== entry.stat.ino)
        throw new Error('SQLite path identity changed.')
    }
    if (bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0')
      throw new Error('Not a standalone SQLite snapshot.')
    return bytes
  } finally {
    closeSync(fd)
  }
}
