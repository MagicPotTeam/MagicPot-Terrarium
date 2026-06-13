import { useEffect, useState } from 'react'

export const CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT = 'magicpot:canvas-layout-resize-interaction'

export type CanvasLayoutResizeInteractionSource = 'side' | 'right' | 'bottom' | 'unknown'

export type CanvasLayoutResizeInteractionDetail = {
  active: boolean
  source: CanvasLayoutResizeInteractionSource
}

let canvasLayoutResizeInteractionState: CanvasLayoutResizeInteractionDetail = {
  active: false,
  source: 'unknown'
}

export function getCanvasLayoutResizeInteractionState(): CanvasLayoutResizeInteractionDetail {
  return canvasLayoutResizeInteractionState
}

export function emitCanvasLayoutResizeInteraction(
  active: boolean,
  source: CanvasLayoutResizeInteractionSource = 'unknown'
) {
  const nextState: CanvasLayoutResizeInteractionDetail = {
    active,
    source: active ? source : canvasLayoutResizeInteractionState.source
  }
  canvasLayoutResizeInteractionState = nextState

  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(
    new CustomEvent<CanvasLayoutResizeInteractionDetail>(CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT, {
      detail: nextState
    })
  )

  if (!active) {
    canvasLayoutResizeInteractionState = {
      active: false,
      source: 'unknown'
    }
  }
}

export function useCanvasLayoutResizeInteractionActive() {
  const [isActive, setIsActive] = useState(() => getCanvasLayoutResizeInteractionState().active)

  useEffect(() => {
    const handleInteractionChange = (event: Event) => {
      const detail = (event as CustomEvent<CanvasLayoutResizeInteractionDetail>).detail
      setIsActive(Boolean(detail?.active))
    }

    window.addEventListener(CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT, handleInteractionChange)
    setIsActive(getCanvasLayoutResizeInteractionState().active)

    return () => {
      window.removeEventListener(CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT, handleInteractionChange)
    }
  }, [])

  return isActive
}
