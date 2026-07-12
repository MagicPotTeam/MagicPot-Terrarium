import { describe, expect, it } from 'vitest'
import { isAnimatedGifCanvasImage } from './canvasAnimatedImageUtils'
import type { CanvasImageItem } from './types'

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'https://example.com/image.png',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

describe('isAnimatedGifCanvasImage', () => {
  it('recognizes GIFs from data MIME, blob MIME, filenames, provenance, and URL paths', () => {
    expect(isAnimatedGifCanvasImage(createItem({ src: 'data:image/gif;base64,R0lGODlh' }))).toBe(
      true
    )
    expect(
      isAnimatedGifCanvasImage(
        createItem({ src: 'blob:local-image', sourceFile: new Blob([], { type: 'image/gif' }) })
      )
    ).toBe(true)
    expect(isAnimatedGifCanvasImage(createItem({ fileName: 'animation.GIF' }))).toBe(true)
    expect(
      isAnimatedGifCanvasImage(
        createItem({ provenance: { kind: 'imported-file', sourceFileName: 'source.gif' } })
      )
    ).toBe(true)
    expect(
      isAnimatedGifCanvasImage(
        createItem({ src: 'https://example.com/path/animation.gif?token=1' })
      )
    ).toBe(true)
  })

  it('does not classify static image sources as GIFs', () => {
    expect(isAnimatedGifCanvasImage(createItem())).toBe(false)
    expect(isAnimatedGifCanvasImage(createItem({ src: 'data:image/png;base64,AA==' }))).toBe(false)
  })
})
