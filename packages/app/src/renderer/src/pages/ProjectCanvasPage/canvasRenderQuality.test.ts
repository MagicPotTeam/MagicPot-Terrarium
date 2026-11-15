import { afterEach, describe, expect, it } from 'vitest'

import {
  PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO,
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
  const budget = PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS
  const slowFrameMs = budget * PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO + 1
  const slowCount = PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT

  // Runs `count` gesture frames that are `intervalMs` apart; returns the time of the last one.
  const runFrames = (
    governor: ReturnType<typeof createProjectCanvasRenderQualityGovernor>,
    startAt: number,
    count: number,
    intervalMs: number
  ) => {
    let now = startAt
    for (let frame = 0; frame < count; frame += 1) {
      now += intervalMs
      governor.recordFrame({ now })
    }
    return now
  }

  it('keeps the full resolution through a gesture whose frames are in budget', () => {
    const governor = createProjectCanvasRenderQualityGovernor()

    expect(governor.update({ now: 0, interactionActive: true })).toBe('full')
    // Long after the old 80 ms debounce, with frames at 60 Hz and at the edge of the limit.
    let now = runFrames(governor, 0, 120, budget)
    now = runFrames(
      governor,
      now,
      120,
      budget * PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO - 0.01
    )
    expect(governor.update({ now, interactionActive: true })).toBe('full')
    expect(governor.update({ now: now + 1, interactionActive: false })).toBe('full')
    expect(governor.getQuality()).toBe('full')
  })

  it('lowers the resolution only after ten slow frames in a row', () => {
    const governor = createProjectCanvasRenderQualityGovernor()
    governor.update({ now: 0, interactionActive: true })

    // Nine slow frames, one frame in budget, nine slow frames: never ten in a row.
    let now = runFrames(governor, 0, slowCount, slowFrameMs)
    // (the first frame of a gesture has no interval, so that was nine measured slow frames)
    expect(governor.getQuality()).toBe('full')
    now = runFrames(governor, now, 1, budget)
    now = runFrames(governor, now, slowCount - 1, slowFrameMs)
    expect(governor.getQuality()).toBe('full')

    now = runFrames(governor, now, 1, slowFrameMs)
    expect(governor.getQuality()).toBe('interactive')
  })

  it('stays lowered for the rest of the gesture and restores after it, without flipping', () => {
    const governor = createProjectCanvasRenderQualityGovernor()
    governor.update({ now: 0, interactionActive: true })
    let now = runFrames(governor, 0, slowCount + 1, slowFrameMs)
    expect(governor.getQuality()).toBe('interactive')

    // Frames are fast at the lower resolution: that must not raise it again mid-gesture.
    now = runFrames(governor, now, 300, budget)
    expect(governor.getQuality()).toBe('interactive')

    expect(governor.update({ now, interactionActive: false })).toBe('interactive')
    expect(
      governor.update({
        now: now + PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS - 1,
        interactionActive: false
      })
    ).toBe('interactive')
    expect(
      governor.update({
        now: now + PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
        interactionActive: false
      })
    ).toBe('full')

    // The next gesture starts at full resolution with a clean count.
    now += 1000
    expect(governor.update({ now, interactionActive: true })).toBe('full')
    now = runFrames(governor, now, slowCount, slowFrameMs)
    expect(governor.getQuality()).toBe('full')
  })

  it('keeps a lowered resolution across gestures that follow each other quickly', () => {
    const governor = createProjectCanvasRenderQualityGovernor()
    governor.update({ now: 0, interactionActive: true })
    let now = runFrames(governor, 0, slowCount + 1, slowFrameMs)
    governor.update({ now, interactionActive: false })
    // Wheel notches: the next gesture starts before the restore delay is over.
    now += PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS - 20
    expect(governor.update({ now, interactionActive: true })).toBe('interactive')
    now = runFrames(governor, now, 30, budget)
    governor.update({ now, interactionActive: false })
    expect(
      governor.update({
        now: now + PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
        interactionActive: false
      })
    ).toBe('full')
  })

  it('does not take a pause of the pointer for a slow frame, but counts slow renders', () => {
    const governor = createProjectCanvasRenderQualityGovernor()
    governor.update({ now: 0, interactionActive: true })
    // Wheel notches 300 ms apart: every gap is longer than a slow frame.
    let now = runFrames(governor, 0, 40, PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS + 50)
    expect(governor.getQuality()).toBe('full')

    // The same spacing, but each render alone takes longer than the limit.
    for (let frame = 0; frame < slowCount; frame += 1) {
      now += PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS + 50
      governor.recordFrame({ now, renderDurationMs: slowFrameMs })
    }
    expect(governor.getQuality()).toBe('interactive')
  })

  it('ignores frames outside a gesture', () => {
    const governor = createProjectCanvasRenderQualityGovernor()
    runFrames(governor, 0, 50, slowFrameMs)
    expect(governor.getQuality()).toBe('full')
  })

  it('keeps full quality when disabled or explicitly forced for capture/export work', () => {
    const disabledGovernor = createProjectCanvasRenderQualityGovernor({ enabled: false })
    disabledGovernor.update({ now: 0, interactionActive: true })
    runFrames(disabledGovernor, 0, 50, slowFrameMs)
    expect(disabledGovernor.update({ now: 5000, interactionActive: true })).toBe('full')

    const governor = createProjectCanvasRenderQualityGovernor()
    governor.update({ now: 0, interactionActive: true })
    const now = runFrames(governor, 0, slowCount + 1, slowFrameMs)
    expect(governor.getQuality()).toBe('interactive')
    expect(governor.update({ now: now + 1, interactionActive: true, forceFull: true })).toBe('full')
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
