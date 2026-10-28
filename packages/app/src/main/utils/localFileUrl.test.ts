import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLocalFileSource, normalizeLocalFilePath, toFileUrl } from './localFileUrl'

describe('localFileUrl', () => {
  it('normalizes local-media and file URLs into local file paths', () => {
    expect(normalizeLocalFilePath('local-media:///C:/MagicPot/output/image%20one.png')).toBe(
      'C:/MagicPot/output/image one.png'
    )
    expect(normalizeLocalFilePath('local-media://c/Users/17290/Desktop/image%20one.png')).toBe(
      'C:/Users/17290/Desktop/image one.png'
    )
    expect(normalizeLocalFilePath('file:///tmp/magicpot/video%20clip.mp4')).toBe(
      '/tmp/magicpot/video clip.mp4'
    )
  })

  it('detects local file sources across supported formats', () => {
    expect(isLocalFileSource('local-media:///C:/MagicPot/output/image.png')).toBe(true)
    expect(isLocalFileSource('file:///tmp/magicpot/video.mp4')).toBe(true)
    expect(isLocalFileSource('C:/MagicPot/output/image.png')).toBe(true)
    expect(isLocalFileSource('/tmp/magicpot/video.mp4')).toBe(true)
    expect(isLocalFileSource('https://example.com/image.png')).toBe(false)
  })

  it('converts local sources back into fetchable file URLs', () => {
    expect(toFileUrl('local-media:///C:/MagicPot/output/image%20one.png')).toBe(
      'file:///C:/MagicPot/output/image%20one.png'
    )
    expect(toFileUrl('local-media://c/Users/17290/Desktop/image%20one.png')).toBe(
      'file:///C:/Users/17290/Desktop/image%20one.png'
    )
    const localUrl = toFileUrl('/tmp/magicpot/video clip.mp4')
    expect(fileURLToPath(localUrl)).toBe(resolve('/tmp/magicpot/video clip.mp4'))
    expect(localUrl).toMatch(/\/tmp\/magicpot\/video%20clip\.mp4$/)
  })

  it('encodes non-ascii local file paths into safe file URLs', () => {
    expect(toFileUrl('local-media:///C:/MagicPot/output/坦克 拆分902.png')).toBe(
      'file:///C:/MagicPot/output/%E5%9D%A6%E5%85%8B%20%E6%8B%86%E5%88%86902.png'
    )
  })

  describe.each(['file', 'local-media'])('%s URL single decoding', (scheme) => {
    const encodedName = 'literal%2520%252F%20%E5%9B%BE%E7%89%87%23.png'
    const decodedName = 'literal%20%2F \u56fe\u7247#.png'

    it.each([
      [':///C:/assets/', 'C:/assets/'],
      [':///tmp/assets/', '/tmp/assets/'],
      ['://c/assets/', 'C:/assets/'],
      ['://server/share/', '//server/share/'],
      [':////%3F/C:/assets/', '//?/C:/assets/'],
      [':////%3F/UNC/server/share/', '//?/UNC/server/share/']
    ])('preserves literal escapes through %s', (urlPrefix, expectedPathPrefix) => {
      const source = `${scheme}${urlPrefix}${encodedName}`
      expect(normalizeLocalFilePath(source)).toBe(`${expectedPathPrefix}${decodedName}`)
      expect(isLocalFileSource(source)).toBe(true)
    })

    it('does not confuse a literal percent-escape filename with a space filename', () => {
      const literalPercent = `${scheme}:///C:/images/image%2520one.png`
      const actualSpace = `${scheme}:///C:/images/image%20one.png`
      expect(normalizeLocalFilePath(literalPercent)).toBe('C:/images/image%20one.png')
      expect(normalizeLocalFilePath(actualSpace)).toBe('C:/images/image one.png')
      expect(normalizeLocalFilePath(literalPercent)).not.toBe(normalizeLocalFilePath(actualSpace))
      expect(toFileUrl(literalPercent)).toBe('file:///C:/images/image%2520one.png')
      expect(toFileUrl(actualSpace)).toBe('file:///C:/images/image%20one.png')
    })

    it('keeps encoded-looking directory names from becoming separators or traversal', () => {
      expect(normalizeLocalFilePath(`${scheme}:///C:/images/%252F/%255C/%252e%252e/a.png`)).toBe(
        'C:/images/%2F/%5C/%2e%2e/a.png'
      )
    })
  })

  it.each([
    'C:/images/literal%20%2F \u56fe\u7247.png',
    'C:\\images\\literal%20%2F \u56fe\u7247.png',
    '/tmp/images/literal%20%2F \u56fe\u7247.png',
    '//server/share/literal%20%2F \u56fe\u7247.png',
    '\\\\server\\share\\literal%20%2F \u56fe\u7247.png'
  ])('does not decode raw filesystem paths: %s', (source) => {
    expect(normalizeLocalFilePath(source)).toBe(source)
  })

  it('round-trips Windows raw path escapes without changing the selected filename', () => {
    const source = 'C:\\images\\literal%20%2F \u56fe\u7247.png'
    const encoded = toFileUrl(source)
    expect(encoded).toBe('file:///C:/images/literal%2520%252F%20%E5%9B%BE%E7%89%87.png')
    expect(normalizeLocalFilePath(encoded)).toBe(source.replace(/\\/g, '/'))
  })
})
