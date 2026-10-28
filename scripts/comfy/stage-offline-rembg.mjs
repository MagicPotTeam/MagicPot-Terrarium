// Default-off build-time materializer, not a Comfy installer, model downloader or runtime attestor.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { types } from 'node:util'

export const OFFLINE_REMBG_FILES = Object.freeze([
  '__init__.py',
  'nodes.py',
  'offline_loader.py',
  'rgba8_png.py',
  '_inspyrenet/__init__.py',
  '_inspyrenet/InSPyReNet.py',
  '_inspyrenet/backbones/__init__.py',
  '_inspyrenet/backbones/SwinTransformer.py',
  '_inspyrenet/modules/__init__.py',
  '_inspyrenet/modules/layers.py',
  '_inspyrenet/modules/context_module.py',
  '_inspyrenet/modules/attention_module.py',
  '_inspyrenet/modules/decoder_module.py',
  'LICENSE.inspyrenet',
  'LICENSE.swin',
  'NOTICE',
  'README.md',
  'provenance.json'
])
const INVALID = 'Offline rembg staging refused; existing files were not overwritten.'
const MAX_FILE = 512 * 1024
const MAX_TOTAL = 2 * 1024 * 1024
export function parseOfflineRembgFlag(argv) {
  if (
    !Array.isArray(argv) ||
    (argv.length !== 0 && !(argv.length === 1 && argv[0] === '--offline-rembg'))
  ) {
    throw new Error('Only an optional --offline-rembg flag is supported by embedded staging.')
  }
  return argv.length === 1
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stat = (file) => fs.lstatSync(file, { bigint: true })
const fail = () => {
  throw new Error(INVALID)
}
const check = (condition) => {
  if (!condition) fail()
}
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const normalReal = (file) => {
  const value = fs.realpathSync.native(file)
  return value.startsWith('\\\\?\\') ? value.slice(4) : value
}
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameFile = (a, b) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.nlink === b.nlink
const regular = (value) =>
  value.isFile() &&
  !value.isSymbolicLink() &&
  value.nlink === 1n &&
  value.size > 0n &&
  value.size <= BigInt(MAX_FILE)

function optionsSnapshot(input) {
  check(input !== null && typeof input === 'object' && !types.isProxy(input))
  check([null, Object.prototype].includes(Object.getPrototypeOf(input)))
  const result = Object.create(null)
  const keys = Reflect.ownKeys(input)
  check(keys.length >= 1 && keys.length <= 2)
  for (const key of keys) {
    check(key === 'projectRoot' || key === 'enabled')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    check(descriptor && 'value' in descriptor && descriptor.enumerable)
    result[key] = descriptor.value
  }
  check(Object.hasOwn(result, 'projectRoot'))
  check(!Object.hasOwn(result, 'enabled') || typeof result.enabled === 'boolean')
  return result
}

function projectPath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 32768)
  check(
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  )
  check(path.isAbsolute(value) && !value.startsWith('//') && !value.startsWith('\\\\'))
  check(!value.split(/[\\/]/).some((part) => part === '..' || part === '.'))
  const absolute = path.resolve(value),
    drive = path.parse(absolute).root
  check(drive === '/' || /^[A-Za-z]:\\$/.test(drive))
  const parts = absolute.slice(drive.length).split(path.sep)
  check(
    parts.every(
      (part) =>
        part &&
        !/[\\<>:"|?*]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i.test(part)
    )
  )
  return absolute
}

// Reject link/junction ancestry before filesystem reads/writes. This detects ordinary changes;
// it is not a claim of openat-style race immunity against a hostile local filesystem owner.
function directoryChain(directory) {
  const paths = []
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    paths.push(cursor)
    if (path.dirname(cursor) === cursor) break
  }
  return paths.reverse().map((cursor) => {
    const value = stat(cursor)
    check(value.isDirectory() && !value.isSymbolicLink())
    check(samePath(path.resolve(normalReal(cursor)), path.resolve(cursor)))
    return { path: cursor, stat: value }
  })
}
function checkChain(chain) {
  for (const entry of chain) {
    const current = stat(entry.path)
    check(current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, entry.stat))
    check(samePath(path.resolve(normalReal(entry.path)), path.resolve(entry.path)))
  }
}
function requireAbsent(file) {
  try {
    fs.lstatSync(file)
    fail()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
function readPinned(file, chain, remaining = MAX_FILE) {
  checkChain(chain)
  const before = stat(file)
  check(regular(before) && before.size <= BigInt(remaining))
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
  )
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    check(regular(opened) && sameFile(before, opened))
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      check(count > 0)
      offset += count
    }
    check(sameFile(opened, fs.fstatSync(fd, { bigint: true })))
    check(sameFile(opened, stat(file)))
    checkChain(chain)
    return { bytes, sha256: hash(bytes) }
  } finally {
    fs.closeSync(fd)
  }
}

/** Explicit build tool only. Omission/false performs no filesystem operations.
 * Reads a bounded snapshot of the exact owned bundle before creating the destination. No keys,
 * checkpoints, installed dependencies, model imports or caller-selected output paths are accepted.
 * On a later write failure a new partial directory may remain; a retry refuses collisions rather
 * than removing someone else's data. This never certifies an installed or live Comfy runtime.
 */
export function stageOfflineRembg(options) {
  const input = optionsSnapshot(options)
  if (input.enabled !== true) return { staged: false }
  const project = projectPath(input.projectRoot)
  const source = path.join(
    project,
    'packages/runtime-assets/resources/comfy/magicpot_offline_rembg'
  )
  const parent = path.join(project, '.staging/embedded/ComfyUI/custom_nodes')
  const destination = path.join(parent, 'magicpot_offline_rembg')
  const sourceChain = directoryChain(source),
    parentChain = directoryChain(parent)
  requireAbsent(destination)
  const expected = new Set(OFFLINE_REMBG_FILES),
    directories = new Set()
  for (const file of expected) {
    for (
      let directory = path.posix.dirname(file);
      directory !== '.';
      directory = path.posix.dirname(directory)
    )
      directories.add(directory)
  }
  const found = new Set(),
    sources = [],
    chains = []
  let total = 0
  const scan = (directory, relative = '') => {
    const chain = directoryChain(directory)
    chains.push(chain)
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    check(entries.length <= expected.size + directories.size)
    for (const entry of entries) {
      check(!entry.isSymbolicLink())
      const file = relative ? relative + '/' + entry.name : entry.name
      if (entry.isDirectory()) {
        check(directories.has(file))
        scan(path.join(directory, entry.name), file)
      } else {
        check(entry.isFile() && expected.has(file) && !found.has(file))
        const snapshot = readPinned(path.join(directory, entry.name), chain, MAX_TOTAL - total)
        total += snapshot.bytes.length
        check(total <= MAX_TOTAL)
        sources.push({ path: file, ...snapshot })
        found.add(file)
      }
    }
  }
  scan(source)
  check(found.size === expected.size && [...expected].every((file) => found.has(file)))
  checkChain(sourceChain)
  checkChain(parentChain)
  for (const chain of chains) checkChain(chain)
  requireAbsent(destination)
  fs.mkdirSync(destination) // Exclusive new directory; never remove an existing target.
  const outputChain = directoryChain(destination)
  for (const relative of [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
  )) {
    checkChain(parentChain)
    checkChain(outputChain)
    const target = path.join(destination, ...relative.split('/'))
    directoryChain(path.dirname(target))
    fs.mkdirSync(target)
  }
  const files = []
  for (const item of sources.sort((a, b) => a.path.localeCompare(b.path))) {
    checkChain(parentChain)
    checkChain(outputChain)
    const file = path.join(destination, ...item.path.split('/')),
      chain = directoryChain(path.dirname(file))
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600
    )
    try {
      fs.writeFileSync(fd, item.bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    checkChain(chain)
    const copy = readPinned(file, chain)
    check(copy.sha256 === item.sha256 && copy.bytes.equals(item.bytes))
    files.push({ path: item.path, bytes: item.bytes.length, sha256: item.sha256 })
  }
  checkChain(parentChain)
  checkChain(outputChain)
  return { staged: true, destination, files }
}
