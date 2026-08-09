import { describe, expect, it } from 'vitest'
import type { ChatAttachment as ApiChatAttachment } from './api/svcLLMProxy'
import type { ChatAttachment as LLMChatAttachment } from './llm/types'
import { isMediaReference, normalizeMediaReference } from './mediaReference'

const hash = 'A'.repeat(64)
const baseReference = {
  version: 1,
  kind: 'managed',
  relativePath: 'assets/image.png',
  sha256: hash,
  sizeBytes: 42,
  mimeType: 'image/png',
  originalFileName: 'image.png'
} as const

const validDerivative = (overrides: Record<string, unknown> = {}) => ({
  maxEdge: 512,
  relativePath: 'derivatives/preview.webp',
  mimeType: 'image/webp',
  sizeBytes: 1_024,
  width: 512,
  height: 384,
  sha256: 'B'.repeat(64),
  ...overrides
})

describe('MediaReference', () => {
  it.each(['managed', 'project-asset'] as const)(
    'accepts and normalizes a valid %s reference',
    (kind) => {
      const input = {
        version: 1,
        kind,
        relativePath: 'chat/assets/image.png',
        sha256: hash,
        sizeBytes: 42,
        mimeType: 'IMAGE/PNG',
        originalFileName: 'image.png',
        unknownProperty: 'discard me'
      }

      expect(normalizeMediaReference(input)).toEqual({
        version: 1,
        kind,
        relativePath: 'chat/assets/image.png',
        sha256: hash.toLowerCase(),
        sizeBytes: 42,
        mimeType: 'image/png',
        originalFileName: 'image.png'
      })
      expect(isMediaReference(input)).toBe(true)
    }
  )

  it('accepts bounded persisted metadata and strips unknown nested properties', () => {
    const input = {
      ...baseReference,
      mediaId: 'media_A-1.0',
      originalUrl: 'https://example.com/original/image.png',
      width: 4_096,
      height: 2_160,
      status: 'ready',
      derivatives: [
        {
          maxEdge: 512,
          relativePath: 'derivatives/media_A-1.0/512.webp',
          mimeType: 'IMAGE/WEBP',
          sizeBytes: 12_345,
          width: 512,
          height: 270,
          sha256: 'B'.repeat(64),
          localMediaUrl: 'local-media:///must-not-persist',
          unknownProperty: true
        }
      ],
      unknownProperty: 'discard me'
    }

    expect(normalizeMediaReference(input)).toEqual({
      ...baseReference,
      sha256: hash.toLowerCase(),
      mediaId: 'media_A-1.0',
      originalUrl: 'https://example.com/original/image.png',
      width: 4_096,
      height: 2_160,
      status: 'ready',
      derivatives: [
        {
          maxEdge: 512,
          relativePath: 'derivatives/media_A-1.0/512.webp',
          mimeType: 'image/webp',
          sizeBytes: 12_345,
          width: 512,
          height: 270,
          sha256: 'b'.repeat(64)
        }
      ]
    })
  })

  it.each([
    ['empty media ID', { mediaId: '' }],
    ['media ID with whitespace', { mediaId: 'media id' }],
    ['overlong media ID', { mediaId: 'x'.repeat(256) }],
    ['relative original URL', { originalUrl: '../image.png' }],
    ['unsupported original URL scheme', { originalUrl: 'javascript:alert(1)' }],
    ['original URL with credentials', { originalUrl: 'https://user:secret@example.com/image.png' }],
    ['original URL with control data', { originalUrl: 'https://example.com/a\n.png' }],
    ['overlong original URL', { originalUrl: `https://example.com/${'x'.repeat(8_192)}` }],
    ['zero width', { width: 0 }],
    ['fractional height', { height: 1.5 }],
    ['unbounded width', { width: 1_000_001 }],
    ['unknown status', { status: 'available' }]
  ])('rejects unsafe persisted metadata: %s', (_label, metadata) => {
    expect(normalizeMediaReference({ ...baseReference, ...metadata })).toBeUndefined()
  })

  it.each([
    ['non-array descriptors', {}],
    ['too many descriptors', Array.from({ length: 17 }, () => validDerivative())],
    ['unsupported max edge', [validDerivative({ maxEdge: 255 })]],
    ['unsafe relative path', [validDerivative({ relativePath: '../outside.webp' })]],
    ['encoded traversal', [validDerivative({ relativePath: 'derivatives/%2e%2e/outside.webp' })]],
    ['absolute path', [validDerivative({ relativePath: '/derivatives/preview.webp' })]],
    ['invalid MIME type', [validDerivative({ mimeType: 'image/webp; charset=x' })]],
    ['non-positive size', [validDerivative({ sizeBytes: 0 })]],
    ['unbounded dimensions', [validDerivative({ width: 1_000_001 })]],
    ['invalid hash', [validDerivative({ sha256: 'bad' })]],
    [
      'duplicate relative path',
      [validDerivative(), validDerivative({ maxEdge: 1024, width: 1024, height: 768 })]
    ]
  ])('rejects invalid derivative metadata: %s', (_label, derivatives) => {
    expect(normalizeMediaReference({ ...baseReference, derivatives })).toBeUndefined()
  })

  it('preserves version 1 references that predate optional metadata', () => {
    expect(normalizeMediaReference(baseReference)).toEqual({
      ...baseReference,
      sha256: hash.toLowerCase()
    })
  })

  it('keeps legacy attachment JSON without media unchanged', () => {
    const legacy = { type: 'file', url: 'data:text/plain;base64,SGk=', fileName: 'note.txt' }
    const apiAttachment: ApiChatAttachment = JSON.parse(JSON.stringify(legacy))
    const llmAttachment: LLMChatAttachment = JSON.parse(JSON.stringify(legacy))

    expect(apiAttachment).toEqual(legacy)
    expect(llmAttachment).toEqual(legacy)
    expect('media' in apiAttachment).toBe(false)
    expect('media' in llmAttachment).toBe(false)
  })

  it.each([
    ['NUL', 'assets/image\0.png'],
    ['C0 control', 'assets/image\n.png'],
    ['C1 control', 'assets/image\u0085.png'],
    ['query delimiter', 'assets/image.png?download=1'],
    ['fragment delimiter', 'assets/image.png#preview'],
    ['colon', 'assets/image:preview.png'],
    ['malformed percent escape', 'assets/image%2.png'],
    ['encoded traversal', 'assets/%2e%2e/secret.png'],
    ['encoded slash', 'assets%2fsecret.png'],
    ['encoded backslash', 'assets%5csecret.png'],
    ['encoded NUL', 'assets/image%00.png'],
    ['encoded control', 'assets/image%0a.png'],
    ['encoded query delimiter', 'assets/image.png%3fdownload=1'],
    ['encoded fragment delimiter', 'assets/image.png%23preview'],
    ['encoded colon', 'assets/image%3apreview.png'],
    ['encoded ordinary character (not canonical decoded form)', 'assets/image%20name.png'],
    ['absolute POSIX path', '/assets/image.png'],
    ['drive path', 'C:/assets/image.png'],
    ['drive-relative path', 'C:assets/image.png'],
    ['UNC path', '//server/share/image.png'],
    ['Windows UNC path', '\\\\server\\share\\image.png'],
    ['backslash', 'assets\\image.png'],
    ['dot segment', 'assets/./image.png'],
    ['dotdot segment', 'assets/../secret.png'],
    ['leading empty segment', '/assets/image.png'],
    ['middle empty segment', 'assets//image.png'],
    ['trailing empty segment', 'assets/image.png/']
  ])('rejects relativePath with %s', (_label, relativePath) => {
    const input = { ...baseReference, relativePath }
    expect(normalizeMediaReference(input)).toBeUndefined()
    expect(isMediaReference(input)).toBe(false)
  })

  it.each([
    ['missing subtype', 'image'],
    ['empty type', '/png'],
    ['empty subtype', 'image/'],
    ['extra slash', 'image/png/extra'],
    ['parameter', 'image/png; charset=utf-8'],
    ['space', 'image /png'],
    ['tab', 'image/\tpng'],
    ['newline', 'image/png\n'],
    ['NUL', 'image/\0png'],
    ['non-ASCII token', 'image/pñg'],
    ['overlong value', 'x'.repeat(256)]
  ])('rejects mimeType with %s', (_label, mimeType) => {
    expect(normalizeMediaReference({ ...baseReference, mimeType })).toBeUndefined()
  })

  it.each([
    ['slash', 'folder/image.png'],
    ['backslash', 'folder\\image.png'],
    ['NUL', 'image\0.png'],
    ['C0 control', 'image\r.png'],
    ['C1 control', 'image\u009f.png'],
    ['dot', '.'],
    ['dotdot', '..'],
    ['empty value', ''],
    ['overlong value', 'x'.repeat(256)]
  ])('rejects originalFileName with %s', (_label, originalFileName) => {
    expect(normalizeMediaReference({ ...baseReference, originalFileName })).toBeUndefined()
  })

  it('requires integrity and descriptive fields for managed references only', () => {
    expect(
      normalizeMediaReference({ version: 1, kind: 'managed', relativePath: 'assets/image.png' })
    ).toBeUndefined()
    expect(
      normalizeMediaReference({
        version: 1,
        kind: 'project-asset',
        relativePath: 'assets/image.png'
      })
    ).toEqual({ version: 1, kind: 'project-asset', relativePath: 'assets/image.png' })
  })

  it('applies Windows-safe filenames to managed references without breaking project assets', () => {
    expect(
      normalizeMediaReference({ ...baseReference, originalFileName: 'CON.png' })
    ).toBeUndefined()
    expect(
      normalizeMediaReference({
        version: 1,
        kind: 'project-asset',
        relativePath: 'assets/legacy.png',
        originalFileName: 'CON.png'
      })
    ).toEqual({
      version: 1,
      kind: 'project-asset',
      relativePath: 'assets/legacy.png',
      originalFileName: 'CON.png'
    })
  })

  it('rejects overlong relative paths', () => {
    expect(
      normalizeMediaReference({ ...baseReference, relativePath: `assets/${'x'.repeat(1_024)}` })
    ).toBeUndefined()
  })

  it.each([
    ['invalid hash', { ...baseReference, sha256: 'abc' }],
    ['invalid version', { ...baseReference, version: 2 }],
    ['invalid kind', { ...baseReference, kind: 'external' }],
    ['non-positive size', { ...baseReference, sizeBytes: 0 }],
    ['unsafe size', { ...baseReference, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }]
  ])('rejects %s', (_label, input) => {
    expect(normalizeMediaReference(input)).toBeUndefined()
    expect(isMediaReference(input)).toBe(false)
  })
})
