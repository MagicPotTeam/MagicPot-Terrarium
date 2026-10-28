import { useCallback, useEffect, useRef } from 'react'

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
  const projectIdRef = useRef<string | null>(null)
  const projectTraceCanvasSnapshotRef = useRef<ProjectTraceCanvasSnapshot | null>(null)
  const projectTraceCanvasPendingBaselineRef = useRef<ProjectTraceCanvasSnapshot | null>(null)
  const projectTraceCanvasEventTimerRef = useRef<number | null>(null)
  const pendingEventRef = useRef<{
    input: ProjectTraceCanvasRuntimeEventInput
    emit: (input: ProjectTraceCanvasRuntimeEventInput) => void
  } | null>(null)

  const flushPendingEvent = useCallback(() => {
    if (projectTraceCanvasEventTimerRef.current !== null) {
      window.clearTimeout(projectTraceCanvasEventTimerRef.current)
      projectTraceCanvasEventTimerRef.current = null
    }
    const pending = pendingEventRef.current
    pendingEventRef.current = null
    projectTraceCanvasPendingBaselineRef.current = null
    if (pending) pending.emit(pending.input)
  }, [])

  // Only leaving a project flushes. Ordinary rerenders must keep the debounce baseline.
  useEffect(() => () => flushPendingEvent(), [canvasId, flushPendingEvent])

  useEffect(() => {
    const itemMetrics = buildProjectTraceCanvasItemMetrics(items)
    const signature = buildProjectTraceCanvasItemSignature(itemMetrics)
    const nextSnapshot = {
      signature,
      itemCount: items.length,
      selectionCount: selectedIds.size,
      items: itemMetrics
    }

    if (projectIdRef.current !== canvasId) {
      flushPendingEvent()
      projectIdRef.current = canvasId
      projectTraceCanvasSnapshotRef.current = nextSnapshot
      if (canvasId) {
        // The identity ref also prevents duplicate opens during StrictMode effect replay.
        emitRuntimeEvent({
          projectId: canvasId,
          scope: 'system',
          action: 'project_opened',
          status: 'info',
          safeSummary: 'Project opened.',
          canvasMutation: false
        })
      }
      return
    }

    const previous = projectTraceCanvasSnapshotRef.current
    if (!canvasId || !previous) return
    if (
      previous.signature === signature &&
      previous.itemCount === items.length &&
      previous.selectionCount === selectedIds.size &&
      Object.values(itemMetrics).every(
        (item) => previous.items[item.id]?.committedText === item.committedText
      )
    ) {
      return
    }

    projectTraceCanvasSnapshotRef.current = nextSnapshot
    if (projectTraceCanvasEventTimerRef.current !== null) {
      window.clearTimeout(projectTraceCanvasEventTimerRef.current)
    }

    const baseline = projectTraceCanvasPendingBaselineRef.current || previous
    projectTraceCanvasPendingBaselineRef.current = baseline
    // A commit immediately reverted inside the debounce has no net operation.
    // Discard it rather than flushing an invented mutation on project switch.
    if (
      baseline.signature === signature &&
      baseline.selectionCount === selectedIds.size &&
      Object.values(itemMetrics).every(
        (item) => baseline.items[item.id]?.committedText === item.committedText
      )
    ) {
      projectTraceCanvasEventTimerRef.current = null
      projectTraceCanvasPendingBaselineRef.current = null
      pendingEventRef.current = null
      return
    }
    // Count identities, not net length: additions and deletions can share a debounce window.
    const createdItemCount = Object.keys(itemMetrics).filter(
      (id) => !Object.prototype.hasOwnProperty.call(baseline.items, id)
    ).length
    const removedItemCount = Object.keys(baseline.items).filter(
      (id) => !Object.prototype.hasOwnProperty.call(itemMetrics, id)
    ).length
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
      createdItemCount > 0 && removedItemCount > 0
        ? 'canvas_items_changed'
        : createdItemCount > 0
          ? 'canvas_items_added'
          : removedItemCount > 0
            ? 'canvas_items_removed'
            : baseline.signature !== signature || canvasChange.textEditedItemCount > 0
              ? 'canvas_items_changed'
              : selectionChanged
                ? 'canvas_selection_changed'
                : 'canvas_items_changed'
    const itemTypeSummary = summarizeProjectTraceCanvasItemTypes(items)
    const outputKinds = Array.from(new Set(items.map((item) => item.type))).slice(0, 12)

    // Capture the original project and computed metrics, never a later render's props.
    pendingEventRef.current = {
      emit: emitRuntimeEvent,
      input: {
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
      }
    }
    projectTraceCanvasEventTimerRef.current = window.setTimeout(flushPendingEvent, debounceMs)
  }, [
    canvasId,
    debounceMs,
    emitRuntimeEvent,
    flushPendingEvent,
    isChineseUi,
    items,
    projectName,
    selectedIds
  ])
}
