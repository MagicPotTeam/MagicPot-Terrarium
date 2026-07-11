import { useCallback, useEffect, useRef, useState } from 'react'

export type CanvasSelectionRectDomElements = {
  svg: SVGSVGElement
  rect: SVGRectElement
}

export type CanvasSelectionRectDomValue = {
  x: number
  y: number
  w: number
  h: number
}

export type UseCanvasSelectionRectDomDriverOptions = {
  canvasContainerRef: React.RefObject<HTMLElement | null>
  isDebugEnabled?: () => boolean
}

function recordSelectionRectDebugTrace(rect: CanvasSelectionRectDomValue | null) {
  const traceWindow = window as Window & {
    __canvasSelectionRectDomTrace?: Array<Record<string, unknown>>
  }
  if (!traceWindow.__canvasSelectionRectDomTrace) {
    traceWindow.__canvasSelectionRectDomTrace = []
  }
  traceWindow.__canvasSelectionRectDomTrace.push({
    phase: rect ? 'apply' : 'clear',
    width: rect?.w ?? null,
    height: rect?.h ?? null
  })
  if (traceWindow.__canvasSelectionRectDomTrace.length > 80) {
    traceWindow.__canvasSelectionRectDomTrace.shift()
  }
}

export function useCanvasSelectionRectDomDriver({
  canvasContainerRef,
  isDebugEnabled = () => false
}: UseCanvasSelectionRectDomDriverOptions) {
  const [suppressSelectionChromeAfterMarquee, setSuppressSelectionChromeAfterMarquee] =
    useState(false)
  const selectionChromeSettleFrameRef = useRef<number | null>(null)
  const selectionRectElementsRef = useRef<CanvasSelectionRectDomElements | null>(null)

  const handleSelectionRectElementsChange = useCallback(
    (elements: CanvasSelectionRectDomElements | null) => {
      selectionRectElementsRef.current = elements
    },
    []
  )

  const handleSelectionRectChange = useCallback(
    (rect: CanvasSelectionRectDomValue | null) => {
      if (isDebugEnabled()) {
        recordSelectionRectDebugTrace(rect)
      }

      let els = selectionRectElementsRef.current
      if (!els || !els.svg.isConnected || !els.rect.isConnected) {
        const container = canvasContainerRef.current
        if (!container) return
        const svg = container.querySelector<SVGSVGElement>('[data-canvas-selection-rect="svg"]')
        const rectEl = container.querySelector<SVGRectElement>(
          '[data-canvas-selection-rect="rect"]'
        )
        if (!svg || !rectEl) return
        els = { svg, rect: rectEl }
        selectionRectElementsRef.current = els
      }

      if (!rect || rect.w <= 2 || rect.h <= 2) {
        els.svg.style.display = 'none'
        return
      }

      els.svg.style.display = ''
      els.svg.style.left = rect.x + 'px'
      els.svg.style.top = rect.y + 'px'
      els.svg.setAttribute('width', String(rect.w))
      els.svg.setAttribute('height', String(rect.h))
      els.rect.setAttribute('width', String(rect.w))
      els.rect.setAttribute('height', String(rect.h))
    },
    [canvasContainerRef, isDebugEnabled]
  )

  const cancelSelectionChromeSettleFrame = useCallback(() => {
    if (selectionChromeSettleFrameRef.current === null) {
      return
    }

    window.cancelAnimationFrame(selectionChromeSettleFrameRef.current)
    selectionChromeSettleFrameRef.current = null
  }, [])

  useEffect(
    () => () => {
      cancelSelectionChromeSettleFrame()
    },
    [cancelSelectionChromeSettleFrame]
  )

  const scheduleSelectionChromeAfterMarquee = useCallback(() => {
    cancelSelectionChromeSettleFrame()
    setSuppressSelectionChromeAfterMarquee(true)

    let remainingFrames = 2
    const settle = () => {
      remainingFrames -= 1
      if (remainingFrames <= 0) {
        selectionChromeSettleFrameRef.current = null
        setSuppressSelectionChromeAfterMarquee(false)
        return
      }

      selectionChromeSettleFrameRef.current = window.requestAnimationFrame(settle)
    }

    selectionChromeSettleFrameRef.current = window.requestAnimationFrame(settle)
  }, [cancelSelectionChromeSettleFrame])

  const handleSelectionMarqueeActiveChange = useCallback(
    (active: boolean) => {
      const canvasContainer = canvasContainerRef.current

      if (active) {
        cancelSelectionChromeSettleFrame()
        setSuppressSelectionChromeAfterMarquee(false)
        canvasContainer?.setAttribute('data-project-canvas-marquee-active', 'true')
        return
      }

      canvasContainer?.removeAttribute('data-project-canvas-marquee-active')
      scheduleSelectionChromeAfterMarquee()
    },
    [canvasContainerRef, cancelSelectionChromeSettleFrame, scheduleSelectionChromeAfterMarquee]
  )

  return {
    suppressSelectionChromeAfterMarquee,
    handleSelectionRectElementsChange,
    handleSelectionRectChange,
    handleSelectionMarqueeActiveChange
  }
}
