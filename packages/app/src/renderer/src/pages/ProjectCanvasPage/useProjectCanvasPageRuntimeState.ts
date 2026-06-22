import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CANVAS_OCR_HOVER_EVENT, type CanvasOcrHoverDetail } from './ocrCanvasUtils'
import {
  CANVAS_HISTORY_LIMIT,
  createCanvasHistorySnapshot,
  restoreCanvasHistorySnapshot
} from './canvasHistory'
import type { AnnotationShape, CanvasGroup, CanvasGroupBranch, CanvasItem } from './types'
import type { InlineTextEditState } from './ProjectCanvasPageInlineTextEditor'
import type { CanvasTool } from './projectCanvasPageShared'

type CanvasDrawingState = {
  shape: AnnotationShape
  startX: number
  startY: number
  x: number
  y: number
  w: number
  h: number
  endX?: number
  endY?: number
  points?: number[]
} | null

function areSelectedIdsEqual(current: Set<string>, next: Set<string>) {
  if (current === next) return true
  if (current.size !== next.size) return false

  const currentIterator = current.values()
  const nextIterator = next.values()
  while (true) {
    const currentStep = currentIterator.next()
    const nextStep = nextIterator.next()
    if (currentStep.done || nextStep.done) {
      return currentStep.done === nextStep.done
    }
    if (currentStep.value !== nextStep.value) {
      return false
    }
  }
}

export function useProjectCanvasPageRuntimeState() {
  const [items, setItems] = useState<CanvasItem[]>([])
  const [groups, setGroups] = useState<CanvasGroup[]>([])
  const [groupBranches, setGroupBranches] = useState<CanvasGroupBranch[]>([])
  const [selectedIds, setSelectedIdsState] = useState<Set<string>>(new Set())
  const selectedIdsRef = useRef(selectedIds)
  const historyRef = useRef<CanvasItem[][]>([])
  const futureRef = useRef<CanvasItem[][]>([])
  const lastClickedIdRef = useRef<string | null>(null)
  const [tool, setTool] = useState<CanvasTool>('select')

  const [stagePos, setStagePos] = useState({ x: 0, y: 0 })
  const [stageScale, setStageScale] = useState(1)
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 })
  const stagePosRef = useRef(stagePos)
  const stageScaleRef = useRef(stageScale)

  const [isPanning, setIsPanning] = useState(false)
  const lastPanPosRef = useRef({ x: 0, y: 0 })

  const [annoTool, setAnnoTool] = useState<AnnotationShape>('rect')
  const [drawingState, setDrawingState] = useState<CanvasDrawingState>(null)
  const [inlineTextEdit, setInlineTextEdit] = useState<InlineTextEditState | null>(null)

  const [activeOcrHover, setActiveOcrHover] = useState<CanvasOcrHoverDetail | null>(null)

  selectedIdsRef.current = selectedIds

  const setSelectedIds = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: Set<string>) => Set<string>)(selectedIdsRef.current)
          : updater
      if (areSelectedIdsEqual(selectedIdsRef.current, next)) return

      selectedIdsRef.current = next
      setSelectedIdsState(next)
    },
    []
  )

  useEffect(() => {
    const handleOcrHover = (event: Event) => {
      const detail = (event as CustomEvent<CanvasOcrHoverDetail>).detail
      if (!detail?.bundleId) {
        setActiveOcrHover(null)
        return
      }

      setActiveOcrHover({
        bundleId: detail.bundleId,
        bboxIds: detail.bboxIds || [],
        cellIds: detail.cellIds || []
      })
    }

    window.addEventListener(CANVAS_OCR_HOVER_EVENT, handleOcrHover)
    return () => {
      window.removeEventListener(CANVAS_OCR_HOVER_EVENT, handleOcrHover)
    }
  }, [])

  useEffect(() => {
    stagePosRef.current = stagePos
  }, [stagePos])

  useEffect(() => {
    stageScaleRef.current = stageScale
  }, [stageScale])

  const setItemsWithHistory = useCallback(
    (updater: CanvasItem[] | ((prev: CanvasItem[]) => CanvasItem[])) => {
      setItems((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        historyRef.current = [
          ...historyRef.current.slice(-CANVAS_HISTORY_LIMIT + 1),
          createCanvasHistorySnapshot(prev)
        ]
        futureRef.current = []
        return next
      })
    },
    []
  )

  const handleUndo = useCallback(() => {
    const history = historyRef.current
    if (history.length === 0) return

    setItems((prev) => {
      const prevState = history[history.length - 1]
      historyRef.current = history.slice(0, -1)
      futureRef.current = [
        createCanvasHistorySnapshot(prev),
        ...futureRef.current.slice(0, CANVAS_HISTORY_LIMIT - 1)
      ]
      return restoreCanvasHistorySnapshot(prevState, prev)
    })
    setSelectedIds(new Set())
  }, [setSelectedIds])

  const handleRedo = useCallback(() => {
    const future = futureRef.current
    if (future.length === 0) return

    setItems((prev) => {
      const nextState = future[0]
      futureRef.current = future.slice(1)
      historyRef.current = [
        ...historyRef.current.slice(-CANVAS_HISTORY_LIMIT + 1),
        createCanvasHistorySnapshot(prev)
      ]
      return restoreCanvasHistorySnapshot(nextState, prev)
    })
    setSelectedIds(new Set())
  }, [setSelectedIds])

  return useMemo(
    () => ({
      activeOcrHover,
      annoTool,
      drawingState,
      groups,
      groupBranches,
      handleRedo,
      handleUndo,
      inlineTextEdit,
      isPanning,
      items,
      lastClickedIdRef,
      lastPanPosRef,
      selectedIds,
      selectedIdsRef,
      setActiveOcrHover,
      setAnnoTool,
      setDrawingState,
      setGroups,
      setGroupBranches,
      setInlineTextEdit,
      setIsPanning,
      setItems,
      setItemsWithHistory,
      setSelectedIds,
      setStagePos,
      setStageScale,
      setStageSize,
      setTool,
      stagePos,
      stagePosRef,
      stageScale,
      stageScaleRef,
      stageSize,
      tool
    }),
    [
      activeOcrHover,
      annoTool,
      drawingState,
      groups,
      groupBranches,
      handleRedo,
      handleUndo,
      inlineTextEdit,
      isPanning,
      items,
      setSelectedIds,
      setItemsWithHistory,
      selectedIds,
      stagePos,
      stageScale,
      stageSize,
      tool
    ]
  )
}
