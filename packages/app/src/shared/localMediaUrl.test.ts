import { describe, expect, it } from 'vitest'
import { localMediaUrlToFilePath, toLocalMediaUrl } from './localMediaUrl'

describe('shared local-media URL conversion', () => {
  it.each([
    {
      label: 'Windows drive',
      filePath: String.raw`C:\assets\hash#query?\literal%2F-%25-图像.png`,
      url: 'local-media:///C:/assets/hash%23query%3F/literal%252F-%2525-%E5%9B%BE%E5%83%8F.png',
      parsed: 'C:/assets/hash#query?/literal%2F-%25-图像.png'
    },
    {
      label: 'POSIX',
      filePath: '/Users/demo/a b/图像.png',
      url: 'local-media:///Users/demo/a%20b/%E5%9B%BE%E5%83%8F.png',
      parsed: '/Users/demo/a b/图像.png'
    },
    {
      label: 'UNC',
      filePath: String.raw`\\server-name\share\x.png`,
      url: 'local-media://server-name/share/x.png',
      parsed: '//server-name/share/x.png'
    }
  ])('round-trips $label paths', ({ filePath, url, parsed }) => {
    expect(toLocalMediaUrl(filePath)).toBe(url)
    expect(localMediaUrlToFilePath(url)).toBe(parsed)
  })

  it('parses the unencoded producer form, drive hosts and file URLs', () => {
    expect(localMediaUrlToFilePath('local-media:///C:/a b/r.md')).toBe('C:/a b/r.md')
    expect(localMediaUrlToFilePath('local-media://c/dir/r.md')).toBe('c:/dir/r.md')
    expect(localMediaUrlToFilePath('file:///home/u/r.md')).toBe('/home/u/r.md')
  })

  it('returns null for other schemes, undecodable input and empty paths', () => {
    expect(localMediaUrlToFilePath('https://example.test/r.md')).toBeNull()
    expect(localMediaUrlToFilePath('data:text/plain,abc')).toBeNull()
    expect(localMediaUrlToFilePath('local-media:///%E0%A4%A')).toBeNull()
    expect(localMediaUrlToFilePath('not a url')).toBeNull()
    expect(toLocalMediaUrl('   ')).toBeNull()
    expect(toLocalMediaUrl('//')).toBeNull()
  })
})
