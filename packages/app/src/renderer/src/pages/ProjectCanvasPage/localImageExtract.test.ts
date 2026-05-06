import { describe, expect, it } from 'vitest'

import { filterToPrimaryForegroundComponents } from './localImageExtract'

function createImageData(width: number, height: number) {
  return new Uint8ClampedArray(width * height * 4)
}

function paintOpaqueRect(
  data: Uint8ClampedArray,
  width: number,
  rect: { x: number; y: number; rectWidth: number; rectHeight: number }
) {
  for (let y = rect.y; y < rect.y + rect.rectHeight; y += 1) {
    for (let x = rect.x; x < rect.x + rect.rectWidth; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = 255
      data[offset + 1] = 255
      data[offset + 2] = 255
      data[offset + 3] = 255
    }
  }
}

describe('filterToPrimaryForegroundComponents', () => {
  it('keeps the dominant foreground group and nearby support content while dropping far fragments', () => {
    const width = 20
    const height = 12
    const imageData = createImageData(width, height)

    paintOpaqueRect(imageData, width, {
      x: 4,
      y: 3,
      rectWidth: 5,
      rectHeight: 5
    })
    paintOpaqueRect(imageData, width, {
      x: 10,
      y: 3,
      rectWidth: 5,
      rectHeight: 4
    })
    paintOpaqueRect(imageData, width, {
      x: 17,
      y: 0,
      rectWidth: 2,
      rectHeight: 2
    })

    const result = filterToPrimaryForegroundComponents(imageData, width, height)

    expect(result.totalComponentCount).toBe(3)
    expect(result.keptComponentCount).toBe(2)
    expect(result.removedComponentCount).toBe(1)
    expect(result.keptForegroundRatio).toBeGreaterThan(0.88)

    const nearbyOffset = (4 * width + 11) * 4 + 3
    const farFragmentOffset = (1 * width + 17) * 4 + 3

    expect(result.data[nearbyOffset]).toBe(255)
    expect(result.data[farFragmentOffset]).toBe(0)
  })

  it('returns a stable copy when only one foreground component exists', () => {
    const width = 10
    const height = 10
    const imageData = createImageData(width, height)

    paintOpaqueRect(imageData, width, {
      x: 2,
      y: 2,
      rectWidth: 5,
      rectHeight: 5
    })

    const result = filterToPrimaryForegroundComponents(imageData, width, height)

    expect(result.totalComponentCount).toBe(1)
    expect(result.keptComponentCount).toBe(1)
    expect(result.removedComponentCount).toBe(0)
    expect(result.keptForegroundRatio).toBe(1)
    expect(result.data).not.toBe(imageData)
    expect(result.data).toEqual(imageData)
  })
})
