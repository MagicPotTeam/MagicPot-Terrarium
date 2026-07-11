import type {
  CanvasTargetCapabilityActionPhase,
  CanvasTargetOutputTarget
} from './canvasTargetCapabilityTypes'

export const CANVAS_TARGET_OUTPUT_TARGETS: CanvasTargetOutputTarget[] = [
  'auto',
  'agent',
  'canvas',
  'both'
]

export const CANVAS_TARGET_ACTION_PHASES: CanvasTargetCapabilityActionPhase[] = [
  'before_model_stages',
  'before_stage',
  'after_stage',
  'after_model_stages',
  'after_summary'
]
