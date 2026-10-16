import { describe, expect, it } from 'vitest'
import {
  readLocalFileResponseSchema,
  agentLocalFilesSvcDef,
  type ReadLocalFileResponse
} from './svcAgentLocalFiles'

const pdf = (): ReadLocalFileResponse => ({
  name: 'owned.pdf',
  relativePath: '',
  encoding: 'utf-8',
  sizeBytes: 4096,
  returnedBytes: new TextEncoder().encode('UNIQUE-TEXT-42').byteLength,
  content: 'UNIQUE-TEXT-42',
  truncated: false,
  document: {
    format: 'pdf',
    sourceSha256: 'e'.repeat(64),
    warnings: ['reading-order-unverified'],
    segments: [{ text: 'UNIQUE-TEXT-42', locator: { kind: 'pdf-item', page: 2, item: 0 } }]
  }
})

describe('local document public protocol', () => {
  it('admits only matching extracted text, parent provenance and format locators', () => {
    expect(readLocalFileResponseSchema.parse(pdf())).toEqual(pdf())
    expect(typeof agentLocalFilesSvcDef.setScope.request).toBe('function')
  })
  it.each([
    ['content divergence', (value: ReadLocalFileResponse) => ({ ...value, content: 'tampered' })],
    ['incorrect byte count', (value: ReadLocalFileResponse) => ({ ...value, returnedBytes: 12 })],
    ['unsound truncation', (value: ReadLocalFileResponse) => ({ ...value, truncated: true })],
    [
      'duplicate warning',
      (value: ReadLocalFileResponse) => ({
        ...value,
        document: {
          ...value.document,
          warnings: ['reading-order-unverified', 'reading-order-unverified']
        }
      })
    ],
    [
      'wrong locator format',
      (value: ReadLocalFileResponse) => ({
        ...value,
        document: { ...value.document, format: 'pptx' }
      })
    ],
    [
      'zero page',
      (value: ReadLocalFileResponse) => ({
        ...value,
        document: {
          ...value.document,
          segments: [{ text: value.content, locator: { kind: 'pdf-item', page: 0, item: 0 } }]
        }
      })
    ],
    ['authority field', (value: ReadLocalFileResponse) => ({ ...value, grantId: 'a'.repeat(32) })],
    [
      'parser path leak',
      (value: ReadLocalFileResponse) => ({
        ...value,
        document: { ...value.document, absolutePath: 'synthetic-only' }
      })
    ]
  ])('rejects %s', (_label, transform) => {
    expect(readLocalFileResponseSchema.safeParse(transform(pdf())).success).toBe(false)
  })
  it('preserves the original 64-KiB plain-text byte contract despite JSON escaping', () => {
    for (const content of ['\u0001'.repeat(64 * 1024), '"'.repeat(64 * 1024)]) {
      expect(
        readLocalFileResponseSchema.safeParse({
          ...pdf(),
          name: 'owned.txt',
          document: undefined,
          content,
          returnedBytes: new TextEncoder().encode(content).byteLength
        }).success
      ).toBe(true)
    }
  })
  it.each(['\ud800', '\udc00'])(
    'rejects ill-formed Unicode in content and each individual segment',
    (content) => {
      expect(
        readLocalFileResponseSchema.safeParse({
          ...pdf(),
          content,
          returnedBytes: new TextEncoder().encode(content).byteLength,
          document: undefined
        }).success
      ).toBe(false)
      const pair = '\ud83d\udca9'
      expect(
        readLocalFileResponseSchema.safeParse({
          ...pdf(),
          content: pair,
          returnedBytes: 4,
          document: {
            ...pdf().document,
            segments: [
              { text: pair[0], locator: { kind: 'pdf-item', page: 1, item: 0 } },
              { text: pair[1], locator: { kind: 'pdf-item', page: 1, item: 1 } }
            ]
          }
        }).success
      ).toBe(false)
    }
  )

  it('enforces the UTF-8 wire budget including duplicated content and locators', () => {
    const text = '\\'.repeat(64 * 1024)
    const value = {
      ...pdf(),
      content: text,
      returnedBytes: text.length,
      document: {
        ...pdf().document,
        segments: [{ text, locator: { kind: 'pdf-item', page: 1, item: 0 } }]
      }
    }
    expect(readLocalFileResponseSchema.safeParse(value).success).toBe(false)
  })
  it('keeps truncation explicit for document extraction but disallows silent plain-text truncation', () => {
    const value = pdf()
    expect(
      readLocalFileResponseSchema.safeParse({
        ...value,
        truncated: true,
        document: { ...value.document, warnings: ['output-truncated'] }
      }).success
    ).toBe(true)
    expect(
      readLocalFileResponseSchema.safeParse({ ...value, document: undefined, truncated: true })
        .success
    ).toBe(false)
  })
})
