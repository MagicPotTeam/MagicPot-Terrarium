export type ProjectCanvasRenderQuality = 'full' | 'interactive'

// The layer renders at the full device pixel ratio, also while the view is panned or zoomed:
// switching the resolution at the start and end of every gesture showed as a blur followed by
// a sharp pop, and reallocated the drawing buffer twice. The resolution is lowered only when
// the gesture measurably cannot keep up: this many gesture frames in a row took longer than
// the frame budget times the ratio. It comes back after the gesture has ended.
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS = 1000 / 60
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO = 1.5
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT = 10
// A longer gap between two gesture frames is a pause of the pointer, not a slow frame.
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS = 250
export const PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS = 180
export const PROJECT_CANVAS_INTERACTIVE_DPR = 1

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
  restoreDebounceMs?: number
}

export type ProjectCanvasRenderQualityGovernorUpdate = {
  now: number
  interactionActive: boolean
  forceFull?: boolean
}

export type ProjectCanvasRenderQualityGovernorFrame = {
  // When this gesture frame started.
  now: number
  // How long the layer's own render of this frame took, when known.
  renderDurationMs?: number
}

export function createProjectCanvasRenderQualityGovernor({
  enabled = true,
  frameBudgetMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_BUDGET_MS,
  slowFrameRatio = PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_RATIO,
  slowFrameCount = PROJECT_CANVAS_ADAPTIVE_QUALITY_SLOW_FRAME_COUNT,
  framePauseMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_FRAME_PAUSE_MS,
  restoreDebounceMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS
}: ProjectCanvasRenderQualityGovernorOptions = {}) {
  let quality: ProjectCanvasRenderQuality = 'full'
  let interactionActive = false
  let interactionEndedAt: number | null = null
  let lastFrameAt: number | null = null
  let slowFrameStreak = 0

  const reset = () => {
    quality = 'full'
    interactionActive = false
    interactionEndedAt = null
    lastFrameAt = null
    slowFrameStreak = 0
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
        lastFrameAt = null
        slowFrameStreak = 0
      }
      interactionActive = true
      interactionEndedAt = null
      return quality
    }

    interactionActive = false
    lastFrameAt = null
    slowFrameStreak = 0
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
   * Counts one frame of the running gesture. The cost of a frame is the time since the previous
   * gesture frame (unless that gap is a pause) or the layer's own render time, whichever is
   * larger. Once lowered, the quality stays lowered until the gesture has ended: raising it in
   * the middle of a gesture would bring the slow frames back and flip again.
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
    if (Math.max(frameIntervalMs, renderMs) > frameBudgetMs * slowFrameRatio) {
      slowFrameStreak += 1
    } else {
      slowFrameStreak = 0
    }
    if (quality === 'full' && slowFrameStreak >= slowFrameCount) {
      quality = 'interactive'
    }
    return quality
  }

  return {
    getQuality: () => quality,
    reset,
    update,
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
