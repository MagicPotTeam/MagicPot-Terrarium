import { afterEach, describe, expect, it } from 'vitest'

import {
  PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
  createProjectCanvasRenderQualityGovernor,
  isProjectCanvasAdaptiveQualityEnabled,
  resolveProjectCanvasRenderDpr,
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
})
