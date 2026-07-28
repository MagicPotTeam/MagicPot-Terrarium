import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
  type Dirent,
  type Stats
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSemanticVersionV1 } from '../../packages/app/src/main/appUpdate/channelManifestProtocol.ts'
import {
  isSafeRelativePath,
  isValidBuildId,
  isValidRuntimeId,
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  type InstalledFileV1
} from '../../packages/app/src/shared/appUpdate/launcherProtocol.ts'
import { inspectArchive } from './build-channel-manifest.ts'
import {
  assertNoSymlinkChain,
  normalizedPath,
  publishExactFileNoReplace,
  resolveSafeDeleteDelegate,
  safeReadRegularFileByFd,
  sameIdentity,
  systemCode
} from './safe-file.ts'

const MAX_ENTRIES = 100_000,
  MAX_INPUT = 8 * 1024 ** 3,
  MAX_SOURCE_FILE = 16 * 1024 ** 3,
  ZIP32_LIMIT = 0xffffffff,
  MAX_JSON = 2 * 1024 * 1024
const UTF8_DESCRIPTOR = 0x0808,
  METHOD_STORE = 0
class PackError extends Error {}
const fail = (message: string): never => {
  throw new PackError(message)
}
interface AppIdentity {
  version: string
  buildId: string
  commitSha: string
  runtimeId: string
  platform: 'win32'
  arch: 'x64'
  entrypoint: string
  createdAt: string
}
interface RuntimeIdentity {
  runtimeId: string
  platform: 'win32'
  arch: 'x64'
  pythonEntrypoint: string
  comfyuiEntrypoint: string
  createdAt: string
}
type Identity = AppIdentity | RuntimeIdentity
interface Options {
  kind: 'app' | 'runtime'
  inputDir: string
  output: string
  identity: string
}
interface Snapshot {
  path: string
  absolute: string
  stat: Stats
  sha256: string
}
interface DirectorySnapshot {
  path: string
  absolute: string
  stat: Stats
  entries: string[]
}
interface Central {
  name: Buffer
  crc: number
  size: number
  offset: number
  time: number
  date: number
}
interface TestLimits {
  zipLimit?: number
  afterScan?: (files: readonly Snapshot[]) => void
  afterIdentityOpen?: (fd: number) => void
  afterTempOpen?: (temporary: string, fd: number) => void
  beforePublish?: () => void
  afterLink?: (output: string) => void
  afterVerify?: (output: string, fd: number) => void
  corruptBeforeVerify?: (fd: number) => void
  beforeCleanup?: (temporary: string, fd: number) => void
}
let testLimits: TestLimits | undefined
export function __setPackLimitsForTest(value?: TestLimits): void {
  testLimits = value
}
export function cliFailureMessage(error: unknown, output?: string): string {
  const reason = error instanceof Error ? error.message : 'unexpected error'
  return `artifact pack failed${output ? ` output=${basename(output)}` : ''}: ${reason}`
}

function args(values: readonly string[]): Options {
  const found = new Map<string, string>(),
    allowed = new Set(['--kind', '--input-dir', '--output', '--identity'])
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i],
      value = values[i + 1]
    if (!key || !allowed.has(key)) fail('unknown option')
    if (!value || value.startsWith('--')) fail('missing option value')
    if (found.has(key)) fail('duplicate option')
    found.set(key, value)
  }
  if (found.size !== 4) fail('missing required option')
  const rawKind = found.get('--kind')
  if (rawKind !== 'app' && rawKind !== 'runtime') fail('kind must be app or runtime')
  const kind = rawKind as 'app' | 'runtime'
  const result: Options = {
    kind,
    inputDir: found.get('--input-dir')!,
    output: found.get('--output')!,
    identity: found.get('--identity')!
  }
  if (![result.inputDir, result.output, result.identity].every(isAbsolute))
    fail('all paths must be absolute')
  if (new Set([result.inputDir, result.output, result.identity].map(normalizedPath)).size !== 3)
    fail('input and output paths must differ')
  return result
}
function strictJson(text: string): unknown {
  let i = 0
  const bad = (): never => fail('identity is not valid strict JSON')
  const ws = (): void => {
    while (' \t\r\n'.includes(text[i] ?? 'x')) i++
  }
  const string = (): string => {
    const start = i
    if (text[i++] !== '"') bad()
    while (i < text.length) {
      const c = text.charCodeAt(i++)
      if (c === 34) {
        try {
          return JSON.parse(text.slice(start, i)) as string
        } catch {
          bad()
        }
      }
      if (c < 32) bad()
      if (c === 92) {
        const e = text[i++]
        if (e === 'u') {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(i, i + 4))) bad()
          i += 4
        } else if (!e || !'"\\/bfnrt'.includes(e)) bad()
      }
    }
    return bad()
  }
  const value = (depth: number): unknown => {
    if (depth > 64) bad()
    ws()
    if (text[i] === '"') return string()
    if (text[i] === '{') {
      i++
      ws()
      const out: Record<string, unknown> = Object.create(null),
        keys = new Set<string>()
      if (text[i] === '}') {
        i++
        return out
      }
      while (true) {
        ws()
        const key = string()
        if (keys.has(key)) fail('identity contains duplicate field')
        keys.add(key)
        ws()
        if (text[i++] !== ':') bad()
        out[key] = value(depth + 1)
        ws()
        if (text[i] === '}') {
          i++
          return out
        }
        if (text[i++] !== ',') bad()
      }
    }
    if (text[i] === '[') {
      i++
      const out: unknown[] = []
      ws()
      if (text[i] === ']') {
        i++
        return out
      }
      while (true) {
        out.push(value(depth + 1))
        ws()
        if (text[i] === ']') {
          i++
          return out
        }
        if (text[i++] !== ',') bad()
      }
    }
    for (const [word, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const)
      if (text.startsWith(word, i)) {
        i += word.length
        return parsed
      }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(text.slice(i))
    if (!match) return bad()
    i += match[0].length
    const n = Number(match[0])
    if (!Number.isFinite(n)) bad()
    return n
  }
  const result = value(0)
  ws()
  if (i !== text.length) bad()
  return result
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('identity must be an object')
  return value as Record<string, unknown>
}
function sameSnapshot(a: Stats, b: Stats): boolean {
  return (
    sameIdentity(a, b) &&
    a.size === b.size &&
    a.nlink === b.nlink &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode
  )
}
function entryType(entry: Dirent): string {
  return entry.isFile()
    ? 'file'
    : entry.isDirectory()
      ? 'dir'
      : entry.isSymbolicLink()
        ? 'symlink'
        : 'special'
}
function directoryEntries(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .map((entry) => `${entry.name}\0${entryType(entry)}`)
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
}
function openDirectory(path: string): number {
  return openSync(
    path,
    constants.O_RDONLY |
      ((constants as typeof constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0)
  )
}
function assertDirectorySnapshot(directory: DirectorySnapshot): void {
  const linked = lstatSync(directory.absolute)
  if (!linked.isDirectory() || linked.isSymbolicLink() || !sameSnapshot(linked, directory.stat))
    fail('input directory tree changed')
  const fd = openDirectory(directory.absolute)
  try {
    if (
      !sameSnapshot(fstatSync(fd), directory.stat) ||
      JSON.stringify(directoryEntries(directory.absolute)) !== JSON.stringify(directory.entries) ||
      !sameSnapshot(fstatSync(fd), directory.stat)
    )
      fail('input directory tree changed')
  } finally {
    closeSync(fd)
  }
}
function assertTree(directories: readonly DirectorySnapshot[]): void {
  for (const directory of directories) assertDirectorySnapshot(directory)
}
function parseIdentity(kind: 'app' | 'runtime', path: string): Identity {
  const result = safeReadRegularFileByFd(
    path,
    MAX_JSON,
    'identity failed safety checks',
    testLimits?.afterIdentityOpen
  )
  const value = object(strictJson(result.bytes.toString('utf8'))),
    app = [
      'version',
      'buildId',
      'commitSha',
      'runtimeId',
      'platform',
      'arch',
      'entrypoint',
      'createdAt'
    ],
    runtime = [
      'runtimeId',
      'platform',
      'arch',
      'pythonEntrypoint',
      'comfyuiEntrypoint',
      'createdAt'
    ],
    wanted = kind === 'app' ? app : runtime
  if (
    Object.keys(value).length !== wanted.length ||
    wanted.some((key) => !Object.hasOwn(value, key))
  )
    fail('identity has missing, unknown, or private fields')
  if (Object.values(value).some((item) => typeof item !== 'string'))
    fail('identity fields must be strings')
  const identity = value as unknown as Identity
  if (
    identity.platform !== 'win32' ||
    identity.arch !== 'x64' ||
    !isValidRuntimeId(identity.runtimeId)
  )
    fail('identity platform, arch, or runtimeId is invalid')
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(identity.createdAt) ||
    Number.isNaN(Date.parse(identity.createdAt))
  )
    fail('createdAt is invalid')
  if (kind === 'app') {
    const a = identity as AppIdentity
    if (
      !parseSemanticVersionV1(a.version) ||
      !isValidBuildId(a.buildId) ||
      !/^[0-9a-f]{40}$/.test(a.commitSha) ||
      a.buildId.slice(-7) !== a.commitSha.slice(0, 7) ||
      !isSafeRelativePath(a.entrypoint) ||
      !/\.exe$/i.test(a.entrypoint)
    )
      fail('app identity is invalid')
  } else {
    const r = identity as RuntimeIdentity
    if (
      !isSafeRelativePath(r.pythonEntrypoint) ||
      !/\.exe$/i.test(r.pythonEntrypoint) ||
      !isSafeRelativePath(r.comfyuiEntrypoint) ||
      !/\.py$/i.test(r.comfyuiEntrypoint)
    )
      fail('runtime identity is invalid')
  }
  if (!result.stat.isFile() || result.stat.nlink !== 1 || result.stat.size > MAX_JSON)
    fail('identity failed safety checks')
  return identity
}
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
const hasInvalidWindowsFilenameChar = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || ':<>"|?*'.includes(character))
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 260 &&
    path.normalize('NFC') === path &&
    !hasInvalidWindowsFilenameChar(path) &&
    path
      .split('/')
      .every(
        (part) =>
          part && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !WINDOWS_DEVICE.test(part)
      )
  )
}
function hashFile(path: string, expected: Stats): string {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    const opened = fstatSync(fd)
    if (!sameSnapshot(expected, opened)) fail('input changed while reading')
    const hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(1024 * 1024)
    let pos = 0
    while (pos < opened.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - pos), pos)
      if (!count) fail('input changed while reading')
      hash.update(buffer.subarray(0, count))
      pos += count
    }
    if (!sameSnapshot(opened, fstatSync(fd)) || !sameSnapshot(opened, lstatSync(path)))
      fail('input changed while reading')
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}
function scan(root: string): {
  files: Snapshot[]
  directories: DirectorySnapshot[]
  payload: number
} {
  assertNoSymlinkChain(root, true, 'input directory failed safety checks')
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('input directory failed safety checks')
  const files: Snapshot[] = [],
    directories: DirectorySnapshot[] = [],
    keys = new Map<string, 'file' | 'dir'>()
  let count = 0,
    payload = 0
  const walk = (directory: string): void => {
    const before = lstatSync(directory)
    if (!before.isDirectory() || before.isSymbolicLink())
      fail('input contains symlink or special file')
    const fd = openDirectory(directory)
    let entries: string[]
    try {
      if (!sameSnapshot(before, fstatSync(fd))) fail('input directory changed during scan')
      entries = directoryEntries(directory)
      if (!sameSnapshot(before, fstatSync(fd))) fail('input directory changed during scan')
    } finally {
      closeSync(fd)
    }
    directories.push({
      path: relative(root, directory).split(sep).join('/'),
      absolute: directory,
      stat: before,
      entries
    })
    for (const name of entries.map((item) => item.slice(0, item.indexOf('\0')))) {
      const absolute = join(directory, name),
        path = relative(root, absolute).split(sep).join('/')
      if (!safePath(path)) fail('input contains unsafe or non-NFC path')
      const key = path.normalize('NFC').toLowerCase()
      if (keys.has(key)) fail('input contains case or Unicode path collision')
      const stat = lstatSync(absolute)
      if (++count > MAX_ENTRIES) fail('input contains too many entries')
      if (stat.isSymbolicLink()) fail('input contains symlink or reparse point')
      if (stat.isDirectory()) {
        keys.set(key, 'dir')
        walk(absolute)
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('input contains hardlink')
        if (stat.size > MAX_SOURCE_FILE || stat.size >= (testLimits?.zipLimit ?? ZIP32_LIMIT))
          fail('input file exceeds ZIP32 limit')
        payload += stat.size
        if (payload >= MAX_INPUT) fail('input exceeds 8 GiB')
        keys.set(key, 'file')
        files.push({ path, absolute, stat, sha256: hashFile(absolute, stat) })
      } else fail('input contains special file')
    }
    if (!sameSnapshot(before, lstatSync(directory))) fail('input directory changed during scan')
  }
  walk(root)
  if (!files.length) fail('input directory is empty')
  if (keys.has('manifest.json')) fail('input already contains root manifest.json')
  for (const [key, type] of keys)
    if (type === 'file')
      for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1))
        if (keys.get(key.slice(0, slash)) === 'file') fail('input contains file-directory conflict')
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
  assertTree(directories)
  if (!sameSnapshot(rootStat, lstatSync(root))) fail('input directory changed during scan')
  return { files, directories, payload }
}
function manifest(
  kind: 'app' | 'runtime',
  identity: Identity,
  files: InstalledFileV1[],
  payload: number
): Buffer {
  const base =
    kind === 'app'
      ? { schema: 1, kind: 'magicpot-app', ...(identity as AppIdentity), unpackedSize: 0, files }
      : {
          schema: 1,
          kind: 'magicpot-runtime',
          runtimeId: identity.runtimeId,
          platform: identity.platform,
          arch: identity.arch,
          createdAt: identity.createdAt,
          entrypoints: {
            python: (identity as RuntimeIdentity).pythonEntrypoint,
            comfyui: (identity as RuntimeIdentity).comfyuiEntrypoint
          },
          unpackedSize: 0,
          files
        }
  let bytes = Buffer.alloc(0)
  for (let i = 0; i < 20; i++) {
    bytes = Buffer.from(`${JSON.stringify(base, null, 2)}\n`)
    const total = payload + bytes.length
    if (base.unpackedSize === total) break
    base.unpackedSize = total
  }
  bytes = Buffer.from(`${JSON.stringify(base, null, 2)}\n`)
  if (base.unpackedSize !== payload + bytes.length) fail('manifest unpackedSize fixed point failed')
  const compatibility = JSON.stringify({ ...base, unpackedSize: payload })
  if (kind === 'app') parseInstalledAppManifest(compatibility)
  else parseInstalledRuntimeManifest(compatibility)
  return bytes
}
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(bytes: Buffer, crc = 0xffffffff): number {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return crc
}
function dos(createdAt: string): { time: number; date: number } {
  const d = new Date(createdAt),
    year = d.getUTCFullYear()
  if (year < 1980 || year > 2107) fail('createdAt is outside ZIP DOS timestamp range')
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
  }
}
function header(signature: number, size: number): Buffer {
  const b = Buffer.alloc(size)
  b.writeUInt32LE(signature, 0)
  return b
}
function writeAll(fd: number, bytes: Buffer, position: number): number {
  let done = 0
  while (done < bytes.length)
    done += writeSync(fd, bytes, done, bytes.length - done, position + done)
  return position + done
}
function packZip(
  fd: number,
  createdAt: string,
  manifestBytes: Buffer,
  files: readonly Snapshot[],
  currentDirectories: readonly DirectorySnapshot[]
): void {
  const stamp = dos(createdAt),
    central: Central[] = [],
    limit = testLimits?.zipLimit ?? ZIP32_LIMIT
  let position = 0
  const add = (nameText: string, size: number, source?: Snapshot, memory?: Buffer): void => {
    if (size >= limit || position >= limit) fail('ZIP32 size or offset overflow')
    const name = Buffer.from(nameText, 'utf8'),
      offset = position,
      local = header(0x04034b50, 30)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_DESCRIPTOR, 6)
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt16LE(name.length, 26)
    position = writeAll(fd, local, position)
    position = writeAll(fd, name, position)
    let crc = 0xffffffff,
      copied = 0
    const hash = createHash('sha256')
    if (memory) {
      crc = crc32(memory, crc)
      hash.update(memory)
      position = writeAll(fd, memory, position)
      copied = memory.length
    } else if (source) {
      assertTree(currentDirectories)
      const input = openSync(source.absolute, constants.O_RDONLY)
      try {
        if (!sameSnapshot(source.stat, fstatSync(input))) fail('input changed while packing')
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        while (copied < size) {
          const n = readSync(input, buffer, 0, Math.min(buffer.length, size - copied), copied)
          if (!n) fail('input changed while packing')
          const chunk = buffer.subarray(0, n)
          crc = crc32(chunk, crc)
          hash.update(chunk)
          position = writeAll(fd, chunk, position)
          copied += n
        }
        if (
          !sameSnapshot(source.stat, fstatSync(input)) ||
          !sameSnapshot(source.stat, lstatSync(source.absolute)) ||
          hash.digest('hex') !== source.sha256
        )
          fail('input changed while packing')
      } finally {
        closeSync(input)
      }
      assertTree(currentDirectories)
    }
    if (copied !== size) fail('entry size changed while packing')
    crc = (crc ^ 0xffffffff) >>> 0
    const descriptor = header(0x08074b50, 16)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    position = writeAll(fd, descriptor, position)
    central.push({ name, crc, size, offset, ...stamp })
  }
  add('manifest.json', manifestBytes.length, undefined, manifestBytes)
  for (const file of files) add(file.path, file.stat.size, file)
  const centralOffset = position
  for (const item of central) {
    const c = header(0x02014b50, 46)
    c.writeUInt16LE(0x0314, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(UTF8_DESCRIPTOR, 8)
    c.writeUInt16LE(METHOD_STORE, 10)
    c.writeUInt16LE(item.time, 12)
    c.writeUInt16LE(item.date, 14)
    c.writeUInt32LE(item.crc, 16)
    c.writeUInt32LE(item.size, 20)
    c.writeUInt32LE(item.size, 24)
    c.writeUInt16LE(item.name.length, 28)
    c.writeUInt32LE(0x81a40000, 38)
    c.writeUInt32LE(item.offset, 42)
    position = writeAll(fd, c, position)
    position = writeAll(fd, item.name, position)
  }
  const centralSize = position - centralOffset
  if (
    position >= limit ||
    centralOffset >= limit ||
    centralSize >= limit ||
    central.length > 0xffff
  )
    fail('ZIP32 central directory overflow')
  const end = header(0x06054b50, 22)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  writeAll(fd, end, position)
}
export async function run(values: readonly string[]): Promise<void> {
  const options = args(values),
    identity = parseIdentity(options.kind, options.identity)
  try {
    lstatSync(options.output)
    fail('output already exists')
  } catch (error) {
    if (error instanceof PackError) throw error
    if (systemCode(error) !== 'ENOENT') fail('output availability could not be determined')
  }
  assertNoSymlinkChain(dirname(options.output), true, 'output parent failed safety checks')
  const scanned = scan(options.inputDir),
    declared = scanned.files.map((file) => ({
      path: file.path,
      size: file.stat.size,
      sha256: file.sha256
    }))
  const required =
    options.kind === 'app'
      ? [(identity as AppIdentity).entrypoint]
      : [
          (identity as RuntimeIdentity).pythonEntrypoint,
          (identity as RuntimeIdentity).comfyuiEntrypoint
        ]
  if (
    required.some(
      (entry) => !scanned.files.some((file) => file.path === entry.replaceAll('\\', '/'))
    )
  )
    fail('identity entrypoint is missing from input')
  testLimits?.afterScan?.(scanned.files)
  const manifestBytes = manifest(options.kind, identity, declared, scanned.payload),
    temporary = resolve(
      dirname(options.output),
      `.${basename(options.output)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
    ),
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600),
    tempIdentity = fstatSync(fd)
  let published = false
  try {
    testLimits?.afterTempOpen?.(temporary, fd)
    packZip(fd, identity.createdAt, manifestBytes, scanned.files, scanned.directories)
    fsyncSync(fd)
    assertTree(scanned.directories)
    const archiveStat = fstatSync(fd),
      archiveSha256 = (() => {
        const hash = createHash('sha256'),
          buffer = Buffer.allocUnsafe(1024 * 1024)
        let offset = 0
        while (offset < archiveStat.size) {
          const count = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, archiveStat.size - offset),
            offset
          )
          if (!count) fail('temporary archive changed')
          hash.update(buffer.subarray(0, count))
          offset += count
        }
        return hash.digest('hex')
      })()
    const deadline = { expiresAt: Number.POSITIVE_INFINITY, now: () => 0 }
    const validate = async (archiveFd: number): Promise<void> => {
      testLimits?.corruptBeforeVerify?.(archiveFd)
      if (options.kind === 'app')
        await inspectArchive(archiveFd, parseInstalledAppManifest, 'app archive', deadline)
      else
        await inspectArchive(archiveFd, parseInstalledRuntimeManifest, 'runtime archive', deadline)
    }
    await validate(fd)
    assertTree(scanned.directories)
    testLimits?.beforePublish?.()
    await publishExactFileNoReplace({
      tempPath: temporary,
      tempFd: fd,
      output: options.output,
      expectedSize: archiveStat.size,
      expectedSha256: archiveSha256,
      verifyFromFd: validate,
      hooks: {
        afterLink: () => testLimits?.afterLink?.(options.output),
        afterVerify: ({ outputFd }) => testLimits?.afterVerify?.(options.output, outputFd)
      }
    })
    published = true
    process.stdout.write(`packed ${options.kind} artifact entries=${declared.length}\n`)
  } catch (error) {
    process.stderr.write(
      `artifact publication failed; any output path is quarantined and no success was reported: ${error instanceof Error ? error.message : 'unexpected error'}\n`
    )
    throw error
  } finally {
    try {
      if (!published) {
        testLimits?.beforeCleanup?.(temporary, fd)
        const live = fstatSync(fd)
        if (sameIdentity(live, tempIdentity)) {
          const current = lstatSync(temporary)
          if (!current.isSymbolicLink() && current.isFile() && sameIdentity(current, live)) {
            const delegate = resolveSafeDeleteDelegate()
            const request = { root: dirname(options.output), path: temporary }
            const identity = delegate.inspect(request)
            const rebound = lstatSync(temporary)
            if (!sameIdentity(rebound, live)) fail('temporary cleanup failed safety checks')
            delegate.delete({ ...request, identity })
            const unlinked = fstatSync(fd)
            if (
              !sameIdentity(unlinked, live) ||
              (unlinked.nlink !== 0 && unlinked.nlink !== live.nlink - 1)
            )
              fail('temporary cleanup failed safety checks')
          }
        }
      }
    } catch (error) {
      if (systemCode(error) !== 'ENOENT') {
        /* preserve unknown or attacker-owned paths */
      }
    } finally {
      closeSync(fd)
    }
  }
}
if (normalizedPath(process.argv[1] ?? '') === normalizedPath(fileURLToPath(import.meta.url))) {
  const values = process.argv.slice(2),
    outputIndex = values.indexOf('--output'),
    output = outputIndex >= 0 ? values[outputIndex + 1] : undefined
  run(values).catch((error) => {
    process.stderr.write(`${cliFailureMessage(error, output)}\n`)
    process.exitCode = 1
  })
}
