const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type PngValidationFailure = 'non-png' | 'truncated' | 'crc' | 'invalid-structure'

export type PngInspection = {
  valid: boolean
  byteLength: number
  failure?: PngValidationFailure
}

export type ComfyBatchOutputMetadata = {
  sourceSha256: string
  planFingerprint: string
}

export type BatchPngInspection = PngInspection & {
  metadata: ComfyBatchOutputMetadata | null
}

const BATCH_PNG_TEXT_KEY = 'MagicPotBatch'

export function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= PNG_SIGNATURE.byteLength &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  )
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

let pngCrcTable: Uint32Array | undefined
function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  if (!pngCrcTable) {
    pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      return value >>> 0
    })
  }
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = pngCrcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function inspectPng(bytes: Uint8Array): PngInspection {
  const byteLength = bytes.byteLength
  if (!isPngSignature(bytes)) return { valid: false, byteLength, failure: 'non-png' }
  // Keep the established lower bound. It also makes a signature-only response
  // an explicit truncation rather than allowing unsafe chunk reads below.
  if (byteLength < 45) return { valid: false, byteLength, failure: 'truncated' }

  let offset = PNG_SIGNATURE.byteLength
  let chunkIndex = 0
  let hasIdat = false
  while (offset < byteLength) {
    if (byteLength - offset < 12) {
      return { valid: false, byteLength, failure: 'truncated' }
    }
    const dataLength = readUint32Be(bytes, offset)
    const dataOffset = offset + 8
    const crcOffset = dataOffset + dataLength
    const nextOffset = crcOffset + 4
    if (!Number.isSafeInteger(nextOffset) || nextOffset > byteLength) {
      return { valid: false, byteLength, failure: 'truncated' }
    }

    const type = chunkType(bytes, offset + 4)
    if (chunkIndex === 0 && (type !== 'IHDR' || dataLength !== 13)) {
      return { valid: false, byteLength, failure: 'invalid-structure' }
    }
    if (readUint32Be(bytes, crcOffset) !== pngCrc32(bytes, offset + 4, crcOffset)) {
      return { valid: false, byteLength, failure: 'crc' }
    }
    if (type === 'IDAT') hasIdat = true
    if (type === 'IEND') {
      return dataLength === 0 && hasIdat && nextOffset === byteLength
        ? { valid: true, byteLength }
        : { valid: false, byteLength, failure: 'invalid-structure' }
    }

    offset = nextOffset
    chunkIndex += 1
  }
  return { valid: false, byteLength, failure: 'truncated' }
}

export function isValidPng(bytes: Uint8Array): boolean {
  return inspectPng(bytes).valid
}

export function describePngFailure(failure: PngValidationFailure | undefined): string {
  switch (failure) {
    case 'non-png':
      return 'non-PNG format'
    case 'truncated':
      return 'PNG truncation'
    case 'crc':
      return 'PNG CRC mismatch'
    case 'invalid-structure':
      return 'invalid PNG structure'
    default:
      return 'invalid PNG'
  }
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes)
  crcInput.set(data, typeBytes.length)
  const chunk = new Uint8Array(12 + data.length)
  chunk.set(
    Uint8Array.from([
      (data.length >>> 24) & 0xff,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff
    ])
  )
  chunk.set(typeBytes, 4)
  chunk.set(data, 8)
  const crc = pngCrc32(crcInput, 0, crcInput.length)
  chunk.set(
    Uint8Array.from([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]),
    8 + data.length
  )
  return chunk
}

export function addBatchPngMetadata(
  bytes: Uint8Array,
  metadata: ComfyBatchOutputMetadata
): Uint8Array {
  if (!isValidPng(bytes)) throw new Error('ComfyUI output is not a valid PNG')
  const text = new TextEncoder().encode(`${BATCH_PNG_TEXT_KEY}\0${JSON.stringify(metadata)}`)
  let offset = PNG_SIGNATURE.length
  while (offset <= bytes.length - 12) {
    const dataLength = readUint32Be(bytes, offset)
    const nextOffset = offset + 12 + dataLength
    if (chunkType(bytes, offset + 4) === 'IEND') {
      const chunk = makePngChunk('tEXt', text)
      const result = new Uint8Array(bytes.length + chunk.length)
      result.set(bytes.slice(0, offset))
      result.set(chunk, offset)
      result.set(bytes.slice(offset), offset + chunk.length)
      return result
    }
    offset = nextOffset
  }
  throw new Error('PNG is missing IEND')
}

export function inspectBatchPng(bytes: Uint8Array): BatchPngInspection {
  const inspection = inspectPng(bytes)
  if (!inspection.valid) return { ...inspection, metadata: null }

  let metadata: ComfyBatchOutputMetadata | null = null
  let offset = PNG_SIGNATURE.length
  while (offset <= bytes.length - 12) {
    const dataLength = readUint32Be(bytes, offset)
    const dataOffset = offset + 8
    const nextOffset = offset + 12 + dataLength
    if (chunkType(bytes, offset + 4) === 'tEXt') {
      const data = new TextDecoder().decode(bytes.slice(dataOffset, dataOffset + dataLength))
      const separator = data.indexOf('\0')
      if (separator >= 0 && data.slice(0, separator) === BATCH_PNG_TEXT_KEY) {
        try {
          const parsed = JSON.parse(data.slice(separator + 1)) as Partial<ComfyBatchOutputMetadata>
          if (
            typeof parsed.sourceSha256 === 'string' &&
            typeof parsed.planFingerprint === 'string'
          ) {
            metadata = parsed as ComfyBatchOutputMetadata
          }
        } catch {
          return { ...inspection, metadata: null }
        }
      }
    }
    if (chunkType(bytes, offset + 4) === 'IEND') break
    offset = nextOffset
  }
  return { ...inspection, metadata }
}

export function readBatchPngMetadata(bytes: Uint8Array): ComfyBatchOutputMetadata | null {
  return inspectBatchPng(bytes).metadata
}
