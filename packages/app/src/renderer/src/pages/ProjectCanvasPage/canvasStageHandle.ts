import type { MutableRefObject, RefObject } from 'react'

type CanvasPoint = {
  x: number
  y: number
}

type CanvasStageTransformHandle = {
  copy: () => CanvasStageTransformHandle
  invert: () => CanvasStageTransformHandle
  point: (point: CanvasPoint) => CanvasPoint
}

export type CanvasStageHandle = {
  container: () => HTMLElement | null
  findOne: (_selector: string) => null
  getAbsoluteTransform: () => CanvasStageTransformHandle
  getPointerPosition: () => CanvasPoint | null
  getStage: () => CanvasStageHandle
  height: (nextHeight?: number) => number
  scaleX: (nextScaleX?: number) => number
  scaleY: (nextScaleY?: number) => number
  setPointersPositions: (event: MouseEvent | PointerEvent | WheelEvent) => void
  width: (nextWidth?: number) => number
  x: (nextX?: number) => number
  y: (nextY?: number) => number
}

type CreateCanvasStageHandleOptions = {
  canvasContainerRef: RefObject<HTMLElement | null>
  stagePosRef: MutableRefObject<{ x: number; y: number }>
  stageScaleRef: MutableRefObject<number>
  stageSizeRef: MutableRefObject<{ width: number; height: number }>
}

function createTransformHandle(snapshot: {
  x: number
  y: number
  scale: number
}): CanvasStageTransformHandle {
  let inverted = false

  const handle: CanvasStageTransformHandle = {
    copy: () => createTransformHandle(snapshot),
    invert: () => {
      inverted = !inverted
      return handle
    },
    point: (point) => {
      if (inverted) {
        const scale = Math.max(Math.abs(snapshot.scale), 0.0001)
        return {
          x: (point.x - snapshot.x) / scale,
          y: (point.y - snapshot.y) / scale
        }
      }

      return {
        x: point.x * snapshot.scale + snapshot.x,
        y: point.y * snapshot.scale + snapshot.y
      }
    }
  }

  return handle
}

export function createCanvasStageHandle({
  canvasContainerRef,
  stagePosRef,
  stageScaleRef,
  stageSizeRef
}: CreateCanvasStageHandleOptions): CanvasStageHandle {
  let pointerPosition: CanvasPoint | null = null

  const handle: CanvasStageHandle = {
    container: () => canvasContainerRef.current,
    findOne: () => null,
    getAbsoluteTransform: () =>
      createTransformHandle({
        x: stagePosRef.current.x,
        y: stagePosRef.current.y,
        scale: stageScaleRef.current
      }),
    getPointerPosition: () => pointerPosition,
    getStage: () => handle,
    height: (nextHeight) => {
      if (typeof nextHeight === 'number' && Number.isFinite(nextHeight)) {
        stageSizeRef.current = { ...stageSizeRef.current, height: nextHeight }
      }
      return stageSizeRef.current.height
    },
    scaleX: (nextScaleX) => {
      if (typeof nextScaleX === 'number' && Number.isFinite(nextScaleX)) {
        stageScaleRef.current = nextScaleX
      }
      return stageScaleRef.current
    },
    scaleY: (nextScaleY) => {
      if (typeof nextScaleY === 'number' && Number.isFinite(nextScaleY)) {
        stageScaleRef.current = nextScaleY
      }
      return stageScaleRef.current
    },
    setPointersPositions: (event) => {
      const container = canvasContainerRef.current
      if (!container) {
        pointerPosition = null
        return
      }

      const rect = container.getBoundingClientRect()
      pointerPosition = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      }
    },
    width: (nextWidth) => {
      if (typeof nextWidth === 'number' && Number.isFinite(nextWidth)) {
        stageSizeRef.current = { ...stageSizeRef.current, width: nextWidth }
      }
      return stageSizeRef.current.width
    },
    x: (nextX) => {
      if (typeof nextX === 'number' && Number.isFinite(nextX)) {
        stagePosRef.current = { ...stagePosRef.current, x: nextX }
      }
      return stagePosRef.current.x
    },
    y: (nextY) => {
      if (typeof nextY === 'number' && Number.isFinite(nextY)) {
        stagePosRef.current = { ...stagePosRef.current, y: nextY }
      }
      return stagePosRef.current.y
    }
  }

  return handle
}
