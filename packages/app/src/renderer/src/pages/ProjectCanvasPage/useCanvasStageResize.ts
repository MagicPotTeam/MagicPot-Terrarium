import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

type StageSize = { width: number; height: number }

type UseCanvasStageResizeOptions = {
  setStageSize: Dispatch<SetStateAction<StageSize>>
  stageRef: MutableRefObject<{
    width?: (nextWidth?: number) => number
    height?: (nextHeight?: number) => number
  } | null>
}

export function useCanvasStageResize({ setStageSize, stageRef }: UseCanvasStageResizeOptions) {
  const handleResize = useCallback(
    (width: number, height: number) => {
      setStageSize({ width, height })
      const stage = stageRef.current
      if (!stage) return

      stage.width?.(width)
      stage.height?.(height)
    },
    [setStageSize, stageRef]
  )

  return { handleResize }
}
