import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'

const MAX_CHUNK = 16 * 1024 * 1024
function boundedRegular(file: string, maxBytes: number, virtual = false): Buffer {
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) throw new Error('Invalid bounded HTML bootstrap asset.')
  // Electron extracts an ASAR member on open(); its physical inode is unrelated
  // to lstat's synthetic archive-member inode (which changes on every call).
  // Read members through the virtual
  // API, retaining size/hash checks and a physical archive identity fence below.
  if (virtual) {
    const bytes = readFileSync(file), after = lstatSync(file)
    if (bytes.length !== before.size || !after.isFile() || after.isSymbolicLink() || after.size !== before.size) throw new Error('HTML bootstrap archive member changed.')
    return bytes
  }
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('HTML bootstrap asset changed.')
    const bytes = Buffer.alloc(opened.size)
    let count = 0
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) throw new Error('HTML bootstrap asset truncated.'); count += n }
    const after = fstatSync(fd), current = lstatSync(file)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink()) throw new Error('HTML bootstrap asset changed while reading.')
    return bytes
  } finally { closeSync(fd) }
}
/** Build closure/corruption check, not a replacement for package signing or a disk rollback anchor. */
export function verifyHtmlBootstrap(appRoot: string): string {
  if (!path.isAbsolute(appRoot)) throw new Error('HTML bootstrap root must be absolute.')
  const root = path.resolve(appRoot)
  const virtual = path.extname(root).toLowerCase() === '.asar'
  const physicalStat: typeof lstatSync = virtual ? (createRequire(__filename)('original-fs') as typeof import('node:fs')).lstatSync : lstatSync
  const archive = virtual ? physicalStat(root) : undefined
  if (archive && (!archive.isFile() || archive.isSymbolicLink() || archive.nlink !== 1)) throw new Error('Invalid HTML bootstrap archive.')
  let dir = root
  for (const part of ['out', 'main']) { dir = path.join(dir, part); const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked HTML bootstrap directory.') }
  const manifest = JSON.parse(boundedRegular(path.join(dir, 'html-bootstrap-manifest.json'), 65536, virtual).toString('utf8'))
  if (manifest.protocol !== 'magicpot-isolated-html-bootstrap/v1' || manifest.entry !== 'index.js' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) throw new Error('Current isolated HTML bootstrap manifest unavailable; rebuild sources.')
  let total = 0
  const names = new Set<string>()
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || !/^[A-Za-z0-9_.-]+\.js$/.test(item.path) || names.has(item.path) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_CHUNK || (total += item.bytes) > 64 * 1024 * 1024) throw new Error('Invalid HTML bootstrap manifest entry.')
    names.add(item.path)
    const bytes = boundedRegular(path.join(dir, item.path), MAX_CHUNK, virtual)
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('HTML bootstrap build identity changed.')
  }
  if (archive) {
    const after = physicalStat(root)
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== archive.ino || after.dev !== archive.dev || after.size !== archive.size || after.mtimeMs !== archive.mtimeMs) throw new Error('HTML bootstrap archive changed.')
  }
  if (!names.has('index.js')) throw new Error('HTML bootstrap entry absent.')
  return path.join(dir, 'index.js')
}
