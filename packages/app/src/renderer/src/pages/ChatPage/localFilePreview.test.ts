import { describe, expect, it } from 'vitest'
import {
  formatLocalDocumentPreview,
  formatLocalFilePreview,
  LOCAL_FILE_PREVIEW_MAX_CHARS
} from './localFilePreview'
import type { ReadLocalFileResponse } from '@shared/api/svcAgentLocalFiles'

describe('local file visual preview', () => {
  it('renders page transitions without losing original segments or repeating a same-page heading', () => {
    const file: ReadLocalFileResponse = {
      name: 'owned.pdf',
      relativePath: '',
      encoding: 'utf-8',
      sizeBytes: 1024,
      returnedBytes: 3,
      content: 'ABC',
      truncated: false,
      document: {
        format: 'pdf',
        sourceSha256: '1'.repeat(64),
        warnings: ['reading-order-unverified'],
        segments: [
          { text: 'A', locator: { kind: 'pdf-item', page: 1, item: 0 } },
          { text: 'B', locator: { kind: 'pdf-item', page: 1, item: 1 } },
          { text: 'C', locator: { kind: 'pdf-item', page: 2, item: 0 } }
        ]
      }
    }
    expect(formatLocalDocumentPreview(file)).toBe('[Page 1]\nAB\n[Page 2]\nC')
    expect(file.content).toBe('ABC')
    expect(formatLocalDocumentPreview({ ...file, document: undefined })).toBe('ABC')
  })

  it('preserves empty, ordinary and HTML-looking text as plain display data', () => {
    for (const text of [
      '',
      'read me',
      '<script>not executable</script> & <a href="file:">data</a>'
    ]) {
      expect(formatLocalFilePreview(text)).toEqual({ text, escaped: false, truncated: false })
    }
  })

  it('preserves Unicode and script/emoji joiners without normalising the source', () => {
    const text = '中文 العربية אבג e\u0301 \u200C \u200D 👩‍💻 🏳️‍🌈'
    expect(formatLocalFilePreview(text)).toEqual({ text, escaped: false, truncated: false })
    expect(text).not.toBe(text.normalize('NFC'))
  })

  it('exposes all directional overrides, embeddings, isolates and marks', () => {
    const codes = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069
    ]
    const text = codes.map((code) => String.fromCodePoint(code)).join('')
    expect(formatLocalFilePreview(text)).toEqual({
      text: codes.map((code) => `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`).join(''),
      escaped: true,
      truncated: false
    })
  })

  it('preserves text line breaks and tabs but exposes other C0, DEL and C1 controls', () => {
    const value = '\tline\r\n\u0000\u0007\u000B\u007F\u0085\u009F'
    expect(formatLocalFilePreview(value)).toEqual({
      text: '\tline\r\n[U+0000][U+0007][U+000B][U+007F][U+0085][U+009F]',
      escaped: true,
      truncated: false
    })
  })

  it('exposes selected invisible formatting without interpreting its surrounding text', () => {
    const text = 'name\u00AD\u034F\u180E\u200B\u2060\u206A\u206F\uFEFF\uFFF9\uFFFB.txt'
    expect(formatLocalFilePreview(text)).toEqual({
      text: 'name[U+00AD][U+034F][U+180E][U+200B][U+2060][U+206A][U+206F][U+FEFF][U+FFF9][U+FFFB].txt',
      escaped: true,
      truncated: false
    })
  })

  it('exposes lone surrogates but keeps supplementary characters intact', () => {
    expect(formatLocalFilePreview('\uD800x\uDC00🧪')).toEqual({
      text: '[U+D800]x[U+DC00]🧪',
      escaped: true,
      truncated: false
    })
  })

  it('caps plain output and reports shortening without adding a fake source ellipsis', () => {
    const text = 'x'.repeat(LOCAL_FILE_PREVIEW_MAX_CHARS + 1)
    const preview = formatLocalFilePreview(text)
    expect(preview).toEqual({
      text: 'x'.repeat(LOCAL_FILE_PREVIEW_MAX_CHARS),
      escaped: false,
      truncated: true
    })
    expect(text.length).toBe(LOCAL_FILE_PREVIEW_MAX_CHARS + 1)
  })

  it('allows an exact output limit without a false shortening warning', () => {
    const text = 'x'.repeat(LOCAL_FILE_PREVIEW_MAX_CHARS)
    expect(formatLocalFilePreview(text)).toEqual({ text, escaped: false, truncated: false })
  })

  it('bounds marker expansion and never rewrites the original content', () => {
    const text = '\u202E'.repeat(20_000)
    expect(formatLocalFilePreview(text)).toEqual({
      text: '[U+202E]'.repeat(8192),
      escaped: true,
      truncated: true
    })
    expect(text).toBe('\u202E'.repeat(20_000))
  })

  it('does not split a marker when only part would fit', () => {
    const prefix = 'x'.repeat(LOCAL_FILE_PREVIEW_MAX_CHARS - 7)
    expect(formatLocalFilePreview(prefix + '\u202E')).toEqual({
      text: prefix,
      escaped: false,
      truncated: true
    })
  })

  it('does not split a supplementary code point at the output boundary', () => {
    const prefix = 'x'.repeat(LOCAL_FILE_PREVIEW_MAX_CHARS - 1)
    expect(formatLocalFilePreview(prefix + '🧪')).toEqual({
      text: prefix,
      escaped: false,
      truncated: true
    })
  })
})
