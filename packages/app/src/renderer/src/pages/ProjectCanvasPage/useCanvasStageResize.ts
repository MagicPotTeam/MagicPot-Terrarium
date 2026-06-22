import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import {
  CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT,
  getCanvasLayoutResizeInteractionState,
  type CanvasLayoutResizeInteractionDetail
} from './canvasLayoutResizeInteraction'

type StageSize = { width: number; height: number }

type UseCanvasStageResizeOptions = {
  setStageSize: Dispatch<SetStateAction<StageSize>>
  stageRef: MutableRefObject<{
    width?: (nextWidth?: number) => number
    height?: (nextHeight?: number) => number
  } | null>
}

function normalizeStageSize(width: number, height: number): StageSize {
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 1
  }
}

function areStageSizesEqual(left: StageSize | null | undefined, right: StageSize) {
  return left?.width === right.width && left.height === right.height
}

export function useCanvasStageResize({ setStageSize, stageRef }: UseCanvasStageResizeOptions) {
  const layoutResizeActiveRef = useRef(getCanvasLayoutResizeInteractionState().active)
  const pendingCommitSizeRef = useRef<StageSize | null>(null)
  const committedSizeRef = useRef<StageSize | null>(null)
  const commitFrameRef = useRef<number | null>(null)

  const commitStageSize = useCallback(
    (nextSize: StageSize | null) => {
      if (!nextSize || areStageSizesEqual(committedSizeRef.current, nextSize)) {
        return
      }

      committedSizeRef.current = nextSize
      setStageSize((previousSize) =>
        areStageSizesEqual(previousSize, nextSize) ? previousSize : nextSize
      )
    },
    [setStageSize]
  )

  const flushPendingStageSize = useCallback(() => {
    commitFrameRef.current = null
    const nextSize = pendingCommitSizeRef.current
    pendingCommitSizeRef.current = null
    commitStageSize(nextSize)
  }, [commitStageSize])

  const scheduleStageSizeCommit = useCallback(
    (nextSize: StageSize) => {
      pendingCommitSizeRef.current = nextSize
      if (commitFrameRef.current !== null) {
        return
      }

      commitFrameRef.current = -1
      let animationFrameId = 0
      let didRunSynchronously = false
      animationFrameId = window.requestAnimationFrame(() => {
        didRunSynchronously = true
        flushPendingStageSize()
      })
      if (!didRunSynchronously) {
        commitFrameRef.current = animationFrameId
      }
    },
    [flushPendingStageSize]
  )

  const handleResize = useCallback(
    (width: number, height: number) => {
      const nextSize = normalizeStageSize(width, height)
      const stage = stageRef.current
      if (stage) {
        stage.width?.(nextSize.width)
        stage.height?.(nextSize.height)
      }

      if (layoutResizeActiveRef.current) {
        pendingCommitSizeRef.current = nextSize
        return
      }

      scheduleStageSizeCommit(nextSize)
    },
    [scheduleStageSizeCommit, stageRef]
  )

  useEffect(() => {
    const handleLayoutResizeInteraction = (event: Event) => {
      const detail = (event as CustomEvent<CanvasLayoutResizeInteractionDetail>).detail
      layoutResizeActiveRef.current = Boolean(detail?.active)
      if (!layoutResizeActiveRef.current && pendingCommitSizeRef.current) {
        scheduleStageSizeCommit(pendingCommitSizeRef.current)
      }
    }

    window.addEventListener(CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT, handleLayoutResizeInteraction)
    layoutResizeActiveRef.current = getCanvasLayoutResizeInteractionState().active

    return () => {
      window.removeEventListener(
        CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT,
        handleLayoutResizeInteraction
      )
      if (commitFrameRef.current !== null && commitFrameRef.current > 0) {
        window.cancelAnimationFrame(commitFrameRef.current)
      }
      commitFrameRef.current = null
      pendingCommitSizeRef.current = null
    }
  }, [scheduleStageSizeCommit])

  return { handleResize }
}
