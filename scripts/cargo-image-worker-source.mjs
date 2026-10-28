import fs from 'node:fs'
import path from 'node:path'

const stable = (left, right) =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every((key) => left[key] === right[key])
const regular = (stat) => stat.isFile() && !stat.isSymbolicLink()

// Cargo publishes the executable as two links: release/name.exe and
// release/deps/name_with_underscores.exe. Only that exact two-link identity is
// accepted here. The existing publication gate still receives a single-link
// snapshot and continues to reject arbitrary linked source/output files.
export function prepareCargoImageWorkerSource(sourcePath) {
  const before = fs.lstatSync(sourcePath)
  if (!regular(before)) throw new Error('Cargo image worker source must be a regular file')
  if (before.nlink === 1) return { sourcePath, cleanup() {} }
  if (before.nlink !== 2 || path.basename(sourcePath) !== 'canvas-thumbnail-sidecar.exe') {
    throw new Error('Unexpected Cargo image worker hard-link layout')
  }
  const releaseDir = path.dirname(sourcePath)
  const depsDir = path.join(releaseDir, 'deps')
  const alias = path.join(depsDir, 'canvas_thumbnail_sidecar.exe')
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
