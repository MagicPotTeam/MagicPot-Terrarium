import { describe, expect, it } from 'vitest'
import type { CanvasImageItem } from './types'
import {
  normalizeCanvasImageDisplayCrop,
  resolveCanvasImageDisplayCrop,
  resolveCanvasImageDomPreviewLayout
} from './canvasImageDisplayUtils'

function createImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'img-1',
    type: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    src: 'https://example.com/image.png',
    ...overrides
  }
}

describe('resolveCanvasImageDisplayCrop', () => {
  it('returns the original crop when source and display sizes already match', () => {
    const crop = { x: 10, y: 20, width: 30, height: 40 }

    expect(resolveCanvasImageDisplayCrop(createItem({ crop }), createImage(100, 80))).toEqual(crop)
  })

  it('scales crop coordinates into the loaded image pixel space', () => {
    const item = createItem({
      crop: { x: 20, y: 30, width: 50, height: 60 },
      sourceWidth: 200,
      sourceHeight: 100
    })

    expect(resolveCanvasImageDisplayCrop(item, createImage(400, 200))).toEqual({
      x: 40,
      y: 60,
      width: 100,
      height: 120
    })
  })

  it('clamps scaled crop rectangles to the loaded image bounds', () => {
    const item = createItem({
      crop: { x: -10, y: 10, width: 100, height: 100 },
      sourceWidth: 100,
      sourceHeight: 100
    })

    expect(resolveCanvasImageDisplayCrop(item, createImage(80, 60))).toEqual({
      x: 0,
      y: 6,
      width: 72,
      height: 54
    })
  })

  it('ignores extreme strip crops that are incompatible with the displayed image bounds', () => {
    const item = createItem({
      width: 19_717,
      height: 12_079,
      crop: { x: 0, y: 0, width: 19_717, height: 1 },
      sourceWidth: 19_717,
      sourceHeight: 12_079
    })

    expect(resolveCanvasImageDisplayCrop(item, createImage(512, 314))).toBeUndefined()
  })
})

describe('resolveCanvasImageDomPreviewLayout', () => {
  it('drops source preview layouts when source and asset aspects do not match', () => {
    const item = createItem({
      width: 100,
      height: 80,
      crop: { x: 0, y: 0, width: 100, height: 40 },
      image: createImage(400, 20),
      sourceWidth: 100,
      sourceHeight: 100
    })

    expect(resolveCanvasImageDomPreviewLayout(item)).toBeNull()
  })

  it('drops extreme crop layouts that would cover the canvas with a huge source image strip', () => {
    const item = createItem({
      width: 19_717,
      height: 12_079,
      crop: { x: 0, y: 0, width: 19_717, height: 1 },
      image: createImage(512, 314),
      sourceWidth: 19_717,
      sourceHeight: 12_079
    })

    expect(resolveCanvasImageDomPreviewLayout(item)).toBeNull()
  })

  it('keeps normal crop layouts for matching source previews', () => {
    const item = createItem({
      width: 100,
      height: 50,
      crop: { x: 0, y: 0, width: 400, height: 100 },
      image: createImage(400, 200),
      sourceWidth: 400,
      sourceHeight: 200
    })

    expect(resolveCanvasImageDomPreviewLayout(item)).toEqual({
      left: -0,
      top: -0,
      width: 100,
      height: 100
    })
  })
})

describe('normalizeCanvasImageDisplayCrop', () => {
  it('drops invalid crop rectangles', () => {
    expect(
      normalizeCanvasImageDisplayCrop({ x: 10, y: 10, width: 0, height: 5 }, 100, 100)
    ).toBeUndefined()
  })

  it('clamps rectangles that overflow the image', () => {
    expect(
      normalizeCanvasImageDisplayCrop({ x: -20, y: 5, width: 50, height: 200 }, 100, 80)
    ).toEqual({
      x: 0,
      y: 5,
      width: 30,
      height: 75
    })
  })
})
