import { describe, expect, it } from 'vitest'

import {
  buildCanvasTargetMediaPlacementFailure,
  validateCanvasTargetMediaSourceUrl
} from './canvasTargetMediaDispatchSafety'
import type { CanvasImageItem } from './types'

describe('canvasTargetMediaDispatchSafety', () => {
  it('allows only app-materialized blob URLs', () => {
    expect(validateCanvasTargetMediaSourceUrl(' blob:generated-image ')).toEqual({
      safe: true,
      url: 'blob:generated-image'
    })
  })

  it('rejects file, local-media, remote, and data URLs', () => {
    expect(validateCanvasTargetMediaSourceUrl('file:///Users/demo/secret.png')).toMatchObject({
      safe: false
    })
    expect(
      validateCanvasTargetMediaSourceUrl('local-media:///Users/demo/secret.png')
    ).toMatchObject({ safe: false })
    expect(validateCanvasTargetMediaSourceUrl('https://example.com/generated.png')).toMatchObject({
      safe: false
    })
    expect(validateCanvasTargetMediaSourceUrl('data:text/html;base64,AAAA')).toMatchObject({
      safe: false,
      reason: 'Canvas target media actions only accept app-materialized blob URLs.'
    })
    expect(validateCanvasTargetMediaSourceUrl('data:image/png;base64,AAAA')).toMatchObject({
      safe: false,
      reason: 'Canvas target media actions only accept app-materialized blob URLs.'
    })
  })

  it('builds a fallback result when media placement is not acknowledged', () => {
    expect(buildCanvasTargetMediaPlacementFailure('add_image', [])).toEqual({
      content: 'Canvas add_image action did not report a placed image item.',
      canvasDispatchCount: 0,
      placedCanvasItemIds: [],
      placedCanvasItems: [],
      fallbackReason: 'Canvas placement was not acknowledged for add_image.'
    })
  })

  it('does not build a fallback when at least one canvas item was placed', () => {
    const placedItem: CanvasImageItem = {
      id: 'image-1',
      type: 'image',
      src: 'blob:image-1',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false
    }

    expect(buildCanvasTargetMediaPlacementFailure('add_image', [placedItem])).toBeNull()
  })
})
