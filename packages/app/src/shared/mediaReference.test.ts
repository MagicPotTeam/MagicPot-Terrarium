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
