import { describe, expect, it } from 'vitest'

import {
  findLargestBenchmarkImage,
  resolveProjectCanvasBenchmarkViewport
} from './projectCanvasBenchmarkViewport'
import type { CanvasImageItem, CanvasItem } from './types'

function imageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
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
    src: 'file://image.png',
    ...overrides
  }
}

function resolve(
  viewport: Parameters<typeof resolveProjectCanvasBenchmarkViewport>[0],
  items: CanvasItem[] = []
) {
  return resolveProjectCanvasBenchmarkViewport(viewport, {
    items,
    stagePos: { x: 10, y: 20 },
    stageScale: 1.25,
    stageSize: { width: 800, height: 600 },
    clampStageScale: (scale) => Math.min(4, Math.max(0.2, scale))
  })
}

describe('projectCanvasBenchmarkViewport', () => {
  it('falls back to current viewport for invalid scale and coordinates', () => {
    expect(resolve({ scale: 'bad', x: Number.NaN, y: 'nope' })).toEqual({
      scale: 1.25,
      x: 10,
      y: 20,
      shouldSelectFocusedImage: false
    })
  })

  it('clamps requested scale and accepts finite coordinate strings', () => {
    expect(resolve({ scale: 99, x: '30', y: -40 })).toEqual({
      scale: 4,
      x: 30,
      y: -40,
      shouldSelectFocusedImage: false
    })
  })

  it('finds the largest image using source dimensions before display bounds', () => {
    const smallDisplayLargeSource = imageItem({
      id: 'source-large',
      width: 20,
      height: 20,
      sourceWidth: 1000,
      sourceHeight: 900
    })
    const largeDisplaySmallSource = imageItem({
      id: 'display-large',
      width: 500,
      height: 500,
      sourceWidth: 10,
      sourceHeight: 10
    })

    expect(findLargestBenchmarkImage([largeDisplaySmallSource, smallDisplayLargeSource])?.id).toBe(
      'source-large'
    )
  })

  it('centers the largest image when focusLargestImage is requested', () => {
    const result = resolve({ scale: 2, x: 999, y: 999, focusLargestImage: true }, [
      imageItem({ id: 'small', x: 10, y: 10, width: 100, height: 100 }),
      imageItem({ id: 'large', x: 100, y: 50, width: 200, height: 150 })
    ])

    expect(result).toEqual({
      scale: 2,
      x: 0,
      y: 50,
      focusedImageId: 'large',
      shouldSelectFocusedImage: true
    })
  })

  it('does not select the focused image when selectFocused is false', () => {
    expect(
      resolve({ focusLargestImage: true, selectFocused: false }, [
        imageItem({ id: 'large', x: 0, y: 0, width: 100, height: 100 })
      ])
    ).toMatchObject({
      focusedImageId: 'large',
      shouldSelectFocusedImage: false
    })
  })

  it('does not focus or select when no image exists', () => {
    expect(
      resolve({ focusLargestImage: true }, [
        {
          id: 'text-1',
          type: 'text',
          x: 5,
          y: 6,
          width: 40,
          height: 20,
          text: 'hello'
        } as CanvasItem
      ])
    ).toEqual({
      scale: 1.25,
      x: 10,
      y: 20,
      shouldSelectFocusedImage: false
    })
  })
})
