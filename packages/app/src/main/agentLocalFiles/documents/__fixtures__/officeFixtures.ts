import { makeZip } from './documentFixtures'

const types = 'http://schemas.openxmlformats.org/package/2006/content-types'
const opc = 'http://schemas.openxmlformats.org/package/2006/relationships'
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const relationships = (content: string) =>
  `<Relationships xmlns="${opc}">${content}</Relationships>`
const relation = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`

/** Owned passive Transitional OOXML subsets. Not MS Office export/interoperability proof. */
export function officeFixtures(): Record<'docx' | 'xlsx' | 'pptx', Uint8Array> {
  const packageZip = (
    main: string,
    mainMime: string,
    content: string,
    extra: Array<{ name: string; data: string; mime?: string }> = []
  ) =>
    makeZip(
      [
        {
          name: '[Content_Types].xml',
          data: `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${mainMime}"/>${extra
            .filter((part) => part.mime)
            .map((part) => `<Override PartName="/${part.name}" ContentType="${part.mime}"/>`)
            .join('')}</Types>`
        },
        { name: '_rels/.rels', data: relationships(relation('main', 'officeDocument', main)) },
        { name: main, data: content },
        ...extra
      ].map((part) => ({ name: part.name, data: part.data, compression: 'deflate' as const }))
    )
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  const docx = packageZip(
    'word/document.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    `<w:document xmlns:w="${word}"><w:body>${p('MAGICPOT-DOCX-UNIQUE-PARAGRAPH')}<w:tbl><w:tr><w:tc>${p('')}</w:tc><w:tc>${p('MAGICPOT-DOCX-UNIQUE-TABLE-CELL')}</w:tc></w:tr></w:tbl></w:body></w:document>`
  )
  const worksheet = (text: string, cell: string) =>
    `<worksheet xmlns="${sheet}"><sheetData><row r="3"><c r="${cell}" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`
  const sheetMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
  const xlsx = packageZip(
    'xl/workbook.xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    `<workbook xmlns="${sheet}" xmlns:r="${rel}"><sheets><sheet name="Owned first" sheetId="8" r:id="first"/><sheet name="Owned second" sheetId="23" r:id="second"/></sheets></workbook>`,
    [
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: relationships(
          relation('first', 'worksheet', 'worksheets/sheet1.xml') +
            relation('second', 'worksheet', 'worksheets/sheet2.xml')
        )
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: worksheet('MAGICPOT-XLSX-UNIQUE-SHEET-ONE', 'B3'),
        mime: sheetMime
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: worksheet('MAGICPOT-XLSX-UNIQUE-SHEET-TWO', 'C3'),
        mime: sheetMime
      }
    ]
  )
  const slide = (text: string) =>
    `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  const slideMime = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
  const pptx = packageZip(
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    `<p:presentation xmlns:p="${presentation}" xmlns:r="${rel}"><p:sldIdLst><p:sldId id="258" r:id="first"/><p:sldId id="271" r:id="second"/></p:sldIdLst></p:presentation>`,
    [
      {
        name: 'ppt/_rels/presentation.xml.rels',
        data: relationships(
          relation('first', 'slide', 'slides/slide1.xml') +
            relation('second', 'slide', 'slides/slide2.xml')
        )
      },
      {
        name: 'ppt/slides/slide1.xml',
        data: slide('MAGICPOT-PPTX-UNIQUE-SLIDE-ONE'),
        mime: slideMime
      },
      {
        name: 'ppt/slides/slide2.xml',
        data: slide('MAGICPOT-PPTX-UNIQUE-SLIDE-TWO'),
        mime: slideMime
      }
    ]
  )
  return { docx, xlsx, pptx }
}
