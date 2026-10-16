import { describe, expect, it, vi } from 'vitest'
import {
  DocumentParserError,
  ZIP_XML_LIMITS,
  createZipXmlReader,
  parseBoundedXml,
  validateInternalPartReference
} from './zipXmlReader'
import {
  makeZip,
  minimalOpcZip,
  textBytes,
  zip64Extra,
  type FixtureEntry
} from './__fixtures__/documentFixtures'

function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(DocumentParserError)
  return (error as DocumentParserError).code
}

async function read(zip: Uint8Array, name: string, format?: 'docx' | 'xlsx' | 'pptx' | 'auto') {
  const reader = createZipXmlReader(zip, { format })
  try {
    return await reader.readAllowedPart(name)
  } finally {
    reader.close()
  }
}

function expectReject(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected ${code}`)
    },
    (error) => {
      expect(codeOf(error)).toBe(code)
    }
  )
}

describe('bytes-only ZIP/XML security core', () => {
  it('reads a minimal OPC package from detached bytes and exposes no path or filesystem API', async () => {
    const zip = minimalOpcZip('docx')
    const reader = createZipXmlReader(zip, { format: 'docx' })
    expect(reader.listEntries().map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml'
    ])
    const first = await reader.readAllowedPart('word/document.xml')
    zip.fill(0)
    expect(Buffer.from(first).toString()).toContain('Hello 世界🙂')
    expect(Object.keys(reader).sort()).not.toContain('path')
    reader.close()
  })

  it('supports STORE and DEFLATE, validates CRC with a known vector, and caches repeated reads', async () => {
    const zip = makeZip([
      { name: '[Content_Types].xml', data: '<Types/>', compression: 'store' },
      { name: '_rels/.rels', data: '<Relationships/>', compression: 'deflate' }
    ])
    const reader = createZipXmlReader(zip)
    const first = await reader.readAllowedPart('[Content_Types].xml')
    const second = await reader.readAllowedPart('[Content_Types].xml')
    expect(Buffer.from(first).toString()).toBe('<Types/>')
    expect(second).not.toBe(first)
    reader.close()
  })

  it('rejects metadata before inflation: CRC, unsupported method/flags, ZIP64, split and truncation', async () => {
    const cases: Array<[Uint8Array, string]> = [
      [makeZip([{ name: '[Content_Types].xml', data: '<Types/>', corruptCrc: true }]), 'INVALID'],
      [makeZip([{ name: '[Content_Types].xml', data: '<Types/>', flags: 0x1 }]), 'UNSUPPORTED'],
      [
        makeZip([{ name: '[Content_Types].xml', data: '<Types/>', extra: zip64Extra() }]),
        'UNSUPPORTED'
      ],
      [
        makeZip([{ name: '[Content_Types].xml', data: '<Types/>', versionNeeded: 45 }]),
        'UNSUPPORTED'
      ],
      [
        makeZip([{ name: '[Content_Types].xml', data: '<Types/>', localMethod: 'deflate' }]),
        'INVALID'
      ]
    ]
    for (const [zip, code] of cases) {
      try {
        createZipXmlReader(zip)
        throw new Error(`expected constructor ${code}`)
      } catch (error) {
        expect(codeOf(error)).toBe(code)
      }
    }
    await expectReject(
      read(
        makeZip([{ name: '[Content_Types].xml', data: '<Types/>' }]).slice(0, -1),
        '[Content_Types].xml'
      ),
      'INVALID'
    )
  })

  it('rejects unsafe names, aliases, links, macros, OLE and unknown parts without inflating them', async () => {
    const names = [
      '../[Content_Types].xml',
      'a/../[Content_Types].xml',
      '/[Content_Types].xml',
      'C:[Content_Types].xml',
      'a\\b.xml',
      'a%2fb.xml',
      'a\u0001.xml',
      'MACRO/VBA',
      'word/vbaProject.bin',
      'word/embeddings/oleObject1.bin'
    ]
    for (const name of names) {
      try {
        createZipXmlReader(makeZip([{ name, data: '<x/>' }]))
        throw new Error(`expected unsafe name ${name}`)
      } catch (error) {
        expect(codeOf(error)).toBe('UNSUPPORTED')
      }
    }
    for (const [left, right] of [
      ['word/document.xml', 'WORD/DOCUMENT.XML'],
      ['a.xml', 'a.xml']
    ]) {
      try {
        createZipXmlReader(
          makeZip([
            { name: left, data: '<x/>' },
            { name: right, data: '<x/>' }
          ])
        )
        throw new Error('expected duplicate alias')
      } catch (error) {
        expect(codeOf(error)).toBe('UNSUPPORTED')
      }
    }
    try {
      createZipXmlReader(
        makeZip([
          {
            name: 'word/link.xml',
            data: '<x/>',
            versionMadeBy: 0x0314,
            externalAttributes: 0xa0000000
          }
        ])
      )
      throw new Error('expected link')
    } catch (error) {
      expect(codeOf(error)).toBe('UNSUPPORTED')
    }
    await expectReject(
      read(makeZip([{ name: 'word/unknown.xml', data: '<x/>' }]), 'word/unknown.xml', 'docx'),
      'UNSUPPORTED'
    )
  })

  it('does not inflate media and counts declared and actual expansion across entries', async () => {
    const media = makeZip([
      { name: 'word/media/image.png', data: textBytes('not xml'), compression: 'deflate' }
    ])
    await expectReject(read(media, 'word/media/image.png', 'docx'), 'UNSUPPORTED')
    const bombEntries: FixtureEntry[] = Array.from({ length: 5 }, (_, index) => ({
      name: `[Content_Types].xml.part${index}`,
      data: new Uint8Array(4 * 1024 * 1024),
      compression: 'deflate'
    }))
    try {
      createZipXmlReader(makeZip(bombEntries))
      throw new Error('expected declared expansion limit')
    } catch (error) {
      expect(codeOf(error)).toBe('LIMIT')
    }
  })

  it('bounds entries and entry bytes, and has fixed policy limits', () => {
    expect(ZIP_XML_LIMITS).toMatchObject({
      inputBytes: 1024 * 1024,
      entries: 256,
      entryBytes: 4 * 1024 * 1024,
      expandedBytes: 16 * 1024 * 1024
    })
    expect(() =>
      createZipXmlReader(
        makeZip(
          Array.from({ length: 257 }, (_, index) => ({ name: `x${index}.xml`, data: '<x/>' }))
        )
      )
    ).toThrowError(DocumentParserError)
    try {
      createZipXmlReader(
        makeZip([{ name: '[Content_Types].xml', data: new Uint8Array(4 * 1024 * 1024 + 1) }])
      )
      throw new Error('expected entry limit')
    } catch (error) {
      expect(codeOf(error)).toBe('LIMIT')
    }
  })

  it('parses UTF-8 XML with namespaces, rejects DTD/entities/PI/unsupported encoding and malformed XML', () => {
    const seen: string[] = []
    const summary = parseBoundedXml(
      '<w:document xmlns:w="urn:word"><w:t>Hello🙂</w:t></w:document>',
      {
        opentag: (tag) => seen.push(`${tag.prefix}:${tag.local}:${tag.uri}`),
        text: (text) => seen.push(text)
      }
    )
    expect(summary.elements).toBe(2)
    expect(summary.maxDepth).toBe(2)
    expect(seen).toContain('w:t:urn:word')
    expect(seen).toContain('Hello🙂')
    for (const [xml, code] of [
      ['<!DOCTYPE x><x/>', 'UNSUPPORTED'],
      ['<?custom instruction?><x/>', 'UNSUPPORTED'],
      ['<?xml version="1.0" encoding="ISO-8859-1"?><x/>', 'UNSUPPORTED'],
      ['<x>&evil;</x>', 'INVALID'],
      ['<x>', 'INVALID'],
      ['<x xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include/></x>', 'UNSUPPORTED']
    ] as const) {
      try {
        parseBoundedXml(xml)
        throw new Error(`expected XML ${code}`)
      } catch (error) {
        if (!(error instanceof DocumentParserError)) throw error
        expect(error.code).toBe(code)
      }
    }
    expect(() => parseBoundedXml(new Uint8Array([0xc3, 0x28]))).toThrowError(DocumentParserError)
    expect(() =>
      parseBoundedXml('<x>' + '<y>'.repeat(65) + '</y>'.repeat(65) + '</x>')
    ).toThrowError(DocumentParserError)
  })

  it('rejects accessor/proxy handlers and typed-array shadows without invoking them', () => {
    const spy = vi.fn(() => {
      throw new Error('getter')
    })
    const handlers = Object.defineProperty({}, 'text', { enumerable: true, get: spy })
    expect(() => parseBoundedXml('<x/>', handlers)).toThrowError(DocumentParserError)
    expect(spy).not.toHaveBeenCalled()
    expect(() => parseBoundedXml('<x/>', new Proxy({}, { ownKeys: spy }))).toThrowError(
      DocumentParserError
    )
    const input = new Uint8Array(textBytes('<x/>'))
    for (const key of ['buffer', 'byteOffset', 'byteLength'])
      Object.defineProperty(input, key, { get: spy })
    expect(parseBoundedXml(input).elements).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('cancels an in-flight DEFLATE read and settles the promise after close/abort', async () => {
    const controller = new AbortController()
    const reader = createZipXmlReader(
      makeZip([
        {
          name: '[Content_Types].xml',
          data: new Uint8Array(900000).fill(0x61),
          compression: 'deflate'
        }
      ]),
      { signal: controller.signal }
    )
    const pending = reader.readAllowedPart('[Content_Types].xml')
    controller.abort()
    await expectReject(pending, 'CANCELLED')
    reader.close()
    expect(() => reader.hasEntry('[Content_Types].xml')).not.toThrow()
  })

  it('checks cancellation before and during bounded parsing and closes current reader state', async () => {
    const before = new AbortController()
    before.abort()
    expect(() => parseBoundedXml('<x/>', undefined, { signal: before.signal })).toThrowError(
      DocumentParserError
    )
    const controller = new AbortController()
    let calls = 0
    expect(() =>
      parseBoundedXml(
        '<x>' + 'a'.repeat(200000) + '</x>',
        {
          text: () => {
            calls += 1
            if (calls === 1) controller.abort()
          }
        },
        { signal: controller.signal }
      )
    ).toThrowError(DocumentParserError)
    const reader = createZipXmlReader(minimalOpcZip(), { format: 'docx' })
    reader.close()
    await expectReject(reader.readAllowedPart('[Content_Types].xml'), 'CANCELLED')
  })

  it('validates internal relationship references without decoding, external access or escape', () => {
    expect(validateInternalPartReference('', 'word/document.xml')).toBe(true)
    expect(validateInternalPartReference('word/document.xml', '../other.xml')).toBe(true)
    expect(validateInternalPartReference('word/document.xml', '../../outside.xml')).toBe(false)
    expect(validateInternalPartReference('word/document.xml', 'file:///secret')).toBe(false)
    expect(validateInternalPartReference('word/document.xml', 'a%2fb.xml')).toBe(false)
    expect(validateInternalPartReference('word/document.xml', 'document.xml', 'External')).toBe(
      false
    )
  })
})
