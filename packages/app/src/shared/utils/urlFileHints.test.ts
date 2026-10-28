import { describe, expect, it } from 'vitest'
import { getFileNameHintFromContentDisposition, getFileNameHintFromUrl } from './urlFileHints'

describe('getFileNameHintFromUrl', () => {
  it.each([
    ['https://example.test/models/chair.glb?token=ignored#preview', 'chair.glb'],
    ['https://example.test/models/chair+table.glb', 'chair+table.glb'],
    ['https://example.test/models/chair%2Btable.glb', 'chair+table.glb'],
    ['https://example.test/models/chair%23preview.glb', 'chair#preview.glb'],
    ['https://example.test/models/chair%3Fpreview.glb', 'chair?preview.glb'],
    ['https://example.test/models/literal%2520name.glb', 'literal%20name.glb'],
    ['https://example.test/models/%E6%A4%85%E5%AD%90.glb', '椅子.glb'],
    ['https://example.test/download?filename=chair+table.glb', 'chair table.glb'],
    ['https://example.test/download?filename=chair%2Btable.glb', 'chair+table.glb'],
    ['https://example.test/download?filename=chair%23preview.glb', 'chair#preview.glb'],
    ['https://example.test/download?filename=literal%2520name.glb', 'literal%20name.glb'],
    ['https://example.test/download?path=project%2Fmodels%2Fchair.glb', 'chair.glb'],
    ['https://example.test/download?filename=unknown&filename=chair.glb', 'chair.glb'],
    ['https://example.test/download?unusualKey=chair.glb', 'chair.glb'],
    ['https://example.test/models/chair.glb?filename=other.fbx', 'chair.glb'],
    ['models/chair%23preview.glb?token=ignored', 'chair#preview.glb'],
    ['chair+table.glb', 'chair+table.glb'],
    ['C:\\models\\chair#preview.glb', 'chair#preview.glb'],
    ['C:\\models\\literal%20name.glb', 'literal%20name.glb']
  ])('extracts %s without decoding filename data twice', (url, expected) => {
    expect(getFileNameHintFromUrl(url)).toBe(expected)
  })

  it.each(['', 'https://example.test/download?id=123', 'https://example.test/folder.glb/'])(
    'does not invent a file name for %j',
    (url) => {
      expect(getFileNameHintFromUrl(url)).toBe('')
    }
  )

  it('decodes a query envelope once and the extended filename separately', () => {
    const disposition =
      "attachment; filename=backup.fbx; filename*=UTF-8'zh'%E6%A4%85%E5%AD%90%2B%23.glb"
    const url = new URL('https://example.test/download')
    url.searchParams.set('response-content-disposition', disposition)
    expect(getFileNameHintFromUrl(url.href)).toBe('椅子+#.glb')
  })

  it('preserves percent escapes that are literal data in a quoted header filename', () => {
    const url = new URL('https://example.test/download')
    url.searchParams.set(
      'response-content-disposition',
      'attachment; filename="literal%20+name.glb"'
    )
    expect(getFileNameHintFromUrl(url.href)).toBe('literal%20+name.glb')
  })

  it('ignores malformed disposition hints and continues to another query candidate', () => {
    const url = new URL('https://example.test/download')
    url.searchParams.set('response-content-disposition', 'attachment; x-filename=wrong.fbx')
    url.searchParams.set('object', 'correct.glb')
    expect(getFileNameHintFromUrl(url.href)).toBe('correct.glb')
  })
})

describe('getFileNameHintFromContentDisposition', () => {
  it.each([
    ['attachment; filename="chair.glb"', 'chair.glb'],
    ['attachment; filename="chair;version=2.glb"', 'chair;version=2.glb'],
    ['attachment; filename="chair+table#preview.glb"', 'chair+table#preview.glb'],
    ['attachment; filename="literal%20name.glb"', 'literal%20name.glb'],
    ['attachment; filename="folder/chair.glb"', 'chair.glb'],
    ['attachment; filename="chair\\"v2.glb"', 'chair"v2.glb'],
    ["attachment; filename*=UTF-8''chair%3Bv2.glb", 'chair;v2.glb'],
    ["attachment; filename*=UTF-8'en'chair%2B%23.glb", 'chair+#.glb'],
    ["attachment; filename*=utf-8'zh'%E6%A4%85%E5%AD%90.glb", '椅子.glb'],
    ["attachment; filename*=UTF-8''literal%2520name.glb", 'literal%20name.glb'],
    ["attachment; filename=backup.fbx; filename*=UTF-8''chair.glb", 'chair.glb'],
    ["attachment; filename*=UTF-8''chair.glb; filename=backup.fbx", 'chair.glb'],
    ["attachment; filename*=UTF-8''%ZZ.glb; filename=backup.fbx", 'backup.fbx'],
    ["attachment; filename*=unknown''chair.glb; filename=backup.fbx", 'backup.fbx'],
    ['inline; FILENAME = "chair.glb"', 'chair.glb']
  ])('parses %s using parameter boundaries', (header, expected) => {
    expect(getFileNameHintFromContentDisposition(header)).toBe(expected)
  })

  it.each([
    '',
    'attachment',
    'attachment; filename=download',
    'attachment; x-filename=wrong.glb',
    'attachment; note="text; filename=wrong.glb"',
    'attachment; filename="unterminated.glb',
    "attachment; filename*=UTF-8''bad%00name.glb",
    'attachment; filename="bad\r\nname.glb"'
  ])('ignores missing or invalid filename parameters in %j', (header) => {
    expect(getFileNameHintFromContentDisposition(header)).toBe('')
  })
})
