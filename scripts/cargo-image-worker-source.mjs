import fs from 'node:fs'
import path from 'node:path'

const stable = (left, right) =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every((key) => left[key] === right[key])
const regular = (stat) => stat.isFile() && !stat.isSymbolicLink()

const MAX_SEARCH_ENTRIES = 200_000

const lstatOrNull = (target) => {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

// Newer Cargo keeps its intermediate artifacts in a build directory inside the target directory
// instead of release/deps, so the second link moves. It is looked for only inside this build's
// own target directory, without following links, and it must be the only other link there.
function findBuildDirAlias(sourcePath, searchRoot) {
  // 64-bit file ids (NTFS) lose precision as numbers, so compare them as bigints.
  const before = fs.lstatSync(sourcePath, { bigint: true })
  const matches = []
  const pending = [searchRoot]
  let entries = 0
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > MAX_SEARCH_ENTRIES) {
        throw new Error('Cargo image worker target directory is too large to search')
      }
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile() && full !== sourcePath) {
        const stat = fs.lstatSync(full, { bigint: true })
        if (stat.dev === before.dev && stat.ino === before.ino) matches.push(full)
      }
    }
  }
  if (matches.length !== 1) throw new Error('Cargo image worker hard-link alias not found')
  return matches[0]
}

// Cargo publishes the executable as two links: release/name.exe and its build artifact, which
// older Cargo keeps at release/deps/name_with_underscores.exe and newer Cargo keeps in its build
// directory. Only that exact two-link identity is accepted here; with `searchRoot` (the build's
// own Cargo target directory) the build-directory link is accepted too. The existing
// publication gate still receives a single-link snapshot and continues to reject arbitrary
// linked source/output files.
export function prepareCargoImageWorkerSource(sourcePath, { searchRoot } = {}) {
  const before = fs.lstatSync(sourcePath)
  if (!regular(before)) throw new Error('Cargo image worker source must be a regular file')
  if (before.nlink === 1) return { sourcePath, cleanup() {} }
  if (before.nlink !== 2 || path.basename(sourcePath) !== 'canvas-thumbnail-sidecar.exe') {
    throw new Error('Unexpected Cargo image worker hard-link layout')
  }
  const releaseDir = path.dirname(sourcePath)
  const legacyAlias = path.join(releaseDir, 'deps', 'canvas_thumbnail_sidecar.exe')
  let alias = legacyAlias
  if (!lstatOrNull(legacyAlias)) {
    if (!searchRoot) throw new Error('Cargo image worker hard-link alias not found')
    const root = path.resolve(searchRoot)
    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Cargo image worker directories must not be symbolic links')
    }
    if (path.relative(root, sourcePath).startsWith('..')) {
      throw new Error('Cargo image worker source is outside its target directory')
    }
    alias = findBuildDirAlias(sourcePath, root)
  }
  const depsDir = path.dirname(alias)
  for (const directory of [releaseDir, depsDir]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Cargo image worker directories must not be symbolic links')
    }
  }
  const aliasStat = fs.lstatSync(alias)
  if (!regular(aliasStat) || !stable(before, aliasStat)) {
    throw new Error('Cargo image worker hard-link alias identity mismatch')
  }
  const input = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let owned
  try {
    if (!stable(before, fs.fstatSync(input))) throw new Error('Cargo image worker source changed')
    owned = fs.mkdtempSync(path.join(releaseDir, '.magicpot-image-worker-'))
    const snapshot = path.join(owned, 'worker.exe')
    const output = fs.openSync(snapshot, 'wx', 0o600)
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      let total = 0
      for (;;) {
        const count = fs.readSync(input, buffer, 0, buffer.length, null)
        if (!count) break
        let written = 0
        while (written < count) {
          const amount = fs.writeSync(output, buffer, written, count - written)
          if (!amount) throw new Error('Cargo image worker snapshot write stalled')
          written += amount
        }
        total += count
      }
      fs.fsyncSync(output)
      const copied = fs.fstatSync(output)
      if (
        !copied.isFile() ||
        copied.nlink !== 1 ||
        copied.size !== before.size ||
        total !== before.size
      ) {
        throw new Error('Invalid Cargo image worker single-link snapshot')
      }
      if (
        !stable(before, fs.fstatSync(input)) ||
        !stable(before, fs.lstatSync(sourcePath)) ||
        !stable(before, fs.lstatSync(alias))
      ) {
        throw new Error('Cargo image worker source changed during snapshot')
      }
    } finally {
      fs.closeSync(output)
    }
    return {
      sourcePath: snapshot,
      cleanup() {
        fs.rmSync(owned, { recursive: true })
      }
    }
  } catch (error) {
    if (owned) fs.rmSync(owned, { recursive: true })
    throw error
  } finally {
    fs.closeSync(input)
  }
}
