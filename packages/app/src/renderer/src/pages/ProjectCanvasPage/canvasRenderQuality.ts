export type ProjectCanvasRenderQuality = 'full' | 'interactive'

export const PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS = 80
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
  downgradeDebounceMs?: number
  restoreDebounceMs?: number
}

export type ProjectCanvasRenderQualityGovernorUpdate = {
  now: number
  interactionActive: boolean
  forceFull?: boolean
}

export function createProjectCanvasRenderQualityGovernor({
  enabled = true,
  downgradeDebounceMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_DOWNGRADE_DEBOUNCE_MS,
  restoreDebounceMs = PROJECT_CANVAS_ADAPTIVE_QUALITY_RESTORE_DEBOUNCE_MS
}: ProjectCanvasRenderQualityGovernorOptions = {}) {
  let quality: ProjectCanvasRenderQuality = 'full'
  let interactionStartedAt: number | null = null
  let interactionEndedAt: number | null = null

  const reset = () => {
    quality = 'full'
    interactionStartedAt = null
    interactionEndedAt = null
  }

  const update = ({
    now,
    interactionActive,
    forceFull = false
  }: ProjectCanvasRenderQualityGovernorUpdate) => {
    if (!enabled || forceFull) {
      reset()
      return quality
    }

    if (interactionActive) {
      interactionEndedAt = null
      if (interactionStartedAt === null) {
        interactionStartedAt = now
      }
      if (quality === 'full' && now - interactionStartedAt >= downgradeDebounceMs) {
        quality = 'interactive'
      }
      return quality
    }

    interactionStartedAt = null
    if (quality === 'interactive') {
      if (interactionEndedAt === null) {
        interactionEndedAt = now
      }
      if (now - interactionEndedAt >= restoreDebounceMs) {
        quality = 'full'
      }
    } else {
      interactionEndedAt = null
    }
    return quality
  }

  return {
    getQuality: () => quality,
    reset,
    update
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
