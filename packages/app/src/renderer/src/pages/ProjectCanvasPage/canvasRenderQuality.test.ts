import { afterEach, describe, expect, it } from 'vitest'

import {
  PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
  createProjectCanvasRenderQualityGovernor,
  isProjectCanvasAdaptiveQualityEnabled,
  PROJECT_CANVAS_WEBGL_RENDER_GROUP_MAX_SCREEN_REACH_PX,
  resolveProjectCanvasRenderDpr,
  shouldUseProjectCanvasWorldRenderGroup,
  type ProjectCanvasAdaptiveQualityGlobal
} from './canvasRenderQuality'

const adaptiveQualityGlobal = globalThis as ProjectCanvasAdaptiveQualityGlobal

afterEach(() => {
  delete adaptiveQualityGlobal.__MAGICPOT_PROJECT_CANVAS_ADAPTIVE_QUALITY__
})

describe('canvasRenderQuality', () => {
  it('debounces quality reduction and uses a longer restore hysteresis', () => {
    const governor = createProjectCanvasRenderQualityGovernor()

    expect(governor.update({ now: 0, interactionActive: true })).toBe('full')
    expect(
      governor.update({
        now: PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS - 1,
        interactionActive: true
      })
    ).toBe('full')
    expect(
      governor.update({
        now: PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS,
        interactionActive: true
      })
    ).toBe('interactive')

    expect(
      governor.update({
        now: PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS + 1,
        interactionActive: false
      })
    ).toBe('interactive')
    expect(
      governor.update({
        now:
          PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS +
          PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
        interactionActive: false
      })
    ).toBe('interactive')
    expect(
      governor.update({
        now:
          PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS +
          PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS +
          1,
        interactionActive: false
      })
    ).toBe('full')
  })

  it('keeps full quality when disabled or explicitly forced for capture/export work', () => {
    const disabledGovernor = createProjectCanvasRenderQualityGovernor({
      enabled: false,
      downgradeDebounceMs: 0
    })
    expect(disabledGovernor.update({ now: 100, interactionActive: true })).toBe('full')

    const governor = createProjectCanvasRenderQualityGovernor({ downgradeDebounceMs: 0 })
    expect(governor.update({ now: 0, interactionActive: true })).toBe('interactive')
    expect(governor.update({ now: 1, interactionActive: true, forceFull: true })).toBe('full')
  })

  it('caps only interactive rendering at DPR 1 and leaves full-quality DPR untouched', () => {
    expect(resolveProjectCanvasRenderDpr(2, 'interactive')).toBe(1)
    expect(resolveProjectCanvasRenderDpr(1, 'interactive')).toBe(1)
    expect(resolveProjectCanvasRenderDpr(2, 'full')).toBe(2)
    expect(resolveProjectCanvasRenderDpr(Number.NaN, 'full')).toBe(1)
  })

  it('supports a runtime kill switch without changing the default-on behavior', () => {
    expect(isProjectCanvasAdaptiveQualityEnabled()).toBe(true)
    adaptiveQualityGlobal.__MAGICPOT_PROJECT_CANVAS_ADAPTIVE_QUALITY__ = false
    expect(isProjectCanvasAdaptiveQualityEnabled()).toBe(false)
  })

  it('uses the world render group only where 32-bit GPU maths stays sub-pixel exact', () => {
    const shouldUse = shouldUseProjectCanvasWorldRenderGroup
    const limit = PROJECT_CANVAS_WEBGL_RENDER_GROUP_MAX_SCREEN_REACH_PX
    const stage = { width: 1920, height: 1080 }
    expect(shouldUse({ x: 0, y: 0 }, stage, false)).toBe(true)
    expect(shouldUse({ x: -90_000, y: 150_000 }, stage, false)).toBe(true)
    // At the limit: stays on, does not turn on.
    expect(shouldUse({ x: limit - 1920, y: 0 }, stage, true)).toBe(true)
    expect(shouldUse({ x: limit - 1920, y: 0 }, stage, false)).toBe(false)
    expect(shouldUse({ x: limit - 1919, y: 0 }, stage, true)).toBe(false)
    expect(shouldUse({ x: 0, y: -(limit * 0.75 - 1920) }, stage, false)).toBe(true)
    expect(shouldUse({ x: 0, y: -5_000_000 }, stage, true)).toBe(false)
    // Unknown stage size and broken numbers.
    expect(shouldUse({ x: 100, y: 100 }, undefined, false)).toBe(true)
    expect(shouldUse({ x: Number.NaN, y: 0 }, stage, true)).toBe(false)
    expect(shouldUse({ x: Number.POSITIVE_INFINITY, y: 0 }, stage, true)).toBe(false)
  })
})
