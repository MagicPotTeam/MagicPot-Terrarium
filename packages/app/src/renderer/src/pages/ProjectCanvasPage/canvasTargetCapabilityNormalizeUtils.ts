import { CANVAS_TARGET_CANVAS_ACTIONS } from './canvasTargetCanvasActionCatalog'
import {
  CANVAS_TARGET_ACTION_PHASES,
  CANVAS_TARGET_OUTPUT_TARGETS
} from './canvasTargetCapabilityConstants'
import {
  type CanvasTargetAnnotationShape,
  type CanvasTargetCanvasActionName,
  type CanvasTargetCanvasArrangement,
  type CanvasTargetCanvasCoordinateSpace,
  type CanvasTargetCanvasFlipAxis,
  type CanvasTargetCanvasItemSource,
  type CanvasTargetCanvasTool,
  type CanvasTargetCanvasZOrder,
  type CanvasTargetCapabilityActionPhase,
  type CanvasTargetOutputTarget
} from './canvasTargetCapabilityTypes'

export const normalizeNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export const normalizeFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const normalizePositiveInteger = (value: unknown): number | undefined => {
  const number = normalizeFiniteNumber(value)
  if (number == null || number <= 0) return undefined
  return Math.floor(number)
}

export const normalizeBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

export const normalizeStringLiteral = <T extends string>(
  value: unknown,
  allowedValues: readonly T[]
): T | undefined => {
  const normalized = normalizeNonEmptyString(value)
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  return normalized && allowedValues.includes(normalized as T) ? (normalized as T) : undefined
}

export const normalizeOutputTarget = (
  value: unknown,
  fallback: CanvasTargetOutputTarget
): CanvasTargetOutputTarget => {
  const normalized = normalizeNonEmptyString(value)
  if (normalized && CANVAS_TARGET_OUTPUT_TARGETS.includes(normalized as CanvasTargetOutputTarget)) {
    return normalized as CanvasTargetOutputTarget
  }
  return fallback
}

export const normalizeActionPhase = (
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

export const normalizeCanvasOutputTarget = (value: unknown) => {
  const outputTarget = normalizeOutputTarget(value, 'canvas')
  return outputTarget === 'auto' ? 'canvas' : outputTarget
}

export const normalizeCanvasActionName = (
  value: unknown
): CanvasTargetCanvasActionName | undefined => {
  const normalized = normalizeNonEmptyString(value)
    ?.replace(/^canvas[.:]/i, '')
    .replace(/-/g, '_')
  if (!normalized) return undefined
  return CANVAS_TARGET_CANVAS_ACTIONS.some((entry) => entry.action === normalized)
    ? (normalized as CanvasTargetCanvasActionName)
    : undefined
}

export const normalizeCanvasItemSource = (
  value: unknown
): CanvasTargetCanvasItemSource | undefined =>
  normalizeStringLiteral(value, ['current_selection', 'all_canvas', 'item_ids'] as const)

export const normalizeCanvasArrangement = (
  value: unknown
): CanvasTargetCanvasArrangement | undefined =>
  normalizeStringLiteral(value, ['grid', 'row', 'column'] as const)

export const normalizeCanvasZOrder = (value: unknown): CanvasTargetCanvasZOrder | undefined =>
  normalizeStringLiteral(value, ['front', 'back', 'forward', 'backward'] as const)

export const normalizeCanvasFlipAxis = (value: unknown): CanvasTargetCanvasFlipAxis | undefined =>
  normalizeStringLiteral(value, ['horizontal', 'vertical'] as const)

export const normalizeCanvasCoordinateSpace = (
  value: unknown
): CanvasTargetCanvasCoordinateSpace | undefined =>
  normalizeStringLiteral(value, [
    'canvas',
    'source_item',
    'source_item_normalized',
    'source_image_pixels'
  ] as const)

export const normalizeCanvasTool = (value: unknown): CanvasTargetCanvasTool | undefined => {
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

export const normalizeAnnotationShape = (value: unknown): CanvasTargetAnnotationShape | undefined =>
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

export const normalizeFontWeight = (value: unknown): 'normal' | 'bold' | undefined =>
  normalizeStringLiteral(value, ['normal', 'bold'] as const)

export const normalizeVolume = (value: unknown): number | undefined => {
  const number = normalizeFiniteNumber(value)
  if (number == null) return undefined
  return Math.min(1, Math.max(0, number))
}

export const normalizeCanvasItemIds = (value: unknown): string[] | undefined => {
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

export function normalizeRawCapabilityActionRecord(
  rawAction: unknown
): Record<string, unknown> | null {
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

export function normalizeCanvasSourceReference(value: unknown): {
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
