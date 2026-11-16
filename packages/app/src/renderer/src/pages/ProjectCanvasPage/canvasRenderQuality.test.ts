import { afterEach, describe, expect, it } from 'vitest'

import {
  PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_LATE_GESTURE_FRAME_COUNT,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT,
  PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO,
  createProjectCanvasRenderQualityGovernor,
  estimateProjectCanvasDisplayIntervalMs,
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

  // Runs `count` display frames that are `intervalMs` apart; returns the time of the last one.
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

  it('asks for frame timing only after several late draws in a row, and never lowers on draws alone', () => {
    const governor = createProjectCanvasRenderQualityGovernor()
    const lateCount = PROJECT_CANVAS_ADAPTIVE_QUALITY_LATE_GESTURE_FRAME_COUNT
    governor.update({ now: 0, interactionActive: true })

    // Draws on time: nothing to time.
    let now = 0
    for (let draw = 0; draw < 200; draw += 1) {
      now += budget
      expect(governor.recordGestureFrame({ now })).toBe(false)
    }
    // Late draws (a slow drag: one every 50 ms). The first ones are not yet a reason.
    for (let draw = 1; draw < lateCount; draw += 1) {
      now += 50
      expect(governor.recordGestureFrame({ now })).toBe(false)
    }
    now += 50
    expect(governor.recordGestureFrame({ now })).toBe(true)
    expect(governor.shouldMeasureFrames(now)).toBe(true)
    // However many late draws follow, they do not lower the quality by themselves.
    for (let draw = 0; draw < 100; draw += 1) {
      now += 50
      expect(governor.recordGestureFrame({ now })).toBe(true)
    }
    expect(governor.getQuality()).toBe('full')

    // One draw on time ends the reason; so does a pause of the pointer, and the gesture's end.
    now += budget
    expect(governor.recordGestureFrame({ now })).toBe(false)
    for (let draw = 0; draw < lateCount; draw += 1) {
      now += 50
      governor.recordGestureFrame({ now })
    }
    expect(governor.shouldMeasureFrames(now)).toBe(true)
    expect(
      governor.shouldMeasureFrames(now + PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS + 1)
    ).toBe(false)
    now += PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS + 1
    expect(governor.recordGestureFrame({ now })).toBe(false)
    for (let draw = 0; draw < lateCount; draw += 1) {
      now += 50
      governor.recordGestureFrame({ now })
    }
    expect(governor.shouldMeasureFrames(now)).toBe(true)
    governor.update({ now, interactionActive: false })
    expect(governor.shouldMeasureFrames(now)).toBe(false)
    expect(governor.recordGestureFrame({ now: now + 50 })).toBe(false)
  })

  it('lowers on late draws only when the timed display frames are slow too', () => {
    const lateCount = PROJECT_CANVAS_ADAPTIVE_QUALITY_LATE_GESTURE_FRAME_COUNT
    const lateDraws = (
      governor: ReturnType<typeof createProjectCanvasRenderQualityGovernor>,
      startAt: number
    ) => {
      let now = startAt
      for (let draw = 0; draw <= lateCount; draw += 1) {
        now += slowFrameMs
        governor.recordGestureFrame({ now })
      }
      return now
    }

    // Input is slow, the display keeps up: frames at 60 Hz between the draws.
    const keepsUp = createProjectCanvasRenderQualityGovernor()
    keepsUp.update({ now: 0, interactionActive: true })
    let now = lateDraws(keepsUp, 0)
    for (let draw = 0; draw < 60; draw += 1) {
      now = runFrames(keepsUp, now, 3, budget)
      expect(keepsUp.recordGestureFrame({ now })).toBe(true)
    }
    expect(keepsUp.getQuality()).toBe('full')

    // The display is slow: every frame carries a draw and takes longer than the limit.
    const slow = createProjectCanvasRenderQualityGovernor()
    slow.update({ now: 0, interactionActive: true })
    now = lateDraws(slow, 0)
    for (let frame = 0; frame <= slowCount; frame += 1) {
      expect(slow.getQuality()).toBe('full')
      now += slowFrameMs
      slow.recordGestureFrame({ now })
      slow.recordFrame({ now })
    }
    expect(slow.getQuality()).toBe('interactive')
    // Lowered: no more timing in this gesture.
    expect(slow.recordGestureFrame({ now: now + slowFrameMs })).toBe(false)

    // A draw on time in between starts the count again.
    const mixed = createProjectCanvasRenderQualityGovernor()
    mixed.update({ now: 0, interactionActive: true })
    now = lateDraws(mixed, 0)
    now = runFrames(mixed, now, slowCount, slowFrameMs)
    now += budget
    mixed.recordGestureFrame({ now })
    now = lateDraws(mixed, now)
    now = runFrames(mixed, now, slowCount, slowFrameMs)
    expect(mixed.getQuality()).toBe('full')
    runFrames(mixed, now, 1, slowFrameMs)
    expect(mixed.getQuality()).toBe('interactive')
  })

  it('does not lower the resolution on a 30 Hz display that keeps up', () => {
    const displayMs = 1000 / 30
    const gesture = (
      governor: ReturnType<typeof createProjectCanvasRenderQualityGovernor>,
      frameMs: number
    ) => {
      governor.update({ now: 0, interactionActive: true })
      // Every display frame carries a draw, and the frame sampler runs whenever asked.
      let now = 0
      for (let frame = 0; frame < 60; frame += 1) {
        now += frameMs
        governor.recordGestureFrame({ now })
        if (governor.shouldMeasureFrames(now)) {
          governor.recordFrame({ now, renderDurationMs: 2 })
        }
      }
      return governor.getQuality()
    }

    // Without a measured interval, 33 ms frames count as slow (the old 60 Hz budget).
    expect(gesture(createProjectCanvasRenderQualityGovernor(), displayMs)).toBe('interactive')
    // With the measured 30 Hz interval they are on time...
    const thirtyHz = createProjectCanvasRenderQualityGovernor()
    thirtyHz.setDisplayIntervalMs(displayMs)
    expect(thirtyHz.getSlowFrameThresholdMs()).toBeCloseTo(displayMs * 1.5)
    expect(gesture(thirtyHz, displayMs)).toBe('full')
    // ...and frames that miss even the 30 Hz interval by half still lower it.
    const slowOnThirtyHz = createProjectCanvasRenderQualityGovernor()
    slowOnThirtyHz.setDisplayIntervalMs(displayMs)
    expect(gesture(slowOnThirtyHz, displayMs * 2)).toBe('interactive')
    // A fast display does not make the budget stricter than 60 Hz.
    const fast = createProjectCanvasRenderQualityGovernor()
    fast.setDisplayIntervalMs(1000 / 144)
    expect(fast.getSlowFrameThresholdMs()).toBeCloseTo(slowFrameMs - 1)
    expect(gesture(fast, budget)).toBe('full')
  })

  it('estimates the display interval from the on-time frames among the deltas', () => {
    const deltas = [33.3, 33.4, 33.3, 120, 33.3, 33.2, 66.7, 33.3, 33.4, 33.3, 33.3]
    expect(estimateProjectCanvasDisplayIntervalMs(deltas)).toBeCloseTo(33.3)
    expect(estimateProjectCanvasDisplayIntervalMs([16.7, 16.6, 16.7, 16.7, 33.4])).toBeCloseTo(16.7)
    // A busy 60 Hz page: most frames late by one or two intervals, a few on time.
    const busy = [33.4, 16.7, 50, 33.3, 16.6, 33.4, 33.3, 16.7, 50.1, 33.3, 33.4, 33.3]
    expect(estimateProjectCanvasDisplayIntervalMs(busy)).toBeCloseTo(16.7)
    // A hidden window (no frames for seconds) or too few samples: unknown.
    expect(estimateProjectCanvasDisplayIntervalMs([1000, 1000, 1000, 16.7])).toBeNull()
    expect(estimateProjectCanvasDisplayIntervalMs([16.7, 16.7])).toBeNull()
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
