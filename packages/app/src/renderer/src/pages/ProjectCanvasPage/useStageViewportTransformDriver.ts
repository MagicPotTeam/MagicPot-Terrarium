import { useCallback, useRef } from 'react'

/**
 * Static base style for stage-viewport DOM layers.
 * The viewport transform is managed imperatively so React re-renders cannot reset it.
 */
export const STAGE_VIEWPORT_LAYER_BASE_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 0,
  height: 0,
  overflow: 'visible',
  transformOrigin: '0 0',
  willChange: 'transform',
  pointerEvents: 'none'
}

/**
 * Drives viewport DOM layers with transform-only updates.
 *
 * Key design decisions:
 * - left/top stay fixed at 0 while translate3d handles movement without layout.
 * - registerViewportLayer immediately positions newly mounted overlays.
 * - applyViewportTransform can be passed to useCanvasStageInteraction as onViewportChange
 *   so the pan/zoom hot path bypasses React setState entirely.
 */
export function useStageViewportTransformDriver() {
  const layersRef = useRef<Set<HTMLElement>>(new Set())
  // Generic viewport update callbacks (e.g. grid background-position).
  // Each callback receives (pos, scale) on every imperative transform.
  const callbacksRef = useRef<Set<(pos: { x: number; y: number }, scale: number) => void>>(
    new Set()
  )
  const interactionCallbacksRef = useRef<Set<(active: boolean) => void>>(new Set())
  const currentRef = useRef<{ x: number; y: number; scale: number }>({
    x: 0,
    y: 0,
    scale: 1
  })
  const currentInteractionRef = useRef(false)

  const formatViewportTransform = useCallback(
    (pos: { x: number; y: number }, scale: number) =>
      `translate3d(${pos.x}px, ${pos.y}px, 0) scale(${scale})`,
    []
  )

  const registerViewportLayer = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        layersRef.current.add(el)
        // Apply current transform immediately so newly-mounted overlays
        // are positioned correctly even when stagePos/stageScale have not changed.
        const { x, y, scale } = currentRef.current
        el.style.left = '0px'
        el.style.top = '0px'
        el.style.transform = formatViewportTransform({ x, y }, scale)
      }
    },
    [formatViewportTransform]
  )

  const applyViewportTransform = useCallback(
    (pos: { x: number; y: number }, scale: number) => {
      currentRef.current = { x: pos.x, y: pos.y, scale }
      const transform = formatViewportTransform(pos, scale)
      for (const el of layersRef.current) {
        if (!el.isConnected) {
          layersRef.current.delete(el)
          continue
        }
        el.style.transform = transform
      }
      // Fire registered viewport callbacks (grid, etc.)
      for (const fn of callbacksRef.current) {
        fn(pos, scale)
      }
    },
    [formatViewportTransform]
  )

  /**
   * Register a generic callback that fires on every imperative viewport transform.
   * Returns an unregister function. Useful for elements that need non-transform
   * CSS updates (e.g. grid backgroundPosition/backgroundSize).
   */
  const registerViewportCallback = useCallback(
    (fn: (pos: { x: number; y: number }, scale: number) => void) => {
      callbacksRef.current.add(fn)
      // Immediately call with current values so the element syncs on mount.
      const { x, y, scale } = currentRef.current
      fn({ x, y }, scale)
      return () => {
        callbacksRef.current.delete(fn)
      }
    },
    []
  )

  const applyViewportInteractionState = useCallback((active: boolean) => {
    if (currentInteractionRef.current === active) {
      return
    }

    currentInteractionRef.current = active
    for (const fn of interactionCallbacksRef.current) {
      fn(active)
    }
  }, [])

  const registerViewportInteractionCallback = useCallback((fn: (active: boolean) => void) => {
    interactionCallbacksRef.current.add(fn)
    fn(currentInteractionRef.current)
    return () => {
      interactionCallbacksRef.current.delete(fn)
    }
  }, [])

  return {
    registerViewportLayer,
    registerViewportCallback,
    registerViewportInteractionCallback,
    applyViewportTransform,
    applyViewportInteractionState
  }
}
