import { deflateSync } from 'node:zlib'

export type PdfFixturePage = Readonly<{ content: string; compressed?: boolean }>

/** Owned PDFs with real byte offsets, xref tables and streams; no third-party document data.
 * The embedded Type3 font keeps these text fixtures independent of external font files. */
export function makePdfFixture(
  pages: readonly PdfFixturePage[],
  options: Readonly<{ reverseObjects?: boolean; standardFont?: boolean }> = {}
): Uint8Array {
  const ascii = (text: string): Buffer => Buffer.from(text, 'latin1')
  const stream = (data: Buffer, compressed = false): Buffer => {
    const bytes = compressed ? deflateSync(data) : data
    return Buffer.concat([
      ascii(`<< /Length ${bytes.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
      bytes,
      ascii('\nendstream')
    ])
  }
  const names = [
    'space',
    'exclam',
    'quotedbl',
    'numbersign',
    'dollar',
    'percent',
    'ampersand',
    'quotesingle',
    'parenleft',
    'parenright',
    'asterisk',
    'plus',
    'comma',
    'hyphen',
    'period',
    'slash',
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'colon',
    'semicolon',
    'less',
    'equal',
    'greater',
    'question',
    'at',
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'bracketleft',
    'backslash',
    'bracketright',
    'asciicircum',
    'underscore',
    'grave',
    ...'abcdefghijklmnopqrstuvwxyz',
    'braceleft',
    'bar',
    'braceright',
    'asciitilde'
  ]
  const objects = new Map<number, Buffer>()
  objects.set(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'))
  objects.set(
    2,
    ascii(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`
    )
  )
  objects.set(
    3,
    ascii(
      options.standardFont
        ? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
        : `<< /Type /Font /Subtype /Type3 /Name /F1 /FontBBox [0 0 600 800] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 32 /LastChar 126 /Widths [${names.map(() => 600).join(' ')}] /Encoding << /Type /Encoding /Differences [32 ${names.map((name) => `/${name}`).join(' ')}] >> /CharProcs << ${names.map((name) => `/${name} 4 0 R`).join(' ')} >> /Resources << >> >>`
    )
  )
  objects.set(4, stream(ascii('600 0 0 0 500 700 d1 0 0 500 700 re f')))
  pages.forEach((page, i) => {
    objects.set(
      5 + i * 2,
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
      )
    )
    objects.set(6 + i * 2, stream(ascii(page.content), page.compressed))
  })
  // Valid PDF comment: a whole-file text-operator regex incorrectly treats this as page text.
  const parts = [ascii('%PDF-1.7\n% (DECOY OUTSIDE STREAM) Tj\n')]
  const offsets = new Map<number, number>()
  let length = parts[0].length
  const entries = [...objects]
  if (options.reverseObjects) entries.reverse()
  for (const [id, body] of entries) {
    offsets.set(id, length)
    const part = Buffer.concat([ascii(`${id} 0 obj\n`), body, ascii('\nendobj\n')])
    parts.push(part)
    length += part.length
  }
  const count = objects.size + 1
  const xref = Array.from(
    { length: objects.size },
    (_, i) => `${String(offsets.get(i + 1)).padStart(10, '0')} 00000 n \n`
  ).join('')
  parts.push(
    ascii(
      `xref\n0 ${count}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`
    )
  )
  return new Uint8Array(Buffer.concat(parts))
}

export function pdfFixtures(): Record<
  'compressedEscaped' | 'hexAndTJ' | 'multiPage' | 'noText' | 'invalid' | 'resourceDenied',
  Uint8Array
> {
  return {
    compressedEscaped: makePdfFixture([
      { content: 'BT /F1 12 Tf 72 720 Td (Compressed \\(escaped\\) text) Tj ET', compressed: true }
    ]),
    hexAndTJ: makePdfFixture([
      {
        content: 'BT /F1 12 Tf 72 720 Td <4865782074657874> Tj 0 -20 Td [(Array) 30 ( text)] TJ ET'
      }
    ]),
    multiPage: makePdfFixture(
      [
        { content: 'BT /F1 12 Tf 72 720 Td (First page) Tj ET', compressed: true },
        { content: 'BT /F1 12 Tf 72 720 Td (Second page) Tj ET' }
      ],
      { reverseObjects: true }
    ),
    noText: makePdfFixture([{ content: 'q Q' }]),
    invalid: new Uint8Array(Buffer.from('%PDF-1.7\nnot a document\n(decoy) Tj\n%%EOF')),
    resourceDenied: makePdfFixture([{ content: 'BT /F1 12 Tf 72 720 Td (External font) Tj ET' }], {
      standardFont: true
    })
  }
}
