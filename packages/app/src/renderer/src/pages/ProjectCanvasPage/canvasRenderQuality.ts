export type ProjectCanvasRenderQuality = 'full' | 'interactive'

// The layer renders at the full device pixel ratio, also while the view is panned or zoomed:
// switching the resolution at the start and end of every gesture showed as a blur followed by
// a sharp pop, and reallocated the drawing buffer twice. The resolution is lowered only when
// the gesture measurably cannot keep up: this many display frames in a row took longer than
// the frame budget times the ratio. It comes back after the gesture has ended. The budget is
// the display's measured frame interval (a 30 Hz output draws every 33 ms however fast the
// layer is), and never less than this: a fast display does not make the governor stricter.
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS = 1000 / 60
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO = 1.5
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT = 10
// A longer gap between two frames is a pause of the pointer, not a slow frame.
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS = 250
// The view is drawn when the pointer or the wheel moved it, so the time between two of those
// draws says how often input arrived, not how long a frame took: a slow, careful drag and a
// wheel turned notch by notch both draw every 30 to 200 ms on a display that keeps up. Late
// draws are therefore only a reason to look: after this many in a row, the display frames
// themselves are timed (requestAnimationFrame), and only those decide.
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_LATE_GESTURE_FRAME_COUNT = 3
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS = 180
export const PROJECT_CANVAS_INTERACTIVE_DPR = 1

// The display interval is measured on this many idle display frames.
export const PROJECT_CANVAS_DISPLAY_INTERVAL_PROBE_FRAMES = 12
// Display intervals outside this range are not a refresh rate (a busy frame, a hidden window).
const PROJECT_CANVAS_DISPLAY_INTERVAL_MIN_MS = 4
const PROJECT_CANVAS_DISPLAY_INTERVAL_MAX_MS = 100

/**
 * The display's frame interval from the time between consecutive requestAnimationFrame
 * callbacks. Frames delayed by other work are a whole number of intervals apart, never less
 * than one, so the lower quartile is taken: it holds as long as a quarter of the frames was
 * on time. Null when too few deltas look like a refresh rate.
 */
export function estimateProjectCanvasDisplayIntervalMs(deltasMs: readonly number[]): number | null {
  const valid = deltasMs
    .filter(
      (delta) =>
        Number.isFinite(delta) &&
        delta >= PROJECT_CANVAS_DISPLAY_INTERVAL_MIN_MS &&
        delta <= PROJECT_CANVAS_DISPLAY_INTERVAL_MAX_MS
    )
    .sort((a, b) => a - b)
  if (valid.length < Math.max(3, Math.ceil(deltasMs.length / 2))) {
    return null
  }
  return valid[Math.floor((valid.length - 1) / 4)]
}

export type ProjectCanvasAdaptiveQualityGlobal = typeof globalThis & {
  __MAGICPOT_PROJECT_CANVAS_ADAPTIVE_QUALITY__?: boolean
}

export function isProjectCanvasAdaptiveQualityEnabled(): boolean {
  const override = (globalThis as ProjectCanvasAdaptiveQualityGlobal)
    .__MAGICPOT_PROJECT_CANVAS_ADAPTIVE_QUALITY__
  return override !== false
}

export type ProjectCanvasRenderQualityGovernorOptions = {
  enabled?: boolean
  frameBudgetMs?: number
  slowFrameRatio?: number
  slowFrameCount?: number
  framePauseMs?: number
  lateGestureFrameCount?: number
  restoreDebounceMs?: number
}

export type ProjectCanvasRenderQualityGovernorUpdate = {
  now: number
  interactionActive: boolean
  forceFull?: boolean
}

export type ProjectCanvasRenderQualityGovernorFrame = {
  // When this display frame started.
  now: number
  // How long the layer's own render of this frame took, when known.
  renderDurationMs?: number
}

export type ProjectCanvasRenderQualityGovernorGestureFrame = {
  // When the view was moved and drawn.
  now: number
}

export function createProjectCanvasRenderQualityGovernor({
  enabled = true,
  frameBudgetMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS,
  slowFrameRatio = PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO,
  slowFrameCount = PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT,
  framePauseMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS,
  lateGestureFrameCount = PROJECT_CANVAS_ADAPTIVE_QUALITY_LATE_GESTURE_FRAME_COUNT,
  restoreDebounceMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS
}: ProjectCanvasRenderQualityGovernorOptions = {}) {
  let quality: ProjectCanvasRenderQuality = 'full'
  let interactionActive = false
  let interactionEndedAt: number | null = null
  let lastFrameAt: number | null = null
  let slowFrameStreak = 0
  let lastGestureFrameAt: number | null = null
  let lateGestureFrameStreak = 0
  let displayIntervalMs: number | null = null
  const getSlowFrameThresholdMs = () =>
    Math.max(frameBudgetMs, displayIntervalMs ?? 0) * slowFrameRatio

  const resetFrameMeasurement = () => {
    lastFrameAt = null
    slowFrameStreak = 0
  }

  const resetGestureFrames = () => {
    lastGestureFrameAt = null
    lateGestureFrameStreak = 0
    resetFrameMeasurement()
  }

  const reset = () => {
    quality = 'full'
    interactionActive = false
    interactionEndedAt = null
    resetGestureFrames()
  }

  /** Tells the governor that a gesture started, goes on or ended. Never lowers the quality. */
  const update = ({
    now,
    interactionActive: nextInteractionActive,
    forceFull = false
  }: ProjectCanvasRenderQualityGovernorUpdate) => {
    if (!enabled || forceFull) {
      reset()
      return quality
    }

    if (nextInteractionActive) {
      if (!interactionActive) {
        resetGestureFrames()
      }
      interactionActive = true
      interactionEndedAt = null
      return quality
    }

    interactionActive = false
    resetGestureFrames()
    if (quality === 'interactive') {
      if (interactionEndedAt === null) {
        interactionEndedAt = now
      }
      if (now - interactionEndedAt >= restoreDebounceMs) {
        quality = 'full'
        interactionEndedAt = null
      }
    } else {
      interactionEndedAt = null
    }
    return quality
  }

  /**
   * Whether the display frames of the running gesture should be timed now: the gesture is
   * still at full quality, its last draws came late, and the pointer has not come to rest.
   */
  const shouldMeasureFrames = (now: number) =>
    enabled &&
    interactionActive &&
    quality === 'full' &&
    lateGestureFrameStreak >= lateGestureFrameCount &&
    lastGestureFrameAt !== null &&
    now - lastGestureFrameAt <= framePauseMs

  /**
   * The view was moved and drawn. Never lowers the quality: a late draw may only mean that the
   * input came late. Returns whether the display frames should be timed (see recordFrame).
   */
  const recordGestureFrame = ({ now }: ProjectCanvasRenderQualityGovernorGestureFrame) => {
    if (!enabled || !interactionActive) {
      return false
    }

    const sinceLastGestureFrameMs = lastGestureFrameAt === null ? 0 : now - lastGestureFrameAt
    lastGestureFrameAt = now
    if (
      Number.isFinite(sinceLastGestureFrameMs) &&
      sinceLastGestureFrameMs > getSlowFrameThresholdMs() &&
      sinceLastGestureFrameMs <= framePauseMs
    ) {
      lateGestureFrameStreak += 1
    } else {
      // On time, or after a pause: whatever was being timed belongs to the past.
      lateGestureFrameStreak = 0
      resetFrameMeasurement()
    }
    return shouldMeasureFrames(now)
  }

  /**
   * Counts one display frame of the running gesture, while shouldMeasureFrames says so. The
   * cost of a frame is the time since the previous display frame (unless that gap is a pause)
   * or the layer's own render time, whichever is larger. Once lowered, the quality stays
   * lowered until the gesture has ended: raising it in the middle of a gesture would bring
   * the slow frames back and flip again.
   */
  const recordFrame = ({ now, renderDurationMs }: ProjectCanvasRenderQualityGovernorFrame) => {
    if (!enabled || !interactionActive) {
      return quality
    }

    const sinceLastFrameMs = lastFrameAt === null ? 0 : now - lastFrameAt
    lastFrameAt = now
    const frameIntervalMs =
      Number.isFinite(sinceLastFrameMs) && sinceLastFrameMs > 0 && sinceLastFrameMs <= framePauseMs
        ? sinceLastFrameMs
        : 0
    const renderMs =
      typeof renderDurationMs === 'number' && Number.isFinite(renderDurationMs)
        ? Math.max(0, renderDurationMs)
        : 0
    if (Math.max(frameIntervalMs, renderMs) > getSlowFrameThresholdMs()) {
      slowFrameStreak += 1
    } else {
      slowFrameStreak = 0
    }
    if (quality === 'full' && slowFrameStreak >= slowFrameCount) {
      quality = 'interactive'
    }
    return quality
  }

  /**
   * The measured display frame interval (see estimateProjectCanvasDisplayIntervalMs), or null
   * when it is unknown. Kept across gestures and resets.
   */
  const setDisplayIntervalMs = (intervalMs: number | null) => {
    displayIntervalMs =
      typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
        ? intervalMs
        : null
  }

  return {
    getQuality: () => quality,
    getDisplayIntervalMs: () => displayIntervalMs,
    getSlowFrameThresholdMs,
    setDisplayIntervalMs,
    reset,
    update,
    recordGestureFrame,
    shouldMeasureFrames,
    recordFrame
  }
}

export function resolveProjectCanvasRenderDpr(
  baseDpr: number,
  quality: ProjectCanvasRenderQuality
): number {
  const safeDpr = Number.isFinite(baseDpr) ? Math.max(1, baseDpr) : 1
  return quality === 'interactive' ? Math.min(safeDpr, PROJECT_CANVAS_INTERACTIVE_DPR) : safeDpr
}

// The world container is a Pixi render group: a pan or zoom then changes one matrix on the
// GPU instead of the vertices of every sprite. The GPU does that multiplication in 32-bit
// floats, whose step grows with the distance of the view from the canvas origin in screen
// pixels (1/64 px at 262,144 px, 2 px at 20 million px, which a deep zoom on a large board
// reaches). Beyond this reach the layer goes back to transforming on the CPU, which is exact;
// few sprites are on screen at such a zoom, so nothing is lost there.
export const PROJECT_CANVAS_WEBGL_RENDER_GROUP_MAX_SCREEN_REACH_PX = 262_144
const PROJECT_CANVAS_WEBGL_RENDER_GROUP_REENABLE_RATIO = 0.75
const PROJECT_CANVAS_WEBGL_RENDER_GROUP_UNKNOWN_STAGE_EXTENT_PX = 4096

/**
 * Whether the world container should be a render group for this view. `pos` is the stage
 * position in screen pixels, so |pos| plus the stage size bounds the magnitude of every
 * on-screen coordinate the GPU has to compute. The band between the two limits keeps a view
 * that sits on the limit from switching back and forth.
 */
export function shouldUseProjectCanvasWorldRenderGroup(
  pos: { x: number; y: number },
  stageSize: { width: number; height: number } | null | undefined,
  currentlyEnabled: boolean
): boolean {
  const stageExtent = Math.max(stageSize?.width ?? 0, stageSize?.height ?? 0)
  const extent =
    Number.isFinite(stageExtent) && stageExtent > 0
      ? stageExtent
      : PROJECT_CANVAS_WEBGL_RENDER_GROUP_UNKNOWN_STAGE_EXTENT_PX
  const reach = Math.max(Math.abs(pos.x), Math.abs(pos.y)) + extent
  if (!Number.isFinite(reach)) {
    return false
  }

  return (
    reach <=
    PROJECT_CANVAS_WEBGL_RENDER_GROUP_MAX_SCREEN_REACH_PX *
      (currentlyEnabled ? 1 : PROJECT_CANVAS_WEBGL_RENDER_GROUP_REENABLE_RATIO)
  )
}
