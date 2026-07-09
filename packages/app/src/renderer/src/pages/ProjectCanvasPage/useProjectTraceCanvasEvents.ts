import { useEffect, useRef } from 'react'

import { emitProjectTraceRuntimeEvent } from '@renderer/features/projectTrace/projectTraceRuntime'
import {
  buildProjectTraceCanvasItemMetrics,
  buildProjectTraceCanvasItemSignature,
  measureProjectTraceCanvasRuleMetrics,
  summarizeProjectTraceCanvasChange,
  summarizeProjectTraceCanvasItemTypes,
  type ProjectTraceCanvasSnapshot
} from './projectTraceCanvasMetrics'
import type { CanvasItem } from './types'

export type ProjectTraceCanvasRuntimeEventInput = Parameters<typeof emitProjectTraceRuntimeEvent>[0]

export type UseProjectTraceCanvasEventsOptions = {
  canvasId: string
  projectName: string
  items: CanvasItem[]
  selectedIds: Set<string>
  isChineseUi: boolean
  debounceMs?: number
  emitRuntimeEvent?: (input: ProjectTraceCanvasRuntimeEventInput) => void
}

export function useProjectTraceCanvasEvents({
  canvasId,
  projectName,
  items,
  selectedIds,
  isChineseUi,
  debounceMs = 700,
  emitRuntimeEvent = emitProjectTraceRuntimeEvent
}: UseProjectTraceCanvasEventsOptions) {
  const projectTraceCanvasSnapshotRef = useRef<ProjectTraceCanvasSnapshot | null>(null)
  const projectTraceCanvasPendingBaselineRef = useRef<ProjectTraceCanvasSnapshot | null>(null)
  const projectTraceCanvasEventTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const itemMetrics = buildProjectTraceCanvasItemMetrics(items)
    const signature = buildProjectTraceCanvasItemSignature(itemMetrics)
    const previous = projectTraceCanvasSnapshotRef.current
    const nextSnapshot = {
      signature,
      itemCount: items.length,
      selectionCount: selectedIds.size,
      items: itemMetrics
    }

    if (!previous) {
      projectTraceCanvasSnapshotRef.current = nextSnapshot
      return
    }

    if (
      previous.signature === signature &&
      previous.itemCount === items.length &&
      previous.selectionCount === selectedIds.size
    ) {
      return
    }

    projectTraceCanvasSnapshotRef.current = nextSnapshot
    if (projectTraceCanvasEventTimerRef.current) {
      window.clearTimeout(projectTraceCanvasEventTimerRef.current)
    }

    const baseline = projectTraceCanvasPendingBaselineRef.current || previous
    projectTraceCanvasPendingBaselineRef.current = baseline
    const createdItemCount = Math.max(0, items.length - baseline.itemCount)
    const removedItemCount = Math.max(0, baseline.itemCount - items.length)
    const selectionChanged = baseline.selectionCount !== selectedIds.size
    const canvasChange = summarizeProjectTraceCanvasChange(
      baseline.items,
      itemMetrics,
      selectedIds.size,
      selectionChanged,
      isChineseUi
    )
    const canvasRuleMetrics = measureProjectTraceCanvasRuleMetrics(baseline.items, itemMetrics)
    const action =
      createdItemCount > 0
        ? 'canvas_items_added'
        : removedItemCount > 0
          ? 'canvas_items_removed'
          : canvasChange.movementDistancePx !== undefined
            ? 'canvas_items_changed'
            : selectionChanged
              ? 'canvas_selection_changed'
              : 'canvas_items_changed'
    const itemTypeSummary = summarizeProjectTraceCanvasItemTypes(items)
    const outputKinds = Array.from(new Set(items.map((item) => item.type))).slice(0, 12)

    projectTraceCanvasEventTimerRef.current = window.setTimeout(() => {
      emitRuntimeEvent({
        projectId: canvasId,
        projectName,
        scope: 'canvas',
        action,
        status: 'success',
        safeSummary: [
          canvasChange.summary,
          `Canvas has ${items.length} item(s), ${selectedIds.size} selected.`,
          itemTypeSummary ? `Item types: ${itemTypeSummary}.` : 'Canvas is empty.'
        ].join(' '),
        entityType: 'canvas_item',
        entityCount: items.length,
        outputKinds,
        affectedItemCount: canvasChange.affectedItemCount,
        createdItemCount,
        ...(canvasRuleMetrics.removedItemCount !== undefined
          ? { removedItemCount: canvasRuleMetrics.removedItemCount }
          : {}),
        ...(canvasRuleMetrics.resizedItemCount !== undefined
          ? { resizedItemCount: canvasRuleMetrics.resizedItemCount }
          : {}),
        ...(canvasRuleMetrics.rotatedItemCount !== undefined
          ? { rotatedItemCount: canvasRuleMetrics.rotatedItemCount }
          : {}),
        ...(canvasRuleMetrics.reorderedItemCount !== undefined
          ? { reorderedItemCount: canvasRuleMetrics.reorderedItemCount }
          : {}),
        ...(canvasChange.movementDistancePx !== undefined
          ? { movementDistancePx: canvasChange.movementDistancePx }
          : {}),
        ...(canvasRuleMetrics.maxScaleChangeRatio !== undefined
          ? { maxScaleChangeRatio: canvasRuleMetrics.maxScaleChangeRatio }
          : {}),
        ...(canvasRuleMetrics.maxRotationDeltaDeg !== undefined
          ? { maxRotationDeltaDeg: canvasRuleMetrics.maxRotationDeltaDeg }
          : {}),
        ...(canvasRuleMetrics.maxLayerDelta !== undefined
          ? { maxLayerDelta: canvasRuleMetrics.maxLayerDelta }
          : {}),
        canvasMutation: action !== 'canvas_selection_changed',
        riskSignals: removedItemCount > 0 ? ['destructive_action'] : []
      })
      projectTraceCanvasPendingBaselineRef.current = null
    }, debounceMs)

    return () => {
      if (projectTraceCanvasEventTimerRef.current) {
        window.clearTimeout(projectTraceCanvasEventTimerRef.current)
      }
    }
  }, [canvasId, debounceMs, emitRuntimeEvent, isChineseUi, items, projectName, selectedIds])
}
