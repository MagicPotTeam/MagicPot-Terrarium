import type { QAppCfgAuto, QAppCfgInput } from '@shared/qApp/cfgTypes'
import type { JsonValue } from '@shared/utils/utilTypes'

export type CanvasTargetOutputTarget = 'auto' | 'agent' | 'canvas' | 'both'

export type CanvasTargetCapabilityActionPhase =
  | 'before_model_stages'
  | 'before_stage'
  | 'after_stage'
  | 'after_model_stages'
  | 'after_summary'

export type CanvasTargetQuickAppInputAssignment = {
  slot?: string
  label?: string
  value?: JsonValue
  source?:
    | 'user_intent'
    | 'selection_snapshot'
    | 'first_source_asset'
    | 'first_source_image'
    | 'first_source_video'
    | 'first_upstream_asset'
    | 'first_upstream_image'
    | 'first_upstream_video'
  sourceStageId?: string
  sourceStageIds?: string[]
  artifactId?: string
  artifactIds?: string[]
  itemIds?: string[]
}

export type CanvasTargetQuickAppAction = {
  type: 'quick_app'
  id: string
  qAppKey: string
  label?: string
  reason?: string
  phase: CanvasTargetCapabilityActionPhase
  stageId?: string
  beforeStageId?: string
  afterStageId?: string
  inputAssignments: CanvasTargetQuickAppInputAssignment[]
  outputTarget: CanvasTargetOutputTarget
  preferredProfileId?: string
}

export type CanvasTargetCanvasActionName =
  | 'add_text'
  | 'add_annotation'
  | 'add_image'
  | 'add_video'
  | 'add_model3d'
  | 'select_items'
  | 'duplicate_items'
  | 'arrange_items'
  | 'transform_items'
  | 'set_z_order'
  | 'delete_items'
  | 'clear_canvas'
  | 'flip_items'
  | 'crop_image'
  | 'extract_image_region'
  | 'update_text'
  | 'update_annotation'
  | 'set_media_playback'
  | 'create_group'
  | 'delete_group'
  | 'rename_group'
  | 'focus_items'
  | 'set_canvas_background'
  | 'set_grid_visibility'
  | 'set_canvas_tool'

export type CanvasTargetCanvasItemSource = 'current_selection' | 'all_canvas' | 'item_ids'

export type CanvasTargetCanvasArrangement = 'grid' | 'row' | 'column'

export type CanvasTargetCanvasZOrder = 'front' | 'back' | 'forward' | 'backward'

export type CanvasTargetCanvasFlipAxis = 'horizontal' | 'vertical'

export type CanvasTargetCanvasCoordinateSpace =
  | 'canvas'
  | 'source_item'
  | 'source_item_normalized'
  | 'source_image_pixels'

export type CanvasTargetCanvasTool =
  | 'select'
  | 'hand'
  | 'annotate'
  | 'export-select'
  | 'crop-select'
  | 'extract-select'
  | 'target-select'

export type CanvasTargetAnnotationShape =
  | 'rect'
  | 'ellipse'
  | 'circle'
  | 'arrow'
  | 'line'
  | 'freedraw'
  | 'text-anno'
  | 'rhombus'
  | 'parallelogram'
  | 'double-line-rect'
  | 'document'
  | 'cylinder'
  | 'rounded-rect'

export type CanvasTargetCanvasAction = {
  type: 'canvas'
  id: string
  action: CanvasTargetCanvasActionName
  label?: string
  reason?: string
  phase: CanvasTargetCapabilityActionPhase
  stageId?: string
  beforeStageId?: string
  afterStageId?: string
  text?: string
  sourceUrl?: string
  fileName?: string
  artifactId?: string
  artifactIds?: string[]
  itemIds?: string[]
  source?: CanvasTargetCanvasItemSource
  sourceStageId?: string
  sourceStageIds?: string[]
  count?: number
  offsetX?: number
  offsetY?: number
  arrangement?: CanvasTargetCanvasArrangement
  columns?: number
  gapX?: number
  gapY?: number
  x?: number
  y?: number
  coordinateSpace?: CanvasTargetCanvasCoordinateSpace
  deltaX?: number
  deltaY?: number
  width?: number
  height?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
  zOrder?: CanvasTargetCanvasZOrder
  flipAxis?: CanvasTargetCanvasFlipAxis
  cropX?: number
  cropY?: number
  cropWidth?: number
  cropHeight?: number
  color?: string
  stroke?: string
  fill?: string
  strokeWidth?: number
  fillOpacity?: number
  fontSize?: number
  fontWeight?: 'normal' | 'bold'
  itemLabel?: string
  groupId?: string
  groupName?: string
  bgColor?: string
  showGrid?: boolean
  tool?: CanvasTargetCanvasTool
  annotationShape?: CanvasTargetAnnotationShape
  playing?: boolean
  muted?: boolean
  volume?: number
  explicitUserIntent?: boolean
  selectResult?: boolean
  outputTarget: Exclude<CanvasTargetOutputTarget, 'auto'>
}

export type CanvasTargetCapabilityAction = CanvasTargetQuickAppAction | CanvasTargetCanvasAction

export type CanvasTargetFinalPresentation = {
  target: CanvasTargetOutputTarget
  reason?: string
  addMediaToCanvas?: boolean
}

export type CanvasTargetQAppInputCapability = {
  label: string
  component: QAppCfgInput['component']
  slot?: string
}

export type CanvasTargetQAppCapability = {
  key: string
  name: string
  path: string[]
  category?: string
  mustFollow?: string
  forbiddenActions?: string
  inputs: CanvasTargetQAppInputCapability[]
  autoInputs: Array<{
    label: string
    component: QAppCfgAuto['component']
  }>
  outputNodeIds?: string[]
  detailUnavailable?: boolean
}

export type CanvasTargetCanvasActionCapability = {
  action: CanvasTargetCanvasActionName
  label: string
  description: string
  requiredFields: string[]
  surface:
    | 'canvas'
    | 'top_toolbar'
    | 'selection_toolbar'
    | 'group_toolbar'
    | 'annotation_toolbar'
    | 'external_toolbar'
  executionMode: 'direct'
  destructive?: boolean
}

export type CanvasTargetCapabilityCatalog = {
  quickApps: CanvasTargetQAppCapability[]
  canvasActions: CanvasTargetCanvasActionCapability[]
}
