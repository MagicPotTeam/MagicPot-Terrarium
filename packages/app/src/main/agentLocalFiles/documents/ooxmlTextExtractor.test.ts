import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { extractOoxmlText, type OfficeTextFormat } from './ooxmlTextExtractor'
import { checkDocumentTextResult, DOCUMENT_TEXT_LIMITS } from './documentSchema'
import { ZipXmlReader } from './zipXmlReader'
import { makeZip } from './__fixtures__/documentFixtures'

const JOB_ID = '0123456789abcdef0123456789abcdef'
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OPC = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const MAIN = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml'
}
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  shared: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
}
type Part = { name: string; data: string }
type Replacements = Record<string, string | undefined>

function relationships(content: string): string {
  return `<Relationships xmlns="${OPC}">${content}</Relationships>`
}

function relation(id: string, type: string, target: string, mode = ''): string {
  return `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`
}

function contentTypes(format: OfficeTextFormat, overrides = '', mainMime = MIME[format]): string {
  return `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${MAIN[format]}" ContentType="${mainMime}"/>${overrides}</Types>`
}

// Owned, minimal Transitional OOXML parts: official MIME/namespace/relationship identities.
// These fixtures exercise this bytes-only subset, not Office application interoperability.
function officeZip(
  format: OfficeTextFormat,
  content: string,
  extra: readonly Part[] = [],
  replacements: Replacements = {}
): Uint8Array {
  const overrides = extra.flatMap(({ name }) => {
    const mime =
      name.startsWith('xl/worksheets/') && name.endsWith('.xml')
        ? MIME.sheet
        : name === 'xl/sharedStrings.xml'
          ? MIME.shared
          : name.startsWith('ppt/slides/') && name.endsWith('.xml')
            ? MIME.slide
            : undefined
    return mime ? [`<Override PartName="/${name}" ContentType="${mime}"/>`] : []
  })
  const rootRels = relationships(relation('rId1', 'officeDocument', MAIN[format]))
  const parts = new Map([
    ['[Content_Types].xml', contentTypes(format, overrides.join(''))],
    ['_rels/.rels', rootRels],
    [MAIN[format], content],
    ...extra.map(({ name, data }) => [name, data] as const)
  ])
  for (const [name, data] of Object.entries(replacements)) {
    if (data === undefined) parts.delete(name)
    else parts.set(name, data)
  }
  return makeZip(
    [...parts].map(([name, data]) => ({ name, data, compression: 'deflate' as const }))
  )
}

function documentXml(text = 'text'): string {
  return `<w:document xmlns:w="${WORD}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
}

function workbook(ids = ['rId1']): string {
  return `<workbook xmlns="${SHEET}" xmlns:r="${REL}"><sheets>${ids.map((id, i) => `<sheet name="Sheet${i + 1}" sheetId="${i + 1}" r:id="${id}"/>`).join('')}</sheets></workbook>`
}

function worksheet(
  cells = '<c r="A1" t="inlineStr"><is><t>sheet text</t></is></c>',
  row = 1
): string {
  return `<worksheet xmlns="${SHEET}"><sheetData><row r="${row}">${cells}</row></sheetData></worksheet>`
}

function presentation(ids = ['rId1']): string {
  return `<p:presentation xmlns:p="${PRESENTATION}" xmlns:r="${REL}"><p:sldIdLst>${ids.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
}

function slideXml(text = 'Slide text'): string {
  return `<p:sld xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function manifestZip(format: 'xlsx' | 'pptx', replacements: Replacements = {}): Uint8Array {
  return officeZip(
    format,
    format === 'xlsx' ? workbook() : presentation(),
    format === 'xlsx'
      ? [
          {
            name: 'xl/_rels/workbook.xml.rels',
            data: relationships(relation('rId1', 'worksheet', 'worksheets/sheet1.xml'))
          },
          { name: 'xl/worksheets/sheet1.xml', data: worksheet() }
        ]
      : [
          {
            name: 'ppt/_rels/presentation.xml.rels',
            data: relationships(relation('rId1', 'slide', 'slides/slide1.xml'))
          },
          { name: 'ppt/slides/slide1.xml', data: slideXml() }
        ],
    replacements
  )
}

function sharedZip(index: string, replacements: Replacements = {}): Uint8Array {
  return officeZip(
    'xlsx',
    workbook(),
    [
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: relationships(
          relation('rId1', 'worksheet', 'worksheets/sheet1.xml') +
            relation('rId2', 'sharedStrings', 'sharedStrings.xml')
        )
      },
      { name: 'xl/sharedStrings.xml', data: `<sst xmlns="${SHEET}"><si><t>shared</t></si></sst>` },
      { name: 'xl/worksheets/sheet1.xml', data: worksheet(`<c r="A1" t="s"><v>${index}</v></c>`) }
    ],
    replacements
  )
}

function expectBounded(result: Awaited<ReturnType<typeof extractOoxmlText>>): void {
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
    DOCUMENT_TEXT_LIMITS.envelopeBytes
  )
  if ('jobId' in result)
    expect(checkDocumentTextResult(result, JOB_ID, result.format).ok).toBe(true)
}

describe('bytes-only OOXML text extraction', () => {
  it('extracts DOCX paragraphs with Unicode and stable paragraph locators', async () => {
    const zip = officeZip(
      'docx',
      `<w:document xmlns:w="${WORD}"><w:body><w:p><w:r><w:t>Hello 世界🙂</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p></w:body></w:document>`
    )
    const result = await extractOoxmlText(zip, JOB_ID, 'docx')
    expect(result).toMatchObject({ ok: true, format: 'docx', truncated: false, warnings: [] })
    if (result.ok) {
      expect(result.segments).toEqual([
        {
          text: 'Hello 世界🙂',
          locator: { kind: 'docx-paragraph', part: 'word/document.xml', paragraph: 0 }
        },
        {
          text: 'second',
          locator: { kind: 'docx-paragraph', part: 'word/document.xml', paragraph: 1 }
        }
      ])
    }
    expectBounded(result)
  })

  it('preserves DOCX paragraph and table cell locations including empty columns and nested tables', async () => {
    const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
    const nested = `<w:tbl><w:tr><w:tc>${p('nested')}</w:tc></w:tr></w:tbl>`
    const xml = `<w:document xmlns:w="${WORD}"><w:body>${p('intro')}<w:tbl><w:tr><w:tc>${p('')}</w:tc><w:tc>${p('cell-one')}${nested}${p('cell-after-nested')}</w:tc></w:tr><w:tr><w:tc>${p('row-two')}</w:tc></w:tr></w:tbl>${p('outro')}</w:body></w:document>`
    const result = await extractOoxmlText(officeZip('docx', xml), JOB_ID, 'docx')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.segments.map(({ text }) => text)).toEqual([
      'intro',
      'cell-one',
      'nested',
      'cell-after-nested',
      'row-two',
      'outro'
    ])
    expect(result.segments.map(({ locator }) => locator)).toEqual([
      { kind: 'docx-paragraph', part: 'word/document.xml', paragraph: 0 },
      { kind: 'docx-table-cell', part: 'word/document.xml', table: 0, row: 0, column: 1 },
      { kind: 'docx-table-cell', part: 'word/document.xml', table: 1, row: 0, column: 0 },
      { kind: 'docx-table-cell', part: 'word/document.xml', table: 0, row: 0, column: 1 },
      { kind: 'docx-table-cell', part: 'word/document.xml', table: 0, row: 1, column: 0 },
      { kind: 'docx-paragraph', part: 'word/document.xml', paragraph: 6 }
    ])
    expectBounded(result)
  })
  it.each(['<w:tr/>', '<w:tc/>', '<w:tbl><w:tc/></w:tbl>', '<w:tbl><w:p/></w:tbl>'])(
    'fails closed for table ancestry that cannot produce trustworthy locators: %s',
    async (body) => {
      const result = await extractOoxmlText(
        officeZip('docx', `<w:document xmlns:w="${WORD}"><w:body>${body}</w:body></w:document>`),
        JOB_ID,
        'docx'
      )
      expect(result).toMatchObject({ ok: false, code: 'INVALID' })
    }
  )

  it('extracts XLSX shared-string and inline text cells with cell locators', async () => {
    const sheet = worksheet(
      '<c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>内联🙂</t></is></c>'
    )
    const shared = `<sst xmlns="${SHEET}"><si><t>共享文本</t></si></sst>`
    const zip = sharedZip('0', {
      'xl/sharedStrings.xml': shared,
      'xl/worksheets/sheet1.xml': sheet
    })
    const result = await extractOoxmlText(zip, JOB_ID, 'xlsx')
    expect(result).toMatchObject({ ok: true, format: 'xlsx', truncated: false, warnings: [] })
    if (result.ok) {
      expect(result.segments).toEqual([
        { text: '共享文本', locator: { kind: 'xlsx-cell', sheet: 1, cell: 'A1' } },
        { text: '42', locator: { kind: 'xlsx-cell', sheet: 1, cell: 'B1' } },
        { text: '内联🙂', locator: { kind: 'xlsx-cell', sheet: 1, cell: 'C1' } }
      ])
    }
    expectBounded(result)
  })

  it('extracts PPTX text with slide, shape and paragraph locators', async () => {
    const result = await extractOoxmlText(manifestZip('pptx'), JOB_ID, 'pptx')
    expect(result).toMatchObject({ ok: true, format: 'pptx', truncated: false, warnings: [] })
    if (result.ok)
      expect(result.segments).toEqual([
        { text: 'Slide text', locator: { kind: 'pptx-shape', slide: 1, shape: 0, paragraph: 0 } }
      ])
    expectBounded(result)
  })

  it('fails closed for missing package identity, macro content and no text', async () => {
    const noText = await extractOoxmlText(officeZip('docx', documentXml('')), JOB_ID, 'docx')
    expect(noText).toMatchObject({ ok: false, code: 'NO_TEXT', jobId: JOB_ID, format: 'docx' })
    const macro = await extractOoxmlText(
      officeZip('docx', documentXml(), [{ name: 'word/vbaProject.bin', data: 'macro' }]),
      JOB_ID,
      'docx'
    )
    expect(macro).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    const missing = await extractOoxmlText(
      makeZip([{ name: '[Content_Types].xml', data: '<Types />' }]),
      JOB_ID,
      'docx'
    )
    expect(missing).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
  })

  it('honors cancellation without leaking parser details or accepting a PDF label', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await extractOoxmlText(officeZip('docx', documentXml()), JOB_ID, 'docx', {
      signal: controller.signal
    })
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' })
    const pdfLabel = await extractOoxmlText(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      JOB_ID,
      'docx'
    )
    expect(pdfLabel).toMatchObject({ ok: false, code: 'INVALID' })
  })

  it.each([
    [
      'content-type namespace',
      '[Content_Types].xml',
      contentTypes('docx').replace(TYPES, 'urn:fake')
    ],
    ['forged MIME', '[Content_Types].xml', contentTypes('docx', '', 'application/docx')],
    [
      'template MIME',
      '[Content_Types].xml',
      contentTypes(
        'docx',
        '',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
      )
    ],
    [
      'relationship namespace',
      '_rels/.rels',
      relationships(relation('rId1', 'officeDocument', MAIN.docx)).replace(OPC, 'urn:fake')
    ],
    [
      'relationship type',
      '_rels/.rels',
      relationships(relation('rId1', 'officeDocument', MAIN.docx)).replace(
        `${REL}/officeDocument`,
        'urn:internal'
      )
    ],
    [
      'duplicate root relation',
      '_rels/.rels',
      relationships(
        relation('rId1', 'officeDocument', MAIN.docx) +
          relation('rId2', 'officeDocument', MAIN.docx)
      )
    ],
    [
      'namespaced target attribute',
      '_rels/.rels',
      relationships(relation('rId1', 'officeDocument', MAIN.docx)).replace(
        'Target=',
        'xmlns:x="urn:fake" x:Target='
      )
    ],
    [
      'external root relation',
      '_rels/.rels',
      relationships(relation('rId1', 'officeDocument', MAIN.docx, 'External'))
    ],
    [
      'invalid target mode',
      '_rels/.rels',
      relationships(relation('rId1', 'officeDocument', MAIN.docx, 'bogus'))
    ],
    ['document namespace', MAIN.docx, documentXml().replace(WORD, 'urn:word')],
    ['text namespace', MAIN.docx, documentXml().replace('<w:t>', '<w:t xmlns:w="urn:fake">')],
    ['wrong document root', MAIN.docx, documentXml().replaceAll('w:document', 'w:other')]
  ])('rejects %s', async (_name, part, data) => {
    const result = await extractOoxmlText(
      officeZip('docx', documentXml(), [], { [part]: data }),
      JOB_ID,
      'docx'
    )
    expect(result.ok).toBe(false)
    expectBounded(result)
  })

  it.each(['xlsx', 'pptx'] as const)(
    'uses %s manifest order and never reads orphan ZIP parts',
    async (format) => {
      const xlsx = format === 'xlsx'
      const folder = xlsx ? 'xl' : 'ppt'
      const stem = xlsx ? 'worksheet' : 'slide'
      const target = `${stem}s/${xlsx ? 'sheet' : 'slide'}`
      const part = (number: number): string => `${folder}/${target}${number}.xml`
      const mainRels = `${folder}/_rels/${xlsx ? 'workbook' : 'presentation'}.xml.rels`
      const content = (text: string): string =>
        xlsx ? worksheet(`<c r="A1" t="inlineStr"><is><t>${text}</t></is></c>`) : slideXml(text)
      const zip = officeZip(
        format,
        xlsx ? workbook(['second', 'first']) : presentation(['second', 'first']),
        [
          {
            name: mainRels,
            data: relationships(
              relation('first', stem, `${target}1.xml`) +
                relation('second', stem, `./${target}999.xml`)
            )
          },
          { name: part(1), data: content('last') },
          { name: part(999), data: content('first') },
          { name: part(2), data: '<not-even-well-formed' }
        ]
      )
      const result = await extractOoxmlText(zip, JOB_ID, format)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.segments.map(({ text }) => text)).toEqual(['first', 'last'])
        expect(
          result.segments.map(({ locator }) =>
            xlsx ? 'sheet' in locator && locator.sheet : 'slide' in locator && locator.slide
          )
        ).toEqual([1, 2])
      }
      expectBounded(result)
    }
  )

  it.each(['xlsx', 'pptx'] as const)(
    'rejects ambiguous, missing, external and forged %s manifest references',
    async (format) => {
      const xlsx = format === 'xlsx'
      const main = MAIN[format]
      const relPart = xlsx ? 'xl/_rels/workbook.xml.rels' : 'ppt/_rels/presentation.xml.rels'
      const kind = xlsx ? 'worksheet' : 'slide'
      const target = xlsx ? 'worksheets/sheet1.xml' : 'slides/slide1.xml'
      const xml = xlsx ? workbook() : presentation()
      const cases: Replacements[] = [
        { [relPart]: undefined },
        { [main]: xlsx ? workbook([]) : presentation([]) },
        { [main]: xlsx ? workbook(['missing']) : presentation(['missing']) },
        { [main]: xlsx ? workbook(['rId1', 'rId1']) : presentation(['rId1', 'rId1']) },
        { [main]: xml.replace(REL, 'urn:fake') },
        { [main]: xml.replace('r:id=', 'idref=') },
        { [main]: xml.replace(xlsx ? SHEET : PRESENTATION, 'urn:fake') },
        { [relPart]: relationships(relation('rId1', kind, target, 'External')) },
        { [relPart]: relationships(relation('rId1', kind, target, 'bogus')) },
        { [relPart]: relationships(relation('rId1', kind, target)).replace(OPC, 'urn:fake') },
        { [relPart]: relationships(relation('rId1', 'oleObject', target)) },
        {
          [relPart]: relationships(relation('rId1', kind, target)).replace(
            `${REL}/${kind}`,
            'urn:internal'
          )
        },
        {
          [relPart]: relationships(relation('rId1', kind, target) + relation('rId1', kind, target))
        },
        {
          [relPart]: relationships(
            relation('rId1', kind, target) + relation('rId2', kind, `./${target}`)
          )
        },
        { [relPart]: relationships(relation('rId1', kind, target.replace('1.xml', '3.xml'))) }
      ]
      for (const replacements of cases) {
        const result = await extractOoxmlText(manifestZip(format, replacements), JOB_ID, format)
        expect(result.ok, JSON.stringify(replacements)).toBe(false)
        expectBounded(result)
      }
    }
  )

  it.each(['xlsx', 'pptx'] as const)(
    'requires exact %s text-part MIME and namespaces',
    async (format) => {
      const xlsx = format === 'xlsx'
      const part = xlsx ? 'xl/worksheets/sheet1.xml' : 'ppt/slides/slide1.xml'
      const xml = xlsx ? worksheet() : slideXml()
      for (const namespace of xlsx ? [SHEET] : [PRESENTATION, DRAWING]) {
        const result = await extractOoxmlText(
          manifestZip(format, { [part]: xml.replaceAll(namespace, 'urn:fake') }),
          JOB_ID,
          format
        )
        expect(result.ok).toBe(false)
      }
      const forgedTypes = contentTypes(
        format,
        `<Override PartName="/${part}" ContentType="application/xml"/>`
      )
      const result = await extractOoxmlText(
        manifestZip(format, { '[Content_Types].xml': forgedTypes }),
        JOB_ID,
        format
      )
      expect(result.ok).toBe(false)
    }
  )

  it.each([
    '0junk',
    '0.5',
    '0e0',
    '+0',
    '-0',
    ' 0',
    '0 ',
    '00',
    '1',
    '9007199254740993',
    '',
    '0&#10;',
    '0&#13;',
    '0&#8232;'
  ])('rejects noncanonical/out-of-range shared-string index %j', async (index) => {
    expect(await extractOoxmlText(sharedZip(index), JOB_ID, 'xlsx')).toMatchObject({
      ok: false,
      code: 'INVALID'
    })
  })

  it('validates shared-string MIME, namespace and relationship before reading it', async () => {
    const cases: Replacements[] = [
      { 'xl/sharedStrings.xml': `<sst xmlns="urn:fake"><si><t>shared</t></si></sst>` },
      { 'xl/sharedStrings.xml': undefined },
      {
        '[Content_Types].xml': contentTypes(
          'xlsx',
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${MIME.sheet}"/>`
        )
      },
      {
        'xl/_rels/workbook.xml.rels': relationships(
          relation('rId1', 'worksheet', 'worksheets/sheet1.xml') +
            relation('rId2', 'sharedStrings', 'sharedStrings.xml', 'External')
        )
      }
    ]
    for (const replacements of cases) {
      expect((await extractOoxmlText(sharedZip('0', replacements), JOB_ID, 'xlsx')).ok).toBe(false)
    }
  })

  it.each(['XFE1', 'ZZZ1', 'A1048577', 'A9999999', 'A0', 'a1', 'A01', '', 'A1&#10;'])(
    'rejects invalid cell locator %j instead of silently omitting it',
    async (cell) => {
      const result = await extractOoxmlText(
        manifestZip('xlsx', {
          'xl/worksheets/sheet1.xml': worksheet(`<c r="${cell}"><v>42</v></c>`)
        }),
        JOB_ID,
        'xlsx'
      )
      expect(result).toMatchObject({ ok: false, code: 'INVALID' })
    }
  )

  it('accepts the maximum Excel cell and never uses an orphan shared-string table', async () => {
    const result = await extractOoxmlText(
      manifestZip('xlsx', {
        'xl/worksheets/sheet1.xml': worksheet('<c r="XFD1048576"><v>42</v></c>', 1048576)
      }),
      JOB_ID,
      'xlsx'
    )
    expect(result).toMatchObject({
      ok: true,
      segments: [{ text: '42', locator: { cell: 'XFD1048576' } }]
    })
    expectBounded(result)
    const orphan = await extractOoxmlText(
      manifestZip('xlsx', {
        'xl/sharedStrings.xml': `<sst xmlns="${SHEET}"><si><t>orphan</t></si></sst>`,
        'xl/worksheets/sheet1.xml': worksheet('<c r="A1" t="s"><v>0</v></c>')
      }),
      JOB_ID,
      'xlsx'
    )
    expect(orphan).toMatchObject({ ok: false, code: 'INVALID' })
  })

  it('rejects unsupported active relationships before reading their payload', async () => {
    const result = await extractOoxmlText(
      officeZip('docx', documentXml(), [
        {
          name: 'word/_rels/document.xml.rels',
          data: relationships(relation('active', 'aFChunk', 'payload.xml'))
        },
        { name: 'word/payload.xml', data: '<malformed-active-payload' }
      ]),
      JOB_ID,
      'docx'
    )
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
  })

  it.each(['xlsx', 'pptx'] as const)(
    'checks selected %s relationships before reading a malformed payload',
    async (format) => {
      const xlsx = format === 'xlsx'
      const part = xlsx ? 'xl/worksheets/sheet1.xml' : 'ppt/slides/slide1.xml'
      const relPart = xlsx
        ? 'xl/worksheets/_rels/sheet1.xml.rels'
        : 'ppt/slides/_rels/slide1.xml.rels'
      const result = await extractOoxmlText(
        manifestZip(format, {
          [part]: '<malformed-payload',
          [relPart]: relationships(relation('active', 'oleObject', 'payload.xml'))
        }),
        JOB_ID,
        format
      )
      expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    }
  )

  it.each(['escaped text', 'many segments'] as const)(
    'bounds the entire escaped JSON envelope for %s',
    async (kind) => {
      const body =
        kind === 'escaped text'
          ? `<w:p><w:r><w:t>${'&quot;\\'.repeat(40000)}</w:t></w:r></w:p>`
          : Array.from(
              { length: DOCUMENT_TEXT_LIMITS.segments },
              () => `<w:p><w:r><w:t>${'x'.repeat(90)}</w:t></w:r></w:p>`
            ).join('')
      const result = await extractOoxmlText(
        officeZip('docx', `<w:document xmlns:w="${WORD}"><w:body>${body}</w:body></w:document>`),
        JOB_ID,
        'docx'
      )
      expectBounded(result)
      if (result.ok)
        expect(result).toMatchObject({ truncated: true, warnings: ['output-truncated'] })
      else expect(result.code).toBe('LIMIT')
    }
  )

  it.each(['text bytes', 'segment count'] as const)(
    'preserves explicit bounded truncation at the %s limit',
    async (kind) => {
      const xml =
        kind === 'text bytes'
          ? documentXml('🙂'.repeat(13000))
          : `<w:document xmlns:w="${WORD}"><w:body>${'<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(DOCUMENT_TEXT_LIMITS.segments + 8)}</w:body></w:document>`
      const result = await extractOoxmlText(officeZip('docx', xml), JOB_ID, 'docx')
      expect(result).toMatchObject({ ok: true, truncated: true, warnings: ['output-truncated'] })
      expectBounded(result)
    }
  )

  it('never coerces or echoes invalid correlation and does not execute input getters', async () => {
    const trap = vi.fn(() => {
      throw new Error('must not execute')
    })
    const hostile = {
      toString: trap,
      [Symbol.toPrimitive]: trap,
      get jobId(): never {
        return trap()
      }
    }
    const bytes = officeZip('docx', documentXml())
    for (const jobId of [hostile, Symbol('id'), null, 'x'.repeat(100000)]) {
      expect(await extractOoxmlText(bytes, jobId as string, 'docx')).toEqual({
        ok: false,
        code: 'INVALID'
      })
    }
    for (const format of [hostile, 'pdf', 'bogus', null]) {
      expect(await extractOoxmlText(bytes, JOB_ID, format as OfficeTextFormat)).toEqual({
        ok: false,
        code: 'INVALID'
      })
    }
    const badBytes = {
      get buffer(): never {
        return trap()
      },
      get byteLength(): never {
        return trap()
      }
    }
    expect(await extractOoxmlText(badBytes as unknown as Uint8Array, JOB_ID, 'docx')).toMatchObject(
      {
        ok: false,
        code: 'INVALID'
      }
    )
    expect(
      await extractOoxmlText(new Proxy(bytes, { get: trap, getPrototypeOf: trap }), JOB_ID, 'docx')
    ).toMatchObject({ ok: false, code: 'INVALID' })
    expect(trap).not.toHaveBeenCalled()
  })

  it('rejects option accessors/proxies and forged signals without running them', async () => {
    const trap = vi.fn(() => {
      throw new Error('must not execute')
    })
    const bytes = officeZip('docx', documentXml())
    for (const options of [
      {
        get signal(): never {
          return trap()
        }
      },
      new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap }),
      {
        signal: {
          get aborted(): never {
            return trap()
          }
        }
      },
      {
        get deadlineAt(): never {
          return trap()
        }
      }
    ]) {
      expect(
        await extractOoxmlText(
          bytes,
          JOB_ID,
          'docx',
          options as Parameters<typeof extractOoxmlText>[3]
        )
      ).toMatchObject({ ok: false, code: 'INVALID' })
    }
    expect(trap).not.toHaveBeenCalled()
  })

  it('honors a live abort signal and a deadline across the whole extraction', async () => {
    const bytes = officeZip('docx', documentXml())
    const live = new AbortController()
    expect(await extractOoxmlText(bytes, JOB_ID, 'docx', { signal: live.signal })).toMatchObject({
      ok: true
    })
    const controller = new AbortController()
    const pending = extractOoxmlText(bytes, JOB_ID, 'docx', { signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(
      await extractOoxmlText(bytes, JOB_ID, 'docx', { deadlineAt: Date.now() - 1 })
    ).toMatchObject({ ok: false, code: 'CANCELLED' })
  })
})

describe('DOCX passive picture and normal multi-paragraph compatibility', () => {
  const wp = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
  const pic = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
  const wrap = (body: string) =>
    `<w:document xmlns:w="${WORD}" xmlns:a="${DRAWING}" xmlns:wp="${wp}" xmlns:pic="${pic}"><w:body>${body}</w:body></w:document>`
  const image = (kind: string = 'inline') =>
    `<w:drawing><wp:${kind}><wp:extent cx="10" cy="10"/><a:graphic><a:graphicData uri="${pic}"><pic:pic><pic:blipFill><a:blip/><a:stretch><a:fillRect/></a:stretch></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:${kind}></w:drawing>`
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  it.each(['inline', 'anchor'])(
    'extracts text before/after a passive %s picture without opening image data',
    async (kind) => {
      const read = vi.spyOn(ZipXmlReader.prototype, 'readAllowedPart')
      try {
        const xml = wrap(
          `<w:p><w:r><w:t>before</w:t>${image(kind)}<w:t>after</w:t></w:r></w:p><w:tbl><w:tr><w:tc>${p('cell')}</w:tc></w:tr></w:tbl>${p('end')}`
        )
        const result = await extractOoxmlText(
          officeZip('docx', xml, [
            { name: 'word/media/image1.png', data: 'owned opaque image bytes, never decode' }
          ]),
          JOB_ID,
          'docx'
        )
        expect(result).toMatchObject({ ok: true, truncated: false })
        if (!result.ok) return
        expect(result.segments.map((s) => s.text)).toEqual(['beforeafter', 'cell', 'end'])
        expect(result.segments[1].locator).toMatchObject({
          kind: 'docx-table-cell',
          row: 0,
          column: 0
        })
        expect(read.mock.calls.some(([name]) => name.includes('/media/'))).toBe(false)
        expectBounded(result)
      } finally {
        read.mockRestore()
      }
    }
  )
  it('does not confuse DrawingML text with Word paragraphs or text', async () => {
    const drawing =
      '<w:drawing><wp:inline><a:graphic><a:graphicData><a:p><a:r><a:t>not Word body text</a:t></a:r></a:p></a:graphicData></a:graphic></wp:inline></w:drawing>'
    const result = await extractOoxmlText(
      officeZip('docx', wrap(`<w:p><w:r><w:t>A</w:t>${drawing}<w:t>B</w:t></w:r></w:p>`)),
      JOB_ID,
      'docx'
    )
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.segments.map((s) => s.text)).toEqual(['AB'])
  })
  it.each([
    '<w:altChunk/>',
    '<w:control/>',
    '<a:oleObject/>',
    '<x:payload xmlns:x="urn:untrusted"/>'
  ])('still rejects unsupported active or foreign markup inside a drawing: %s', async (child) => {
    const xml = wrap(
      `<w:p><w:r><w:t>visible</w:t><w:drawing><wp:inline>${child}</wp:inline></w:drawing></w:r></w:p>`
    )
    expect(await extractOoxmlText(officeZip('docx', xml), JOB_ID, 'docx')).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED'
    })
  })
  it('does not allow drawing namespaces to impersonate body text outside a Word drawing', async () => {
    expect(
      await extractOoxmlText(officeZip('docx', wrap('<w:p><a:t>fake</a:t></w:p>')), JOB_ID, 'docx')
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
  })
  it('retains all 560 modest paragraphs when text is below the returned text budget', async () => {
    const paragraphs = Array.from({ length: 560 }, (_, i) => `owned ${i} ` + 'x'.repeat(62))
    const result = await extractOoxmlText(
      officeZip('docx', wrap(paragraphs.map(p).join(''))),
      JOB_ID,
      'docx'
    )
    expect(result).toMatchObject({ ok: true, truncated: false, warnings: [] })
    if (result.ok) expect(result.segments.map((s) => s.text)).toEqual(paragraphs)
    expectBounded(result)
  })
})
