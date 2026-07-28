import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const MAX_EOCD_SIZE = 65_557
const UTF8_FLAG = 1 << 11
const DATA_DESCRIPTOR_FLAG = 1 << 3
const ENCRYPTED_FLAGS = (1 << 0) | (1 << 6) | (1 << 13)
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i
const DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024

export interface SafeZipExtractionOptions {
  archivePath: string
  stagingParent: string
  maxEntries?: number
  maxCompressedBytes?: number
  maxUncompressedBytes?: number
  maxEntryBytes?: number
  maxCentralDirectoryBytes?: number
  expectedUncompressedBytes?: number
}

export class SafeZipError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SafeZipError'
  }
}

interface ZipEntry {
  name: string
  nameBytes: Buffer
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  dataOffset: number
  directory: boolean
}

interface ExtractionBudget {
  maxEntries: number
  maxCompressedBytes: number
  maxUncompressedBytes: number
  maxEntryBytes: number
  maxCentralDirectoryBytes: number
  expectedUncompressedBytes?: number
}

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  CRC_TABLE[index] = value >>> 0
}

function fail(code: string, message: string): never {
  throw new SafeZipError(code, message)
}

function checkedRange(offset: number, length: number, limit: number, description: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0)
    fail('MALFORMED', `Invalid ${description} range`)
  if (offset > limit || length > limit - offset) fail('TRUNCATED', `Truncated ${description}`)
}

function decodeName(bytes: Buffer, flags: number): string {
  if (bytes.length === 0 || bytes.includes(0))
    fail('INVALID_PATH', 'ZIP entry has an empty or NUL-containing name')
  if ((flags & UTF8_FLAG) === 0 && bytes.some((value) => value > 0x7f))
    fail('AMBIGUOUS_ENCODING', 'Non-ASCII ZIP names must be explicitly UTF-8')
  const name = bytes.toString('utf8')
  if (Buffer.from(name, 'utf8').compare(bytes) !== 0)
    fail('AMBIGUOUS_ENCODING', 'ZIP entry name is not valid UTF-8')
  return name
}

function validatePath(name: string): { normalized: string; directory: boolean } {
  if (name.includes('\\')) fail('INVALID_PATH', `Backslashes are forbidden in ZIP path: ${name}`)
  if (name.startsWith('/') || /^\/?[a-zA-Z]:/.test(name) || name.startsWith('//'))
    fail('INVALID_PATH', `Absolute or drive-qualified ZIP path is forbidden: ${name}`)
  const directory = name.endsWith('/')
  const normalized = directory ? name.slice(0, -1) : name
  const parts = normalized.split('/')
  if (normalized.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..'))
    fail('INVALID_PATH', `Unsafe ZIP path: ${name}`)
  for (const part of parts) {
    const hasForbiddenCharacter = [...part].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f || '<>:"|?*'.includes(character)
    })
    if (hasForbiddenCharacter || /[. ]$/.test(part) || RESERVED_NAMES.test(part))
      fail('INVALID_PATH', `Windows-unsafe ZIP path component: ${part}`)
  }
  return { normalized, directory }
}

function validateExtra(extra: Buffer): void {
  let offset = 0
  while (offset < extra.length) {
    if (extra.length - offset < 4) fail('MALFORMED', 'Truncated ZIP extra field')
    const id = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    offset += 4
    if (size > extra.length - offset) fail('MALFORMED', 'Truncated ZIP extra field payload')
    if (id === 0x0001) fail('UNSUPPORTED_ZIP64', 'ZIP64 archives are not supported')
    offset += size
  }
}

function validateFileType(
  versionMadeBy: number,
  externalAttributes: number,
  directory: boolean
): void {
  const host = versionMadeBy >>> 8
  if (host === 3) {
    const mode = externalAttributes >>> 16
    const type = mode & 0xf000
    if (type !== 0 && type !== 0x8000 && type !== 0x4000)
      fail('UNSUPPORTED_FILE_TYPE', 'ZIP contains a symbolic link or special file')
    if ((type === 0x4000) !== directory && type !== 0)
      fail('MALFORMED', 'ZIP directory metadata disagrees with its path')
  }
  const dosDirectory = (externalAttributes & 0x10) !== 0
  if (dosDirectory !== directory && (host === 0 || dosDirectory))
    fail('MALFORMED', 'ZIP directory metadata disagrees with its path')
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
  description: string
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let totalRead = 0
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      position + totalRead
    )
    if (bytesRead === 0) fail('TRUNCATED', `Truncated ${description}`)
    totalRead += bytesRead
  }
  return buffer
}

async function parseArchive(
  handle: Awaited<ReturnType<typeof open>>,
  budget: ExtractionBudget
): Promise<ZipEntry[]> {
  const stat = await handle.stat()
  const archiveSize = stat.size
  if (!stat.isFile()) fail('MALFORMED', 'ZIP archive is not a regular file')
  if (archiveSize > budget.maxCompressedBytes)
    fail('BUDGET_EXCEEDED', 'ZIP archive exceeds compressed-size budget')
  if (archiveSize < 22) fail('TRUNCATED', 'ZIP archive is too short')
  const tailSize = Math.min(archiveSize, MAX_EOCD_SIZE)
  const tailOffset = archiveSize - tailSize
  const tail = await readExactly(handle, tailSize, tailOffset, 'ZIP end record')
  let eocd = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    if (offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) fail('MALFORMED', 'ZIP end-of-central-directory record was not found')
  if (
    (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) ||
    (eocd >= 56 && tail.readUInt32LE(eocd - 56) === ZIP64_EOCD_SIGNATURE)
  )
    fail('UNSUPPORTED_ZIP64', 'ZIP64 archives are not supported')
  const disk = tail.readUInt16LE(eocd + 4)
  const centralDisk = tail.readUInt16LE(eocd + 6)
  const entriesOnDisk = tail.readUInt16LE(eocd + 8)
  const entryCount = tail.readUInt16LE(eocd + 10)
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount)
    fail('UNSUPPORTED_MULTIDISK', 'Multi-disk ZIP archives are not supported')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    fail('UNSUPPORTED_ZIP64', 'ZIP64 archives are not supported')
  if (entryCount > budget.maxEntries) fail('BUDGET_EXCEEDED', 'ZIP entry count exceeds budget')
  if (centralSize > budget.maxCentralDirectoryBytes)
    fail('BUDGET_EXCEEDED', 'ZIP central directory exceeds memory budget')
  const absoluteEocd = tailOffset + eocd
  checkedRange(centralOffset, centralSize, absoluteEocd, 'central directory')
  if (centralOffset + centralSize !== absoluteEocd)
    fail('MALFORMED', 'Central directory is not contiguous with the ZIP end record')
  const central = await readExactly(handle, centralSize, centralOffset, 'central directory')
  const entries: ZipEntry[] = []
  const occupied = new Map<string, 'file' | 'directory'>()
  let totalUncompressed = 0
  let cursor = 0
  for (let index = 0; index < entryCount; index += 1) {
    checkedRange(cursor, 46, central.length, 'central directory entry')
    if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
      fail('MALFORMED', 'Invalid central directory entry signature')
    const versionMadeBy = central.readUInt16LE(cursor + 4)
    const flags = central.readUInt16LE(cursor + 8)
    const method = central.readUInt16LE(cursor + 10)
    const crc32 = central.readUInt32LE(cursor + 16)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const diskStart = central.readUInt16LE(cursor + 34)
    const externalAttributes = central.readUInt32LE(cursor + 38)
    const localOffset = central.readUInt32LE(cursor + 42)
    const recordLength = 46 + nameLength + extraLength + commentLength
    checkedRange(cursor, recordLength, central.length, 'central directory entry')
    if ((flags & ENCRYPTED_FLAGS) !== 0) fail('ENCRYPTED', 'Encrypted ZIP entries are forbidden')
    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0)
      fail('UNSUPPORTED_FLAGS', 'ZIP data descriptors are not supported')
    if ((flags & ~UTF8_FLAG) !== 0)
      fail('UNSUPPORTED_FLAGS', 'ZIP entry uses unsupported general-purpose flags')
    if (method !== 0 && method !== 8)
      fail('UNSUPPORTED_COMPRESSION', `Unsupported ZIP compression method: ${method}`)
    if (diskStart !== 0) fail('UNSUPPORTED_MULTIDISK', 'Multi-disk ZIP entries are not supported')
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      fail('UNSUPPORTED_ZIP64', 'ZIP64 entries are not supported')
    if (uncompressedSize > budget.maxEntryBytes)
      fail('BUDGET_EXCEEDED', 'ZIP entry exceeds per-entry size budget')
    totalUncompressed += uncompressedSize
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > budget.maxUncompressedBytes)
      fail('BUDGET_EXCEEDED', 'ZIP archive exceeds uncompressed-size budget')
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength)
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
    validateExtra(extra)
    const rawName = decodeName(nameBytes, flags)
    const safePath = validatePath(rawName)
    validateFileType(versionMadeBy, externalAttributes, safePath.directory)
    if (safePath.directory && (compressedSize !== 0 || uncompressedSize !== 0))
      fail('MALFORMED', 'ZIP directory has file data')
    const parts = safePath.normalized.split('/')
    for (let partIndex = 1; partIndex < parts.length; partIndex += 1) {
      const parentKey = parts.slice(0, partIndex).join('/').toLocaleLowerCase('en-US')
      if (occupied.get(parentKey) === 'file')
        fail('PATH_CONFLICT', 'ZIP file conflicts with a descendant path')
      if (!occupied.has(parentKey)) occupied.set(parentKey, 'directory')
    }
    const key = safePath.normalized.toLocaleLowerCase('en-US')
    if (occupied.has(key))
      fail('PATH_CONFLICT', `Duplicate or case-conflicting ZIP path: ${rawName}`)
    occupied.set(key, safePath.directory ? 'directory' : 'file')
    entries.push({
      name: safePath.normalized,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset: 0,
      directory: safePath.directory
    })
    cursor += recordLength
  }
  if (cursor !== central.length)
    fail('MALFORMED', 'Central directory size does not match its entries')
  if (
    budget.expectedUncompressedBytes !== undefined &&
    totalUncompressed !== budget.expectedUncompressedBytes
  )
    fail('SIZE_MISMATCH', 'ZIP declared unpacked size does not match artifact manifest')
  const ranges: Array<[number, number]> = []
  for (const entry of entries) {
    checkedRange(entry.localOffset, 30, centralOffset, 'local file header')
    const local = await readExactly(handle, 30, entry.localOffset, 'local file header')
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE)
      fail('MALFORMED', 'Invalid local file header signature')
    const localFlags = local.readUInt16LE(6)
    const localMethod = local.readUInt16LE(8)
    const localCrc = local.readUInt32LE(14)
    const localCompressed = local.readUInt32LE(18)
    const localUncompressed = local.readUInt32LE(22)
    const localNameLength = local.readUInt16LE(26)
    const localExtraLength = local.readUInt16LE(28)
    const headerLength = 30 + localNameLength + localExtraLength
    checkedRange(entry.localOffset, headerLength, centralOffset, 'local file header')
    const variable = await readExactly(
      handle,
      localNameLength + localExtraLength,
      entry.localOffset + 30,
      'local file header'
    )
    if (variable.subarray(0, localNameLength).compare(entry.nameBytes) !== 0)
      fail('MALFORMED', 'Local and central ZIP entry names differ')
    validateExtra(variable.subarray(localNameLength))
    if (localFlags !== entry.flags || localMethod !== entry.method)
      fail('MALFORMED', 'Local and central ZIP entry metadata differ')
    if (
      (entry.flags & DATA_DESCRIPTOR_FLAG) === 0 &&
      (localCrc !== entry.crc32 ||
        localCompressed !== entry.compressedSize ||
        localUncompressed !== entry.uncompressedSize)
    )
      fail('MALFORMED', 'Local and central ZIP entry sizes or CRC differ')
    const dataOffset = entry.localOffset + headerLength
    checkedRange(dataOffset, entry.compressedSize, centralOffset, 'ZIP entry data')
    entry.dataOffset = dataOffset
    ranges.push([entry.localOffset, dataOffset + entry.compressedSize])
  }
  ranges.sort((left, right) => left[0] - right[0])
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) fail('MALFORMED', 'ZIP entries overlap')
  }
  return entries
}

class VerifyEntryTransform extends Transform {
  private size = 0
  private crc = 0xffffffff

  constructor(private readonly entry: ZipEntry) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.size += chunk.length
    if (this.size > this.entry.uncompressedSize)
      return callback(
        new SafeZipError(
          'SIZE_MISMATCH',
          `ZIP entry expanded beyond declared size: ${this.entry.name}`
        )
      )
    for (const byte of chunk) this.crc = CRC_TABLE[(this.crc ^ byte) & 0xff] ^ (this.crc >>> 8)
    callback(null, chunk)
  }

  override _flush(callback: (error?: Error | null) => void): void {
    const crc = (this.crc ^ 0xffffffff) >>> 0
    if (this.size !== this.entry.uncompressedSize)
      return callback(
        new SafeZipError('SIZE_MISMATCH', `ZIP entry size mismatch: ${this.entry.name}`)
      )
    if (crc !== this.entry.crc32)
      return callback(
        new SafeZipError('CRC_MISMATCH', `ZIP entry CRC mismatch: ${this.entry.name}`)
      )
    callback()
  }
}

export async function extractZipSafely(options: SafeZipExtractionOptions): Promise<string> {
  const budget: ExtractionBudget = {
    maxEntries: options.maxEntries ?? 20_000,
    maxCompressedBytes: options.maxCompressedBytes ?? 2 * 1024 * 1024 * 1024,
    maxUncompressedBytes: options.maxUncompressedBytes ?? 4 * 1024 * 1024 * 1024,
    maxEntryBytes: options.maxEntryBytes ?? 1024 * 1024 * 1024,
    maxCentralDirectoryBytes:
      options.maxCentralDirectoryBytes ?? DEFAULT_MAX_CENTRAL_DIRECTORY_BYTES,
    expectedUncompressedBytes: options.expectedUncompressedBytes
  }
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      fail('INVALID_BUDGET', `Invalid ZIP extraction budget: ${name}`)
  }
  const handle = await open(options.archivePath, 'r')
  let staging: string | undefined
  try {
    const entries = await parseArchive(handle, budget)
    await mkdir(options.stagingParent, { recursive: true })
    staging = await mkdtemp(path.join(options.stagingParent, 'zip-'))
    for (const entry of entries) {
      const destination = path.join(staging, ...entry.name.split('/'))
      if (entry.directory) {
        await mkdir(destination, { recursive: true })
        continue
      }
      await mkdir(path.dirname(destination), { recursive: true })
      const source =
        entry.compressedSize === 0
          ? Readable.from(Buffer.alloc(0))
          : handle.createReadStream({
              start: entry.dataOffset,
              end: entry.dataOffset + entry.compressedSize - 1,
              autoClose: false
            })
      const verifier = new VerifyEntryTransform(entry)
      const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
      if (entry.method === 8) await pipeline(source, createInflateRaw(), verifier, output)
      else await pipeline(source, verifier, output)
    }
    return staging
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}
