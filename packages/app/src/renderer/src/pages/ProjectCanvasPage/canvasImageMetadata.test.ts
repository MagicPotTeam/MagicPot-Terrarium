import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  detectImageHasAlpha,
  estimateDataUrlByteSize,
  inferKnownImageHasAlpha
} from './canvasImageMetadata'

describe('canvasImageMetadata', () => {
  const originalVideoFrame = globalThis.VideoFrame

  beforeEach(() => {
    class MockVideoFrame {
      constructor(_source: CanvasImageSource, _init?: VideoFrameInit) {
        void _source
        void _init
      }

      allocationSize(): number {
        return 8
      }

      async copyTo(destination: AllowSharedBufferSource): Promise<void> {
        new Uint8Array(destination as ArrayBufferLike).set([0, 0, 0, 255, 255, 255, 255, 128])
      }

      close(): void {
        return
      }
    }

    vi.stubGlobal('VideoFrame', MockVideoFrame as unknown as typeof VideoFrame)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.VideoFrame = originalVideoFrame
  })

  it('estimates byte size for base64 data URLs', () => {
    expect(estimateDataUrlByteSize('data:image/jpeg;base64,SGVsbG8=')).toBe(5)
  })

  it('marks jpeg images as opaque without pixel inspection', () => {
    expect(inferKnownImageHasAlpha('hero.jpg')).toBe(false)
    expect(inferKnownImageHasAlpha(undefined, 'data:image/jpeg;base64,SGVsbG8=')).toBe(false)
  })

  it('detects alpha pixels for png images', async () => {
    const image = {
      naturalWidth: 64,
      naturalHeight: 64,
      width: 64,
      height: 64
    } as HTMLImageElement

    await expect(
      detectImageHasAlpha({
        fileName: 'hero.png',
        sourceUrl: 'data:image/png;base64,AAAA',
        image
      })
    ).resolves.toBe(true)
  })
})
