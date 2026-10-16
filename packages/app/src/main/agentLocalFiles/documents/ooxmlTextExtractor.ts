import { Buffer } from 'node:buffer'
import { types } from 'node:util'
import {
  DOCUMENT_TEXT_LIMITS,
  DOCUMENT_TEXT_PROTOCOL,
  checkDocumentTextRequest,
  checkDocumentTextResult,
  type DocumentTextFailureCode,
  type DocumentTextFormat,
  type DocumentTextResult
} from './documentSchema'
import {
  DocumentParserError,
  createZipXmlReader,
  parseBoundedXml,
  validateInternalPartReference,
  type BoundedXmlHandlers,
  type BoundedXmlTag,
  type ZipXmlReader
} from './zipXmlReader'

export type OfficeTextFormat = Exclude<DocumentTextFormat, 'pdf'>
export type OfficeExtractionOutcome =
  DocumentTextResult | Readonly<{ ok: false; code: 'INVALID' | 'LIMIT' }>

export type OfficeTextExtractionOptions = Readonly<{
  signal?: AbortSignal
  deadlineAt?: number
}>

type SuccessResult = Extract<DocumentTextResult, { ok: true }>
type Segment = SuccessResult['segments'][number]
type TextCollector = {
  readonly segments: Segment[]
  truncated: boolean
  outputBytes: number
}
type ContentTypes = { overrides: Map<string, string>; defaults: Map<string, string> }
type Relationship = { type: string; target: string }

const MAX_OUTPUT_BYTES = 48 * 1024
const MAX_SHARED_STRINGS = 100_000
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OPC_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const MAIN_PART = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml'
}
const CONTENT_TYPE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  relationships: 'application/vnd.openxmlformats-package.relationships+xml'
}
const ROOT_RELATION_TYPES = new Set([
  `${OFFICE_REL_NS}/officeDocument`,
  `${OPC_REL_NS}/metadata/core-properties`,
  `${OPC_REL_NS}/metadata/thumbnail`,
  `${OFFICE_REL_NS}/extended-properties`,
  `${OFFICE_REL_NS}/custom-properties`
])
// Only passive relationships are recognized. Their existence is checked, but unrelated
// targets are never opened; active/unknown relationship types fail before payload reads.
const PART_RELATION_TYPES = new Set(
  [
    'worksheet',
    'sharedStrings',
    'styles',
    'numbering',
    'settings',
    'webSettings',
    'fontTable',
    'theme',
    'header',
    'footer',
    'footnotes',
    'endnotes',
    'comments',
    'image',
    'slide',
    'slideMaster',
    'slideLayout',
    'notesMaster',
    'notesSlide',
    'table',
    'calcChain'
  ].map((name) => `${OFFICE_REL_NS}/${name}`)
)
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addAbortListener = EventTarget.prototype.addEventListener
const removeAbortListener = EventTarget.prototype.removeEventListener

function failure(
  jobId: string,
  format: OfficeTextFormat,
  code: DocumentTextFailureCode
): Extract<OfficeExtractionOutcome, { ok: false }> {
  const result = { protocol: DOCUMENT_TEXT_PROTOCOL, jobId, format, ok: false as const, code }
  const checked = checkDocumentTextResult(result, jobId, format)
  return checked.ok ? result : { ok: false, code: checked.code }
}

function mapParserFailure(error: unknown): DocumentTextFailureCode {
  if (error instanceof DocumentParserError) {
    if (error.code === 'LIMIT') return 'LIMIT'
    if (error.code === 'CANCELLED') return 'CANCELLED'
    if (error.code === 'UNSUPPORTED') return 'UNSUPPORTED'
  }
  return 'INVALID'
}

function snapshotOptions(value: unknown): {
  options: OfficeTextExtractionOptions
  cleanup: () => void
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new DocumentParserError('INVALID')
  const data: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'signal' && key !== 'deadlineAt') throw new DocumentParserError('INVALID')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor)) throw new DocumentParserError('INVALID')
    data[key] = descriptor.value
  }
  if (
    data.deadlineAt !== undefined &&
    (typeof data.deadlineAt !== 'number' || !Number.isFinite(data.deadlineAt))
  )
    throw new DocumentParserError('INVALID')
  const deadlineAt = Math.min(
    (data.deadlineAt as number | undefined) ?? Infinity,
    Date.now() + DOCUMENT_TEXT_LIMITS.deadlineMs
  )
  if (data.signal === undefined) return { options: { deadlineAt }, cleanup: () => {} }
  const signal = data.signal
  if (
    signal === null ||
    typeof signal !== 'object' ||
    types.isProxy(signal) ||
    Object.getPrototypeOf(signal) !== AbortSignal.prototype
  )
    throw new DocumentParserError('INVALID')
  for (const key of Reflect.ownKeys(signal)) {
    if (typeof key === 'string' || !('value' in Object.getOwnPropertyDescriptor(signal, key)!))
      throw new DocumentParserError('INVALID')
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (Reflect.apply(abortGetter, signal, [])) controller.abort()
  else Reflect.apply(addAbortListener, signal, ['abort', abort, { once: true }])
  return {
    options: { signal: controller.signal, deadlineAt },
    cleanup: () => Reflect.apply(removeAbortListener, signal, ['abort', abort])
  }
}

function textAttribute(tag: BoundedXmlTag, name: string, namespace = ''): string | undefined {
  return Object.values(tag.attributes).find(
    (attribute) => attribute.local === name && attribute.uri === namespace
  )?.value
}

function parsePart(
  bytes: Uint8Array,
  root: string,
  namespaces: readonly string[],
  handlers: Pick<BoundedXmlHandlers, 'opentag' | 'closetag' | 'text' | 'cdata'>,
  options: OfficeTextExtractionOptions
): void {
  let depth = 0
  parseBoundedXml(
    bytes,
    {
      opentag: (tag) => {
        if (
          !namespaces.includes(tag.uri) ||
          (depth === 0 && (tag.local !== root || tag.uri !== namespaces[0]))
        )
          throw new DocumentParserError('UNSUPPORTED')
        if (['altChunk', 'oleObject', 'oleObj', 'control', 'externalReference'].includes(tag.local))
          throw new DocumentParserError('UNSUPPORTED')
        depth += 1
        handlers.opentag?.(tag)
      },
      closetag: (tag) => {
        handlers.closetag?.(tag)
        depth -= 1
      },
      text: (value) => handlers.text?.(value),
      cdata: (value) => handlers.cdata?.(value)
    },
    options
  )
}

function appendText(collector: TextCollector, text: string, locator: Segment['locator']): void {
  if (collector.truncated || !text) return
  const remaining = MAX_OUTPUT_BYTES - collector.outputBytes
  if (collector.segments.length >= DOCUMENT_TEXT_LIMITS.segments || remaining <= 0) {
    collector.truncated = true
    return
  }
  let bounded = ''
  let bytes = 0
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > remaining) break
    bounded += character
    bytes += characterBytes
  }
  if (!bounded) {
    collector.truncated = true
    return
  }
  collector.segments.push({ text: bounded, locator })
  collector.outputBytes += bytes
  if (bounded.length !== text.length) collector.truncated = true
}

function finish(
  collector: TextCollector,
  jobId: string,
  format: OfficeTextFormat
): OfficeExtractionOutcome {
  if (!collector.segments.length) return failure(jobId, format, 'NO_TEXT')
  // Text budgets alone do not bound JSON escaping, locators or envelope overhead.
  // Until envelope-aware truncation is supported, an oversized envelope fails LIMIT.
  const checked = checkDocumentTextResult(
    {
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId,
      ok: true,
      format,
      segments: collector.segments,
      truncated: collector.truncated,
      warnings: collector.truncated ? ['output-truncated'] : []
    },
    jobId,
    format
  )
  return checked.ok ? checked.result : failure(jobId, format, checked.code)
}

function resolveTarget(fromPart: string, target: string, mode?: string): string {
  if (
    (mode !== undefined && mode !== 'Internal') ||
    !validateInternalPartReference(fromPart, target, mode) ||
    target.endsWith('/')
  )
    throw new DocumentParserError('UNSUPPORTED')
  const segments = fromPart.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment && segment !== '.') segments.push(segment)
  }
  return segments.join('/')
}

function parseRelationships(
  bytes: Uint8Array,
  source: string,
  reader: ZipXmlReader,
  options: OfficeTextExtractionOptions
): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>()
  const targets = new Set<string>()
  const allowed = source ? PART_RELATION_TYPES : ROOT_RELATION_TYPES
  let depth = 0
  parsePart(
    bytes,
    'Relationships',
    [OPC_REL_NS],
    {
      opentag: (tag) => {
        depth += 1
        if (depth === 1) return
        if (depth !== 2 || tag.local !== 'Relationship') throw new DocumentParserError('INVALID')
        const id = textAttribute(tag, 'Id')
        const type = textAttribute(tag, 'Type')
        const target = textAttribute(tag, 'Target')
        if (
          !id ||
          !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id) ||
          !type ||
          !target ||
          relationships.has(id)
        )
          throw new DocumentParserError('INVALID')
        if (!allowed.has(type)) throw new DocumentParserError('UNSUPPORTED')
        const resolved = resolveTarget(source, target, textAttribute(tag, 'TargetMode'))
        if (targets.has(resolved) || !reader.hasEntry(resolved))
          throw new DocumentParserError('INVALID')
        targets.add(resolved)
        relationships.set(id, { type, target: resolved })
      },
      closetag: () => {
        depth -= 1
      }
    },
    options
  )
  return relationships
}

function validateContentTypes(
  bytes: Uint8Array,
  options: OfficeTextExtractionOptions
): ContentTypes {
  const overrides = new Map<string, string>()
  const defaults = new Map<string, string>()
  let depth = 0
  parsePart(
    bytes,
    'Types',
    [CONTENT_TYPES_NS],
    {
      opentag: (tag) => {
        depth += 1
        if (depth === 1) return
        if (depth !== 2 || (tag.local !== 'Override' && tag.local !== 'Default'))
          throw new DocumentParserError('INVALID')
        const contentType = textAttribute(tag, 'ContentType')
        if (!contentType || !/^[^\s/]+\/[^\s/]+$/.test(contentType))
          throw new DocumentParserError('INVALID')
        if (/(macro|vba|activex|oleobject|embedding)/i.test(contentType))
          throw new DocumentParserError('UNSUPPORTED')
        if (tag.local === 'Override') {
          const part = textAttribute(tag, 'PartName')
          if (
            !part?.startsWith('/') ||
            resolveTarget('', part.slice(1)) !== part.slice(1) ||
            overrides.has(part.slice(1))
          )
            throw new DocumentParserError('INVALID')
          overrides.set(part.slice(1), contentType)
        } else {
          const extension = textAttribute(tag, 'Extension')?.toLowerCase()
          if (!extension || !/^[a-z0-9]+$/.test(extension) || defaults.has(extension))
            throw new DocumentParserError('INVALID')
          if (extension === 'bin') throw new DocumentParserError('UNSUPPORTED')
          defaults.set(extension, contentType)
        }
      },
      closetag: () => {
        depth -= 1
      }
    },
    options
  )
  return { overrides, defaults }
}

function requireContentType(contentTypes: ContentTypes, part: string, expected: string): void {
  const actual =
    contentTypes.overrides.get(part) ??
    contentTypes.defaults.get(part.split('.').at(-1)!.toLowerCase())
  if (actual !== expected) throw new DocumentParserError('UNSUPPORTED')
}

function relationshipPart(source: string): string {
  const slash = source.lastIndexOf('/')
  return `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`
}

async function readRelationships(
  reader: ZipXmlReader,
  source: string,
  contentTypes: ContentTypes,
  options: OfficeTextExtractionOptions
): Promise<Map<string, Relationship>> {
  const part = source ? relationshipPart(source) : '_rels/.rels'
  requireContentType(contentTypes, part, CONTENT_TYPE.relationships)
  return parseRelationships(await reader.readAllowedPart(part), source, reader, options)
}

async function validatePackage(
  reader: ZipXmlReader,
  format: OfficeTextFormat,
  options: OfficeTextExtractionOptions
): Promise<ContentTypes> {
  const contentTypes = validateContentTypes(
    await reader.readAllowedPart('[Content_Types].xml'),
    options
  )
  requireContentType(contentTypes, MAIN_PART[format], CONTENT_TYPE[format])
  const relationships = await readRelationships(reader, '', contentTypes, options)
  const roots = [...relationships.values()].filter(
    ({ type }) => type === `${OFFICE_REL_NS}/officeDocument`
  )
  if (roots.length !== 1 || roots[0].target !== MAIN_PART[format])
    throw new DocumentParserError('UNSUPPORTED')
  return contentTypes
}

function orderedParts(
  bytes: Uint8Array,
  format: 'xlsx' | 'pptx',
  relationships: ReadonlyMap<string, Relationship>,
  contentTypes: ContentTypes,
  options: OfficeTextExtractionOptions
): string[] {
  const spreadsheet = format === 'xlsx'
  const root = spreadsheet ? 'workbook' : 'presentation'
  const container = spreadsheet ? 'sheets' : 'sldIdLst'
  const item = spreadsheet ? 'sheet' : 'sldId'
  const relation = spreadsheet ? 'worksheet' : 'slide'
  const stack: string[] = []
  const parts: string[] = []
  const ids = new Set<string>()
  const documentIds = new Set<number>()
  let containers = 0
  parsePart(
    bytes,
    root,
    [spreadsheet ? SHEET_NS : PRESENTATION_NS],
    {
      opentag: (tag) => {
        const parent = stack.at(-1)
        stack.push(tag.local)
        if (tag.local === container) {
          if (parent !== root || stack.length !== 2 || ++containers !== 1)
            throw new DocumentParserError('INVALID')
        }
        if (tag.local !== item) return
        if (stack.length !== 3 || parent !== container) throw new DocumentParserError('INVALID')
        const id = textAttribute(tag, 'id', OFFICE_REL_NS)
        const documentId = textAttribute(tag, spreadsheet ? 'sheetId' : 'id') ?? ''
        const number = Number(documentId)
        if (
          !id ||
          ids.has(id) ||
          !/^[1-9][0-9]*$/.test(documentId) ||
          !Number.isSafeInteger(number) ||
          number < (spreadsheet ? 1 : 256) ||
          number > (spreadsheet ? 4294967295 : 2147483647) ||
          documentIds.has(number)
        )
          throw new DocumentParserError('INVALID')
        if (spreadsheet && !textAttribute(tag, 'name')) throw new DocumentParserError('INVALID')
        const linked = relationships.get(id)
        if (
          !linked ||
          linked.type !== `${OFFICE_REL_NS}/${relation}` ||
          parts.includes(linked.target)
        )
          throw new DocumentParserError('INVALID')
        requireContentType(contentTypes, linked.target, CONTENT_TYPE[relation])
        ids.add(id)
        documentIds.add(number)
        parts.push(linked.target)
        if (parts.length > DOCUMENT_TEXT_LIMITS.zipEntries) throw new DocumentParserError('LIMIT')
      },
      closetag: () => {
        stack.pop()
      }
    },
    options
  )
  if (!parts.length) throw new DocumentParserError('UNSUPPORTED')
  return parts
}

function extractDocxPart(
  bytes: Uint8Array,
  collector: TextCollector,
  options: OfficeTextExtractionOptions
): void {
  let paragraph = -1
  let tableIndex = -1
  const tables: Array<{
    index: number
    row: number
    column: number
    rowOpen: boolean
    cellOpen: boolean
  }> = []
  let paragraphLocator: Segment['locator'] | undefined
  let current = ''
  let paragraphOpen = false
  let textOpen = false
  parsePart(
    bytes,
    'document',
    [WORD_NS],
    {
      opentag: (tag) => {
        const table = tables.at(-1)
        if (tag.local === 'tbl') {
          if (paragraphOpen || (table && !table.cellOpen)) throw new DocumentParserError('INVALID')
          tables.push({ index: ++tableIndex, row: -1, column: -1, rowOpen: false, cellOpen: false })
        } else if (tag.local === 'tr') {
          if (!table || table.rowOpen || paragraphOpen) throw new DocumentParserError('INVALID')
          table.row++
          table.column = -1
          table.rowOpen = true
        } else if (tag.local === 'tc') {
          if (!table?.rowOpen || table.cellOpen || paragraphOpen)
            throw new DocumentParserError('INVALID')
          table.column++
          table.cellOpen = true
        } else if (tag.local === 'p') {
          if (paragraphOpen) throw new DocumentParserError('UNSUPPORTED')
          if (table && !table.cellOpen) throw new DocumentParserError('INVALID')
          paragraph += 1
          paragraphLocator = table
            ? {
                kind: 'docx-table-cell',
                part: 'word/document.xml',
                table: table.index,
                row: table.row,
                column: table.column
              }
            : { kind: 'docx-paragraph', part: 'word/document.xml', paragraph }
          current = ''
          paragraphOpen = true
        } else if (paragraphOpen && tag.local === 't') textOpen = true
        else if (paragraphOpen && (tag.local === 'tab' || tag.local === 'br' || tag.local === 'cr'))
          current += tag.local === 'tab' ? '\t' : '\n'
      },
      text: (value) => {
        if (paragraphOpen && textOpen) current += value
      },
      cdata: (value) => {
        if (paragraphOpen && textOpen) current += value
      },
      closetag: (tag) => {
        if (tag.local === 't') textOpen = false
        if (tag.local === 'p') {
          if (current && paragraphLocator) appendText(collector, current, paragraphLocator)
          paragraphOpen = false
          textOpen = false
          paragraphLocator = undefined
        }
        const table = tables.at(-1)
        if (tag.local === 'tc') {
          if (!table?.cellOpen || paragraphOpen) throw new DocumentParserError('INVALID')
          table.cellOpen = false
        } else if (tag.local === 'tr') {
          if (!table?.rowOpen || table.cellOpen || paragraphOpen)
            throw new DocumentParserError('INVALID')
          table.rowOpen = false
        } else if (tag.local === 'tbl') {
          if (!table || table.rowOpen || table.cellOpen || paragraphOpen)
            throw new DocumentParserError('INVALID')
          tables.pop()
        }
      }
    },
    options
  )
}

function collectSharedStrings(bytes: Uint8Array, options: OfficeTextExtractionOptions): string[] {
  const values: string[] = []
  let current = ''
  let itemDepth = 0
  let textDepth = 0
  parsePart(
    bytes,
    'sst',
    [SHEET_NS],
    {
      opentag: (tag) => {
        if (tag.local === 'si') {
          if (itemDepth) throw new DocumentParserError('INVALID')
          if (values.length >= MAX_SHARED_STRINGS) throw new DocumentParserError('LIMIT')
          current = ''
          itemDepth = 1
        } else if (itemDepth > 0) {
          itemDepth += 1
          if (tag.local === 't') textDepth += 1
        }
      },
      text: (value) => {
        if (itemDepth > 0 && textDepth > 0) current += value
      },
      cdata: (value) => {
        if (itemDepth > 0 && textDepth > 0) current += value
      },
      closetag: (tag) => {
        if (itemDepth <= 0) return
        if (tag.local === 't') textDepth = Math.max(0, textDepth - 1)
        itemDepth -= 1
        if (tag.local === 'si') {
          values.push(current)
          itemDepth = 0
        }
      }
    },
    options
  )
  return values
}

function validCellReference(ref: string): boolean {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref)
  if (!match || Number(match[2]) > 1048576) return false
  let column = 0
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64
  return column <= 16384
}

function extractXlsxSheet(
  bytes: Uint8Array,
  sheet: number,
  sharedStrings: readonly string[],
  collector: TextCollector,
  options: OfficeTextExtractionOptions
): void {
  type Cell = { ref: string; kind?: string; value: string; valueSeen: boolean }
  let cell: Cell | undefined
  let valueOpen = false
  let textOpen = false
  const cells = new Set<string>()
  const stack: string[] = []
  parsePart(
    bytes,
    'worksheet',
    [SHEET_NS],
    {
      opentag: (tag) => {
        const parent = stack.at(-1)
        stack.push(tag.local)
        if (tag.local === 'c') {
          const ref = textAttribute(tag, 'r') ?? ''
          if (
            cell ||
            parent !== 'row' ||
            stack.at(-3) !== 'sheetData' ||
            !validCellReference(ref) ||
            cells.has(ref)
          )
            throw new DocumentParserError('INVALID')
          cells.add(ref)
          cell = { ref, kind: textAttribute(tag, 't'), value: '', valueSeen: false }
        } else if (cell && tag.local === 'v') {
          if (parent !== 'c' || cell.kind === 'inlineStr' || cell.valueSeen)
            throw new DocumentParserError('INVALID')
          cell.valueSeen = true
          valueOpen = true
        } else if (cell && tag.local === 't') {
          if (cell.kind !== 'inlineStr' || (parent !== 'is' && parent !== 'r'))
            throw new DocumentParserError('INVALID')
          textOpen = true
        } else if (valueOpen || textOpen) throw new DocumentParserError('INVALID')
      },
      text: (value) => {
        if (cell && (valueOpen || textOpen)) cell.value += value
      },
      cdata: (value) => {
        if (cell && (valueOpen || textOpen)) cell.value += value
      },
      closetag: (tag) => {
        stack.pop()
        if (tag.local === 'v') valueOpen = false
        if (tag.local === 't') textOpen = false
        if (tag.local !== 'c' || !cell) return
        const finished = cell
        cell = undefined
        let text = finished.value
        if (finished.kind === 's') {
          if (!/^(?:0|[1-9][0-9]*)$/.test(finished.value)) throw new DocumentParserError('INVALID')
          const index = Number(finished.value)
          if (!Number.isSafeInteger(index) || index >= sharedStrings.length)
            throw new DocumentParserError('INVALID')
          text = sharedStrings[index]
        }
        if (text) appendText(collector, text, { kind: 'xlsx-cell', sheet, cell: finished.ref })
      }
    },
    options
  )
}

function extractPptxSlide(
  bytes: Uint8Array,
  slide: number,
  collector: TextCollector,
  options: OfficeTextExtractionOptions
): void {
  let shape = -1
  let paragraph = -1
  let current = ''
  let shapeOpen = false
  let paragraphOpen = false
  let textOpen = false
  parsePart(
    bytes,
    'sld',
    [PRESENTATION_NS, DRAWING_NS],
    {
      opentag: (tag) => {
        if (tag.local === 'sp' && tag.uri === PRESENTATION_NS) {
          if (shapeOpen) throw new DocumentParserError('INVALID')
          shape += 1
          paragraph = -1
          shapeOpen = true
        } else if (shapeOpen && tag.local === 'p' && tag.uri === DRAWING_NS) {
          if (paragraphOpen) throw new DocumentParserError('INVALID')
          paragraph += 1
          paragraphOpen = true
          current = ''
        } else if (paragraphOpen && tag.local === 't' && tag.uri === DRAWING_NS) textOpen = true
      },
      text: (value) => {
        if (paragraphOpen && textOpen) current += value
      },
      cdata: (value) => {
        if (paragraphOpen && textOpen) current += value
      },
      closetag: (tag) => {
        if (tag.local === 't' && tag.uri === DRAWING_NS) textOpen = false
        if (tag.local === 'p' && tag.uri === DRAWING_NS && paragraphOpen) {
          if (current)
            appendText(collector, current, { kind: 'pptx-shape', slide, shape, paragraph })
          paragraphOpen = false
          textOpen = false
        }
        if (tag.local === 'sp' && tag.uri === PRESENTATION_NS) shapeOpen = false
      }
    },
    options
  )
}

export async function extractOoxmlText(
  input: Uint8Array | Buffer,
  jobId: string,
  format: OfficeTextFormat,
  options: OfficeTextExtractionOptions = {}
): Promise<OfficeExtractionOutcome> {
  if (
    typeof jobId !== 'string' ||
    jobId.length !== 32 ||
    !/^[a-f0-9]{32}$/.test(jobId) ||
    (format !== 'docx' && format !== 'xlsx' && format !== 'pptx')
  )
    return { ok: false, code: 'INVALID' }
  const checked = checkDocumentTextRequest({
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId,
    format,
    bytes: input
  })
  if (!checked.ok) return failure(jobId, format, checked.code)

  let reader: ZipXmlReader | undefined
  let cleanup: (() => void) | undefined
  try {
    const snapshot = snapshotOptions(options)
    options = snapshot.options
    cleanup = snapshot.cleanup
    reader = createZipXmlReader(checked.request.bytes, { format, ...options })
    const contentTypes = await validatePackage(reader, format, options)
    const main = MAIN_PART[format]
    const mainRelationships =
      format !== 'docx' || reader.hasEntry(relationshipPart(main))
        ? await readRelationships(reader, main, contentTypes, options)
        : new Map<string, Relationship>()
    const collector: TextCollector = { segments: [], truncated: false, outputBytes: 0 }
    if (format === 'docx') {
      extractDocxPart(await reader.readAllowedPart(main), collector, options)
    } else {
      const parts = orderedParts(
        await reader.readAllowedPart(main),
        format,
        mainRelationships,
        contentTypes,
        options
      )
      let sharedStrings: string[] = []
      if (format === 'xlsx') {
        const shared = [...mainRelationships.values()].filter(
          ({ type }) => type === `${OFFICE_REL_NS}/sharedStrings`
        )
        if (shared.length > 1) throw new DocumentParserError('INVALID')
        if (shared.length) {
          requireContentType(contentTypes, shared[0].target, CONTENT_TYPE.sharedStrings)
          sharedStrings = collectSharedStrings(
            await reader.readAllowedPart(shared[0].target),
            options
          )
        }
      }
      // Validate all selected parts' relationship metadata before any sheet/slide payload,
      // even if the eventual text budget stops extraction early.
      for (const part of parts) {
        if (reader.hasEntry(relationshipPart(part)))
          await readRelationships(reader, part, contentTypes, options)
      }
      for (const [index, part] of parts.entries()) {
        const bytes = await reader.readAllowedPart(part)
        if (format === 'xlsx') extractXlsxSheet(bytes, index + 1, sharedStrings, collector, options)
        else extractPptxSlide(bytes, index + 1, collector, options)
        if (collector.truncated) break
      }
    }
    return finish(collector, jobId, format)
  } catch (error) {
    return failure(jobId, format, mapParserFailure(error))
  } finally {
    reader?.close()
    cleanup?.()
  }
}

export const extractOfficeText = extractOoxmlText
