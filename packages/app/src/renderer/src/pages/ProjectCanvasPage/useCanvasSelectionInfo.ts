import { useCallback, useEffect, useRef } from 'react'
import { useSelector } from 'react-redux'
import type { CanvasTargetAssetMetadata } from '@shared/canvasTarget'
import { CANVAS_MODEL3D_METADATA_UPDATED_EVENT } from './components/modelLoaders/modelInspectionMetadataCache'
import { buildDesignInspectionContextPack } from './designInspectionWorkflow'
import type { CanvasGroup, CanvasItem } from './types'
import type { CanvasExportBounds } from './groupPlaybackUtils'

type StageNodeLike = {
  getClientRect?: () => CanvasExportBounds
}

type StageLike = {
  findOne?: (selector: string) => StageNodeLike | null | undefined
}

type StageRefLike = {
  getStage?: () => StageLike | null
}

type UseCanvasSelectionInfoOptions = {
  canvasId: string
  projectName: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  selectedIds: Set<string>
  stageRef: { current: StageRefLike | null }
  getOverlayStageRect: (item: CanvasItem) => CanvasExportBounds | null
  stageRectToCanvasBounds: (rect: CanvasExportBounds) => CanvasExportBounds
  resolveCanvasTargetItemBounds: (item: CanvasItem) => CanvasExportBounds
  buildCanvasAssetMetadata: (items: CanvasItem[]) => CanvasTargetAssetMetadata[]
}

type LayoutState = {
  layout: {
    bottomPanelVisible: boolean
    bottomPanelActiveTab: string | null
  }
}

function doCanvasBoundsOverlap(
  left: CanvasExportBounds | null | undefined,
  right: CanvasExportBounds | null | undefined
): boolean {
  if (!left || !right) return false

  const overlapWidth =
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const overlapHeight =
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)

  return overlapWidth > 0 && overlapHeight > 0
}

function roundSelectionInfoMetric(value: number): number {
  return Math.round(value * 100) / 100
}

function normalizeSelectionInfoBounds(bounds: CanvasExportBounds): CanvasExportBounds {
  return {
    x: roundSelectionInfoMetric(bounds.x),
    y: roundSelectionInfoMetric(bounds.y),
    width: roundSelectionInfoMetric(bounds.width),
    height: roundSelectionInfoMetric(bounds.height)
  }
}

function mergeSelectionInfoBounds(boundsList: CanvasExportBounds[]): CanvasExportBounds | null {
  if (boundsList.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const bounds of boundsList) {
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return normalizeSelectionInfoBounds({
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  })
}

export function useCanvasSelectionInfo({
  canvasId,
  projectName,
  items,
  groups,
  selectedIds,
  stageRef,
  getOverlayStageRect,
  stageRectToCanvasBounds,
  resolveCanvasTargetItemBounds,
  buildCanvasAssetMetadata
}: UseCanvasSelectionInfoOptions) {
  const bottomPanelVisible = useSelector((state: LayoutState) => state.layout.bottomPanelVisible)
  const bottomPanelActiveTab = useSelector(
    (state: LayoutState) => state.layout.bottomPanelActiveTab
  )
  const selectionInfoDispatchFrameRef = useRef<number | null>(null)

  const getSelectionInfoVisualBounds = useCallback(
    (item: CanvasItem): CanvasExportBounds => {
      if (
        item.type === 'image' ||
        item.type === 'video' ||
        item.type === 'model3d' ||
        item.type === 'html'
      ) {
        const overlayRect = getOverlayStageRect(item)
        if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
          return normalizeSelectionInfoBounds(stageRectToCanvasBounds(overlayRect))
        }
      }

      const stage = stageRef.current?.getStage?.()
      const node = stage?.findOne?.(`#${item.id}`)
      const nodeRect = node?.getClientRect?.()
      if (nodeRect) {
        if (nodeRect.width > 0 && nodeRect.height > 0) {
          return normalizeSelectionInfoBounds(stageRectToCanvasBounds(nodeRect))
        }
      }

      return normalizeSelectionInfoBounds(resolveCanvasTargetItemBounds(item))
    },
    [getOverlayStageRect, resolveCanvasTargetItemBounds, stageRectToCanvasBounds, stageRef]
  )

  const buildSelectionInfoDetail = useCallback(() => {
    if (!bottomPanelVisible || bottomPanelActiveTab !== 'elements') {
      return {
        canvasId,
        projectName,
        selectionCount: 0,
        structure: null,
        assetMetadata: [],
        layerIndexByItemId: {}
      }
    }

    const selectedItems = items.filter((item) => selectedIds.has(item.id))
    const orderedItems = items
      .map((item, index) => ({
        item,
        index,
        bounds: getSelectionInfoVisualBounds(item)
      }))
      .sort((left, right) => {
        if (left.item.zIndex !== right.item.zIndex) {
          return left.item.zIndex - right.item.zIndex
        }
        return left.index - right.index
      })

    const layerIndexByItemId = Object.fromEntries(
      selectedItems.map((item) => {
        const currentIndex = orderedItems.findIndex((entry) => entry.item.id === item.id)
        if (currentIndex === -1) {
          return [item.id, 1] as const
        }

        const currentBounds = orderedItems[currentIndex].bounds
        const overlappingLowerItemCount = orderedItems
          .slice(0, currentIndex)
          .reduce(
            (count, entry) => count + (doCanvasBoundsOverlap(currentBounds, entry.bounds) ? 1 : 0),
            0
          )

        return [item.id, overlappingLowerItemCount + 1] as const
      })
    )

    if (selectedItems.length === 0) {
      return {
        canvasId,
        projectName,
        selectionCount: 0,
        structure: null,
        assetMetadata: [],
        layerIndexByItemId
      }
    }

    const visualBoundsByItemId = new Map(
      selectedItems.map((item) => [item.id, getSelectionInfoVisualBounds(item)] as const)
    )
    const structure = buildDesignInspectionContextPack({
      task: 'Expose selected element info for local inspection debugging.',
      projectId: canvasId,
      projectName,
      targetItems: selectedItems,
      groups,
      getItemBounds: (item) =>
        visualBoundsByItemId.get(item.id) ?? getSelectionInfoVisualBounds(item)
    })
    const visualSelectionItems = structure.selectionItems.map((summary) => {
      const liveBounds = visualBoundsByItemId.get(summary.id)
      if (!liveBounds) return summary

      return {
        ...summary,
        x: liveBounds.x,
        y: liveBounds.y,
        width: liveBounds.width,
        height: liveBounds.height,
        bounds: liveBounds
      }
    })
    const visualSelectionBounds = mergeSelectionInfoBounds(
      visualSelectionItems.map((item) => item.bounds)
    )

    return {
      canvasId,
      projectName,
      selectionCount: selectedItems.length,
      structure: {
        ...structure,
        selection: {
          ...structure.selection,
          bounds: visualSelectionBounds
        },
        selectionItems: visualSelectionItems
      },
      assetMetadata: buildCanvasAssetMetadata(selectedItems),
      layerIndexByItemId
    }
  }, [
    bottomPanelActiveTab,
    bottomPanelVisible,
    buildCanvasAssetMetadata,
    canvasId,
    getSelectionInfoVisualBounds,
    groups,
    items,
    projectName,
    selectedIds
  ])

  const dispatchSelectionInfo = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('canvas:selection-info', { detail: buildSelectionInfoDetail() })
    )
  }, [buildSelectionInfoDetail])

  const scheduleSelectionInfoDispatch = useCallback(() => {
    if (!bottomPanelVisible || bottomPanelActiveTab !== 'elements') return
    if (selectionInfoDispatchFrameRef.current != null) return

    selectionInfoDispatchFrameRef.current = window.requestAnimationFrame(() => {
      selectionInfoDispatchFrameRef.current = null
      dispatchSelectionInfo()
    })
  }, [bottomPanelActiveTab, bottomPanelVisible, dispatchSelectionInfo])

  useEffect(() => {
    return () => {
      if (selectionInfoDispatchFrameRef.current != null) {
        window.cancelAnimationFrame(selectionInfoDispatchFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const handleModelMetadataUpdated = () => {
      scheduleSelectionInfoDispatch()
    }

    window.addEventListener(CANVAS_MODEL3D_METADATA_UPDATED_EVENT, handleModelMetadataUpdated)
    return () => {
      window.removeEventListener(CANVAS_MODEL3D_METADATA_UPDATED_EVENT, handleModelMetadataUpdated)
    }
  }, [scheduleSelectionInfoDispatch])

  useEffect(() => {
    dispatchSelectionInfo()
  }, [dispatchSelectionInfo])

  return {
    scheduleSelectionInfoDispatch
  }
}
