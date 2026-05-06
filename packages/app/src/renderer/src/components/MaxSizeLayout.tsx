import { useCallback, useLayoutEffect, useRef } from 'react'
import { Box } from '@mui/material'

type MaxSizeLayoutProps = {
  onResize: (width: number, height: number) => void
  children: React.ReactNode
}

export const MAX_SIZE_LAYOUT_REMEASURE_EVENT = 'magicpot:max-size-layout-remeasure'

/**
 * Measures the rendered size of the container and reports changes upstream.
 */
export default function MaxSizeLayout({ children, onResize }: MaxSizeLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onResizeRef = useRef(onResize)
  const lastMeasuredSizeRef = useRef<{ width: number; height: number } | null>(null)

  const updateSize = useCallback(() => {
    if (!containerRef.current) {
      return
    }

    const rect = containerRef.current.getBoundingClientRect()
    const nextSize = {
      width: rect.width,
      height: rect.height
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

  useLayoutEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])

  useLayoutEffect(() => {
    const animationFrameId = window.requestAnimationFrame(() => {
      updateSize()
    })

    return () => {
      window.cancelAnimationFrame(animationFrameId)
    }
  })

  useLayoutEffect(() => {
    updateSize()

    const handleResize = () => {
      updateSize()
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener(MAX_SIZE_LAYOUT_REMEASURE_EVENT, handleResize)

    let resizeObserver: ResizeObserver | null = null
    if (containerRef.current && window.ResizeObserver) {
      resizeObserver = new ResizeObserver(updateSize)
      resizeObserver.observe(containerRef.current)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener(MAX_SIZE_LAYOUT_REMEASURE_EVENT, handleResize)
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
    }
  }, [updateSize])

  return (
    <Box ref={containerRef} sx={{ width: '100%', height: '100%' }}>
      {children}
    </Box>
  )
}
