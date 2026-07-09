import { useEffect, useRef } from 'react'

export type CanvasLastViewportPoint = { x: number; y: number }

export function useCanvasLastViewportPoint() {
  const lastViewportPointRef = useRef<CanvasLastViewportPoint | null>(null)

  useEffect(() => {
    const updateMousePoint = (event: MouseEvent | PointerEvent) => {
      lastViewportPointRef.current = { x: event.clientX, y: event.clientY }
    }

    const updateTouchPoint = (event: TouchEvent) => {
      const touch = event.touches[0] || event.changedTouches[0]
      if (!touch) return
      lastViewportPointRef.current = { x: touch.clientX, y: touch.clientY }
    }

    window.addEventListener('mousemove', updateMousePoint, true)
    window.addEventListener('pointermove', updateMousePoint, true)
    window.addEventListener('touchmove', updateTouchPoint, true)
    window.addEventListener('touchend', updateTouchPoint, true)

    return () => {
      window.removeEventListener('mousemove', updateMousePoint, true)
      window.removeEventListener('pointermove', updateMousePoint, true)
      window.removeEventListener('touchmove', updateTouchPoint, true)
      window.removeEventListener('touchend', updateTouchPoint, true)
    }
  }, [])

  return lastViewportPointRef
}
