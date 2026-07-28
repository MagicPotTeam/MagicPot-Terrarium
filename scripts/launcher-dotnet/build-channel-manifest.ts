import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import * as yauzl from 'yauzl'
import {
  parseChannelManifestV1,
  parseSemanticVersionV1,
  type ChannelReleaseV1,
  type TrustedReleaseSource,
  type UpdateChannel
} from '../../packages/app/src/main/appUpdate/channelManifestProtocol.ts'
import {
  parseInstalledAppManifest,
  parseInstalledRuntimeManifest,
  type InstalledAppManifestV1,
  type InstalledRuntimeManifestV1
} from '../../packages/app/src/shared/appUpdate/launcherProtocol.ts'
import {
  assertNoSymlinkChain,
  normalizedPath,
  publishExactNoReplace,
  sameIdentity
} from './safe-file.ts'

const MAX_JSON = 2 * 1024 * 1024,
  MAX_ARCHIVE = 8 * 1024 ** 3,
  MAX_SINGLE_FILE = 16 * 1024 ** 3,
  MAX_UNPACKED = 64 * 1024 ** 3,
  MAX_RATIO = 200,
  MAX_ENTRIES = 100_000,
  DEADLINE_MS = 30 * 60 * 1000
export const BUILD_BUDGETS = Object.freeze({
  maxArchive: MAX_ARCHIVE,
  maxSingleFile: MAX_SINGLE_FILE,
  maxUnpacked: MAX_UNPACKED,
  maxRatio: MAX_RATIO,
  maxEntries: MAX_ENTRIES,
  deadlineMs: DEADLINE_MS
})
const PLACEHOLDER = Buffer.alloc(64).toString('base64')
class BuildError extends Error {}
const fail = (message: string): never => {
  throw new BuildError(message)
}
interface CliOptions {
  descriptors: string[]
  output: string
  channel: UpdateChannel
  generatedAt: string
  sourceConfig: string
}
interface Descriptor {
  schema: 1
  releaseNotesUrl: string
  minimumLauncherVersion: string
  publishedAt: string
  app: { archive: string; url: string }
  runtime: { archive: string; url: string }
}
interface ArchiveResult<T> {
  manifest: T
  sha256: string
  size: number
  unpackedSize: number
}

function parseArgs(args: readonly string[]): CliOptions {
  const descriptors: string[] = [],
    values = new Map<string, string>(),
    single = new Set(['--output', '--channel', '--generated-at', '--release-source-config'])
  for (let index = 0; index < args.length; index++) {
    const option = args[index],
      value = args[++index]
    if (!value || value.startsWith('--')) fail('missing option value')
    if (option === '--descriptor') descriptors.push(value)
    else if (single.has(option)) {
      if (values.has(option)) fail('duplicate option')
      values.set(option, value)
    } else fail('unknown option')
  }
  if (!descriptors.length || [...single].some((key) => !values.has(key)))
    fail('missing required option')
  const channel = values.get('--channel') as UpdateChannel
  if (!['stable', 'beta', 'nightly'].includes(channel)) fail('invalid channel')
  const result = {
    descriptors,
    output: values.get('--output')!,
    channel,
    generatedAt: values.get('--generated-at')!,
    sourceConfig: values.get('--release-source-config')!
  }
  if (![...result.descriptors, result.output, result.sourceConfig].every(isAbsolute))
    fail('all file paths must be absolute')
  timestamp(result.generatedAt, 'generated-at')
  if (
    new Set([...result.descriptors, result.output, result.sourceConfig].map(normalizedPath))
      .size !==
    result.descriptors.length + 2
  )
    fail('all input and output paths must differ')
  return result
}
function strictJson(text: string, label: string): unknown {
  let i = 0
  const bad = (): never => fail(`${label} is not valid strict JSON`)
  const ws = (): void => {
    while (/[\t\n\r ]/.test(text[i] ?? 'x')) i++
  }
  const str = (): string => {
    if (text[i] !== '"') bad()
    const start = i++
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c === 34) {
        i++
        try {
          return JSON.parse(text.slice(start, i)) as string
        } catch {
          bad()
        }
      }
      if (c <= 31) bad()
      if (c === 92) {
        i++
        const e = text[i]
        if (e === 'u') {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(i + 1, i + 5))) bad()
          i += 5
        } else {
          if (!e || !'"\\/bfnrt'.includes(e)) bad()
          i++
        }
      } else i++
    }
    return bad()
  }
  const value = (depth: number): unknown => {
    if (depth > 128) fail(`${label} JSON nesting is too deep`)
    ws()
    const c = text[i]
    if (c === '"') return str()
    if (c === '{') {
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
        const key = str()
        if (keys.has(key)) fail(`${label} contains duplicate key`)
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
    if (c === '[') {
      i++
      ws()
      const out: unknown[] = []
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
    for (const [literal, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const)
      if (text.startsWith(literal, i)) {
        i += literal.length
        return parsed
      }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))?.[0]
    if (!number) return bad()
    i += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed)) bad()
    return parsed
  }
  const result = value(0)
  ws()
  if (i !== text.length) bad()
  return result
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail(`${label} has missing or unknown fields`)
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') return fail(`${label} must be a string`)
  return value
}
function timestamp(value: unknown, label: string): string {
  const text = string(value, label)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) ||
    Number.isNaN(Date.parse(text))
  )
    fail(`${label} must be a UTC timestamp`)
  return text
}
function parseDescriptor(value: unknown): Descriptor {
  const root = record(value, 'descriptor')
  exact(
    root,
    ['schema', 'releaseNotesUrl', 'minimumLauncherVersion', 'publishedAt', 'app', 'runtime'],
    'descriptor'
  )
  if (root.schema !== 1) fail('descriptor schema must be 1')
  const app = record(root.app, 'descriptor.app'),
    runtime = record(root.runtime, 'descriptor.runtime')
  exact(app, ['archive', 'url'], 'descriptor.app')
  exact(runtime, ['archive', 'url'], 'descriptor.runtime')
  const result: Descriptor = {
    schema: 1,
    releaseNotesUrl: string(root.releaseNotesUrl, 'releaseNotesUrl'),
    minimumLauncherVersion: string(root.minimumLauncherVersion, 'minimumLauncherVersion'),
    publishedAt: timestamp(root.publishedAt, 'publishedAt'),
    app: { archive: string(app.archive, 'app.archive'), url: string(app.url, 'app.url') },
    runtime: {
      archive: string(runtime.archive, 'runtime.archive'),
      url: string(runtime.url, 'runtime.url')
    }
  }
  if (!isAbsolute(result.app.archive) || !isAbsolute(result.runtime.archive))
    fail('archive paths must be absolute')
  if (!parseSemanticVersionV1(result.minimumLauncherVersion))
    fail('minimumLauncherVersion must be SemVer')
  return result
}
function readStable(path: string, maximum: number, label: string, deadline: Deadline): Buffer {
  checkDeadline(deadline)
  assertNoSymlinkChain(path, true, `${label} failed safety checks`)
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
    fail(`${label} failed safety checks`)
  const real = realpathSync(path),
    fd = openSync(path, constants.O_RDONLY)
  try {
    const opened = fstatSync(fd)
    if (
      !sameIdentity(before, opened) ||
      opened.nlink !== 1 ||
      opened.size > maximum ||
      normalizedPath(realpathSync(path)) !== normalizedPath(real)
    )
      fail(`${label} failed safety checks`)
    const bytes = Buffer.alloc(opened.size)
    let total = 0
    while (total < bytes.length) {
      checkDeadline(deadline)
      const count = readSync(fd, bytes, total, bytes.length - total, total)
      if (!count) break
      total += count
    }
    checkDeadline(deadline)
    const after = fstatSync(fd),
      final = lstatSync(path)
    if (
      total !== opened.size ||
      !sameIdentity(opened, after) ||
      !sameIdentity(after, final) ||
      after.size !== opened.size ||
      after.nlink !== 1
    )
      fail(`${label} changed while reading`)
    return bytes
  } finally {
    closeSync(fd)
  }
}
function unixType(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xf000
}
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const hasInvalidWindowsFilenameChar = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || ':<>"|?*'.includes(character))
function pathKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}
function unsafeName(name: string, directory: boolean): boolean {
  const value = directory ? name.slice(0, -1) : name
  if (
    !value ||
    value.length > 240 ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    hasInvalidWindowsFilenameChar(value)
  )
    return true
  return value
    .split('/')
    .some(
      (part) =>
        !part || part === '.' || part === '..' || /[ .]$/.test(part) || WINDOWS_DEVICE.test(part)
    )
}
interface Deadline {
  expiresAt: number
  now: () => number
}
function checkDeadline(deadline: Deadline, close?: () => void): void {
  if (deadline.now() < deadline.expiresAt) return
  try {
    close?.()
  } finally {
    fail('manifest build deadline exceeded')
  }
}
function hashFd(fd: number, size: number, deadline: Deadline): string {
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (position < size) {
    checkDeadline(deadline)
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
    if (!count) fail('archive changed while reading')
    hash.update(buffer.subarray(0, count))
    position += count
  }
  if (position !== size) fail('archive changed while reading')
  return hash.digest('hex')
}
interface TestLimits {
  maxEntries?: number
  deadlineMs?: number
  now?: () => number
  onEntryMetrics?: (label: string, metrics: EntryMetrics) => void
  beforePublishForTest?: () => void
  onPublishVerifyForTest?: () => void
}
let archiveSnapshotHook: ((path: string) => void) | undefined, testLimits: TestLimits | undefined
export function __setArchiveSnapshotHookForTest(hook?: (path: string) => void): void {
  archiveSnapshotHook = hook
}
export function __setArchiveLimitsForTest(options?: TestLimits): void {
  if (
    options?.maxEntries !== undefined &&
    (!Number.isInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      options.maxEntries > MAX_ENTRIES)
  )
    fail('test maxEntries may only tighten production limit')
  if (
    options?.deadlineMs !== undefined &&
    (!Number.isFinite(options.deadlineMs) ||
      options.deadlineMs <= 0 ||
      options.deadlineMs > DEADLINE_MS)
  )
    fail('test deadline may only tighten production limit')
  testLimits = options
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
function updateCrc(crc: number, bytes: Buffer): number {
  for (let index = 0; index < bytes.length; index++)
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 255]! ^ (crc >>> 8)
  return crc
}
interface EntryMetrics {
  actualSize: number
  sha256: string
  buffer?: Buffer
}
async function streamEntryMetrics(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  expectedMax: number,
  label: string,
  deadline: Deadline,
  keepBufferLimit?: number
): Promise<EntryMetrics> {
  checkDeadline(deadline, () => zip.close())
  const maximum = Math.min(expectedMax, entry.uncompressedSize, MAX_SINGLE_FILE),
    stream = await zip.openReadStreamPromise(entry),
    chunks: Buffer[] = [],
    hash = createHash('sha256')
  let actualSize = 0,
    crc = 0xffffffff
  try {
    for await (const chunk of stream) {
      checkDeadline(deadline, () => {
        stream.destroy()
        zip.close()
      })
      const bytes = Buffer.from(chunk)
      actualSize += bytes.length
      if (actualSize > maximum) {
        stream.destroy()
        fail(`${label} exceeds size limit`)
      }
      hash.update(bytes)
      crc = updateCrc(crc, bytes)
      if (keepBufferLimit !== undefined) chunks.push(bytes)
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  if (actualSize !== entry.uncompressedSize || actualSize !== expectedMax)
    fail(`${label} size mismatch`)
  if ((crc ^ 0xffffffff) >>> 0 !== entry.crc32) fail(`${label} CRC mismatch`)
  const metrics: EntryMetrics = { actualSize, sha256: hash.digest('hex') }
  if (keepBufferLimit !== undefined) {
    if (actualSize > keepBufferLimit) fail(`${label} exceeds size limit`)
    metrics.buffer = Buffer.concat(chunks, actualSize)
  }
  testLimits?.onEntryMetrics?.(label, metrics)
  return metrics
}
export async function inspectArchive<T extends InstalledAppManifestV1 | InstalledRuntimeManifestV1>(
  source: string | number,
  parser: (text: string) => T,
  label: string,
  deadline: Deadline
): Promise<ArchiveResult<T>> {
  checkDeadline(deadline)
  const path = typeof source === 'string' ? source : undefined
  let before: ReturnType<typeof lstatSync> | undefined, real: string | undefined
  if (path !== undefined) {
    assertNoSymlinkChain(path, true, `${label} failed safety checks`)
    before = lstatSync(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_ARCHIVE
    )
      fail(`${label} failed safety checks`)
    real = realpathSync(path)
  }
  const sourceFd = typeof source === 'number' ? source : openSync(source, constants.O_RDONLY),
    ownsSourceFd = typeof source !== 'number'
  let snapshotFd = -1,
    snapshotPath = '',
    snapshotRoot = ''
  try {
    const opened = fstatSync(sourceFd)
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > MAX_ARCHIVE ||
      (before &&
        (!sameIdentity(before, opened) ||
          opened.nlink !== 1 ||
          opened.size !== before.size ||
          normalizedPath(realpathSync(path!)) !== normalizedPath(real!)))
    )
      fail(`${label} failed safety checks`)
    assertNoSymlinkChain(tmpdir(), true, `${label} temporary root failed safety checks`)
    snapshotRoot = mkdtempSync(join(realpathSync(tmpdir()), 'magicpot-manifest-'))
    const rootIdentity = lstatSync(snapshotRoot)
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink())
      fail(`${label} temporary root failed safety checks`)
    snapshotPath = join(snapshotRoot, 'archive.snapshot')
    snapshotFd = openSync(
      snapshotPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600
    )
    const snapshotIdentity = fstatSync(snapshotFd),
      hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(1024 * 1024)
    let size = 0
    while (size < opened.size) {
      checkDeadline(deadline)
      const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, opened.size - size), size)
      if (!count) fail(`${label} changed while snapshotting`)
      let written = 0
      while (written < count) {
        checkDeadline(deadline)
        written += writeSync(snapshotFd, buffer, written, count - written, size + written)
      }
      hash.update(buffer.subarray(0, count))
      size += count
    }
    checkDeadline(deadline)
    fsyncSync(snapshotFd)
    const sha256 = hash.digest('hex')
    if (size !== opened.size || hashFd(sourceFd, opened.size, deadline) !== sha256)
      fail(`${label} changed while snapshotting`)
    const postCopy = fstatSync(sourceFd)
    if (
      !sameIdentity(opened, postCopy) ||
      postCopy.size !== opened.size ||
      (path !== undefined && postCopy.nlink !== 1)
    )
      fail(`${label} changed while snapshotting`)
    archiveSnapshotHook?.(path ?? `<fd:${sourceFd}>`)
    const zip = await yauzl.fromFdPromise(snapshotFd, {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true
      }),
      entries: yauzl.Entry[] = [],
      keys = new Map<string, { name: string; directory: boolean }>()
    let unpackedSize = 0,
      entryCount = 0
    for await (const entry of zip.eachEntry()) {
      checkDeadline(deadline, () => zip.close())
      if (++entryCount > (testLimits?.maxEntries ?? MAX_ENTRIES)) {
        zip.close()
        fail(`${label} contains too many entries`)
      }
      const directory = entry.fileName.endsWith('/'),
        type = unixType(entry),
        key = pathKey(directory ? entry.fileName.slice(0, -1) : entry.fileName)
      if (entry.isEncrypted() || !entry.canDecodeFileData())
        fail(`${label} contains unsupported encrypted or compressed data`)
      if (entry.extraFields.some((field) => field.id === 0x0001)) fail(`${label} uses ZIP64`)
      if (unsafeName(entry.fileName, directory)) fail(`${label} contains unsafe path`)
      if (keys.has(key)) fail(`${label} contains duplicate or Unicode-colliding path`)
      if (
        (entry.externalFileAttributes & 0x400) !== 0 ||
        (directory && type !== 0 && type !== 0x4000) ||
        (!directory && type !== 0 && type !== 0x8000)
      )
        fail(`${label} contains symlink or special file`)
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        !Number.isSafeInteger(entry.compressedSize) ||
        entry.uncompressedSize > MAX_SINGLE_FILE
      )
        fail(`${label} entry size exceeds limit`)
      if (entry.uncompressedSize / Math.max(entry.compressedSize, 1) > MAX_RATIO)
        fail(`${label} compression ratio exceeds limit`)
      if (
        !Number.isSafeInteger(unpackedSize + entry.uncompressedSize) ||
        unpackedSize + entry.uncompressedSize > MAX_UNPACKED
      )
        fail(`${label} unpacked size exceeds limit`)
      keys.set(key, { name: directory ? entry.fileName.slice(0, -1) : entry.fileName, directory })
      entries.push(entry)
      unpackedSize += entry.uncompressedSize
    }
    if (unpackedSize / Math.max(size, 1) > MAX_RATIO)
      fail(`${label} total compression ratio exceeds limit`)
    for (const [key, item] of keys)
      for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
        const parent = keys.get(key.slice(0, slash))
        if (parent && !parent.directory) fail(`${label} contains file-directory prefix conflict`)
      }
    const foundManifest = entries.find(
      (entry) => pathKey(entry.fileName) === 'manifest.json' && !entry.fileName.endsWith('/')
    )
    if (!foundManifest) fail(`${label} is missing root manifest.json`)
    const manifestEntry = foundManifest as yauzl.Entry
    if (manifestEntry.fileName !== 'manifest.json' || manifestEntry.uncompressedSize > MAX_JSON)
      fail(`${label} manifest path or size is invalid`)
    const manifestRead = await streamEntryMetrics(
        zip,
        manifestEntry,
        manifestEntry.uncompressedSize,
        `${label} manifest`,
        deadline,
        MAX_JSON
      ),
      parsedValue = record(
        strictJson(manifestRead.buffer!.toString('utf8'), `${label} manifest`),
        `${label} manifest`
      )
    if (parsedValue.unpackedSize !== unpackedSize) fail(`${label} manifest unpackedSize mismatch`)
    const rawFiles = Array.isArray(parsedValue.files) ? parsedValue.files : [],
      declaredPayloadSize = rawFiles.reduce(
        (total, item) => total + (record(item, `${label} manifest file`).size as number),
        0
      )
    const compatibility = { ...parsedValue, unpackedSize: declaredPayloadSize },
      manifest = parser(JSON.stringify(compatibility))
    ;(manifest as { unpackedSize: number }).unpackedSize = unpackedSize
    if (!manifest.files?.length) fail(`${label} manifest.files must be non-empty`)
    const manifestFiles = manifest.files as NonNullable<T['files']>
    if (manifestFiles.some((file) => unsafeName(file.path, false)))
      fail(`${label} manifest contains unsafe path`)
    const expected = new Map(manifestFiles.map((file) => [pathKey(file.path), file]))
    if (expected.size !== manifestFiles.length || expected.has('manifest.json'))
      fail(`${label} manifest files contain duplicate path`)
    const actualFiles = entries.filter(
      (entry) => !entry.fileName.endsWith('/') && entry !== manifestEntry
    )
    if (
      actualFiles.length !== expected.size ||
      actualFiles.some((entry) => !expected.has(pathKey(entry.fileName)))
    )
      fail(`${label} payload entries do not exactly match manifest.files`)
    const parentKeys = new Set<string>()
    for (const entry of actualFiles) {
      const key = pathKey(entry.fileName)
      for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1))
        parentKeys.add(key.slice(0, slash))
    }
    for (const [key, item] of keys)
      if (item.directory && !parentKeys.has(key)) fail(`${label} contains extraneous directory`)
    let streamedBytes = manifestRead.actualSize
    for (const entry of actualFiles) {
      checkDeadline(deadline, () => zip.close())
      const expectedFile = expected.get(pathKey(entry.fileName))!
      if (
        entry.uncompressedSize !== expectedFile.size ||
        expectedFile.size > MAX_SINGLE_FILE ||
        streamedBytes + expectedFile.size > MAX_UNPACKED
      )
        fail(`${label} payload hash or size mismatch`)
      const metrics = await streamEntryMetrics(
        zip,
        entry,
        expectedFile.size,
        `${label} payload ${entry.fileName}`,
        deadline
      )
      streamedBytes += metrics.actualSize
      if (metrics.sha256 !== expectedFile.sha256) fail(`${label} payload hash or size mismatch`)
    }
    checkDeadline(deadline, () => zip.close())
    const after = fstatSync(sourceFd)
    if (
      !sameIdentity(opened, after) ||
      after.size !== opened.size ||
      hashFd(sourceFd, opened.size, deadline) !== sha256
    )
      fail(`${label} changed while reading`)
    if (path !== undefined) {
      const final = lstatSync(path)
      if (!sameIdentity(after, final) || after.nlink !== 1) fail(`${label} changed while reading`)
    }
    return { manifest, sha256, size, unpackedSize }
  } catch (error) {
    if (error instanceof BuildError) throw error
    return fail(`${label} is not a safe ZIP archive`)
  } finally {
    if (snapshotFd >= 0) {
      try {
        const identity = fstatSync(snapshotFd)
        closeSync(snapshotFd)
        const current = lstatSync(snapshotPath)
        if (sameIdentity(identity, current) && current.isFile() && !current.isSymbolicLink())
          unlinkSync(snapshotPath)
      } catch {
        try {
          const current = lstatSync(snapshotPath)
          if (current.isFile() && !current.isSymbolicLink()) unlinkSync(snapshotPath)
        } catch {
          // Best-effort cleanup after a failed transactional write.
        }
      }
    }
    if (snapshotRoot)
      try {
        rmdirSync(snapshotRoot)
      } catch {
        // Best-effort cleanup after a failed transactional write.
      }
    if (ownsSourceFd) closeSync(sourceFd)
  }
}
function parseSources(value: unknown): TrustedReleaseSource[] {
  const root = record(value, 'release source config')
  exact(root, ['schema', 'trustedSources'], 'release source config')
  if (root.schema !== 1 || !Array.isArray(root.trustedSources) || !root.trustedSources.length)
    return fail('invalid release source config')
  return root.trustedSources.map((item: unknown, index: number) => {
    const source = record(item, `trustedSources[${index}]`)
    exact(source, ['origin', 'repoPathPrefix'], `trustedSources[${index}]`)
    return {
      origin: string(source.origin, 'origin'),
      repoPathPrefix: string(source.repoPathPrefix, 'repoPathPrefix')
    }
  })
}
function precedence(version: string): string {
  const parsed = parseSemanticVersionV1(version)
  if (!parsed) return fail('app version must be SemVer')
  return `${parsed.core.join('.')}-${parsed.prerelease.join('.')}`
}
function runtimeIdentity(release: ChannelReleaseV1): string {
  const r = release.artifacts.runtime!
  return `${r.url}\0${r.sha256}\0${r.size}\0${r.unpackedSize}\0${r.createdAt}\0${r.entrypoint}`
}
export async function run(args: readonly string[]): Promise<void> {
  const now = testLimits?.now ?? performance.now.bind(performance),
    startedAt = now(),
    deadline = { now, expiresAt: startedAt + (testLimits?.deadlineMs ?? DEADLINE_MS) }
  const options = parseArgs(args)
  checkDeadline(deadline)
  const sources = parseSources(
      strictJson(
        readStable(options.sourceConfig, MAX_JSON, 'release source config', deadline).toString(
          'utf8'
        ),
        'release source config'
      )
    ),
    releases: ChannelReleaseV1[] = []
  for (const descriptorPath of options.descriptors) {
    checkDeadline(deadline)
    const descriptor = parseDescriptor(
      strictJson(
        readStable(descriptorPath, MAX_JSON, 'descriptor', deadline).toString('utf8'),
        'descriptor'
      )
    )
    const [app, runtime] = await Promise.all([
      inspectArchive<InstalledAppManifestV1>(
        descriptor.app.archive,
        parseInstalledAppManifest,
        'app archive',
        deadline
      ),
      inspectArchive<InstalledRuntimeManifestV1>(
        descriptor.runtime.archive,
        parseInstalledRuntimeManifest,
        'runtime archive',
        deadline
      )
    ])
    checkDeadline(deadline)
    if (app.manifest.runtimeId !== runtime.manifest.runtimeId)
      fail('app and runtime identities do not match')
    if (
      Date.parse(descriptor.publishedAt) <
      Math.max(Date.parse(app.manifest.createdAt), Date.parse(runtime.manifest.createdAt))
    )
      fail('publishedAt predates an artifact')
    releases.push({
      version: app.manifest.version,
      buildId: app.manifest.buildId,
      commitSha: app.manifest.commitSha,
      publishedAt: descriptor.publishedAt,
      releaseNotesUrl: descriptor.releaseNotesUrl,
      minimumLauncherVersion: descriptor.minimumLauncherVersion,
      artifacts: {
        app: {
          kind: 'app',
          version: app.manifest.version,
          buildId: app.manifest.buildId,
          commitSha: app.manifest.commitSha,
          runtimeId: app.manifest.runtimeId,
          platform: 'win32',
          arch: 'x64',
          url: descriptor.app.url,
          sha256: app.sha256,
          size: app.size,
          unpackedSize: app.unpackedSize,
          entrypoint: app.manifest.entrypoint,
          createdAt: app.manifest.createdAt
        },
        runtime: {
          kind: 'runtime',
          runtimeId: runtime.manifest.runtimeId,
          platform: 'win32',
          arch: 'x64',
          url: descriptor.runtime.url,
          sha256: runtime.sha256,
          size: runtime.size,
          unpackedSize: runtime.unpackedSize,
          entrypoint: runtime.manifest.entrypoints.python,
          createdAt: runtime.manifest.createdAt
        }
      }
    })
  }
  checkDeadline(deadline)
  releases.sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.buildId.localeCompare(a.buildId)
  )
  const builds = new Set<string>(),
    versions = new Map<string, string>(),
    runtimes = new Map<string, string>()
  for (const release of releases) {
    if (builds.has(release.buildId)) fail(`duplicate buildId ${release.buildId}`)
    builds.add(release.buildId)
    const p = precedence(release.version),
      identity = `${release.version}\0${release.buildId}\0${release.commitSha}`,
      old = versions.get(p)
    if (old && old !== identity) fail(`semantic version precedence ${p} has conflicting identity`)
    versions.set(p, identity)
    const ri = runtimeIdentity(release),
      ro = runtimes.get(release.artifacts.runtime!.runtimeId)
    if (ro && ro !== ri)
      fail(`runtimeId ${release.artifacts.runtime!.runtimeId} has conflicting artifacts`)
    runtimes.set(release.artifacts.runtime!.runtimeId, ri)
  }
  checkDeadline(deadline)
  const candidate = {
    schema: 1 as const,
    channel: options.channel,
    generatedAt: options.generatedAt,
    releases,
    signature: {
      algorithm: 'ed25519' as const,
      keyId: 'unsigned-builder-placeholder',
      value: PLACEHOLDER
    }
  }
  parseChannelManifestV1(candidate, { expectedChannel: options.channel, trustedSources: sources })
  const unsigned = {
      schema: candidate.schema,
      channel: candidate.channel,
      generatedAt: candidate.generatedAt,
      releases: candidate.releases
    },
    contents = `${JSON.stringify(unsigned, null, 2)}\n`
  testLimits?.beforePublishForTest?.() // Test-only hook intentionally runs before the final deadline gate.
  checkDeadline(deadline)
  publishExactNoReplace(options.output, contents, (bytes) => {
    testLimits?.onPublishVerifyForTest?.()
    const parsed = strictJson(bytes.toString('utf8'), 'published manifest'),
      root = record(parsed, 'published manifest')
    exact(root, ['schema', 'channel', 'generatedAt', 'releases'], 'published manifest')
    parseChannelManifestV1(
      { ...root, signature: candidate.signature },
      { expectedChannel: options.channel, trustedSources: sources }
    )
  })
  process.stdout.write(`built unsigned channel manifest releases=${releases.length}\n`)
}
if (normalizedPath(process.argv[1] ?? '') === normalizedPath(fileURLToPath(import.meta.url))) {
  const values = process.argv.slice(2),
    outputIndex = values.indexOf('--output'),
    output = outputIndex >= 0 ? values[outputIndex + 1] : undefined
  run(values).catch((error) => {
    process.stderr.write(
      `manifest build failed${output ? ` output=${basename(output)}` : ''}: ${error instanceof Error ? error.message : 'unexpected error'}\n`
    )
    process.exitCode = 1
  })
}
