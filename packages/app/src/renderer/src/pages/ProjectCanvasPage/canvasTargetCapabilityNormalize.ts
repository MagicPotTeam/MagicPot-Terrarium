import { isJsonValue } from '@shared/utils/utilTypes'

import {
  normalizeActionPhase,
  normalizeAnnotationShape,
  normalizeBoolean,
  normalizeCanvasActionName,
  normalizeCanvasArrangement,
  normalizeCanvasCoordinateSpace,
  normalizeCanvasFlipAxis,
  normalizeCanvasItemIds,
  normalizeCanvasItemSource,
  normalizeCanvasOutputTarget,
  normalizeCanvasSourceReference,
  normalizeCanvasTool,
  normalizeCanvasZOrder,
  normalizeFiniteNumber,
  normalizeFontWeight,
  normalizeNonEmptyString,
  normalizeOutputTarget,
  normalizePositiveInteger,
  normalizeRawCapabilityActionRecord,
  normalizeVolume
} from './canvasTargetCapabilityNormalizeUtils'
import { validateCanvasTargetMediaSourceUrl } from './canvasTargetMediaDispatchSafety'
import type {
  CanvasTargetCapabilityAction,
  CanvasTargetCapabilityCatalog,
  CanvasTargetFinalPresentation,
  CanvasTargetQuickAppInputAssignment
} from './canvasTargetCapabilityTypes'

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
      const rawSourceUrl =
        normalizeNonEmptyString(action.sourceUrl) || normalizeNonEmptyString(action.url)
      const sourceUrl = rawSourceUrl
        ? validateCanvasTargetMediaSourceUrl(rawSourceUrl).safe
          ? rawSourceUrl
          : undefined
        : undefined
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
