import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'

import {
  extractOfficePreviewText,
  insertCanvasPreviewSheetColumn,
  insertCanvasPreviewSheetRow,
  removeCanvasPreviewSheetColumn,
  removeCanvasPreviewSheetRow,
  resolveOfficeFileNodeData,
  saveSpreadsheetPreviewSheetsToFile,
  updateCanvasPreviewSheetCell
} from './officePreviewUtils'

const toBlobBytes = (payload: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(payload.byteLength)
  bytes.set(payload)
  return bytes
}

const encodeUtf16Le = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index)
    bytes[index * 2] = codeUnit & 0xff
    bytes[index * 2 + 1] = codeUnit >> 8
  }
  return bytes
}

const concatBytes = (...chunks: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }

  return result
}

const originalCreateObjectUrl = URL.createObjectURL

beforeEach(() => {
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:mock-office-${blob.size}`)
})

afterEach(() => {
  URL.createObjectURL = originalCreateObjectUrl
  vi.restoreAllMocks()
})

describe('extractOfficePreviewText', () => {
  it('extracts plain text previews from txt and md files', async () => {
    const txtFile = new File(['Line 1\r\nLine 2'], 'notes.txt', { type: 'text/plain' })
    const mdFile = new File(['  # Title  '], 'readme.md', { type: 'text/markdown' })
    const csvFile = new File(['Name,Score\r\nAlice,90'], 'table.csv', { type: 'text/csv' })

    await expect(extractOfficePreviewText(txtFile)).resolves.toBe('Line 1\nLine 2')
    await expect(extractOfficePreviewText(mdFile)).resolves.toBe('# Title')
    await expect(extractOfficePreviewText(csvFile)).resolves.toBe('Name,Score\nAlice,90')
  })

  it('extracts readable text from docx files', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Alpha</w:t></w:r></w:p>
          <w:p><w:r><w:t>Beta</w:t></w:r></w:p>
        </w:body>
      </w:document>`
    )

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const file = new File([toBlobBytes(payload)], 'notes.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    await expect(extractOfficePreviewText(file)).resolves.toBe('Alpha Beta')
    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileKind: 'word',
      editable: false,
      previewText: 'Alpha Beta',
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })

  it('extracts embedded preview images from docx files', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Alpha</w:t></w:r></w:p>
        </w:body>
      </w:document>`
    )
    zip.file('word/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    zip.file('word/media/image2.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const file = new File([toBlobBytes(payload)], 'notes.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    const resolved = await resolveOfficeFileNodeData(file)

    expect(resolved.previewText).toBe('Alpha')
    expect(resolved.previewImages).toHaveLength(2)
    expect(resolved.previewImages[0]).toEqual(
      expect.objectContaining({
        mimeType: 'image/png',
        fileName: 'image1.png'
      })
    )
    expect(resolved.previewImages[0]?.src).toMatch(/^blob:mock-office-/)
    expect(resolved.previewImages[0]?.src).not.toContain('data:image')
    expect(resolved.previewImages[1]).toEqual(
      expect.objectContaining({
        mimeType: 'image/jpeg',
        fileName: 'image2.jpg',
        src: expect.stringMatching(/^blob:mock-office-/)
      })
    )
  })

  it('extracts readable text from legacy doc files when binary text runs exist', async () => {
    const file = new File(
      [
        concatBytes(
          new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1, 2, 3]),
          encodeUtf16Le('Legacy brief'),
          new Uint8Array([0xff, 0x00, 0x10, 0x27]),
          encodeUtf16Le('Character setup'),
          new Uint8Array([5, 6, 7, 8])
        )
      ],
      'brief.doc',
      {
        type: 'application/msword'
      }
    )

    await expect(extractOfficePreviewText(file)).resolves.toBe('Legacy brief\nCharacter setup')
    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/msword',
      fileKind: 'word',
      editable: false,
      previewText: 'Legacy brief\nCharacter setup',
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })

  it('extracts readable text from xlsx worksheet xml files', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
        <si><t>Name</t></si>
        <si><t>Score</t></si>
        <si><t>Alice</t></si>
        <si><t>Bob</t></si>
      </sst>`
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
          </row>
          <row r="2">
            <c r="A2" t="s"><v>2</v></c>
            <c r="B2"><v>90</v></c>
          </row>
          <row r="3">
            <c r="A3" t="s"><v>3</v></c>
            <c r="B3"><v>85</v></c>
          </row>
        </sheetData>
      </worksheet>`
    )

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const file = new File([toBlobBytes(payload)], 'scores.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })

    await expect(extractOfficePreviewText(file)).resolves.toBe(
      '[Sheet 1]\nName | Score\nAlice | 90\nBob | 85'
    )
    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileKind: 'excel',
      editable: false,
      previewText: '[Sheet 1]\nName | Score\nAlice | 90\nBob | 85',
      previewImages: [],
      previewSheets: [
        {
          id: 'sheet-1',
          name: 'Sheet 1',
          rows: 3,
          cols: 2,
          cells: [
            { row: 1, col: 1, text: 'Name' },
            { row: 1, col: 2, text: 'Score' },
            { row: 2, col: 1, text: 'Alice' },
            { row: 2, col: 2, text: '90' },
            { row: 3, col: 1, text: 'Bob' },
            { row: 3, col: 2, text: '85' }
          ]
        }
      ],
      content: null
    })
  })

  it('keeps workbook sheet structure for blank xlsx files', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="工作表1" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship
          Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
          Target="worksheets/sheet1.xml"
        />
      </Relationships>`
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <dimension ref="A1" />
        <sheetData />
      </worksheet>`
    )

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const file = new File([toBlobBytes(payload)], 'blank.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })

    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileKind: 'excel',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [
        {
          id: '1',
          name: '工作表1',
          rows: 1,
          cols: 1,
          cells: []
        }
      ],
      content: null
    })
  })

  it('saves edited xlsx worksheet cells back into the workbook', async () => {
    const zip = new JSZip()
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Sheet 1" sheetId="1" r:id="rId1" />
        </sheets>
      </workbook>`
    )
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship
          Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
          Target="worksheets/sheet1.xml"
        />
      </Relationships>`
    )
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <dimension ref="A1" />
        <sheetData />
      </worksheet>`
    )

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const file = new File([toBlobBytes(payload)], 'editable.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    const original = await resolveOfficeFileNodeData(file)
    const editedFile = await saveSpreadsheetPreviewSheetsToFile(file, original.previewSheets, [
      {
        id: '1',
        name: 'Sheet 1',
        rows: 2,
        cols: 2,
        cells: [
          { row: 1, col: 1, text: 'Name' },
          { row: 1, col: 2, text: 'Score' },
          { row: 2, col: 1, text: 'Alice' },
          { row: 2, col: 2, text: '95' }
        ]
      }
    ])

    await expect(resolveOfficeFileNodeData(editedFile)).resolves.toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileKind: 'excel',
      editable: false,
      previewText: '[Sheet 1]\nName | Score\nAlice | 95',
      previewImages: [],
      previewSheets: [
        {
          id: '1',
          name: 'Sheet 1',
          rows: 2,
          cols: 2,
          cells: [
            { row: 1, col: 1, text: 'Name' },
            { row: 1, col: 2, text: 'Score' },
            { row: 2, col: 1, text: 'Alice' },
            { row: 2, col: 2, text: '95' }
          ]
        }
      ],
      content: null
    })
  })

  it('extracts readable text from pptx slide xml files', async () => {
    const zip = new JSZip()
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Intro</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`
    )
    zip.file(
      'ppt/slides/slide2.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Summary</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`
    )

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const file = new File([toBlobBytes(payload)], 'slides.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })

    await expect(extractOfficePreviewText(file)).resolves.toBe(
      '[Slide 1] Intro\n\n[Slide 2] Summary'
    )
    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileKind: 'powerpoint',
      editable: false,
      previewText: '[Slide 1] Intro\n\n[Slide 2] Summary',
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })

  it('safely skips OOXML previews when archive size exceeds the preview limit', async () => {
    const file = new File(['small'], 'large.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
    Object.defineProperty(file, 'size', { value: 129 * 1024 * 1024 })

    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileKind: 'word',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })

  it('safely skips OOXML previews when archive entry count exceeds the preview limit', async () => {
    const files: Record<string, unknown> = {}
    for (let index = 0; index < 4097; index += 1) {
      files[`word/media/image-${index}.png`] = { dir: false }
    }
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValue({ files } as JSZip)

    const file = new File(['zip'], 'many.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    await expect(resolveOfficeFileNodeData(file)).resolves.toMatchObject({
      previewText: null,
      previewImages: [],
      previewSheets: []
    })
  })

  it('safely skips OOXML previews when declared uncompressed size exceeds the preview limit', async () => {
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValue({
      files: {
        'word/document.xml': {
          dir: false,
          _data: { uncompressedSize: 257 * 1024 * 1024 }
        }
      }
    } as unknown as JSZip)

    const file = new File(['zip'], 'expanded.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    await expect(resolveOfficeFileNodeData(file)).resolves.toMatchObject({
      previewText: null,
      previewImages: [],
      previewSheets: []
    })
  })

  it('returns null text for legacy office formats without readable runs', async () => {
    const pptFile = new File(['legacy-binary'], 'slides.ppt', {
      type: 'application/vnd.ms-powerpoint'
    })
    const xlsFile = new File(['legacy-binary'], 'sheet.xls', {
      type: 'application/vnd.ms-excel'
    })

    await expect(extractOfficePreviewText(pptFile)).resolves.toBeNull()
    await expect(extractOfficePreviewText(xlsFile)).resolves.toBeNull()
  })

  it('builds canonical file node metadata for editable and read-only office files', async () => {
    const txtFile = new File(['Draft line'], 'notes.txt', { type: 'text/plain' })
    const legacyDocFile = new File(['legacy-binary'], 'brief.doc', {
      type: 'application/msword'
    })
    const legacyExcelFile = new File(['legacy-binary'], 'sheet.xls', {
      type: 'application/vnd.ms-excel'
    })

    await expect(resolveOfficeFileNodeData(txtFile)).resolves.toEqual({
      mimeType: 'text/plain',
      fileKind: 'text',
      editable: true,
      previewText: 'Draft line',
      previewImages: [],
      previewSheets: [],
      content: 'Draft line'
    })

    await expect(resolveOfficeFileNodeData(legacyDocFile)).resolves.toEqual({
      mimeType: 'application/msword',
      fileKind: 'word',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [],
      content: null
    })

    await expect(resolveOfficeFileNodeData(legacyExcelFile)).resolves.toEqual({
      mimeType: 'application/vnd.ms-excel',
      fileKind: 'excel',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })
})

describe('spreadsheet preview sheet helpers', () => {
  it('updates cells and shifts rows/columns when editing the preview sheet grid', () => {
    const baseSheet = {
      id: 'sheet-1',
      name: 'Scores',
      rows: 2,
      cols: 2,
      cells: [
        { row: 1, col: 1, text: 'Name' },
        { row: 1, col: 2, text: 'Score' },
        { row: 2, col: 1, text: 'Alice' },
        { row: 2, col: 2, text: '90' }
      ]
    }

    expect(updateCanvasPreviewSheetCell(baseSheet, 3, 2, '95')).toEqual({
      id: 'sheet-1',
      name: 'Scores',
      rows: 3,
      cols: 2,
      cells: [
        { row: 1, col: 1, text: 'Name' },
        { row: 1, col: 2, text: 'Score' },
        { row: 2, col: 1, text: 'Alice' },
        { row: 2, col: 2, text: '90' },
        { row: 3, col: 2, text: '95' }
      ]
    })

    expect(insertCanvasPreviewSheetRow(baseSheet, 1)).toEqual({
      id: 'sheet-1',
      name: 'Scores',
      rows: 3,
      cols: 2,
      cells: [
        { row: 1, col: 1, text: 'Name' },
        { row: 1, col: 2, text: 'Score' },
        { row: 3, col: 1, text: 'Alice' },
        { row: 3, col: 2, text: '90' }
      ]
    })

    expect(removeCanvasPreviewSheetRow(baseSheet, 1)).toEqual({
      id: 'sheet-1',
      name: 'Scores',
      rows: 1,
      cols: 2,
      cells: [
        { row: 1, col: 1, text: 'Alice' },
        { row: 1, col: 2, text: '90' }
      ]
    })

    expect(insertCanvasPreviewSheetColumn(baseSheet, 1)).toEqual({
      id: 'sheet-1',
      name: 'Scores',
      rows: 2,
      cols: 3,
      cells: [
        { row: 1, col: 1, text: 'Name' },
        { row: 1, col: 3, text: 'Score' },
        { row: 2, col: 1, text: 'Alice' },
        { row: 2, col: 3, text: '90' }
      ]
    })

    expect(removeCanvasPreviewSheetColumn(baseSheet, 1)).toEqual({
      id: 'sheet-1',
      name: 'Scores',
      rows: 2,
      cols: 1,
      cells: [
        { row: 1, col: 1, text: 'Score' },
        { row: 2, col: 1, text: '90' }
      ]
    })
  })
})
