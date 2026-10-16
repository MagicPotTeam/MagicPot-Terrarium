import { crc32, createInflateRaw } from 'node:zlib'
import { TextDecoder, types } from 'node:util'
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS, type XMLDecl } from 'saxes'

const MAX_INPUT_BYTES = 1024 * 1024
const MAX_ENTRIES = 256
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024
const MAX_XML_DEPTH = 64
const MAX_XML_ELEMENTS = 100000
const MAX_XML_CHUNK = 64 * 1024
const MAX_OPERATION_MS = 5000
const UTF8_FLAG = 0x800
const DATA_DESCRIPTOR_FLAG = 0x8
const ALLOWED_FLAGS = UTF8_FLAG | DATA_DESCRIPTOR_FLAG
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP64_EXTRA = 0x0001
const UNICODE_PATH_EXTRA = 0x7075
const XINCLUDE_NAMESPACE = 'http://www.w3.org/2001/XInclude'

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const arrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const Uint8ArrayIntrinsic = Uint8Array
const TextDecoderIntrinsic = TextDecoder

type ByteInput = Uint8Array | Buffer
type Format = 'docx' | 'xlsx' | 'pptx' | 'auto'
type OperationContext = { readonly signal?: AbortSignal; readonly deadlineAt: number }

export type DocumentParserErrorCode = 'INVALID' | 'LIMIT' | 'UNSUPPORTED' | 'CANCELLED'

export class DocumentParserError extends Error {
  readonly code: DocumentParserErrorCode

  constructor(code: DocumentParserErrorCode) {
    super('Document parser failed')
    this.name = 'DocumentParserError'
    this.code = code
  }
}

function parserFailure(code: DocumentParserErrorCode): DocumentParserError {
  return new DocumentParserError(code)
}

function fixedError(
  error: unknown,
  fallback: DocumentParserErrorCode = 'INVALID'
): DocumentParserError {
  return error instanceof DocumentParserError ? error : parserFailure(fallback)
}

function checkOperation(context: OperationContext): void {
  if (context.signal?.aborted || Date.now() > context.deadlineAt) throw parserFailure('CANCELLED')
}

function snapshotBytes(value: unknown): Uint8Array {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      !types.isUint8Array(value)
    )
      throw parserFailure('INVALID')
    const buffer = Reflect.apply(arrayBufferGetter, value, [])
    if (
      !types.isArrayBuffer(buffer) ||
      types.isSharedArrayBuffer(buffer) ||
      (resizableGetter && Reflect.apply(resizableGetter, buffer, []))
    )
      throw parserFailure('INVALID')
    const offset = Reflect.apply(byteOffsetGetter, value, [])
    const length = Reflect.apply(byteLengthGetter, value, [])
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0)
      throw parserFailure('INVALID')
    if (length > MAX_INPUT_BYTES) throw parserFailure('LIMIT')
    const copy = new Uint8ArrayIntrinsic(length)
    copy.set(new Uint8ArrayIntrinsic(buffer, offset, length))
    return copy
  } catch (error) {
    throw fixedError(error)
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw parserFailure('INVALID')
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw parserFailure('INVALID')
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false
  return true
}

function parseExtraFieldIds(extra: Uint8Array): void {
  let offset = 0
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw parserFailure('INVALID')
    const id = readU16(extra, offset)
    const size = readU16(extra, offset + 2)
    offset += 4
    if (offset + size > extra.length) throw parserFailure('INVALID')
    if (id === ZIP64_EXTRA || id === UNICODE_PATH_EXTRA) throw parserFailure('UNSUPPORTED')
    offset += size
  }
}

function decodeFileName(raw: Uint8Array, flags: number): string {
  try {
    let name: string
    if ((flags & UTF8_FLAG) !== 0)
      name = new TextDecoderIntrinsic('utf-8', { fatal: true }).decode(raw)
    else {
      for (const byte of raw) if (byte > 0x7f) throw parserFailure('UNSUPPORTED')
      name = String.fromCharCode(...raw)
    }
    if (!name || name.normalize('NFC') !== name || name.includes('%'))
      throw parserFailure('UNSUPPORTED')
    if (name.includes('\\') || name.includes(':') || name.startsWith('/'))
      throw parserFailure('UNSUPPORTED')
    for (const character of name) {
      const code = character.codePointAt(0)!
      if (code < 0x20 || code === 0x7f) throw parserFailure('UNSUPPORTED')
    }
    const segments = name.split('/')
    if (
      segments.some(
        (segment, index) =>
          segment === '.' || segment === '..' || (!segment && index < segments.length - 1)
      )
    )
      throw parserFailure('UNSUPPORTED')
    if (/^[A-Za-z]:/.test(name)) throw parserFailure('UNSUPPORTED')
    return name
  } catch (error) {
    throw fixedError(error, 'UNSUPPORTED')
  }
}

function forbiddenPayloadName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.includes('vbaproject') ||
    lower.includes('/vba') ||
    lower.includes('activex') ||
    lower.includes('oleobject') ||
    lower.includes('embedding') ||
    lower.includes('customui') ||
    lower.endsWith('.bin')
  )
}

function validateEntryType(
  versionMadeBy: number,
  externalAttributes: number,
  directory: boolean
): void {
  const host = versionMadeBy >>> 8
  if (host !== 3) return
  const mode = externalAttributes >>> 16
  const fileType = mode & 0xf000
  if (fileType === 0xa000) throw parserFailure('UNSUPPORTED')
  if (!directory && fileType !== 0 && fileType !== 0x8000) throw parserFailure('UNSUPPORTED')
}

interface ZipEntryRecord {
  readonly name: string
  readonly nameBytes: Uint8Array
  readonly flags: number
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
  readonly versionNeeded: number
  readonly versionMadeBy: number
  readonly externalAttributes: number
  readonly directory: boolean
  dataStart: number
  dataEnd: number
  regionEnd: number
}

export interface ZipEntryInfo {
  readonly name: string
  readonly compressionMethod: 0 | 8
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly encrypted: false
  readonly directory: boolean
  readonly media: boolean
}

function isMediaName(name: string): boolean {
  return /^(?:word|xl|ppt)\/media\//i.test(name)
}

function parseZip(bytes: Uint8Array, context: OperationContext): ZipEntryRecord[] {
  checkOperation(context)
  const searchStart = Math.max(0, bytes.length - 0xffff - 22)
  const candidates: number[] = []
  for (let offset = searchStart; offset <= bytes.length - 22; offset += 1) {
    if (readU32(bytes, offset) !== EOCD_SIGNATURE) continue
    const commentLength = readU16(bytes, offset + 20)
    if (offset + 22 + commentLength === bytes.length) candidates.push(offset)
  }
  if (candidates.length !== 1) throw parserFailure('INVALID')
  const eocd = candidates[0]
  const disk = readU16(bytes, eocd + 4)
  const centralDisk = readU16(bytes, eocd + 6)
  const entriesOnDisk = readU16(bytes, eocd + 8)
  const entryCount = readU16(bytes, eocd + 10)
  const centralSize = readU32(bytes, eocd + 12)
  const centralOffset = readU32(bytes, eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount)
    throw parserFailure('UNSUPPORTED')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw parserFailure('UNSUPPORTED')
  if (entryCount > MAX_ENTRIES) throw parserFailure('LIMIT')
  if (centralOffset + centralSize !== eocd || centralOffset > bytes.length)
    throw parserFailure('INVALID')
  if (eocd >= 20 && readU32(bytes, eocd - 20) === 0x07064b50) throw parserFailure('UNSUPPORTED')
  if (eocd >= 56 && readU32(bytes, eocd - 56) === 0x06064b50) throw parserFailure('UNSUPPORTED')

  const records: ZipEntryRecord[] = []
  const caseNames = new Set<string>()
  let cursor = centralOffset
  let declaredTotal = 0
  for (let index = 0; index < entryCount; index += 1) {
    checkOperation(context)
    if (cursor + 46 > eocd || readU32(bytes, cursor) !== CENTRAL_SIGNATURE)
      throw parserFailure('INVALID')
    const versionMadeBy = readU16(bytes, cursor + 4)
    const versionNeeded = readU16(bytes, cursor + 6)
    const flags = readU16(bytes, cursor + 8)
    const method = readU16(bytes, cursor + 10)
    const crc = readU32(bytes, cursor + 16)
    const compressedSize = readU32(bytes, cursor + 20)
    const uncompressedSize = readU32(bytes, cursor + 24)
    const nameLength = readU16(bytes, cursor + 28)
    const extraLength = readU16(bytes, cursor + 30)
    const commentLength = readU16(bytes, cursor + 32)
    const diskStart = readU16(bytes, cursor + 34)
    const externalAttributes = readU32(bytes, cursor + 38)
    const localOffset = readU32(bytes, cursor + 42)
    const payloadStart = cursor + 46
    const payloadEnd = payloadStart + nameLength + extraLength + commentLength
    if (payloadEnd > eocd) throw parserFailure('INVALID')
    if (diskStart !== 0) throw parserFailure('UNSUPPORTED')
    if ((flags & ~ALLOWED_FLAGS) !== 0 || (flags & 1) !== 0) throw parserFailure('UNSUPPORTED')
    if (method !== 0 && method !== 8) throw parserFailure('UNSUPPORTED')
    if (versionNeeded < 10 || versionNeeded > 20) throw parserFailure('UNSUPPORTED')
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw parserFailure('UNSUPPORTED')
    if (uncompressedSize > MAX_ENTRY_BYTES) throw parserFailure('LIMIT')
    declaredTotal += uncompressedSize
    if (declaredTotal > MAX_EXPANDED_BYTES) throw parserFailure('LIMIT')

    const nameBytes = bytes.slice(payloadStart, payloadStart + nameLength)
    const extra = bytes.slice(payloadStart + nameLength, payloadStart + nameLength + extraLength)
    parseExtraFieldIds(extra)
    const name = decodeFileName(nameBytes, flags)
    const directory = name.endsWith('/')
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0))
      throw parserFailure('INVALID')
    validateEntryType(versionMadeBy, externalAttributes, directory)
    if (forbiddenPayloadName(name)) throw parserFailure('UNSUPPORTED')
    const caseName = name.toLocaleLowerCase('en-US')
    if (caseNames.has(caseName)) throw parserFailure('UNSUPPORTED')
    caseNames.add(caseName)
    if (method === 0 && compressedSize !== uncompressedSize) throw parserFailure('INVALID')
    records.push({
      name,
      nameBytes,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      versionNeeded,
      versionMadeBy,
      externalAttributes,
      directory,
      dataStart: 0,
      dataEnd: 0,
      regionEnd: 0
    })
    cursor = payloadEnd
  }
  if (cursor !== eocd) throw parserFailure('INVALID')

  const ranges: Array<{ start: number; end: number }> = []
  for (const record of records) {
    checkOperation(context)
    const offset = record.localOffset
    if (offset < 0 || offset + 30 > centralOffset) throw parserFailure('INVALID')
    if (readU32(bytes, offset) !== LOCAL_SIGNATURE) throw parserFailure('INVALID')
    const localVersion = readU16(bytes, offset + 4)
    const localFlags = readU16(bytes, offset + 6)
    const localMethod = readU16(bytes, offset + 8)
    const localCrc = readU32(bytes, offset + 14)
    const localCompressedSize = readU32(bytes, offset + 18)
    const localUncompressedSize = readU32(bytes, offset + 22)
    const localNameLength = readU16(bytes, offset + 26)
    const localExtraLength = readU16(bytes, offset + 28)
    const localPayload = offset + 30
    const localEnd = localPayload + localNameLength + localExtraLength
    if (localEnd > centralOffset) throw parserFailure('INVALID')
    const localName = bytes.slice(localPayload, localPayload + localNameLength)
    const localExtra = bytes.slice(localPayload + localNameLength, localEnd)
    parseExtraFieldIds(localExtra)
    if (
      localVersion < 10 ||
      localVersion > 20 ||
      localFlags !== record.flags ||
      localMethod !== record.method ||
      !sameBytes(localName, record.nameBytes)
    )
      throw parserFailure('INVALID')
    const descriptor = (record.flags & DATA_DESCRIPTOR_FLAG) !== 0
    if (descriptor) {
      if (localCrc !== 0 && localCrc !== record.crc) throw parserFailure('INVALID')
      if (localCompressedSize !== 0 && localCompressedSize !== record.compressedSize)
        throw parserFailure('INVALID')
      if (localUncompressedSize !== 0 && localUncompressedSize !== record.uncompressedSize)
        throw parserFailure('INVALID')
    } else if (
      localCrc !== record.crc ||
      localCompressedSize !== record.compressedSize ||
      localUncompressedSize !== record.uncompressedSize
    ) {
      throw parserFailure('INVALID')
    }
    const dataStart = localEnd
    const dataEnd = dataStart + record.compressedSize
    if (dataEnd > centralOffset) throw parserFailure('INVALID')
    let regionEnd = dataEnd
    if (descriptor) {
      if (dataEnd + 12 > centralOffset) throw parserFailure('INVALID')
      const descriptorHasSignature = readU32(bytes, dataEnd) === DATA_DESCRIPTOR_SIGNATURE
      const descriptorStart = dataEnd + (descriptorHasSignature ? 4 : 0)
      const descriptorEnd = descriptorStart + 12
      if (descriptorEnd > centralOffset) throw parserFailure('INVALID')
      if (
        readU32(bytes, descriptorStart) !== record.crc ||
        readU32(bytes, descriptorStart + 4) !== record.compressedSize ||
        readU32(bytes, descriptorStart + 8) !== record.uncompressedSize
      )
        throw parserFailure('INVALID')
      regionEnd = descriptorEnd
    }
    record.dataStart = dataStart
    record.dataEnd = dataEnd
    record.regionEnd = regionEnd
    ranges.push({ start: offset, end: regionEnd })
  }

  ranges.sort((left, right) => left.start - right.start)
  let expectedStart = 0
  for (const range of ranges) {
    if (range.start !== expectedStart || range.end < range.start || range.end > centralOffset)
      throw parserFailure('INVALID')
    expectedStart = range.end
  }
  if (expectedStart !== centralOffset && records.length > 0) throw parserFailure('INVALID')
  return records
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8ArrayIntrinsic(bytes.length)
  copy.set(bytes)
  return copy
}

function allowedPart(name: string, format: Format): boolean {
  if (name === '[Content_Types].xml' || name === '_rels/.rels') return true
  const formats = format === 'auto' ? (['docx', 'xlsx', 'pptx'] as const) : [format]
  for (const selected of formats) {
    if (selected === 'docx') {
      if (
        name === 'word/document.xml' ||
        name === 'word/styles.xml' ||
        name === 'word/numbering.xml' ||
        name === 'word/settings.xml' ||
        name === 'word/fontTable.xml' ||
        /^word\/(?:header|footer)[1-9][0-9]*\.xml$/.test(name) ||
        /^word\/_rels\/[A-Za-z0-9._-]+\.rels$/.test(name)
      )
        return true
    }
    if (selected === 'xlsx') {
      if (
        name === 'xl/workbook.xml' ||
        name === 'xl/sharedStrings.xml' ||
        name === 'xl/styles.xml' ||
        name === 'xl/theme/theme1.xml' ||
        /^xl\/worksheets\/sheet[1-9][0-9]*\.xml$/.test(name) ||
        /^xl\/_rels\/[A-Za-z0-9._-]+\.rels$/.test(name) ||
        /^xl\/worksheets\/_rels\/sheet[1-9][0-9]*\.xml\.rels$/.test(name)
      )
        return true
    }
    if (selected === 'pptx') {
      if (
        name === 'ppt/presentation.xml' ||
        /^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(name) ||
        /^ppt\/slideMasters\/slideMaster[1-9][0-9]*\.xml$/.test(name) ||
        /^ppt\/slideLayouts\/slideLayout[1-9][0-9]*\.xml$/.test(name) ||
        /^ppt\/theme\/theme[1-9][0-9]*\.xml$/.test(name) ||
        /^ppt\/_rels\/[A-Za-z0-9._-]+\.rels$/.test(name) ||
        /^ppt\/slides\/_rels\/slide[1-9][0-9]*\.xml\.rels$/.test(name)
      )
        return true
    }
  }
  return false
}

function sourcePartForRelationships(name: string): string {
  if (name === '_rels/.rels') return ''
  const marker = '/_rels/'
  const markerIndex = name.indexOf(marker)
  if (markerIndex < 0 || !name.endsWith('.rels')) throw parserFailure('INVALID')
  return `${name.slice(0, markerIndex)}/${name.slice(markerIndex + marker.length, -5)}`
}

function validPartName(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('%')) return false
  const segments = name.split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..')
}

export function validateInternalPartReference(
  fromPart: string,
  target: string,
  targetMode?: string
): boolean {
  if (typeof fromPart !== 'string' || typeof target !== 'string') return false
  if (targetMode && targetMode.toLowerCase() === 'external') return false
  if (fromPart !== '' && !validPartName(fromPart)) return false
  if (!target || target.startsWith('/') || target.includes('\\') || target.includes('%'))
    return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.includes(':')) return false
  for (const character of target) {
    const code = character.codePointAt(0)!
    if (code < 0x20 || code === 0x7f || character === '?' || character === '#') return false
  }
  const base = fromPart ? fromPart.split('/').slice(0, -1) : []
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!base.length) return false
      base.pop()
    } else base.push(segment)
  }
  const resolved = base.join('/')
  return validPartName(resolved)
}

function relationshipAttribute(tag: SaxesTagNS, localName: string): string | undefined {
  for (const key of Object.keys(tag.attributes)) {
    const attribute = tag.attributes[key]
    if (attribute.local === localName || attribute.name === localName) return attribute.value
  }
  return undefined
}

function validateRelationshipPart(
  bytes: Uint8Array,
  name: string,
  context: OperationContext
): void {
  const sourcePart = sourcePartForRelationships(name)
  parseBoundedXml(
    bytes,
    {
      opentag: (tag) => {
        if (tag.local !== 'Relationship' && tag.name !== 'Relationship') return
        const target = relationshipAttribute(tag, 'Target')
        if (
          target === undefined ||
          !validateInternalPartReference(
            sourcePart,
            target,
            relationshipAttribute(tag, 'TargetMode')
          )
        )
          throw parserFailure('UNSUPPORTED')
      }
    },
    context
  )
}

function validateContentTypes(bytes: Uint8Array, context: OperationContext): void {
  parseBoundedXml(
    bytes,
    {
      opentag: (tag) => {
        const contentType = relationshipAttribute(tag, 'ContentType')?.toLowerCase()
        const extension = relationshipAttribute(tag, 'Extension')?.toLowerCase()
        if (
          (contentType && /(macro|vba|activex|ole|embedding)/.test(contentType)) ||
          extension === 'bin'
        )
          throw parserFailure('UNSUPPORTED')
      }
    },
    context
  )
}

export interface ZipXmlReaderOptions {
  readonly format?: Format
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}

export class ZipXmlReader {
  private readonly bytes: Uint8Array
  private readonly context: OperationContext
  private readonly format: Format
  private readonly records: ZipEntryRecord[]
  private readonly byName: ReadonlyMap<string, ZipEntryRecord>
  private readonly publicEntries: readonly ZipEntryInfo[]
  private readonly cache = new Map<string, Uint8Array>()
  private cacheBytes = 0
  private activeRead = false
  private currentInflater: ReturnType<typeof createInflateRaw> | undefined
  private cancelCurrentRead: (() => void) | undefined
  private signalCleanup: (() => void) | undefined
  private closed = false

  constructor(input: ByteInput, options: ZipXmlReaderOptions = {}) {
    this.bytes = snapshotBytes(input)
    const requestedDeadline = options.deadlineAt
    const deadlineAt =
      typeof requestedDeadline === 'number' && Number.isFinite(requestedDeadline)
        ? Math.min(requestedDeadline, Date.now() + MAX_OPERATION_MS)
        : Date.now() + MAX_OPERATION_MS
    this.context = { signal: options.signal, deadlineAt }
    this.format = options.format ?? 'auto'
    if (
      this.format !== 'auto' &&
      this.format !== 'docx' &&
      this.format !== 'xlsx' &&
      this.format !== 'pptx'
    )
      throw parserFailure('UNSUPPORTED')
    this.records = parseZip(this.bytes, this.context)
    this.byName = new Map(this.records.map((record) => [record.name, record]))
    this.publicEntries = Object.freeze(
      this.records.map((record) =>
        Object.freeze({
          name: record.name,
          compressionMethod: record.method as 0 | 8,
          compressedSize: record.compressedSize,
          uncompressedSize: record.uncompressedSize,
          encrypted: false as const,
          directory: record.directory,
          media: isMediaName(record.name)
        })
      )
    )
  }

  get entries(): readonly ZipEntryInfo[] {
    return this.publicEntries
  }
  listEntries(): readonly ZipEntryInfo[] {
    return this.publicEntries
  }
  hasEntry(name: string): boolean {
    return typeof name === 'string' && this.byName.has(name)
  }

  close(): void {
    this.closed = true
    const cancel = this.cancelCurrentRead
    this.cancelCurrentRead = undefined
    cancel?.()
    this.currentInflater?.destroy()
    this.currentInflater = undefined
  }

  async readAllowedPart(name: string): Promise<Uint8Array> {
    if (this.closed) throw parserFailure('CANCELLED')
    if (this.activeRead) throw parserFailure('INVALID')
    this.activeRead = true
    const signal = this.context.signal
    if (signal) {
      const onAbort = (): void => this.cancelCurrentRead?.()
      signal.addEventListener('abort', onAbort, { once: true })
      this.signalCleanup = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
    }
    try {
      checkOperation(this.context)
      if (typeof name !== 'string' || !allowedPart(name, this.format))
        throw parserFailure('UNSUPPORTED')
      const cached = this.cache.get(name)
      if (cached) return copyBytes(cached)
      const record = this.byName.get(name)
      if (!record || record.directory || isMediaName(name)) throw parserFailure('UNSUPPORTED')
      const bytes = await this.readRecord(record)
      checkOperation(this.context)
      if (name === '[Content_Types].xml') validateContentTypes(bytes, this.context)
      if (name.endsWith('.rels')) validateRelationshipPart(bytes, name, this.context)
      if (this.cacheBytes + bytes.length > MAX_EXPANDED_BYTES) throw parserFailure('LIMIT')
      this.cache.set(name, bytes)
      this.cacheBytes += bytes.length
      return copyBytes(bytes)
    } catch (error) {
      throw fixedError(error)
    } finally {
      this.signalCleanup?.()
      this.signalCleanup = undefined
      this.activeRead = false
    }
  }

  private async readRecord(record: ZipEntryRecord): Promise<Uint8Array> {
    checkOperation(this.context)
    if (record.method === 0) {
      const output = new Uint8ArrayIntrinsic(record.uncompressedSize)
      let outputOffset = 0
      let crc = 0
      while (outputOffset < record.uncompressedSize) {
        checkOperation(this.context)
        const end = Math.min(record.uncompressedSize, outputOffset + MAX_XML_CHUNK)
        const chunk = this.bytes.subarray(record.dataStart + outputOffset, record.dataStart + end)
        output.set(chunk, outputOffset)
        crc = crc32(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), crc)
        outputOffset = end
      }
      if (crc >>> 0 !== record.crc) throw parserFailure('INVALID')
      return output
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const inflater = createInflateRaw()
      this.currentInflater = inflater
      const chunks: Buffer[] = []
      let total = 0
      let crc = 0
      let failure: DocumentParserError | undefined
      let settled = false
      const finish = (error?: DocumentParserError, output?: Uint8Array): void => {
        if (settled) return
        settled = true
        if (this.currentInflater === inflater) this.currentInflater = undefined
        this.cancelCurrentRead = undefined
        if (error) reject(error)
        else resolve(output!)
      }
      this.cancelCurrentRead = () => {
        finish(parserFailure('CANCELLED'))
        inflater.destroy()
      }
      const failStream = (error: unknown, fallback: DocumentParserErrorCode = 'INVALID'): void => {
        failure = fixedError(error, fallback)
        finish(failure)
        inflater.destroy()
      }
      inflater.on('data', (chunk: Buffer) => {
        try {
          checkOperation(this.context)
          if (chunk.length > MAX_ENTRY_BYTES || total + chunk.length > record.uncompressedSize)
            throw parserFailure('LIMIT')
          total += chunk.length
          crc = crc32(chunk, crc)
          chunks.push(chunk)
        } catch (error) {
          failStream(error)
        }
      })
      inflater.once('error', (error: unknown) => finish(failure ?? fixedError(error)))
      inflater.once('close', () => {
        if (!settled) finish(failure ?? parserFailure('CANCELLED'))
      })
      inflater.once('end', () => {
        try {
          checkOperation(this.context)
          if (failure) return finish(failure)
          if (total !== record.uncompressedSize || crc >>> 0 !== record.crc)
            return finish(parserFailure('INVALID'))
          const bytesWritten = (inflater as unknown as { bytesWritten?: number }).bytesWritten
          if (typeof bytesWritten === 'number' && bytesWritten !== record.compressedSize)
            return finish(parserFailure('INVALID'))
          return finish(undefined, new Uint8ArrayIntrinsic(Buffer.concat(chunks, total)))
        } catch (error) {
          return finish(fixedError(error))
        }
      })
      try {
        let offset = record.dataStart
        while (!settled && offset < record.dataEnd) {
          checkOperation(this.context)
          const end = Math.min(record.dataEnd, offset + MAX_XML_CHUNK)
          inflater.write(
            Buffer.from(this.bytes.buffer, this.bytes.byteOffset + offset, end - offset)
          )
          offset = end
        }
        if (!settled) inflater.end()
      } catch (error) {
        failStream(error)
      }
    })
  }
}

export function createZipXmlReader(
  input: ByteInput,
  options: ZipXmlReaderOptions = {}
): ZipXmlReader {
  return new ZipXmlReader(input, options)
}
export const openZipXmlReader = createZipXmlReader
export const createBytesOnlyZipXmlReader = createZipXmlReader

export async function readAllowedPart(
  input: ByteInput,
  name: string,
  options: ZipXmlReaderOptions = {}
): Promise<Uint8Array> {
  const reader = createZipXmlReader(input, options)
  try {
    return await reader.readAllowedPart(name)
  } finally {
    reader.close()
  }
}

export type BoundedXmlTag = SaxesTagNS
export type BoundedXmlAttribute = SaxesAttributeNS
export type BoundedXmlEventType =
  | 'xmldecl'
  | 'text'
  | 'processinginstruction'
  | 'doctype'
  | 'comment'
  | 'opentagstart'
  | 'attribute'
  | 'opentag'
  | 'closetag'
  | 'cdata'
  | 'end'
export interface BoundedXmlEvent {
  readonly type: BoundedXmlEventType
  readonly value: unknown
}
export type BoundedXmlVisitor = (event: BoundedXmlEvent) => void
export interface BoundedXmlHandlers {
  readonly visitor?: BoundedXmlVisitor
  readonly xmldecl?: (value: XMLDecl) => void
  readonly text?: (value: string) => void
  readonly processinginstruction?: (value: { target: string; body: string }) => void
  readonly doctype?: (value: string) => void
  readonly comment?: (value: string) => void
  readonly opentagstart?: (value: BoundedXmlTag) => void
  readonly attribute?: (value: BoundedXmlAttribute) => void
  readonly opentag?: (value: BoundedXmlTag) => void
  readonly closetag?: (value: BoundedXmlTag) => void
  readonly cdata?: (value: string) => void
  readonly end?: () => void
  readonly onXmlDeclaration?: (value: XMLDecl) => void
  readonly onText?: (value: string) => void
  readonly onProcessingInstruction?: (value: { target: string; body: string }) => void
  readonly onDoctype?: (value: string) => void
  readonly onComment?: (value: string) => void
  readonly onOpenTag?: (value: BoundedXmlTag) => void
  readonly onCloseTag?: (value: BoundedXmlTag) => void
  readonly onCdata?: (value: string) => void
}
export interface BoundedXmlOptions {
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}
export interface BoundedXmlSummary {
  readonly bytes: number
  readonly elements: number
  readonly maxDepth: number
}

const HANDLER_NAMES = [
  'visitor',
  'xmldecl',
  'text',
  'processinginstruction',
  'doctype',
  'comment',
  'opentagstart',
  'attribute',
  'opentag',
  'closetag',
  'cdata',
  'end',
  'onXmlDeclaration',
  'onText',
  'onProcessingInstruction',
  'onDoctype',
  'onComment',
  'onOpenTag',
  'onCloseTag',
  'onCdata'
] as const

function safeHandlers(
  value: BoundedXmlHandlers | BoundedXmlVisitor | undefined
): BoundedXmlHandlers {
  if (value === undefined) return {}
  if (typeof value === 'function') return { visitor: value }
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    throw parserFailure('INVALID')
  const result: Record<string, (...args: never[]) => void> = Object.create(null)
  for (const name of HANDLER_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor) continue
    if (!('value' in descriptor) || typeof descriptor.value !== 'function')
      throw parserFailure('INVALID')
    result[name] = descriptor.value as (...args: never[]) => void
  }
  return result as BoundedXmlHandlers
}

function assertWellFormedString(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw parserFailure('INVALID')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) throw parserFailure('INVALID')
  }
}

function callHandler(
  handlers: BoundedXmlHandlers,
  event: BoundedXmlEventType,
  value: unknown,
  aliases: readonly string[]
): void {
  if (handlers.visitor) handlers.visitor({ type: event, value })
  for (const alias of aliases) {
    const candidate = (handlers as Record<string, unknown>)[alias]
    if (typeof candidate === 'function') (candidate as (value: unknown) => void)(value)
  }
}

export function parseBoundedXml(
  input: string | ByteInput,
  handlersOrVisitor?: BoundedXmlHandlers | BoundedXmlVisitor,
  options: BoundedXmlOptions = {}
): BoundedXmlSummary {
  const requestedDeadline = options.deadlineAt
  const context: OperationContext = {
    signal: options.signal,
    deadlineAt:
      typeof requestedDeadline === 'number' && Number.isFinite(requestedDeadline)
        ? Math.min(requestedDeadline, Date.now() + MAX_OPERATION_MS)
        : Date.now() + MAX_OPERATION_MS
  }
  const handlers = safeHandlers(handlersOrVisitor)
  let bytes: number
  let text: string
  try {
    checkOperation(context)
    if (typeof input === 'string') {
      assertWellFormedString(input)
      bytes = Buffer.byteLength(input, 'utf8')
      if (bytes > MAX_ENTRY_BYTES) throw parserFailure('LIMIT')
      text = input
    } else {
      const snapshot = snapshotBytes(input)
      bytes = snapshot.length
      if (
        snapshot.length >= 2 &&
        ((snapshot[0] === 0xff && snapshot[1] === 0xfe) ||
          (snapshot[0] === 0xfe && snapshot[1] === 0xff))
      )
        throw parserFailure('UNSUPPORTED')
      try {
        text = new TextDecoderIntrinsic('utf-8', { fatal: true }).decode(snapshot)
      } catch {
        throw parserFailure('INVALID')
      }
    }

    let depth = 0
    let elements = 0
    let maxDepth = 0
    let observedTextBytes = 0
    let parseFailure: DocumentParserError | undefined
    const parser = new SaxesParser<{ xmlns: true; fragment: false; position: false }>({
      xmlns: true,
      fragment: false,
      position: false
    })
    const fail = (error: DocumentParserError): never => {
      parseFailure = error
      throw error
    }
    parser.on('xmldecl', (decl) => {
      try {
        checkOperation(context)
        if (decl.encoding && decl.encoding.toLowerCase() !== 'utf-8')
          fail(parserFailure('UNSUPPORTED'))
        callHandler(handlers, 'xmldecl', decl, ['xmldecl', 'onXmlDeclaration'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('text', (value) => {
      try {
        checkOperation(context)
        observedTextBytes += Buffer.byteLength(value, 'utf8')
        if (observedTextBytes > bytes) fail(parserFailure('LIMIT'))
        callHandler(handlers, 'text', value, ['text', 'onText'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('cdata', (value) => {
      try {
        checkOperation(context)
        observedTextBytes += Buffer.byteLength(value, 'utf8')
        if (observedTextBytes > bytes) fail(parserFailure('LIMIT'))
        callHandler(handlers, 'cdata', value, ['cdata', 'onCdata'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('comment', (value) => {
      try {
        checkOperation(context)
        observedTextBytes += Buffer.byteLength(value, 'utf8')
        if (observedTextBytes > bytes) fail(parserFailure('LIMIT'))
        callHandler(handlers, 'comment', value, ['comment', 'onComment'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('doctype', () => fail(parserFailure('UNSUPPORTED')))
    parser.on('processinginstruction', () => fail(parserFailure('UNSUPPORTED')))
    parser.on('opentagstart', (tag) => {
      try {
        checkOperation(context)
        callHandler(handlers, 'opentagstart', tag, ['opentagstart'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('attribute', (attribute) => {
      try {
        checkOperation(context)
        callHandler(handlers, 'attribute', attribute, ['attribute'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('opentag', (tag) => {
      try {
        checkOperation(context)
        elements += 1
        depth += 1
        maxDepth = Math.max(maxDepth, depth)
        if (elements > MAX_XML_ELEMENTS || depth > MAX_XML_DEPTH) fail(parserFailure('LIMIT'))
        if (
          tag.uri === XINCLUDE_NAMESPACE ||
          Object.values(tag.ns).includes(XINCLUDE_NAMESPACE) ||
          (tag.prefix === 'xi' && tag.local === 'include')
        )
          fail(parserFailure('UNSUPPORTED'))
        for (const attribute of Object.values(tag.attributes)) {
          observedTextBytes +=
            Buffer.byteLength(attribute.name, 'utf8') + Buffer.byteLength(attribute.value, 'utf8')
          if (observedTextBytes > bytes) fail(parserFailure('LIMIT'))
          if (attribute.uri === XINCLUDE_NAMESPACE) fail(parserFailure('UNSUPPORTED'))
        }
        callHandler(handlers, 'opentag', tag, ['opentag', 'onOpenTag'])
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('closetag', (tag) => {
      try {
        checkOperation(context)
        if (depth <= 0) fail(parserFailure('INVALID'))
        callHandler(handlers, 'closetag', tag, ['closetag', 'onCloseTag'])
        depth -= 1
      } catch (error) {
        fail(fixedError(error))
      }
    })
    parser.on('error', () => {
      parseFailure ??= parserFailure('INVALID')
    })
    parser.on('end', () => {
      try {
        callHandler(handlers, 'end', undefined, ['end'])
      } catch (error) {
        parseFailure = fixedError(error)
      }
    })

    for (let offset = 0; offset < text.length;) {
      checkOperation(context)
      let end = Math.min(text.length, offset + MAX_XML_CHUNK)
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff
      )
        end -= 1
      if (end <= offset) end += 1
      parser.write(text.slice(offset, end))
      if (parseFailure) throw parseFailure
      offset = end
    }
    parser.close()
    if (parseFailure) throw parseFailure
    checkOperation(context)
    return { bytes, elements, maxDepth }
  } catch (error) {
    throw fixedError(error)
  }
}

export const ZIP_XML_LIMITS = Object.freeze({
  inputBytes: MAX_INPUT_BYTES,
  entries: MAX_ENTRIES,
  entryBytes: MAX_ENTRY_BYTES,
  expandedBytes: MAX_EXPANDED_BYTES,
  xmlDepth: MAX_XML_DEPTH,
  xmlElements: MAX_XML_ELEMENTS
})
