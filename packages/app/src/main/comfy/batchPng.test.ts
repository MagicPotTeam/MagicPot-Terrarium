import { describe, expect, it } from 'vitest'
import {
  addBatchPngMetadata,
  describePngFailure,
  inspectBatchPng,
  inspectPng,
  isValidPng
} from './batchPng'

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)

describe('batch PNG validation', () => {
  it('keeps complete structure and CRC validation strict', () => {
    expect(isValidPng(validPng)).toBe(true)
    expect(inspectPng(validPng.subarray(0, -1))).toMatchObject({
      valid: false,
      failure: 'truncated',
      byteLength: validPng.length - 1
    })
    const crcCorrupt = Buffer.from(validPng)
    crcCorrupt[20] ^= 1
    expect(inspectPng(crcCorrupt)).toMatchObject({ valid: false, failure: 'crc' })
    expect(inspectPng(Buffer.from('not an image'))).toMatchObject({
      valid: false,
      failure: 'non-png'
    })
  })

  it('adds metadata without weakening validation', () => {
    const bytes = addBatchPngMetadata(validPng, { sourceSha256: 'source', planFingerprint: 'plan' })
    expect(inspectBatchPng(bytes)).toMatchObject({
      valid: true,
      metadata: { sourceSha256: 'source', planFingerprint: 'plan' }
    })
    expect(isValidPng(bytes)).toBe(true)
  })

  it('provides stable diagnostics for each malformed class', () => {
    expect(describePngFailure('non-png')).toBe('non-PNG format')
    expect(describePngFailure('truncated')).toBe('PNG truncation')
    expect(describePngFailure('crc')).toBe('PNG CRC mismatch')
  })
})
