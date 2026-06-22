import { useCallback, useLayoutEffect, useRef } from 'react'
import { Box } from '@mui/material'

type MaxSizeLayoutProps = {
  onResize: (width: number, height: number) => void
  children: React.ReactNode
}

export const MAX_SIZE_LAYOUT_REMEASURE_EVENT = 'magicpot:max-size-layout-remeasure'

const normalizeMeasuredSize = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.round(value) : 0

/**
 * Measures the rendered size of the container and reports changes upstream.
 */
export default function MaxSizeLayout({ children, onResize }: MaxSizeLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onResizeRef = useRef(onResize)
  const lastMeasuredSizeRef = useRef<{ width: number; height: number } | null>(null)
  const measureFrameRef = useRef<number | null>(null)

  const updateSize = useCallback(() => {
    measureFrameRef.current = null
    if (!containerRef.current) {
      return
    }

    const rect = containerRef.current.getBoundingClientRect()
    const nextSize = {
      width: normalizeMeasuredSize(rect.width),
      height: normalizeMeasuredSize(rect.height)
    }

    if (
      lastMeasuredSizeRef.current?.width === nextSize.width &&
      lastMeasuredSizeRef.current?.height === nextSize.height
    ) {
      return
    }

    lastMeasuredSizeRef.current = nextSize
    onResizeRef.current(nextSize.width, nextSize.height)
  }, [])

  const scheduleUpdateSize = useCallback(() => {
    if (measureFrameRef.current !== null) {
      return
    }

    measureFrameRef.current = -1
    let didRunSynchronously = false
    const animationFrameId = window.requestAnimationFrame(() => {
      didRunSynchronously = true
      updateSize()
    })
    if (!didRunSynchronously) {
      measureFrameRef.current = animationFrameId
    }
  }, [updateSize])

  useLayoutEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])

  useLayoutEffect(() => {
    scheduleUpdateSize()

    const handleResize = () => {
      scheduleUpdateSize()
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener(MAX_SIZE_LAYOUT_REMEASURE_EVENT, handleResize)

    let resizeObserver: ResizeObserver | null = null
    if (containerRef.current && window.ResizeObserver) {
      resizeObserver = new ResizeObserver(scheduleUpdateSize)
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener(MAX_SIZE_LAYOUT_REMEASURE_EVENT, handleResize)
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      if (measureFrameRef.current !== null && measureFrameRef.current > 0) {
        window.cancelAnimationFrame(measureFrameRef.current)
      }
      measureFrameRef.current = null
    }
  }, [scheduleUpdateSize])

  return (
    <Box ref={containerRef} sx={{ width: '100%', height: '100%' }}>
      {children}
    </Box>
  )
}
