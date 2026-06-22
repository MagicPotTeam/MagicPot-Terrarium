import type JSZip from 'jszip'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'
import {
  type CanvasFilePreviewImage,
  type CanvasFilePreviewSheet,
  type CanvasFilePreviewSheetCell,
  detectCanvasFileKind,
  getFileExtension,
  isEditableCanvasFile,
  isOfficePreviewableFile
} from './types'

const extractXmlText = (xml: string): string => {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, 'application/xml')
  const textNodes = Array.from(doc.getElementsByTagNameNS('*', 't'))

  return textNodes
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
    .filter(Boolean)
    .join(' ')
    .trim()
}

const getSortedSlidePaths = (zip: JSZip): string[] =>
  Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftIndex = Number(left.match(/slide(\d+)\.xml/i)?.[1] || 0)
      const rightIndex = Number(right.match(/slide(\d+)\.xml/i)?.[1] || 0)
      return leftIndex - rightIndex
    })

const getSortedWorksheetPaths = (zip: JSZip): string[] =>
  Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftIndex = Number(left.match(/sheet(\d+)\.xml/i)?.[1] || 0)
      const rightIndex = Number(right.match(/sheet(\d+)\.xml/i)?.[1] || 0)
      return leftIndex - rightIndex
    })

const OFFICE_MEDIA_PATH_PATTERNS: Record<string, RegExp> = {
  '.docx': /^word\/media\/[^/]+$/i,
  '.xlsx': /^xl\/media\/[^/]+$/i,
  '.pptx': /^ppt\/media\/[^/]+$/i
}

const PREVIEWABLE_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

const MAX_OFFICE_PREVIEW_IMAGES = 12
const MAX_OFFICE_PREVIEW_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_OFFICE_PREVIEW_ARCHIVE_ENTRIES = 4096
const MAX_OFFICE_PREVIEW_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_OFFICE_PREVIEW_MEDIA_BYTES = 16 * 1024 * 1024
const MAX_OFFICE_PREVIEW_TOTAL_MEDIA_BYTES = 64 * 1024 * 1024

type OfficePreviewLimitKind = 'archiveSize' | 'entryCount' | 'totalUncompressedSize'

class OfficePreviewLimitExceededError extends Error {
  limitKind: OfficePreviewLimitKind
  limit: number
  actual: number

  constructor(limitKind: OfficePreviewLimitKind, limit: number, actual: number) {
    super(`Office preview ${limitKind} exceeds safety limit (${actual} > ${limit})`)
    this.name = 'OfficePreviewLimitExceededError'
    this.limitKind = limitKind
    this.limit = limit
    this.actual = actual
  }
}

function getZipEntryUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) ? size : null
}

function assertOfficePreviewLimit(
  limitKind: OfficePreviewLimitKind,
  actual: number,
  limit: number
): void {
  if (actual > limit) {
    throw new OfficePreviewLimitExceededError(limitKind, limit, actual)
  }
}

function assertOfficePreviewZipLimits(file: File, zip: JSZip): void {
  assertOfficePreviewLimit('archiveSize', file.size, MAX_OFFICE_PREVIEW_ARCHIVE_BYTES)

  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  assertOfficePreviewLimit('entryCount', entries.length, MAX_OFFICE_PREVIEW_ARCHIVE_ENTRIES)

  let totalUncompressedBytes = 0
  for (const entry of entries) {
    const uncompressedSize = getZipEntryUncompressedSize(entry)
    if (uncompressedSize == null) {
      continue
    }
    totalUncompressedBytes += uncompressedSize
    assertOfficePreviewLimit(
      'totalUncompressedSize',
      totalUncompressedBytes,
      MAX_OFFICE_PREVIEW_TOTAL_UNCOMPRESSED_BYTES
    )
  }
}

async function loadOfficePreviewZip(file: File): Promise<JSZip> {
  assertOfficePreviewLimit('archiveSize', file.size, MAX_OFFICE_PREVIEW_ARCHIVE_BYTES)
  const { default: JSZipCtor } = await import('jszip')
  const zip = await JSZipCtor.loadAsync(file)
  assertOfficePreviewZipLimits(file, zip)
  return zip
}

function emptyOfficePreviewData(): {
  previewText: string | null
  previewImages: CanvasFilePreviewImage[]
  previewSheets: CanvasFilePreviewSheet[]
} {
  return {
    previewText: null,
    previewImages: [],
    previewSheets: []
  }
}

function createOfficePreviewObjectUrl(blob: Blob): string {
  if (typeof URL.createObjectURL !== 'function') {
    throw new Error('Object URL support is required for Office preview images.')
  }
  return URL.createObjectURL(blob)
}

const normalizePlainTextPreview = (text: string): string | null => {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  return normalized || null
}

const getSortedOfficeMediaPaths = (zip: JSZip, extension: string): string[] => {
  const pattern = OFFICE_MEDIA_PATH_PATTERNS[extension]
  if (!pattern) return []

  return Object.keys(zip.files)
    .filter((path) => pattern.test(path))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

const getPreviewImageMimeType = (path: string): string | null => {
  const extension = getFileExtension(path)
  return PREVIEWABLE_IMAGE_MIME_TYPES[extension] || null
}

const extractOfficePreviewImages = async (
  zip: JSZip,
  extension: string
): Promise<CanvasFilePreviewImage[]> => {
  const mediaPaths = getSortedOfficeMediaPaths(zip, extension)
  if (mediaPaths.length === 0) return []

  const previewImages: CanvasFilePreviewImage[] = []
  let totalMediaBytes = 0

  for (const mediaPath of mediaPaths) {
    if (previewImages.length >= MAX_OFFICE_PREVIEW_IMAGES) break

    const mimeType = getPreviewImageMimeType(mediaPath)
    const mediaFile = zip.file(mediaPath)
    if (!mimeType || !mediaFile) continue

    const declaredSize = getZipEntryUncompressedSize(mediaFile)
    if (declaredSize != null) {
      if (declaredSize > MAX_OFFICE_PREVIEW_MEDIA_BYTES) continue
      if (totalMediaBytes + declaredSize > MAX_OFFICE_PREVIEW_TOTAL_MEDIA_BYTES) break
    }

    const blob = await mediaFile.async('blob')
    if (blob.size > MAX_OFFICE_PREVIEW_MEDIA_BYTES) continue
    if (totalMediaBytes + blob.size > MAX_OFFICE_PREVIEW_TOTAL_MEDIA_BYTES) break
    totalMediaBytes += blob.size

    const index = previewImages.length
    previewImages.push({
      id: `office-preview-image-${index + 1}-${mediaPath}`,
      src: createOfficePreviewObjectUrl(blob),
      mimeType,
      fileName: mediaPath.split('/').pop() || `image-${index + 1}`
    })
  }

  return previewImages
}

const MAX_LEGACY_PREVIEW_CHARS = 1400
const MIN_LEGACY_CANDIDATE_LENGTH = 6
const LEGACY_OFFICE_COMPOUND_FILE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const LEGACY_BINARY_IGNORE_PATTERNS = [
  /^Root Entry$/i,
  /^WordDocument$/i,
  /^CompObj$/i,
  /^ObjectPool$/i,
  /^SummaryInformation$/i,
  /^DocumentSummaryInformation$/i,
  /^Word\.Document\.\d+$/i,
  /^Microsoft Office Word$/i
]

const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file text'))
    reader.readAsText(file)
  })

const readFileAsArrayBuffer = async (file: File): Promise<ArrayBuffer> => {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer()
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
        return
      }
      reject(new Error('Failed to read file bytes'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file bytes'))
    reader.readAsArrayBuffer(file)
  })
}

const getFirstTagText = (element: Element, tagName: string): string =>
  element.getElementsByTagNameNS('*', tagName)[0]?.textContent?.trim() || ''

type SpreadsheetCellPosition = {
  row: number
  col: number
}

type SpreadsheetSheetDescriptor = {
  id: string
  name: string
  path: string
}

type SpreadsheetSheetLookup = Map<string, CanvasFilePreviewSheet>

const WORKSHEET_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'

const SPREADSHEET_XML_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const parseSpreadsheetCellReference = (reference: string): SpreadsheetCellPosition | null => {
  const normalized = reference.trim().toUpperCase()
  const match = normalized.match(/^([A-Z]+)(\d+)$/)
  if (!match) return null

  const [, columnLabel, rowLabel] = match
  let col = 0

  for (const character of columnLabel) {
    col = col * 26 + (character.charCodeAt(0) - 64)
  }

  const row = Number(rowLabel)
  if (!Number.isFinite(row) || row <= 0 || col <= 0) {
    return null
  }

  return { row, col }
}

const parseSpreadsheetDimensionReference = (
  reference: string
): { start: SpreadsheetCellPosition; end: SpreadsheetCellPosition } | null => {
  const normalized = reference.trim()
  if (!normalized) return null

  const [startRef, endRef = startRef] = normalized.split(':')
  const start = parseSpreadsheetCellReference(startRef)
  const end = parseSpreadsheetCellReference(endRef)

  if (!start || !end) {
    return null
  }

  return { start, end }
}

const toSpreadsheetColumnLabel = (col: number): string => {
  let label = ''
  let current = Math.max(1, Math.trunc(col))

  while (current > 0) {
    const remainder = (current - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    current = Math.floor((current - 1) / 26)
  }

  return label || 'A'
}

const buildSpreadsheetCellReference = (row: number, col: number): string =>
  `${toSpreadsheetColumnLabel(Math.max(1, Math.trunc(col)))}${Math.max(1, Math.trunc(row))}`

const buildSpreadsheetDimensionReference = (rows: number, cols: number): string => {
  const safeRows = Math.max(1, Math.trunc(rows) || 1)
  const safeCols = Math.max(1, Math.trunc(cols) || 1)
  const endRef = buildSpreadsheetCellReference(safeRows, safeCols)

  return safeRows === 1 && safeCols === 1 ? 'A1' : `A1:${endRef}`
}

const isSpreadsheetBooleanText = (value: string): boolean => /^(true|false)$/i.test(value.trim())

const isSpreadsheetNumericText = (value: string): boolean => {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return false
  }

  if (/^-?0\d+/.test(trimmed)) {
    return false
  }

  return true
}

const copyElementAttributes = (
  source: Element | null,
  target: Element,
  ignoredNames: Set<string> = new Set()
) => {
  if (!source) return

  for (const attribute of Array.from(source.attributes)) {
    if (ignoredNames.has(attribute.name)) {
      continue
    }

    target.setAttribute(attribute.name, attribute.value)
  }
}

const findDirectWorksheetChild = (worksheet: Element, localName: string): Element | null =>
  Array.from(worksheet.childNodes).find(
    (node): node is Element =>
      node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === localName
  ) || null

const getWorksheetNamespaceUri = (worksheet: Element): string =>
  worksheet.namespaceURI || 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

const ensureWorksheetChild = (doc: XMLDocument, worksheet: Element, localName: string): Element => {
  const existing = findDirectWorksheetChild(worksheet, localName)
  if (existing) {
    return existing
  }

  const child = doc.createElementNS(getWorksheetNamespaceUri(worksheet), localName)
  worksheet.appendChild(child)
  return child
}

const sortWorksheetRowCells = (row: Element) => {
  const cells = Array.from(row.childNodes).filter(
    (node): node is Element => node instanceof Element && node.localName === 'c'
  )
  const orderedCells = cells.sort((left, right) => {
    const leftPosition = parseSpreadsheetCellReference(left.getAttribute('r') || '')
    const rightPosition = parseSpreadsheetCellReference(right.getAttribute('r') || '')

    if (!leftPosition || !rightPosition) return 0
    return leftPosition.col - rightPosition.col
  })

  for (const cell of orderedCells) {
    row.appendChild(cell)
  }
}

const sortWorksheetRows = (sheetData: Element) => {
  const rows = Array.from(sheetData.childNodes).filter(
    (node): node is Element => node instanceof Element && node.localName === 'row'
  )
  const orderedRows = rows.sort((left, right) => {
    const leftRow = Number(left.getAttribute('r') || '0')
    const rightRow = Number(right.getAttribute('r') || '0')
    return leftRow - rightRow
  })

  for (const row of orderedRows) {
    sheetData.appendChild(row)
    sortWorksheetRowCells(row)
  }
}

const buildPreviewSheetLookup = (sheets: CanvasFilePreviewSheet[]): SpreadsheetSheetLookup => {
  const lookup: SpreadsheetSheetLookup = new Map()

  for (const sheet of sheets) {
    lookup.set(`id:${sheet.id}`, sheet)
    lookup.set(`name:${sheet.name}`, sheet)
  }

  return lookup
}

const resolvePreviewSheetForDescriptor = (
  descriptor: SpreadsheetSheetDescriptor,
  lookup: SpreadsheetSheetLookup
): CanvasFilePreviewSheet | null =>
  lookup.get(`id:${descriptor.id}`) || lookup.get(`name:${descriptor.name}`) || null

export const cloneCanvasFilePreviewSheets = (
  sheets: CanvasFilePreviewSheet[] | null | undefined
): CanvasFilePreviewSheet[] =>
  (sheets || []).map((sheet) => ({
    ...sheet,
    cells: sheet.cells.map((cell) => ({
      ...cell,
      ...(cell.ocrBboxIds ? { ocrBboxIds: [...cell.ocrBboxIds] } : {})
    }))
  }))

const sortCanvasPreviewSheetCells = (cells: CanvasFilePreviewSheetCell[]) =>
  [...cells].sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row
    return left.col - right.col
  })

const getCanvasPreviewSheetBounds = (sheet: CanvasFilePreviewSheet) => {
  let maxRow = Math.max(sheet.rows, 1)
  let maxCol = Math.max(sheet.cols, 1)

  for (const cell of sheet.cells) {
    maxRow = Math.max(maxRow, cell.row)
    maxCol = Math.max(maxCol, cell.col)
  }

  return {
    rows: Math.max(maxRow, 1),
    cols: Math.max(maxCol, 1)
  }
}

export const updateCanvasPreviewSheetCell = (
  sheet: CanvasFilePreviewSheet,
  row: number,
  col: number,
  text: string
): CanvasFilePreviewSheet => {
  const normalizedText = text.replace(/\r\n/g, '\n')
  const nextCells = sheet.cells
    .filter((cell) => !(cell.row === row && cell.col === col))
    .concat(
      normalizedText
        ? [
            {
              ...(sheet.cells.find((cell) => cell.row === row && cell.col === col) || {}),
              row,
              col,
              text: normalizedText
            }
          ]
        : []
    )

  return {
    ...sheet,
    rows: Math.max(sheet.rows, row, 1),
    cols: Math.max(sheet.cols, col, 1),
    cells: sortCanvasPreviewSheetCells(nextCells)
  }
}

export const insertCanvasPreviewSheetRow = (
  sheet: CanvasFilePreviewSheet,
  anchorRow: number
): CanvasFilePreviewSheet => {
  const { rows } = getCanvasPreviewSheetBounds(sheet)
  const safeAnchorRow = Math.min(Math.max(anchorRow, 1), rows)

  return {
    ...sheet,
    rows: rows + 1,
    cells: sortCanvasPreviewSheetCells(
      sheet.cells.map((cell) => (cell.row > safeAnchorRow ? { ...cell, row: cell.row + 1 } : cell))
    )
  }
}

export const removeCanvasPreviewSheetRow = (
  sheet: CanvasFilePreviewSheet,
  targetRow: number
): CanvasFilePreviewSheet => {
  const { rows } = getCanvasPreviewSheetBounds(sheet)
  const safeTargetRow = Math.min(Math.max(targetRow, 1), rows)

  if (rows <= 1) {
    return {
      ...sheet,
      rows: 1,
      cells: sheet.cells.filter((cell) => cell.row !== safeTargetRow)
    }
  }

  return {
    ...sheet,
    rows: rows - 1,
    cells: sortCanvasPreviewSheetCells(
      sheet.cells
        .filter((cell) => cell.row !== safeTargetRow)
        .map((cell) => (cell.row > safeTargetRow ? { ...cell, row: cell.row - 1 } : cell))
    )
  }
}

export const insertCanvasPreviewSheetColumn = (
  sheet: CanvasFilePreviewSheet,
  anchorCol: number
): CanvasFilePreviewSheet => {
  const { cols } = getCanvasPreviewSheetBounds(sheet)
  const safeAnchorCol = Math.min(Math.max(anchorCol, 1), cols)

  return {
    ...sheet,
    cols: cols + 1,
    cells: sortCanvasPreviewSheetCells(
      sheet.cells.map((cell) => (cell.col > safeAnchorCol ? { ...cell, col: cell.col + 1 } : cell))
    )
  }
}

export const removeCanvasPreviewSheetColumn = (
  sheet: CanvasFilePreviewSheet,
  targetCol: number
): CanvasFilePreviewSheet => {
  const { cols } = getCanvasPreviewSheetBounds(sheet)
  const safeTargetCol = Math.min(Math.max(targetCol, 1), cols)

  if (cols <= 1) {
    return {
      ...sheet,
      cols: 1,
      cells: sheet.cells.filter((cell) => cell.col !== safeTargetCol)
    }
  }

  return {
    ...sheet,
    cols: cols - 1,
    cells: sortCanvasPreviewSheetCells(
      sheet.cells
        .filter((cell) => cell.col !== safeTargetCol)
        .map((cell) => (cell.col > safeTargetCol ? { ...cell, col: cell.col - 1 } : cell))
    )
  }
}

const resolveSpreadsheetRelationshipTargetPath = (target: string): string => {
  const parts = target.replace(/\\/g, '/').split('/').filter(Boolean)

  if (parts.length === 0) {
    return ''
  }

  if (parts[0]?.toLowerCase() === 'xl') {
    return parts.join('/')
  }

  const resolvedParts = ['xl']
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (resolvedParts.length > 1) {
        resolvedParts.pop()
      }
      continue
    }
    resolvedParts.push(part)
  }

  return resolvedParts.join('/')
}

const extractSpreadsheetSharedStrings = async (zip: JSZip): Promise<string[]> => {
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string')
  if (!sharedStringsXml) return []

  const parser = new DOMParser()
  const doc = parser.parseFromString(sharedStringsXml, 'application/xml')
  return Array.from(doc.getElementsByTagNameNS('*', 'si')).map((stringItem) => {
    const value = Array.from(stringItem.getElementsByTagNameNS('*', 't'))
      .map((textNode) => textNode.textContent?.replace(/\s+/g, ' ').trim() || '')
      .filter(Boolean)
      .join(' ')
      .trim()
    return value
  })
}

const resolveSpreadsheetCellText = (cell: Element, sharedStrings: string[]): string => {
  const type = cell.getAttribute('t')?.trim().toLowerCase()
  if (type === 'inlinestr') {
    return Array.from(cell.getElementsByTagNameNS('*', 't'))
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() || '')
      .filter(Boolean)
      .join(' ')
      .trim()
  }

  const value = getFirstTagText(cell, 'v')
  if (!value) return ''

  if (type === 's') {
    const sharedStringIndex = Number(value)
    if (Number.isFinite(sharedStringIndex) && sharedStringIndex >= 0) {
      return sharedStrings[sharedStringIndex] || ''
    }
    return ''
  }

  if (type === 'b') {
    return value === '1' ? 'TRUE' : 'FALSE'
  }

  return value
}

const extractSpreadsheetSheetDescriptors = async (
  zip: JSZip
): Promise<SpreadsheetSheetDescriptor[]> => {
  const fallbackWorksheetPaths = getSortedWorksheetPaths(zip)
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')

  if (!workbookXml) {
    return fallbackWorksheetPaths.map((path, index) => ({
      id: `sheet-${index + 1}`,
      name: `Sheet ${index + 1}`,
      path
    }))
  }

  const relationshipPathById = new Map<string, string>()
  const workbookRelationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (workbookRelationshipsXml) {
    const relationshipsDoc = new DOMParser().parseFromString(
      workbookRelationshipsXml,
      'application/xml'
    )

    for (const relationship of Array.from(
      relationshipsDoc.getElementsByTagNameNS('*', 'Relationship')
    )) {
      const relationshipType = relationship.getAttribute('Type')?.trim()
      const relationshipId = relationship.getAttribute('Id')?.trim()
      const target = relationship.getAttribute('Target')?.trim()

      if (relationshipType !== WORKSHEET_RELATIONSHIP_TYPE || !relationshipId || !target) {
        continue
      }

      const normalizedPath = resolveSpreadsheetRelationshipTargetPath(target)
      if (normalizedPath) {
        relationshipPathById.set(relationshipId, normalizedPath)
      }
    }
  }

  const workbookDoc = new DOMParser().parseFromString(workbookXml, 'application/xml')
  const descriptors: SpreadsheetSheetDescriptor[] = []
  const usedPaths = new Set<string>()

  for (const [index, sheet] of Array.from(
    workbookDoc.getElementsByTagNameNS('*', 'sheet')
  ).entries()) {
    const relationshipId =
      sheet.getAttribute('r:id')?.trim() ||
      sheet
        .getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
        ?.trim() ||
      ''

    const matchedRelationshipPath = relationshipPathById.get(relationshipId)
    const matchedFallbackPath =
      fallbackWorksheetPaths[index] ||
      fallbackWorksheetPaths.find((path) => !usedPaths.has(path)) ||
      ''
    const path =
      matchedRelationshipPath && zip.file(matchedRelationshipPath)
        ? matchedRelationshipPath
        : matchedFallbackPath

    if (!path) {
      continue
    }

    usedPaths.add(path)
    descriptors.push({
      id: sheet.getAttribute('sheetId')?.trim() || `sheet-${index + 1}`,
      name: sheet.getAttribute('name')?.trim() || `Sheet ${index + 1}`,
      path
    })
  }

  if (descriptors.length > 0) {
    return descriptors
  }

  return fallbackWorksheetPaths.map((path, index) => ({
    id: `sheet-${index + 1}`,
    name: `Sheet ${index + 1}`,
    path
  }))
}

const extractSpreadsheetSheetPreview = (
  sheetXml: string,
  descriptor: SpreadsheetSheetDescriptor,
  sharedStrings: string[]
): CanvasFilePreviewSheet => {
  const parser = new DOMParser()
  const doc = parser.parseFromString(sheetXml, 'application/xml')
  const rows = Array.from(doc.getElementsByTagNameNS('*', 'row'))
  const dimensionReference =
    doc.getElementsByTagNameNS('*', 'dimension')[0]?.getAttribute('ref')?.trim() || ''
  const dimension = parseSpreadsheetDimensionReference(dimensionReference)
  const cells: CanvasFilePreviewSheetCell[] = []
  let maxRow = Math.max(dimension?.end.row || 0, dimension?.start.row || 0)
  let maxCol = Math.max(dimension?.end.col || 0, dimension?.start.col || 0)
  let fallbackRow = 1

  for (const row of rows) {
    const explicitRow = Number(row.getAttribute('r') || '')
    const rowNumber = Number.isFinite(explicitRow) && explicitRow > 0 ? explicitRow : fallbackRow
    let fallbackCol = 1

    for (const cell of Array.from(row.getElementsByTagNameNS('*', 'c'))) {
      const parsedReference = parseSpreadsheetCellReference(cell.getAttribute('r') || '')
      const resolvedRow = parsedReference?.row ?? rowNumber
      const resolvedCol = parsedReference?.col ?? fallbackCol
      fallbackCol = resolvedCol + 1
      maxRow = Math.max(maxRow, resolvedRow)
      maxCol = Math.max(maxCol, resolvedCol)

      const text = resolveSpreadsheetCellText(cell, sharedStrings)
      if (!text) continue

      cells.push({
        row: resolvedRow,
        col: resolvedCol,
        text
      })
    }

    fallbackRow = rowNumber + 1
  }

  return {
    id: descriptor.id,
    name: descriptor.name,
    rows: maxRow,
    cols: maxCol,
    cells
  }
}

const buildSpreadsheetSheetPreviewText = (sheet: CanvasFilePreviewSheet): string | null => {
  if (sheet.cells.length === 0) {
    return null
  }

  const cellMapByRow = new Map<number, Map<number, string>>()
  for (const cell of sheet.cells) {
    const existingRow = cellMapByRow.get(cell.row) ?? new Map<number, string>()
    existingRow.set(cell.col, cell.text)
    cellMapByRow.set(cell.row, existingRow)
  }

  const rowTexts = Array.from(cellMapByRow.entries())
    .sort(([leftRow], [rightRow]) => leftRow - rightRow)
    .map(([, rowCells]) => {
      const maxCol = Math.max(...Array.from(rowCells.keys()))
      const values = Array.from({ length: maxCol }, (_, index) => rowCells.get(index + 1) || '')

      while (values.length > 0 && values[values.length - 1] === '') {
        values.pop()
      }

      return values.join(' | ')
    })
    .filter(Boolean)

  return rowTexts.length > 0 ? rowTexts.join('\n').trim() : null
}

export const buildSpreadsheetWorkbookPreviewText = (
  sheets: CanvasFilePreviewSheet[]
): string | null => {
  const worksheetTexts = sheets
    .map((sheet) => {
      const sheetText = buildSpreadsheetSheetPreviewText(sheet)
      return sheetText ? `[${sheet.name}]\n${sheetText}` : null
    })
    .filter((sheetText): sheetText is string => Boolean(sheetText))

  return worksheetTexts.length > 0 ? worksheetTexts.join('\n\n') : null
}

const buildSpreadsheetCellDraftMap = (
  sheet: CanvasFilePreviewSheet | null
): Map<string, string> => {
  const draftMap = new Map<string, string>()

  for (const cell of sheet?.cells || []) {
    draftMap.set(buildSpreadsheetCellReference(cell.row, cell.col), cell.text)
  }

  return draftMap
}

const buildSpreadsheetCellElement = (
  doc: XMLDocument,
  reference: string,
  text: string,
  existingCell: Element | null
): Element => {
  const namespaceUri = doc.documentElement?.namespaceURI || null
  const cell = doc.createElementNS(namespaceUri, 'c')
  copyElementAttributes(existingCell, cell, new Set(['r', 't']))
  cell.setAttribute('r', reference)

  const normalizedText = text.replace(/\r\n/g, '\n')
  if (isSpreadsheetBooleanText(normalizedText)) {
    cell.setAttribute('t', 'b')
    const value = doc.createElementNS(namespaceUri, 'v')
    value.textContent = /^true$/i.test(normalizedText.trim()) ? '1' : '0'
    cell.appendChild(value)
    return cell
  }

  if (isSpreadsheetNumericText(normalizedText)) {
    const value = doc.createElementNS(namespaceUri, 'v')
    value.textContent = normalizedText.trim()
    cell.appendChild(value)
    return cell
  }

  cell.setAttribute('t', 'inlineStr')
  const inlineString = doc.createElementNS(namespaceUri, 'is')
  const textNode = doc.createElementNS(namespaceUri, 't')
  if (/^\s|\s$/.test(normalizedText) || /\n/.test(normalizedText)) {
    textNode.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  }
  textNode.textContent = normalizedText
  inlineString.appendChild(textNode)
  cell.appendChild(inlineString)
  return cell
}

const removeEmptyWorksheetRows = (sheetData: Element) => {
  for (const row of Array.from(sheetData.childNodes)) {
    if (row.nodeType !== Node.ELEMENT_NODE || (row as Element).localName !== 'row') {
      continue
    }

    const hasCells = Array.from(row.childNodes).some(
      (cellNode) =>
        cellNode.nodeType === Node.ELEMENT_NODE && (cellNode as Element).localName === 'c'
    )
    if (!hasCells) {
      sheetData.removeChild(row)
    }
  }
}

const resolveWorksheetDimension = (
  worksheet: Element,
  fallbackSheet: CanvasFilePreviewSheet | null
): { rows: number; cols: number } => {
  let maxRow = Math.max(fallbackSheet?.rows || 0, 1)
  let maxCol = Math.max(fallbackSheet?.cols || 0, 1)

  for (const cell of Array.from(worksheet.getElementsByTagNameNS('*', 'c'))) {
    const position = parseSpreadsheetCellReference(cell.getAttribute('r') || '')
    if (!position) {
      continue
    }

    maxRow = Math.max(maxRow, position.row)
    maxCol = Math.max(maxCol, position.col)
  }

  return {
    rows: Math.max(maxRow, 1),
    cols: Math.max(maxCol, 1)
  }
}

const updateSpreadsheetWorksheetXml = (
  worksheetXml: string,
  originalSheet: CanvasFilePreviewSheet | null,
  nextSheet: CanvasFilePreviewSheet | null
): string => {
  const doc = new DOMParser().parseFromString(worksheetXml, 'application/xml')
  const worksheet = doc.getElementsByTagNameNS('*', 'worksheet')[0]
  if (!worksheet) {
    return worksheetXml
  }

  const sheetData = ensureWorksheetChild(doc, worksheet, 'sheetData')
  const rowByNumber = new Map<number, Element>()
  const cellByReference = new Map<string, Element>()

  for (const row of Array.from(sheetData.childNodes)) {
    if (row.nodeType !== Node.ELEMENT_NODE || (row as Element).localName !== 'row') {
      continue
    }

    const rowElement = row as Element
    const rowNumber = Number(rowElement.getAttribute('r') || '')
    if (Number.isFinite(rowNumber) && rowNumber > 0) {
      rowByNumber.set(rowNumber, rowElement)
    }

    for (const cell of Array.from(rowElement.childNodes)) {
      if (cell.nodeType !== Node.ELEMENT_NODE || (cell as Element).localName !== 'c') {
        continue
      }

      const cellElement = cell as Element
      const reference = cellElement.getAttribute('r')?.trim()
      if (reference) {
        cellByReference.set(reference, cellElement)
      }
    }
  }

  const originalDraftMap = buildSpreadsheetCellDraftMap(originalSheet)
  const nextDraftMap = buildSpreadsheetCellDraftMap(nextSheet)
  const touchedReferences = new Set<string>([
    ...Array.from(originalDraftMap.keys()),
    ...Array.from(nextDraftMap.keys())
  ])

  for (const reference of touchedReferences) {
    const originalText = originalDraftMap.get(reference) ?? ''
    const nextText = nextDraftMap.get(reference) ?? ''
    if (originalText === nextText) {
      continue
    }

    const position = parseSpreadsheetCellReference(reference)
    if (!position) {
      continue
    }

    const existingCell = cellByReference.get(reference) || null
    if (!nextText) {
      if (existingCell?.parentNode) {
        existingCell.parentNode.removeChild(existingCell)
        cellByReference.delete(reference)
      }
      continue
    }

    let rowElement = rowByNumber.get(position.row) || null
    if (!rowElement) {
      rowElement = doc.createElementNS(getWorksheetNamespaceUri(worksheet), 'row')
      rowElement.setAttribute('r', position.row.toString())
      sheetData.appendChild(rowElement)
      rowByNumber.set(position.row, rowElement)
    }

    const nextCell = buildSpreadsheetCellElement(doc, reference, nextText, existingCell)
    if (existingCell && existingCell.parentNode === rowElement) {
      rowElement.replaceChild(nextCell, existingCell)
    } else {
      rowElement.appendChild(nextCell)
    }
    cellByReference.set(reference, nextCell)
    sortWorksheetRowCells(rowElement)
  }

  removeEmptyWorksheetRows(sheetData)
  sortWorksheetRows(sheetData)

  const dimension = resolveWorksheetDimension(worksheet, nextSheet || originalSheet)
  const dimensionElement = ensureWorksheetChild(doc, worksheet, 'dimension')
  dimensionElement.setAttribute(
    'ref',
    buildSpreadsheetDimensionReference(dimension.rows, dimension.cols)
  )

  return new XMLSerializer().serializeToString(doc)
}

export const saveSpreadsheetPreviewSheetsToFile = async (
  file: File,
  originalSheets: CanvasFilePreviewSheet[],
  nextSheets: CanvasFilePreviewSheet[]
): Promise<File> => {
  let zip: JSZip
  try {
    zip = await loadOfficePreviewZip(file)
  } catch (error) {
    if (error instanceof OfficePreviewLimitExceededError) {
      return file
    }
    throw error
  }
  const extension = getFileExtension(file.name)
  if (extension !== '.xlsx') {
    return file
  }

  const sheetDescriptors = await extractSpreadsheetSheetDescriptors(zip)
  const originalLookup = buildPreviewSheetLookup(originalSheets)
  const nextLookup = buildPreviewSheetLookup(nextSheets)

  for (const descriptor of sheetDescriptors) {
    const worksheetFile = zip.file(descriptor.path)
    if (!worksheetFile) {
      continue
    }

    const worksheetXml = await worksheetFile.async('string')
    const nextWorksheetXml = updateSpreadsheetWorksheetXml(
      worksheetXml,
      resolvePreviewSheetForDescriptor(descriptor, originalLookup),
      resolvePreviewSheetForDescriptor(descriptor, nextLookup)
    )
    zip.file(descriptor.path, nextWorksheetXml)
  }

  const nextBlob = await zip.generateAsync({ type: 'blob' })
  return new File([nextBlob], file.name, {
    type: normalizeFileMimeType(file.name, file.type || SPREADSHEET_XML_MEDIA_TYPE)
  })
}

const isReadableLegacyUnicodeCodeUnit = (value: number): boolean => {
  if (value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20 || value === 0x3000) {
    return true
  }

  if (value >= 0x21 && value <= 0x7e) return true
  if (value >= 0x2010 && value <= 0x203b) return true
  if (value >= 0x3001 && value <= 0x303f) return true
  if (value >= 0x3040 && value <= 0x30ff) return true
  if (value >= 0x3400 && value <= 0x4dbf) return true
  if (value >= 0x4e00 && value <= 0x9fff) return true
  if (value >= 0xac00 && value <= 0xd7af) return true
  if (value >= 0xff01 && value <= 0xffee) return true

  return false
}

const isReadableLegacyAsciiByte = (value: number): boolean => {
  if (value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20) return true
  return value >= 0x21 && value <= 0x7e
}

const normalizeLegacyCandidate = (value: string): string => {
  const normalized = value
    .split(String.fromCharCode(0))
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return normalized
}

const hasLegacyOfficeCompoundFileHeader = (bytes: Uint8Array): boolean =>
  LEGACY_OFFICE_COMPOUND_FILE_HEADER.every((value, index) => bytes[index] === value)

const isMeaningfulLegacyCandidate = (value: string): boolean => {
  const compact = value.replace(/\s+/g, '')
  const hasCjkContent = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(compact)
  if (compact.length < (hasCjkContent ? 4 : MIN_LEGACY_CANDIDATE_LENGTH)) {
    return false
  }

  if (LEGACY_BINARY_IGNORE_PATTERNS.some((pattern) => pattern.test(compact))) {
    return false
  }

  const contentCharMatches =
    compact.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []
  if (contentCharMatches.length < Math.max(4, Math.floor(compact.length * 0.55))) {
    return false
  }

  if (hasCjkContent) {
    return true
  }

  return /\S+\s+\S+/.test(value) || compact.length >= 16
}

const collectLegacyUtf16Candidates = (bytes: Uint8Array, offset: 0 | 1): string[] => {
  const candidates: string[] = []
  let current = ''

  const flush = () => {
    const normalized = normalizeLegacyCandidate(current)
    if (normalized && isMeaningfulLegacyCandidate(normalized)) {
      candidates.push(normalized)
    }
    current = ''
  }

  for (let index = offset; index + 1 < bytes.length; index += 2) {
    const codeUnit = bytes[index] | (bytes[index + 1] << 8)
    if (!isReadableLegacyUnicodeCodeUnit(codeUnit)) {
      flush()
      continue
    }

    if (codeUnit === 0x0a || codeUnit === 0x0d) {
      current += '\n'
      continue
    }

    if (codeUnit === 0x09) {
      current += ' '
      continue
    }

    current += String.fromCharCode(codeUnit)
  }

  flush()
  return candidates
}

const collectLegacyAsciiCandidates = (bytes: Uint8Array): string[] => {
  const candidates: string[] = []
  let current = ''

  const flush = () => {
    const normalized = normalizeLegacyCandidate(current)
    if (normalized && isMeaningfulLegacyCandidate(normalized)) {
      candidates.push(normalized)
    }
    current = ''
  }

  for (const value of bytes) {
    if (!isReadableLegacyAsciiByte(value)) {
      flush()
      continue
    }

    if (value === 0x0a || value === 0x0d) {
      current += '\n'
      continue
    }

    if (value === 0x09) {
      current += ' '
      continue
    }

    current += String.fromCharCode(value)
  }

  flush()
  return candidates
}

const extractLegacyBinaryPreviewText = (bytes: Uint8Array): string | null => {
  const lines: string[] = []
  const seen = new Set<string>()
  const utf16PrimaryCandidates = collectLegacyUtf16Candidates(bytes, 0)
  const utf16FallbackCandidates =
    utf16PrimaryCandidates.length === 0 ? collectLegacyUtf16Candidates(bytes, 1) : []
  const candidates = [
    ...utf16PrimaryCandidates,
    ...utf16FallbackCandidates,
    ...collectLegacyAsciiCandidates(bytes)
  ]

  for (const candidate of candidates) {
    for (const line of candidate.split('\n')) {
      const normalizedLine = line.trim()
      if (!normalizedLine || seen.has(normalizedLine)) {
        continue
      }

      if (!isMeaningfulLegacyCandidate(normalizedLine)) {
        continue
      }

      seen.add(normalizedLine)
      lines.push(normalizedLine)
    }
  }

  if (lines.length === 0) {
    return null
  }

  const previewLines: string[] = []
  let totalLength = 0

  for (const line of lines) {
    const nextLength = totalLength + line.length + (previewLines.length > 0 ? 1 : 0)
    if (nextLength > MAX_LEGACY_PREVIEW_CHARS) {
      break
    }

    previewLines.push(line)
    totalLength = nextLength
  }

  return previewLines.length > 0 ? previewLines.join('\n') : null
}

export type OfficeFileNodeData = {
  mimeType: string
  fileKind: ReturnType<typeof detectCanvasFileKind>
  editable: boolean
  previewText: string | null
  previewImages: CanvasFilePreviewImage[]
  previewSheets: CanvasFilePreviewSheet[]
  content: string | null
}

const extractOfficePreviewData = async (
  file: File
): Promise<{
  previewText: string | null
  previewImages: CanvasFilePreviewImage[]
  previewSheets: CanvasFilePreviewSheet[]
}> => {
  const extension = getFileExtension(file.name)
  if (extension === '.txt' || extension === '.md' || extension === '.csv') {
    return {
      previewText: normalizePlainTextPreview(await readFileAsText(file)),
      previewImages: [],
      previewSheets: []
    }
  }

  if (extension === '.doc' || extension === '.xls' || extension === '.ppt') {
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file))
    if (!hasLegacyOfficeCompoundFileHeader(bytes)) {
      return {
        previewText: null,
        previewImages: [],
        previewSheets: []
      }
    }
    return {
      previewText: extractLegacyBinaryPreviewText(bytes),
      previewImages: [],
      previewSheets: []
    }
  }

  if (!isOfficePreviewableFile(file.name)) {
    return {
      previewText: null,
      previewImages: [],
      previewSheets: []
    }
  }

  let zip: JSZip
  try {
    zip = await loadOfficePreviewZip(file)
  } catch (error) {
    if (error instanceof OfficePreviewLimitExceededError) {
      return emptyOfficePreviewData()
    }
    throw error
  }
  const previewImages = await extractOfficePreviewImages(zip, extension)

  if (extension === '.docx') {
    const documentXml = await zip.file('word/document.xml')?.async('string')
    if (!documentXml) {
      return {
        previewText: null,
        previewImages,
        previewSheets: []
      }
    }

    const previewText = extractXmlText(documentXml)
    return {
      previewText: previewText || null,
      previewImages,
      previewSheets: []
    }
  }

  if (extension === '.xlsx') {
    const sheetDescriptors = await extractSpreadsheetSheetDescriptors(zip)
    if (sheetDescriptors.length === 0) {
      return {
        previewText: null,
        previewImages,
        previewSheets: []
      }
    }

    const sharedStrings = await extractSpreadsheetSharedStrings(zip)
    const previewSheets: CanvasFilePreviewSheet[] = []

    for (const descriptor of sheetDescriptors) {
      const worksheetXml = await zip.file(descriptor.path)?.async('string')
      if (!worksheetXml) continue

      previewSheets.push(extractSpreadsheetSheetPreview(worksheetXml, descriptor, sharedStrings))
    }

    return {
      previewText: buildSpreadsheetWorkbookPreviewText(previewSheets),
      previewImages,
      previewSheets
    }
  }

  const slidePaths = getSortedSlidePaths(zip)
  if (slidePaths.length === 0) {
    return {
      previewText: null,
      previewImages,
      previewSheets: []
    }
  }

  const slideTexts: string[] = []

  for (const [index, slidePath] of slidePaths.entries()) {
    const slideXml = await zip.file(slidePath)?.async('string')
    if (!slideXml) continue

    const slideText = extractXmlText(slideXml)
    if (slideText) {
      slideTexts.push(`[Slide ${index + 1}] ${slideText}`)
    }
  }

  return {
    previewText: slideTexts.length > 0 ? slideTexts.join('\n\n') : null,
    previewImages,
    previewSheets: []
  }
}

export const extractOfficePreviewText = async (file: File): Promise<string | null> => {
  const { previewText } = await extractOfficePreviewData(file)
  return previewText
}

export const resolveOfficeFileNodeData = async (file: File): Promise<OfficeFileNodeData> => {
  const { previewText, previewImages, previewSheets } = await extractOfficePreviewData(file)
  const editable = isEditableCanvasFile(file.name)

  return {
    mimeType: normalizeFileMimeType(file.name, file.type),
    fileKind: detectCanvasFileKind(file.name),
    editable,
    previewText,
    previewImages,
    previewSheets,
    content: editable ? previewText : null
  }
}
