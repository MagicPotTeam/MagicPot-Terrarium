export const PROJECT_CANVAS_MIN_STAGE_SCALE = 0.0001
export const PROJECT_CANVAS_MAX_STAGE_SCALE = 500

export function formatProjectCanvasScalePercent(stageScale: number): string {
  const percent = stageScale * 100

  if (!Number.isFinite(percent)) {
    return '100'
  }

  if (Math.abs(percent) < 1) {
    return percent.toFixed(3).replace(/\.?0+$/, '')
  }

  if (Math.abs(percent) < 10) {
    return percent.toFixed(1).replace(/\.?0+$/, '')
  }

  return String(Math.round(percent))
}
