import { describe, expect, it } from 'vitest'

import {
  resolveCanvas3DStageLightingPreset,
  resolveCanvas3DStageMountedIds,
  resolveCanvas3DStageDpr,
  resolveCanvas3DStageRenderPumpFrames,
  resolveCanvas3DStageFrameloop,
  shouldCanvas3DStageRenderLighting
} from './canvas3DStageQuality'

describe('canvas3DStageQuality', () => {
  it('drops DPR to the minimum while the viewport is moving', () => {
    expect(
      resolveCanvas3DStageDpr({
        itemCount: 12,
        activatedItemCount: 8,
        isViewportMoving: true
      })
    ).toEqual([1, 1])
  })

  it('reduces DPR as model count grows even after movement settles', () => {
    expect(
      resolveCanvas3DStageDpr({
        itemCount: 9,
        activatedItemCount: 7,
        isViewportMoving: false
      })
    ).toEqual([1, 1.25])

    expect(
      resolveCanvas3DStageDpr({
        itemCount: 16,
        activatedItemCount: 11,
        isViewportMoving: false
      })
    ).toEqual([1, 1.1])
  })

  it('uses the highest quality path for lighter settled scenes', () => {
    expect(
      resolveCanvas3DStageDpr({
        itemCount: 3,
        activatedItemCount: 2,
        isViewportMoving: false
      })
    ).toEqual([1, 1.5])
  })

  it('reduces render pump frames during movement and pending activation', () => {
    expect(
      resolveCanvas3DStageRenderPumpFrames({
        isViewportMoving: true,
        pendingActivationCount: 5,
        mountedItemCount: 3
      })
    ).toBe(2)

    expect(
      resolveCanvas3DStageRenderPumpFrames({
        isViewportMoving: false,
        pendingActivationCount: 3,
        mountedItemCount: 7
      })
    ).toBe(4)

    expect(
      resolveCanvas3DStageRenderPumpFrames({
        isViewportMoving: false,
        pendingActivationCount: 0,
        mountedItemCount: 0
      })
    ).toBe(1)
  })

  it('keeps the 3D stage on demand rendering during viewport movement', () => {
    expect(
      resolveCanvas3DStageFrameloop({
        isViewportMoving: true
      })
    ).toBe('demand')

    expect(
      resolveCanvas3DStageFrameloop({
        isViewportMoving: false
      })
    ).toBe('demand')
  })

  it('keeps all activated models mounted when the viewport is settled', () => {
    expect(
      Array.from(
        resolveCanvas3DStageMountedIds({
          activatedIds: new Set(['item-a', 'item-b', 'item-c']),
          prioritizedLoadIds: ['item-a', 'item-b', 'item-c'],
          isViewportMoving: false
        })
      )
    ).toEqual(['item-a', 'item-b', 'item-c'])
  })

  it('keeps activated full models mounted while the viewport is moving so zoom matches the settled render', () => {
    expect(
      Array.from(
        resolveCanvas3DStageMountedIds({
          activatedIds: new Set(['item-a', 'item-b', 'item-c', 'item-d', 'item-e']),
          prioritizedLoadIds: ['item-c', 'item-a', 'item-e', 'item-b', 'item-d'],
          isViewportMoving: true
        })
      )
    ).toEqual(['item-a', 'item-b', 'item-c', 'item-d', 'item-e'])
  })

  it('keeps the lighting preset fixed so zoom level does not change the rendered look', () => {
    expect(
      resolveCanvas3DStageLightingPreset({
        activatedItemCount: 1
      })
    ).toBe('full')

    expect(
      resolveCanvas3DStageLightingPreset({
        activatedItemCount: 5
      })
    ).toBe('full')

    expect(
      resolveCanvas3DStageLightingPreset({
        activatedItemCount: 9
      })
    ).toBe('full')
  })

  it('skips stage lighting entirely when no full models are mounted', () => {
    expect(
      shouldCanvas3DStageRenderLighting({
        mountedItemCount: 0
      })
    ).toBe(false)

    expect(
      shouldCanvas3DStageRenderLighting({
        mountedItemCount: 2
      })
    ).toBe(true)
  })
})
