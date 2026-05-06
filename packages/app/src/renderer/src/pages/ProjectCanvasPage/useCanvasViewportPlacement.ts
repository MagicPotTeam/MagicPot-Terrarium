import { useCallback, useRef, type MutableRefObject, type RefObject } from 'react'
import {
  getCanvasViewportBounds,
  getCenteredViewportBatchPlacements,
  getCenteredViewportPosition,
  getViewportBatchGridLayout,
  type CanvasViewportBounds,
  type CanvasViewportPlacementSize
} from './canvasViewportPlacementUtils'

type UseCanvasViewportPlacementOptions = {
  stagePos: { x: number; y: number }
  stagePosRef?: MutableRefObject<{ x: number; y: number }>
  stageSize: { width: number; height: number }
  stageScale: number
  stageScaleRef?: MutableRefObject<number>
  stageRef: MutableRefObject<unknown> | RefObject<unknown>
  canvasContainerRef: RefObject<HTMLElement | null>
}

type ResolveCanvasPlacementOptions = {
  width: number
  height: number
  clientX?: number
  clientY?: number
  mode?: 'center' | 'auto'
}

export function useCanvasViewportPlacement({
  stagePos,
  stagePosRef,
  stageSize,
  stageScale,
  stageScaleRef,
  canvasContainerRef
}: UseCanvasViewportPlacementOptions) {
  const autoPlacedSequenceRef = useRef<{ key: string; count: number }>({
    key: '',
    count: 0
  })

  const getLiveStageTransform = useCallback(
    () => ({
      pos: stagePosRef?.current ?? stagePos,
      scale: stageScaleRef?.current ?? stageScale
    }),
    [stagePos, stagePosRef, stageScale, stageScaleRef]
  )

  const getViewportBounds = useCallback((): CanvasViewportBounds => {
    const { pos, scale } = getLiveStageTransform()
    return getCanvasViewportBounds(pos, stageSize, scale)
  }, [getLiveStageTransform, stageSize])

  const fitSizeToCanvas = useCallback((width: number, height: number) => {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    }
  }, [])

  const getCenterPosition = useCallback(
    (width: number, height: number) =>
      getCenteredViewportPosition(getViewportBounds(), {
        width,
        height
      }),
    [getViewportBounds]
  )

  const getCenteredBatchPlacements = useCallback(
    (sizes: CanvasViewportPlacementSize[]) =>
      getCenteredViewportBatchPlacements(getViewportBounds(), sizes),
    [getViewportBounds]
  )

  const getBatchGridLayout = useCallback(
    (
      sizes: CanvasViewportPlacementSize[],
      options?: Parameters<typeof getViewportBatchGridLayout>[2]
    ) => getViewportBatchGridLayout(getViewportBounds(), sizes, options),
    [getViewportBounds]
  )

  const getCanvasPointFromClient = useCallback(
    (clientX?: number, clientY?: number) => {
      if (clientX === undefined || clientY === undefined || !canvasContainerRef.current) {
        return null
      }

      const rect = canvasContainerRef.current.getBoundingClientRect()
      const { pos, scale: rawScale } = getLiveStageTransform()
      const scale = Math.max(Math.abs(rawScale), 0.0001)
      return {
        x: (clientX - rect.left - pos.x) / scale,
        y: (clientY - rect.top - pos.y) / scale
      }
    },
    [canvasContainerRef, getLiveStageTransform]
  )

  const getViewportPlacementKey = useCallback(() => {
    const viewport = getViewportBounds()
    return `${Math.round(viewport.x)}:${Math.round(viewport.y)}:${Math.round(viewport.width)}:${Math.round(viewport.height)}`
  }, [getViewportBounds])

  const getNextAutoPlacement = useCallback(
    (width: number, height: number) => {
      const viewport = getViewportBounds()
      const key = getViewportPlacementKey()
      const nextIndex =
        autoPlacedSequenceRef.current.key === key ? autoPlacedSequenceRef.current.count : 0

      autoPlacedSequenceRef.current = {
        key,
        count: nextIndex + 1
      }

      const placements = getCenteredViewportBatchPlacements(
        viewport,
        Array.from({ length: nextIndex + 1 }, () => ({ width, height }))
      )

      return placements[nextIndex] ?? getCenteredViewportPosition(viewport, { width, height })
    },
    [getViewportBounds, getViewportPlacementKey]
  )

  const markAutoPlacementBatch = useCallback(
    (count: number) => {
      autoPlacedSequenceRef.current = {
        key: getViewportPlacementKey(),
        count: Math.max(0, count)
      }
    },
    [getViewportPlacementKey]
  )

  const resetAutoPlacementSequence = useCallback(() => {
    autoPlacedSequenceRef.current = {
      key: '',
      count: 0
    }
  }, [])

  const resolvePlacement = useCallback(
    ({ width, height, clientX, clientY, mode = 'center' }: ResolveCanvasPlacementOptions) => {
      const clientPoint = getCanvasPointFromClient(clientX, clientY)
      if (clientPoint) {
        return {
          x: clientPoint.x - width / 2,
          y: clientPoint.y - height / 2
        }
      }

      if (mode === 'auto') {
        return getNextAutoPlacement(width, height)
      }

      return getCenterPosition(width, height)
    },
    [getCanvasPointFromClient, getCenterPosition, getNextAutoPlacement]
  )

  return {
    fitSizeToCanvas,
    getBatchGridLayout,
    getCanvasPointFromClient,
    getCenterPosition,
    getCenteredBatchPlacements,
    getNextAutoPlacement,
    getViewportBounds,
    getViewportPlacementKey,
    markAutoPlacementBatch,
    resetAutoPlacementSequence,
    resolvePlacement
  }
}
