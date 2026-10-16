import { crc32, deflateRawSync } from 'node:zlib'

export type FixtureCompression = 'store' | 'deflate'

export interface FixtureEntry {
  readonly name: string
  readonly data: Uint8Array | string
  readonly compression?: FixtureCompression
  readonly flags?: number
  readonly extra?: Uint8Array
  readonly comment?: Uint8Array
  readonly corruptCrc?: boolean
  readonly descriptor?: boolean
  readonly localName?: string
  readonly localMethod?: FixtureCompression
  readonly localFlags?: number
  readonly localCrc?: number
  readonly localCompressedSize?: number
  readonly localUncompressedSize?: number
  readonly versionNeeded?: number
  readonly versionMadeBy?: number
  readonly externalAttributes?: number
}

const textEncoder = new TextEncoder()

function bytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? textEncoder.encode(value) : new Uint8Array(value)
}

function put16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function put32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0))
}

export function makeZip(entries: readonly FixtureEntry[], comment = new Uint8Array()): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const rawName = ascii(entry.localName ?? entry.name)
    const name = ascii(entry.name)
    const input = bytes(entry.data)
    const method = entry.compression === 'deflate' ? 8 : 0
    const localMethod =
      entry.localMethod === 'deflate' ? 8 : entry.localMethod === 'store' ? 0 : method
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(input)) : input
    const actualCrc = crc32(Buffer.from(input)) >>> 0
    const centralCrc = entry.corruptCrc ? actualCrc ^ 0x01000000 : actualCrc
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 0x8 : 0)
    const localFlags = entry.localFlags ?? flags
    const localCrc = entry.localCrc ?? (entry.descriptor ? 0 : actualCrc)
    const localCompressedSize =
      entry.localCompressedSize ?? (entry.descriptor ? 0 : compressed.length)
    const localUncompressedSize =
      entry.localUncompressedSize ?? (entry.descriptor ? 0 : input.length)
    const extra = entry.extra ?? new Uint8Array()
    const localHeader = new Uint8Array(30 + rawName.length + extra.length)
    put32(localHeader, 0, 0x04034b50)
    put16(localHeader, 4, entry.versionNeeded ?? 20)
    put16(localHeader, 6, localFlags)
    put16(localHeader, 8, localMethod)
    put16(localHeader, 10, 0)
    put16(localHeader, 12, 0)
    put32(localHeader, 14, localCrc)
    put32(localHeader, 18, localCompressedSize)
    put32(localHeader, 22, localUncompressedSize)
    put16(localHeader, 26, rawName.length)
    put16(localHeader, 28, extra.length)
    localHeader.set(rawName, 30)
    localHeader.set(extra, 30 + rawName.length)
    const descriptor = entry.descriptor
      ? (() => {
          const data = new Uint8Array(16)
          put32(data, 0, 0x08074b50)
          put32(data, 4, centralCrc)
          put32(data, 8, compressed.length)
          put32(data, 12, input.length)
          return data
        })()
      : new Uint8Array()
    localParts.push(localHeader, compressed, descriptor)

    const fileComment = entry.comment ?? new Uint8Array()
    const centralHeader = new Uint8Array(46 + name.length + extra.length + fileComment.length)
    put32(centralHeader, 0, 0x02014b50)
    put16(centralHeader, 4, entry.versionMadeBy ?? 20)
    put16(centralHeader, 6, entry.versionNeeded ?? 20)
    put16(centralHeader, 8, flags)
    put16(centralHeader, 10, method)
    put16(centralHeader, 12, 0)
    put16(centralHeader, 14, 0)
    put32(centralHeader, 16, centralCrc)
    put32(centralHeader, 20, compressed.length)
    put32(centralHeader, 24, input.length)
    put16(centralHeader, 28, name.length)
    put16(centralHeader, 30, extra.length)
    put16(centralHeader, 32, fileComment.length)
    put16(centralHeader, 34, 0)
    put16(centralHeader, 36, 0)
    put32(centralHeader, 38, entry.externalAttributes ?? 0)
    put32(centralHeader, 42, localOffset)
    centralHeader.set(name, 46)
    centralHeader.set(extra, 46 + name.length)
    centralHeader.set(fileComment, 46 + name.length + extra.length)
    centralParts.push(centralHeader)
    localOffset += localHeader.length + compressed.length + descriptor.length
  }

  const local = concat(localParts)
  const central = concat(centralParts)
  const end = new Uint8Array(22 + comment.length)
  put32(end, 0, 0x06054b50)
  put16(end, 4, 0)
  put16(end, 6, 0)
  put16(end, 8, entries.length)
  put16(end, 10, entries.length)
  put32(end, 12, central.length)
  put32(end, 16, local.length)
  put16(end, 20, comment.length)
  end.set(comment, 22)
  return concat([local, central, end])
}

export function minimalOpcZip(format: 'docx' | 'xlsx' | 'pptx' = 'docx'): Uint8Array {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:internal" Target="${format === 'docx' ? 'word/document.xml' : format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'}"/></Relationships>`
  const content =
    format === 'docx'
      ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello 世界🙂</w:t></w:r></w:p></w:body></w:document>'
      : format === 'xlsx'
        ? '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheet name="Sheet1" sheetId="1"/></workbook>'
        : '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
  const part =
    format === 'docx'
      ? 'word/document.xml'
      : format === 'xlsx'
        ? 'xl/workbook.xml'
        : 'ppt/presentation.xml'
  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes, compression: 'deflate' },
    { name: '_rels/.rels', data: rootRels, compression: 'store' },
    { name: part, data: content, compression: 'deflate' }
  ])
}

export function zip64Extra(): Uint8Array {
  return Uint8Array.from([0x01, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
}

export function textBytes(value: string): Uint8Array {
  return bytes(value)
}
