import type { QAppCfg, QAppCfgAuto, QAppCfgInput } from '@shared/qApp/cfgTypes'
import type { QAppMenuItem, QAppSvc } from '@shared/api/svcQApp'
import type { JsonValue } from '@shared/utils/utilTypes'
import { isJsonValue } from '@shared/utils/utilTypes'

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

const CANVAS_TARGET_OUTPUT_TARGETS: CanvasTargetOutputTarget[] = ['auto', 'agent', 'canvas', 'both']

const CANVAS_TARGET_ACTION_PHASES: CanvasTargetCapabilityActionPhase[] = [
  'before_model_stages',
  'before_stage',
  'after_stage',
  'after_model_stages',
  'after_summary'
]

export const CANVAS_TARGET_CAPABILITY_CATALOG_VERSION = 'canvas-target-tools-v2'

export const CANVAS_TARGET_CANVAS_ACTIONS: CanvasTargetCanvasActionCapability[] = [
  {
    action: 'add_text',
    label: 'Add text',
    description:
      'Create a text block on the current canvas, optionally positioned relative to a resolved source item.',
    requiredFields: ['text', 'x/y or source/sourceStageId'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_annotation',
    label: 'Add annotation',
    description:
      'Create a canvas annotation shape such as a rectangle, arrow, line, ellipse, or text annotation.',
    requiredFields: ['x/y/width/height or source/sourceStageId', 'annotationShape'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_image',
    label: 'Add image',
    description: 'Add an existing image URL/object URL/data URL to the current canvas.',
    requiredFields: ['sourceUrl'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_video',
    label: 'Add video',
    description: 'Add an existing video URL/object URL/data URL to the current canvas.',
    requiredFields: ['sourceUrl'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_model3d',
    label: 'Add 3D model',
    description: 'Add an existing 3D model URL/object URL/data URL to the current canvas.',
    requiredFields: ['sourceUrl'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'select_items',
    label: 'Select items',
    description:
      'Select existing canvas items by source, sourceStageId, or itemIds for later actions.',
    requiredFields: ['source or itemIds'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'duplicate_items',
    label: 'Duplicate items',
    description:
      'Clone existing canvas items, including items just placed by a QuickApp or canvas action.',
    requiredFields: ['source or itemIds', 'count'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'arrange_items',
    label: 'Arrange items',
    description: 'Arrange existing canvas items into a grid, row, or column.',
    requiredFields: ['source or itemIds', 'arrangement'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'transform_items',
    label: 'Transform items',
    description: 'Move, resize, rotate, or scale existing canvas items.',
    requiredFields: ['source or itemIds', 'x/y or deltaX/deltaY or size/rotation/scale'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_z_order',
    label: 'Set z order',
    description: 'Move existing canvas items forward, backward, to front, or to back.',
    requiredFields: ['source or itemIds', 'zOrder'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'delete_items',
    label: 'Delete items',
    description: 'Delete selected or resolved canvas items and prune affected groups.',
    requiredFields: ['source or itemIds'],
    surface: 'selection_toolbar',
    executionMode: 'direct',
    destructive: true
  },
  {
    action: 'clear_canvas',
    label: 'Clear canvas',
    description: 'Remove all canvas items and groups when the user explicitly asks to clear/reset.',
    requiredFields: ['explicitUserIntent'],
    surface: 'top_toolbar',
    executionMode: 'direct',
    destructive: true
  },
  {
    action: 'flip_items',
    label: 'Flip items',
    description: 'Flip resolved canvas items horizontally or vertically while preserving center.',
    requiredFields: ['source or itemIds', 'flipAxis'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'crop_image',
    label: 'Crop image',
    description: 'Apply a crop rectangle to one or more image items.',
    requiredFields: ['source or itemIds', 'coordinateSpace', 'cropX/cropY/cropWidth/cropHeight'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'extract_image_region',
    label: 'Extract image region',
    description:
      'Extract a transparent PNG canvas item from an image item using the supplied source-pixel, display-local, or normalized crop rectangle.',
    requiredFields: ['source or itemIds', 'coordinateSpace', 'cropX/cropY/cropWidth/cropHeight'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'update_text',
    label: 'Update text',
    description: 'Edit selected text items, including content, color, font size, and weight.',
    requiredFields: ['source or itemIds', 'text or style fields'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'update_annotation',
    label: 'Update annotation',
    description: 'Edit selected annotation items, including shape text, stroke, fill, and width.',
    requiredFields: ['source or itemIds', 'annotation/style fields'],
    surface: 'annotation_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_media_playback',
    label: 'Set media playback',
    description: 'Set video playback, mute, and volume state on canvas video items.',
    requiredFields: ['source or itemIds', 'playing/muted/volume'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'create_group',
    label: 'Create group',
    description:
      'Create a canvas group from resolved items and remove overlapping group conflicts.',
    requiredFields: ['source or itemIds'],
    surface: 'group_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'delete_group',
    label: 'Delete group',
    description:
      'Delete a canvas group by id, name, or source item overlap without deleting items.',
    requiredFields: ['groupId/groupName or source'],
    surface: 'group_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'rename_group',
    label: 'Rename group',
    description: 'Rename a canvas group by id, name, or source item overlap.',
    requiredFields: ['groupId/groupName or source', 'groupName'],
    surface: 'group_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'focus_items',
    label: 'Focus items',
    description: 'Select resolved items so the canvas can focus or continue operating on them.',
    requiredFields: ['source or itemIds'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'set_canvas_background',
    label: 'Set background',
    description: 'Set the canvas background color.',
    requiredFields: ['bgColor'],
    surface: 'top_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_grid_visibility',
    label: 'Set grid visibility',
    description: 'Show or hide the canvas grid.',
    requiredFields: ['showGrid'],
    surface: 'top_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_canvas_tool',
    label: 'Set canvas tool',
    description: 'Switch the active canvas tool and annotation defaults.',
    requiredFields: ['tool or annotationShape'],
    surface: 'top_toolbar',
    executionMode: 'direct'
  }
]

const truncateText = (value: string | undefined, maxLength = 120): string | undefined => {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

const normalizeNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const normalizeFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const normalizePositiveInteger = (value: unknown): number | undefined => {
  const number = normalizeFiniteNumber(value)
  if (number == null || number <= 0) return undefined
  return Math.floor(number)
}

const normalizeBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const normalizeStringLiteral = <T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): T | undefined => {
  const normalized = normalizeNonEmptyString(value)
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  return normalized && allowedValues.includes(normalized as T) ? (normalized as T) : undefined
}

const normalizeOutputTarget = (
  value: unknown,
  fallback: CanvasTargetOutputTarget
): CanvasTargetOutputTarget => {
  const normalized = normalizeNonEmptyString(value)
  if (normalized && CANVAS_TARGET_OUTPUT_TARGETS.includes(normalized as CanvasTargetOutputTarget)) {
    return normalized as CanvasTargetOutputTarget
  }
  return fallback
}

const normalizeActionPhase = (
  value: unknown,
  fallback: CanvasTargetCapabilityActionPhase
): CanvasTargetCapabilityActionPhase => {
  const normalized = normalizeNonEmptyString(value)?.replace(/-/g, '_')
  if (
    normalized &&
    CANVAS_TARGET_ACTION_PHASES.includes(normalized as CanvasTargetCapabilityActionPhase)
  ) {
    return normalized as CanvasTargetCapabilityActionPhase
  }
  return fallback
}

const normalizeCanvasOutputTarget = (value: unknown) => {
  const outputTarget = normalizeOutputTarget(value, 'canvas')
  return outputTarget === 'auto' ? 'canvas' : outputTarget
}

const normalizeCanvasActionName = (value: unknown): CanvasTargetCanvasActionName | undefined => {
  const normalized = normalizeNonEmptyString(value)
    ?.replace(/^canvas[.:]/i, '')
    .replace(/-/g, '_')
  if (!normalized) return undefined
  return CANVAS_TARGET_CANVAS_ACTIONS.some((entry) => entry.action === normalized)
    ? (normalized as CanvasTargetCanvasActionName)
    : undefined
}

const normalizeCanvasItemSource = (value: unknown): CanvasTargetCanvasItemSource | undefined =>
  normalizeStringLiteral(value, ['current_selection', 'all_canvas', 'item_ids'] as const)

const normalizeCanvasArrangement = (value: unknown): CanvasTargetCanvasArrangement | undefined =>
  normalizeStringLiteral(value, ['grid', 'row', 'column'] as const)

const normalizeCanvasZOrder = (value: unknown): CanvasTargetCanvasZOrder | undefined =>
  normalizeStringLiteral(value, ['front', 'back', 'forward', 'backward'] as const)

const normalizeCanvasFlipAxis = (value: unknown): CanvasTargetCanvasFlipAxis | undefined =>
  normalizeStringLiteral(value, ['horizontal', 'vertical'] as const)

const normalizeCanvasCoordinateSpace = (
  value: unknown
): CanvasTargetCanvasCoordinateSpace | undefined =>
  normalizeStringLiteral(value, [
    'canvas',
    'source_item',
    'source_item_normalized',
    'source_image_pixels'
  ] as const)

const normalizeCanvasTool = (value: unknown): CanvasTargetCanvasTool | undefined => {
  const normalized = normalizeNonEmptyString(value)?.replace(/_/g, '-')
  if (
    normalized &&
    (
      [
        'select',
        'hand',
        'annotate',
        'export-select',
        'crop-select',
        'extract-select',
        'target-select'
      ] as const
    ).includes(normalized as CanvasTargetCanvasTool)
  ) {
    return normalized as CanvasTargetCanvasTool
  }
  return undefined
}

const normalizeAnnotationShape = (value: unknown): CanvasTargetAnnotationShape | undefined =>
  normalizeStringLiteral(value, [
    'rect',
    'ellipse',
    'circle',
    'arrow',
    'line',
    'freedraw',
    'text_anno',
    'rhombus',
    'parallelogram',
    'double_line_rect',
    'document',
    'cylinder',
    'rounded_rect'
  ] as const)?.replace(/_/g, '-') as CanvasTargetAnnotationShape | undefined

const normalizeFontWeight = (value: unknown): 'normal' | 'bold' | undefined =>
  normalizeStringLiteral(value, ['normal', 'bold'] as const)

const normalizeVolume = (value: unknown): number | undefined => {
  const number = normalizeFiniteNumber(value)
  if (number == null) return undefined
  return Math.min(1, Math.max(0, number))
}

const normalizeCanvasItemIds = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const itemIds = value
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry))
  return itemIds.length > 0 ? Array.from(new Set(itemIds)) : undefined
}

function parseJsonObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function normalizeRawCapabilityActionRecord(rawAction: unknown): Record<string, unknown> | null {
  if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) return null
  const record = rawAction as Record<string, unknown>
  const functionRecord = parseJsonObjectRecord(record.function)
  const argumentRecord =
    parseJsonObjectRecord(record.arguments) ||
    parseJsonObjectRecord(record.args) ||
    parseJsonObjectRecord(record.parameters) ||
    parseJsonObjectRecord(record.input) ||
    parseJsonObjectRecord(functionRecord?.arguments)
  const functionName =
    normalizeNonEmptyString(functionRecord?.name) ||
    normalizeNonEmptyString(record.name) ||
    normalizeNonEmptyString(record.tool) ||
    normalizeNonEmptyString(record.toolName)

  return {
    ...record,
    ...(argumentRecord || {}),
    ...(functionName && !record.action && !record.qAppKey && !record.key
      ? { action: functionName }
      : {})
  }
}

function normalizeCanvasSourceReference(value: unknown): {
  source?: CanvasTargetCanvasItemSource
  itemIds?: string[]
  artifactId?: string
  sourceStageId?: string
} {
  const raw = normalizeNonEmptyString(value)
  if (!raw) return {}
  const normalized = raw.trim()
  const lower = normalized.toLowerCase()
  if (lower === 'selected' || lower === 'selection') {
    return { source: 'current_selection' }
  }
  const directSource = normalizeCanvasItemSource(normalized)
  if (directSource) return { source: directSource }

  const prefixed = normalized.match(/^([a-zA-Z_]+)\s*[:=]\s*(.+)$/)
  if (!prefixed) return {}
  const prefix = prefixed[1]
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  const id = prefixed[2]?.trim()
  if (!id) return {}
  if (prefix === 'artifact') return { artifactId: id }
  if (prefix === 'stage' || prefix === 'source_stage' || prefix === 'source_stage_id') {
    return { sourceStageId: id }
  }
  if (prefix === 'selected' || prefix === 'item' || prefix === 'canvas' || prefix === 'source') {
    return { itemIds: [id] }
  }
  return {}
}

const hasSlot = (value: QAppCfgInput): value is QAppCfgInput & { slot: string } =>
  'slot' in value && typeof value.slot === 'string' && value.slot.trim().length > 0

const summarizeQAppInputs = (cfg?: QAppCfg): CanvasTargetQAppInputCapability[] => {
  if (!cfg) return []
  return cfg.inputs
    .filter((input): input is QAppCfgInput => {
      return input.component !== 'Section' && input.component !== 'Description'
    })
    .map((input) => ({
      label: input.label,
      component: input.component,
      ...(hasSlot(input) ? { slot: input.slot } : {})
    }))
}

const summarizeQAppAutoInputs = (cfg?: QAppCfg): CanvasTargetQAppCapability['autoInputs'] => {
  return (cfg?.autoInputs || []).map((input) => ({
    label: input.label,
    component: input.component
  }))
}

const formatQAppCategory = (category: unknown): string | undefined => {
  if (typeof category === 'string') return category
  if (category && typeof category === 'object') {
    const record = category as Record<string, unknown>
    return normalizeNonEmptyString(record.name) || normalizeNonEmptyString(record.label)
  }
  return undefined
}

function flattenQAppMenuItems(
  items: QAppMenuItem[],
  path: string[] = []
): Array<{ item: QAppMenuItem; path: string[] }> {
  const result: Array<{ item: QAppMenuItem; path: string[] }> = []

  for (const item of items || []) {
    if (!item || item.isHidden) continue
    const nextPath = [...path, item.name || item.key]
    if (item.isDirectory) {
      result.push(...flattenQAppMenuItems(item.children || [], nextPath))
      continue
    }
    if (item.key?.trim()) {
      result.push({ item, path: nextPath })
    }
  }

  return result
}

export async function loadCanvasTargetCapabilityCatalog(
  qAppSvc: Pick<QAppSvc, 'listQAppCfgs' | 'getQAppCfg'> | undefined,
  options?: {
    maxQuickAppDetails?: number
  }
): Promise<CanvasTargetCapabilityCatalog> {
  const maxQuickAppDetails = options?.maxQuickAppDetails ?? 120

  if (!qAppSvc) {
    return {
      quickApps: [],
      canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
    }
  }

  const listResponse = await qAppSvc.listQAppCfgs({})
  const visibleQApps = flattenQAppMenuItems(listResponse.qApps || [])

  const quickApps = await Promise.all(
    visibleQApps.map(async ({ item, path }, index): Promise<CanvasTargetQAppCapability> => {
      if (index >= maxQuickAppDetails) {
        return {
          key: item.key,
          name: item.name || item.key,
          path,
          category: formatQAppCategory(item.category),
          inputs: [],
          autoInputs: [],
          detailUnavailable: true
        }
      }

      try {
        const detail = await qAppSvc.getQAppCfg({ key: item.key })
        return {
          key: item.key,
          name: item.name || item.key,
          path,
          category: formatQAppCategory(item.category),
          inputs: summarizeQAppInputs(detail.cfg),
          autoInputs: summarizeQAppAutoInputs(detail.cfg),
          outputNodeIds: detail.cfg.outputNodeIds
        }
      } catch {
        return {
          key: item.key,
          name: item.name || item.key,
          path,
          category: formatQAppCategory(item.category),
          inputs: [],
          autoInputs: [],
          detailUnavailable: true
        }
      }
    })
  )

  return {
    quickApps,
    canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
  }
}

function summarizeCanvasActionsForPrompt(actions: CanvasTargetCanvasActionCapability[]) {
  return actions.map((entry) => ({
    action: entry.action,
    mode: entry.executionMode,
    surface: entry.surface,
    required: entry.requiredFields,
    destructive: entry.destructive || undefined,
    schemaRef: `magicpot://canvas-target/tools/${entry.action}`,
    description: truncateText(entry.description, 140)
  }))
}

function summarizeQuickAppsForPrompt(quickApps: CanvasTargetQAppCapability[]) {
  return quickApps.map((qApp) => ({
    key: qApp.key,
    name: qApp.name,
    path: qApp.path.join(' / '),
    category: qApp.category,
    mustFollow: qApp.mustFollow || undefined,
    forbiddenActions: qApp.forbiddenActions || undefined,
    inputs: qApp.inputs.slice(0, 16).map((input) => ({
      label: truncateText(input.label, 80),
      component: input.component,
      slot: input.slot
    })),
    autoInputs: qApp.autoInputs.map((input) => ({
      label: truncateText(input.label, 80),
      component: input.component
    })),
    outputNodeIds: qApp.outputNodeIds,
    detailUnavailable: qApp.detailUnavailable || undefined
  }))
}

export function formatCanvasTargetCapabilitiesForPrompt(
  catalog: CanvasTargetCapabilityCatalog | undefined
): string {
  if (!catalog || (catalog.quickApps.length === 0 && catalog.canvasActions.length === 0)) {
    return 'Runtime capability catalog: no QuickApp or canvas actions are currently available.'
  }

  const quickAppsForPrompt = summarizeQuickAppsForPrompt(catalog.quickApps)
  const canvasActionsForPrompt = summarizeCanvasActionsForPrompt(catalog.canvasActions)

  return [
    'Runtime capability catalog:',
    'You may request capabilityActions when they are genuinely useful for the user intent.',
    'QuickApp actions run ComfyUI workflows; only QuickApps explicitly selected for this target are listed. If quickApps is empty, do not request quick_app capabilityActions.',
    'QuickApp mustFollow and forbiddenActions are user-authored constraints. Do not infer fixed software-defined purposes beyond the user rules, the visible workflow inputs, and the main user intent.',
    'Canvas actions are limited to the listed registry entries; do not invent internal UI operations.',
    'Direct canvas actions can be executed by the target runtime. Host UI commands and interactive-only tools are outside this target capability catalog.',
    'Capability actions must not override selected auxiliary models or user-authored constraints.',
    'The runtime executes capabilityActions in the exact order you return for each phase; it does not reorder them by dependency or reinterpret your semantic intent.',
    'Each capabilityAction is a direct command. The runtime only normalizes aliases, validates required fields, resolves referenced media, then calls the matching executor.',
    'Available execution families: model stages for understanding/generation/reporting, quick_app for selected ComfyUI workflows, canvas for deterministic canvas edits.',
    'Available canvas operation groups: add media/text/annotation, select/duplicate/arrange/transform, crop/extract image region, group, z-order, media playback, canvas background/grid/tool.',
    'For QuickApp inputAssignments, prefer slot when known; otherwise label may be used. For image/video inputs, bind the exact main-model-selected source with sourceStageId/sourceStageIds, artifactId/artifactIds, or itemIds. Use source only for generic inputs: user_intent, selection_snapshot, first_source_image, first_source_video, first_source_asset, first_upstream_image, first_upstream_video, or first_upstream_asset.',
    'For canvas item actions, prefer explicit artifactId/artifactIds or itemIds. source=current_selection is allowed only when you intentionally mean the current user selection. source=all_canvas is allowed only for explicit whole-canvas operations. Do not rely on implicit latest-output state.',
    'Use sourceStageId to target items placed or produced by a specific prior capability action; use sourceStageIds to target the ordered union of several prior capability action outputs.',
    'Model and QuickApp media outputs are automatically placed on the canvas and registered under their producing stage id. Do not request a separate canvas action just to add that same AI result again. Use add_image/add_video/add_model3d only for explicit already-known URLs, not for future model outputs. To crop, split, move, arrange, label, or annotate returned media, reference the producing stage with sourceStageId/sourceStageIds.',
    'Source-consuming canvas actions return a structured execution failure when their source cannot be resolved. Do not rely on implicit current selection after model or QuickApp media output; cite the producing stage id explicitly.',
    'For variant workflows, create separate duplicate_items actions with count 1 when different later edits must target different copies. A duplicate action stage output refers to the newly created copy or copies. Use one arrange_items action with sourceStageIds and explicit x/y/gap to align the variant root copies before adding source-relative labels or annotations. Do not create a separate raw duplicate unless the user explicitly asks for a raw/unmodified copy as one of the final deliverables.',
    'Use phase before_stage or after_stage with stageId to insert capability actions immediately around a specific model stage in long goals. The stageId must match a stageInstructions id.',
    'For duplicate_items, count means the number of new copies to create. Use arrangement grid/row/column for arrange_items; x/y on arrange_items is the top-left start anchor for the arranged set. Use zOrder front/back/forward/backward for set_z_order. Use cropX/cropY/cropWidth/cropHeight for crop_image and extract_image_region.',
    'crop_image mutates an existing image crop. extract_image_region creates new transparent PNG canvas item(s) and registered artifacts from explicit image regions. set_canvas_tool with extract-select only switches the UI tool; it does not perform automated extraction.',
    'Canvas geometry uses canvas coordinates by default. For add_text/add_annotation, set coordinateSpace to source_item for display-local coordinates inside the resolved source item, or source_item_normalized for 0..1 coordinates inside that source item. When add_text/add_annotation targets sourceStageId/sourceStageIds and coordinateSpace is omitted, the runtime treats the rectangle as source-local for safety. For crop_image/extract_image_region, coordinateSpace is required: source_item uses display-local coordinates inside the resolved item, canvas uses absolute canvas coordinates, source_item_normalized lets cropX/cropY/cropWidth/cropHeight express fractions of the current visible source crop, and source_image_pixels uses the original source image pixel grid.',
    'Do not place target reports, execution logs, stage summaries, or final explanatory text on the canvas. Keep final text in the Agent conversation or generated markdown files. Use add_text only for literal user-requested canvas labels or text objects, such as adding the exact label "123". Use add_annotation, not add_text, for box selection, bounding boxes, frames, and callout rectangles.',
    'For finalPresentation, choose canvas/both only for media outputs that genuinely belong on the canvas.',
    JSON.stringify(
      {
        capabilityCatalogVersion: CANVAS_TARGET_CAPABILITY_CATALOG_VERSION,
        quickApps: quickAppsForPrompt,
        canvasActions: canvasActionsForPrompt,
        canvasActionFieldGroups: {
          routing: [
            'type',
            'id',
            'action',
            'phase',
            'stageId',
            'beforeStageId',
            'afterStageId',
            'outputTarget'
          ],
          sources: [
            'artifactId',
            'artifactIds',
            'sourceStageId',
            'sourceStageIds',
            'itemIds',
            'source'
          ],
          geometry: [
            'x',
            'y',
            'width',
            'height',
            'coordinateSpace',
            'deltaX',
            'deltaY',
            'scaleX',
            'scaleY',
            'rotation'
          ],
          cropOrExtract: ['cropX', 'cropY', 'cropWidth', 'cropHeight'],
          duplicationAndLayout: [
            'count',
            'offsetX',
            'offsetY',
            'arrangement',
            'columns',
            'gapX',
            'gapY'
          ],
          mediaImport: ['sourceUrl', 'fileName'],
          textAndAnnotation: [
            'text',
            'annotationShape',
            'color',
            'stroke',
            'fill',
            'strokeWidth',
            'fillOpacity',
            'fontSize',
            'fontWeight',
            'itemLabel'
          ],
          state: [
            'zOrder',
            'flipAxis',
            'groupId',
            'groupName',
            'bgColor',
            'showGrid',
            'tool',
            'playing',
            'muted',
            'volume',
            'explicitUserIntent',
            'selectResult'
          ]
        },
        capabilityActionShape: {
          quick_app: {
            type: 'quick_app',
            id: 'action-id',
            qAppKey: 'listed-qapp-key',
            label: 'short label',
            reason: 'why this action is needed',
            phase:
              'before_model_stages | before_stage | after_stage | after_model_stages | after_summary',
            stageId: 'required when phase is before_stage or after_stage',
            beforeStageId: 'optional alias for before_stage anchoring',
            afterStageId: 'optional alias for after_stage anchoring',
            outputTarget: 'auto | agent | canvas | both',
            inputAssignments: [
              {
                slot: 'workflow.json.path',
                label: 'input label',
                value: 'literal value',
                source:
                  'user_intent | selection_snapshot | first_source_image | first_source_video | first_source_asset | first_upstream_image | first_upstream_video | first_upstream_asset',
                sourceStageId: 'prior-stage-id-that-produced-the-input-media',
                artifactId: 'prior-artifact-id-that-produced-the-input-media',
                itemIds: ['canvas-item-id-to-send-to-quickapp']
              }
            ]
          },
          canvas: {
            type: 'canvas',
            id: 'action-id',
            action: CANVAS_TARGET_CANVAS_ACTIONS.map((entry) => entry.action).join(' | '),
            label: 'short label',
            reason: 'why this canvas action is needed',
            phase:
              'before_model_stages | before_stage | after_stage | after_model_stages | after_summary',
            stageId: 'required when phase is before_stage or after_stage',
            beforeStageId: 'optional alias for before_stage anchoring',
            afterStageId: 'optional alias for after_stage anchoring',
            outputTarget: 'canvas | both | agent',
            text: 'text for add_text',
            sourceUrl: 'url for add_image/add_video/add_model3d',
            fileName: 'optional file name',
            artifactId: 'optional explicit Artifact Graph id',
            artifactIds: ['optional explicit Artifact Graph ids'],
            source: 'current_selection | all_canvas | item_ids',
            sourceStageId: 'optional prior capability action id',
            sourceStageIds:
              'optional ordered prior capability action ids; resolves the union of their outputs',
            itemIds: ['optional explicit canvas item ids'],
            count: 10,
            offsetX: 36,
            offsetY: 36,
            arrangement: 'grid | row | column',
            columns: 5,
            gapX: 24,
            gapY: 24,
            x: 100,
            y: 120,
            coordinateSpace: 'canvas | source_item | source_item_normalized | source_image_pixels',
            deltaX: 40,
            deltaY: 0,
            width: 512,
            height: 512,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            zOrder: 'front | back | forward | backward',
            flipAxis: 'horizontal | vertical',
            cropX: 0,
            cropY: 0,
            cropWidth: 512,
            cropHeight: 512,
            color: '#ffffff',
            stroke: '#ef4444',
            fill: '#ffffff',
            strokeWidth: 2,
            fillOpacity: 0.18,
            fontSize: 28,
            fontWeight: 'normal | bold',
            itemLabel:
              'visible label only for text-anno; omit for normal rect/ellipse/box annotations',
            groupId: 'optional group id',
            groupName: 'optional group name',
            bgColor: '#ffffff',
            showGrid: true,
            tool: 'select | hand | annotate | export-select | crop-select | extract-select | target-select',
            annotationShape:
              'rect | ellipse | circle | arrow | line | freedraw | text-anno | rhombus | parallelogram | double-line-rect | document | cylinder | rounded-rect',
            playing: false,
            muted: true,
            volume: 0.5,
            explicitUserIntent: true,
            selectResult: true
          }
        },
        finalPresentationShape: {
          target: 'auto | agent | canvas | both',
          reason: 'why this final output belongs there',
          addMediaToCanvas: true
        }
      },
      null,
      2
    )
  ].join('\n')
}

export function normalizeCanvasTargetCapabilityActions(
  rawActions: unknown,
  catalog: CanvasTargetCapabilityCatalog | undefined
): CanvasTargetCapabilityAction[] {
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return []
  }

  const qAppKeys = new Set((catalog?.quickApps || []).map((qApp) => qApp.key))
  const normalizedActions: CanvasTargetCapabilityAction[] = []

  rawActions.forEach((rawAction, index) => {
    const action = normalizeRawCapabilityActionRecord(rawAction)
    if (!action) return
    const canvasActionCandidate =
      normalizeCanvasActionName(action.action) ||
      normalizeCanvasActionName(action.name) ||
      normalizeCanvasActionName(action.tool) ||
      normalizeCanvasActionName(action.toolName)
    const qAppKeyCandidate =
      normalizeNonEmptyString(action.qAppKey) || normalizeNonEmptyString(action.key)
    const rawType = normalizeNonEmptyString(action.type)
    const explicitType = rawType === 'canvas' || rawType === 'quick_app' ? rawType : undefined
    const type =
      explicitType ||
      (canvasActionCandidate ? 'canvas' : qAppKeyCandidate ? 'quick_app' : undefined)
    const id = normalizeNonEmptyString(action.id) || `capability-action-${index + 1}`
    const label = normalizeNonEmptyString(action.label)
    const reason = normalizeNonEmptyString(action.reason)
    const stageId = normalizeNonEmptyString(action.stageId)
    const beforeStageId = normalizeNonEmptyString(action.beforeStageId)
    const afterStageId = normalizeNonEmptyString(action.afterStageId)

    if (type === 'quick_app') {
      const qAppKey = qAppKeyCandidate
      if (!qAppKey || !qAppKeys.has(qAppKey)) {
        return
      }

      const inputAssignments = Array.isArray(action.inputAssignments)
        ? action.inputAssignments.flatMap((entry): CanvasTargetQuickAppInputAssignment[] => {
            if (!entry || typeof entry !== 'object') return []
            const record = entry as Record<string, unknown>
            const slot = normalizeNonEmptyString(record.slot)
            const inputLabel = normalizeNonEmptyString(record.label)
            const source = normalizeNonEmptyString(record.source)
            const value = record.value
            const sourceReference = normalizeCanvasSourceReference(record.source)
            const valueReference =
              typeof value === 'string' ? normalizeCanvasSourceReference(value) : {}
            const sourceStageId =
              normalizeNonEmptyString(record.sourceStageId) ||
              normalizeNonEmptyString(record.source_stage_id) ||
              sourceReference.sourceStageId ||
              valueReference.sourceStageId
            const sourceStageIds =
              normalizeCanvasItemIds(record.sourceStageIds) ||
              normalizeCanvasItemIds(record.source_stage_ids)
            const artifactId =
              normalizeNonEmptyString(record.artifactId) ||
              normalizeNonEmptyString(record.artifact_id) ||
              sourceReference.artifactId ||
              valueReference.artifactId
            const artifactIds =
              normalizeCanvasItemIds(record.artifactIds) ||
              normalizeCanvasItemIds(record.artifact_ids)
            const itemIds =
              normalizeCanvasItemIds(record.itemIds) ||
              normalizeCanvasItemIds(record.item_ids) ||
              sourceReference.itemIds ||
              valueReference.itemIds
            if (
              !slot &&
              !inputLabel &&
              !source &&
              !sourceStageId &&
              !sourceStageIds &&
              !artifactId &&
              !artifactIds &&
              !itemIds
            ) {
              return []
            }
            return [
              {
                ...(slot ? { slot } : {}),
                ...(inputLabel ? { label: inputLabel } : {}),
                ...(isJsonValue(value) ? { value } : {}),
                ...(source &&
                [
                  'user_intent',
                  'selection_snapshot',
                  'first_source_asset',
                  'first_source_image',
                  'first_source_video',
                  'first_upstream_asset',
                  'first_upstream_image',
                  'first_upstream_video'
                ].includes(source)
                  ? {
                      source: source as CanvasTargetQuickAppInputAssignment['source']
                    }
                  : {}),
                ...(sourceStageId ? { sourceStageId } : {}),
                ...(sourceStageIds ? { sourceStageIds } : {}),
                ...(artifactId ? { artifactId } : {}),
                ...(artifactIds ? { artifactIds } : {}),
                ...(itemIds ? { itemIds } : {})
              }
            ]
          })
        : []

      normalizedActions.push({
        type: 'quick_app',
        id,
        qAppKey,
        ...(label ? { label } : {}),
        ...(reason ? { reason } : {}),
        phase: normalizeActionPhase(action.phase, 'before_model_stages'),
        ...(stageId ? { stageId } : {}),
        ...(beforeStageId ? { beforeStageId } : {}),
        ...(afterStageId ? { afterStageId } : {}),
        inputAssignments,
        outputTarget: normalizeOutputTarget(action.outputTarget, 'auto'),
        ...(normalizeNonEmptyString(action.preferredProfileId)
          ? { preferredProfileId: normalizeNonEmptyString(action.preferredProfileId) }
          : {})
      })
      return
    }

    if (type === 'canvas') {
      const canvasAction = canvasActionCandidate
      if (!canvasAction) return
      const text = normalizeNonEmptyString(action.text)
      const sourceUrl =
        normalizeNonEmptyString(action.sourceUrl) || normalizeNonEmptyString(action.url)
      const fileName = normalizeNonEmptyString(action.fileName)
      const sourceReference = normalizeCanvasSourceReference(action.source)
      const artifactId =
        normalizeNonEmptyString(action.artifactId) ||
        normalizeNonEmptyString(action.artifact_id) ||
        sourceReference.artifactId
      const artifactIds =
        normalizeCanvasItemIds(action.artifactIds) ||
        normalizeCanvasItemIds(action.artifact_ids) ||
        normalizeCanvasItemIds(action.artifacts)
      const itemIds =
        normalizeCanvasItemIds(action.itemIds) ||
        normalizeCanvasItemIds(action.item_ids) ||
        normalizeCanvasItemIds(action.ids) ||
        sourceReference.itemIds
      const source = sourceReference.source || normalizeCanvasItemSource(action.source)
      const sourceStageId =
        normalizeNonEmptyString(action.sourceStageId) ||
        normalizeNonEmptyString(action.source_stage_id) ||
        sourceReference.sourceStageId
      const sourceStageIds =
        normalizeCanvasItemIds(action.sourceStageIds) ||
        normalizeCanvasItemIds(action.source_stage_ids) ||
        normalizeCanvasItemIds(action.sourceStages)
      const count = normalizePositiveInteger(action.count)
      const offsetX = normalizeFiniteNumber(action.offsetX)
      const offsetY = normalizeFiniteNumber(action.offsetY)
      const arrangement =
        normalizeCanvasArrangement(action.arrangement) || normalizeCanvasArrangement(action.layout)
      const columns = normalizePositiveInteger(action.columns)
      const gapX = normalizeFiniteNumber(action.gapX)
      const gapY = normalizeFiniteNumber(action.gapY)
      const x = normalizeFiniteNumber(action.x)
      const y = normalizeFiniteNumber(action.y)
      const coordinateSpace = normalizeCanvasCoordinateSpace(action.coordinateSpace)
      const deltaX = normalizeFiniteNumber(action.deltaX)
      const deltaY = normalizeFiniteNumber(action.deltaY)
      const width = normalizeFiniteNumber(action.width)
      const height = normalizeFiniteNumber(action.height)
      const scaleX = normalizeFiniteNumber(action.scaleX)
      const scaleY = normalizeFiniteNumber(action.scaleY)
      const rotation = normalizeFiniteNumber(action.rotation)
      const zOrder = normalizeCanvasZOrder(action.zOrder)
      const flipAxis =
        normalizeCanvasFlipAxis(action.flipAxis) || normalizeCanvasFlipAxis(action.axis)
      const cropX = normalizeFiniteNumber(action.cropX)
      const cropY = normalizeFiniteNumber(action.cropY)
      const cropWidth = normalizeFiniteNumber(action.cropWidth)
      const cropHeight = normalizeFiniteNumber(action.cropHeight)
      const color = normalizeNonEmptyString(action.color)
      const stroke = normalizeNonEmptyString(action.stroke)
      const fill = normalizeNonEmptyString(action.fill)
      const strokeWidth = normalizeFiniteNumber(action.strokeWidth)
      const fillOpacity = normalizeFiniteNumber(action.fillOpacity)
      const fontSize = normalizeFiniteNumber(action.fontSize)
      const fontWeight = normalizeFontWeight(action.fontWeight)
      const itemLabel =
        normalizeNonEmptyString(action.itemLabel) ||
        normalizeNonEmptyString(action.annotationLabel) ||
        normalizeNonEmptyString(action.textLabel)
      const groupId = normalizeNonEmptyString(action.groupId)
      const groupName = normalizeNonEmptyString(action.groupName)
      const bgColor = normalizeNonEmptyString(action.bgColor)
      const showGrid = normalizeBoolean(action.showGrid)
      const tool = normalizeCanvasTool(action.tool)
      const annotationShape =
        normalizeAnnotationShape(action.annotationShape) || normalizeAnnotationShape(action.shape)
      const playing = normalizeBoolean(action.playing)
      const muted = normalizeBoolean(action.muted)
      const volume = normalizeVolume(action.volume)

      normalizedActions.push({
        type: 'canvas',
        id,
        action: canvasAction,
        ...(label ? { label } : {}),
        ...(reason ? { reason } : {}),
        phase: normalizeActionPhase(action.phase, 'after_summary'),
        ...(stageId ? { stageId } : {}),
        ...(beforeStageId ? { beforeStageId } : {}),
        ...(afterStageId ? { afterStageId } : {}),
        ...(text ? { text } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(fileName ? { fileName } : {}),
        ...(artifactId ? { artifactId } : {}),
        ...(artifactIds ? { artifactIds } : {}),
        ...(itemIds ? { itemIds } : {}),
        ...(source ? { source } : {}),
        ...(sourceStageId ? { sourceStageId } : {}),
        ...(sourceStageIds ? { sourceStageIds } : {}),
        ...(count != null ? { count } : {}),
        ...(offsetX != null ? { offsetX } : {}),
        ...(offsetY != null ? { offsetY } : {}),
        ...(arrangement ? { arrangement } : {}),
        ...(columns != null ? { columns } : {}),
        ...(gapX != null ? { gapX } : {}),
        ...(gapY != null ? { gapY } : {}),
        ...(x != null ? { x } : {}),
        ...(y != null ? { y } : {}),
        ...(coordinateSpace ? { coordinateSpace } : {}),
        ...(deltaX != null ? { deltaX } : {}),
        ...(deltaY != null ? { deltaY } : {}),
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
        ...(scaleX != null ? { scaleX } : {}),
        ...(scaleY != null ? { scaleY } : {}),
        ...(rotation != null ? { rotation } : {}),
        ...(zOrder ? { zOrder } : {}),
        ...(flipAxis ? { flipAxis } : {}),
        ...(cropX != null ? { cropX } : {}),
        ...(cropY != null ? { cropY } : {}),
        ...(cropWidth != null ? { cropWidth } : {}),
        ...(cropHeight != null ? { cropHeight } : {}),
        ...(color ? { color } : {}),
        ...(stroke ? { stroke } : {}),
        ...(fill ? { fill } : {}),
        ...(strokeWidth != null ? { strokeWidth } : {}),
        ...(fillOpacity != null ? { fillOpacity } : {}),
        ...(fontSize != null ? { fontSize } : {}),
        ...(fontWeight ? { fontWeight } : {}),
        ...(itemLabel ? { itemLabel } : {}),
        ...(groupId ? { groupId } : {}),
        ...(groupName ? { groupName } : {}),
        ...(bgColor ? { bgColor } : {}),
        ...(showGrid != null ? { showGrid } : {}),
        ...(tool ? { tool } : {}),
        ...(annotationShape ? { annotationShape } : {}),
        ...(playing != null ? { playing } : {}),
        ...(muted != null ? { muted } : {}),
        ...(volume != null ? { volume } : {}),
        ...(typeof action.explicitUserIntent === 'boolean'
          ? { explicitUserIntent: action.explicitUserIntent }
          : {}),
        ...(typeof action.selectResult === 'boolean' ? { selectResult: action.selectResult } : {}),
        outputTarget: normalizeCanvasOutputTarget(action.outputTarget)
      })
    }
  })

  return normalizedActions
}

export function normalizeCanvasTargetFinalPresentation(
  rawPresentation: unknown,
  fallback?: CanvasTargetFinalPresentation
): CanvasTargetFinalPresentation {
  if (!rawPresentation || typeof rawPresentation !== 'object') {
    return fallback || { target: 'auto' }
  }

  const record = rawPresentation as Record<string, unknown>
  const reason = normalizeNonEmptyString(record.reason)
  return {
    target: normalizeOutputTarget(record.target, fallback?.target || 'auto'),
    ...(reason ? { reason } : {}),
    ...(typeof record.addMediaToCanvas === 'boolean'
      ? { addMediaToCanvas: record.addMediaToCanvas }
      : fallback?.addMediaToCanvas !== undefined
        ? { addMediaToCanvas: fallback.addMediaToCanvas }
        : {})
  }
}
