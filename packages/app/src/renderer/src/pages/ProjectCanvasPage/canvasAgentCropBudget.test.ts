import { describe, expect, it } from 'vitest'
import { assertCanvasAttachmentCropOutputSize } from './canvasAgentCropBudget'

describe('canvas attachment crop allocation guard', () => {
  it('accepts the existing exact edge and area limits, including sub-pixel crops', () => {
    expect(() => assertCanvasAttachmentCropOutputSize({ width: 16384, height: 2048 })).not.toThrow()
    expect(() => assertCanvasAttachmentCropOutputSize({ width: 0.1, height: 0.1 })).not.toThrow()
  })

  it.each([
    { width: 16385, height: 1 },
    { width: 16384, height: 2049 },
    { width: 16384.5, height: 1 },
    { width: Infinity, height: 1 },
    { width: NaN, height: 1 },
    { width: 0, height: 1 },
    { width: -1, height: 1 }
  ])('rejects invalid or oversized output %o', (crop) => {
    expect(() => assertCanvasAttachmentCropOutputSize(crop)).toThrow('Canvas image crop is too large to prepare safely')
  })
})
