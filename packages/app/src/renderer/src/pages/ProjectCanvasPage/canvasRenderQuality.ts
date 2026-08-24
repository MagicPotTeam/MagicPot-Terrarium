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
