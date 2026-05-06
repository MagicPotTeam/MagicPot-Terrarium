import { describe, expect, it } from 'vitest'
import { compareCanvasAutoArrangeEntries, getCanvasItemAutoArrangeName } from './autoArrangeUtils'
import type { CanvasImageItem, CanvasTextItem } from './types'

function createImageItem(id: string, fileName?: string): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: fileName ? `file:///tmp/${fileName}` : 'file:///tmp/untitled.png',
    fileName,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

function createTextItem(id: string, text: string): CanvasTextItem {
  return {
    id,
    type: 'text',
    text,
    fontSize: 16,
    fontFamily: 'sans-serif',
    fill: '#fff',
    x: 0,
    y: 0,
    width: 120,
    height: 60,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

describe('autoArrangeUtils', () => {
  it('prefers the explicit file name when available', () => {
    expect(getCanvasItemAutoArrangeName(createImageItem('image-1', 'B-02.png'))).toBe('B-02.png')
  })

  it('falls back to a decoded source filename for images without fileName', () => {
    expect(
      getCanvasItemAutoArrangeName({
        ...createImageItem('image-2'),
        src: 'file:///tmp/%E6%B5%B7%E6%8A%A5-03.png'
      })
    ).toBe('海报-03.png')
  })

  it('sorts by natural file name order before canvas position', () => {
    const entries = [
      {
        item: createImageItem('image-2', 'shot-10.png'),
        minX: 10,
        minY: 10
      },
      {
        item: createImageItem('image-1', 'shot-2.png'),
        minX: 500,
        minY: 500
      }
    ]

    const sorted = [...entries].sort(compareCanvasAutoArrangeEntries)
    expect(sorted.map((entry) => entry.item.id)).toEqual(['image-1', 'image-2'])
  })

  it('keeps unnamed items after named items and then falls back to position', () => {
    const entries = [
      {
        item: createTextItem('text-1', ''),
        minX: 100,
        minY: 100
      },
      {
        item: createImageItem('image-1', 'A-01.png'),
        minX: 500,
        minY: 500
      },
      {
        item: createTextItem('text-2', ''),
        minX: 20,
        minY: 20
      }
    ]

    const sorted = [...entries].sort(compareCanvasAutoArrangeEntries)
    expect(sorted.map((entry) => entry.item.id)).toEqual(['image-1', 'text-2', 'text-1'])
  })
})
