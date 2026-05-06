import { describe, expect, it } from 'vitest'
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
    expect(toFileUrl('/tmp/magicpot/video clip.mp4')).toBe(
      process.platform === 'win32'
        ? 'file:///C:/tmp/magicpot/video%20clip.mp4'
        : 'file:///tmp/magicpot/video%20clip.mp4'
    )
  })

  it('encodes non-ascii local file paths into safe file URLs', () => {
    expect(toFileUrl('local-media:///C:/MagicPot/output/坦克 拆分902.png')).toBe(
      'file:///C:/MagicPot/output/%E5%9D%A6%E5%85%8B%20%E6%8B%86%E5%88%86902.png'
    )
  })
})
