export const PROJECT_CANVAS_SELECTION_OUTLINE_WIDTH = 3

const PROJECT_CANVAS_SELECTION_OUTLINE_COLOR = 'rgba(99,102,241,0.92)'
const PROJECT_CANVAS_SELECTION_OUTLINE_GLOW_COLOR = 'rgba(99,102,241,0.36)'
const PROJECT_CANVAS_SELECTION_OUTLINE_MAX_SCALE_COMPENSATION = 128

function resolveCanvasSelectionOutlineWidth(scaleCompensation = 1) {
  const safeScaleCompensation =
    Number.isFinite(scaleCompensation) && scaleCompensation > 0 ? scaleCompensation : 1
  return (
    PROJECT_CANVAS_SELECTION_OUTLINE_WIDTH *
    Math.min(PROJECT_CANVAS_SELECTION_OUTLINE_MAX_SCALE_COMPENSATION, safeScaleCompensation)
  )
}

export const buildCanvasSelectionOutlineStyles = (
  isSelected: boolean,
  options: { scaleCompensation?: number } = {}
) => {
  if (!isSelected) {
    return {
      outline: 'none',
      boxShadow: 'none'
    }
  }

  const outlineWidth = resolveCanvasSelectionOutlineWidth(options.scaleCompensation)
  return {
    outline: `${outlineWidth}px solid ${PROJECT_CANVAS_SELECTION_OUTLINE_COLOR}`,
    boxShadow: `0 0 0 ${outlineWidth}px ${PROJECT_CANVAS_SELECTION_OUTLINE_GLOW_COLOR}`
  }
}
