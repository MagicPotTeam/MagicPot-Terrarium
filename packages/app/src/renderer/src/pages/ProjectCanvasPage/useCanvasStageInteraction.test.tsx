import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStageInteraction } from './useCanvasStageInteraction'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from './projectCanvasViewportScale'

function getMockCanvasItemBounds(item: {
  x: number
  y: number
  width: number
  height: number
  scaleX?: number
  scaleY?: number
}) {
  const x2 = item.x + item.width * (item.scaleX ?? 1)
  const y2 = item.y + item.height * (item.scaleY ?? 1)

  return {
    minX: Math.min(item.x, x2),
    minY: Math.min(item.y, y2),
    maxX: Math.max(item.x, x2),
    maxY: Math.max(item.y, y2)
  }
}

function createOptions(overrides: Record<string, unknown> = {}) {
  const canvasContainer = document.createElement('div')
  Object.defineProperty(canvasContainer, 'focus', {
    configurable: true,
    value: vi.fn()
  })

  return {
    annotationColor: '#ef4444',
    annotationFillOpacity: 0,
    annotationStrokeWidth: 2,
    annoTool: 'rect',
    canvasContainerRef: { current: canvasContainer },
    clampStageScale: (scale: number) => scale,
    cropOverlayRef: { current: null },
    dragContextRef: { current: { draggingId: null } },
    drawingState: null,
    getCanvasItemBounds: vi.fn((item) => getMockCanvasItemBounds(item)),
    handleOpenCanvasTargetDialog: vi.fn(),
    isChineseUi: true,
    isFillableAnnotationShape: vi.fn(() => false),
    isMiddleMouseRef: { current: false },
    isPanning: false,
    items: [],
    lastPanPosRef: { current: { x: 0, y: 0 } },
    nextZIndex: { current: 1 },
    notifyWarning: vi.fn(),
    selectedIds: new Set<string>(),
    selectionRect: null,
    setDrawingState: vi.fn(),
    setInlineTextEdit: vi.fn(),
    setIsPanning: vi.fn(),
    setItemsWithHistory: vi.fn(),
    setSelectedIds: vi.fn(),
    setSelectionRect: vi.fn(),
    setStagePos: vi.fn(),
    setStageScale: vi.fn(),
    setTool: vi.fn(),
    stagePosRef: { current: { x: 0, y: 0 } },
    stageRef: { current: null },
    stageScale: 1,
    stageScaleRef: { current: 1 },
    tool: 'select',
    ...overrides
  }
}

describe('useCanvasStageInteraction', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    delete (window as Window & { __projectCanvasDebugInteraction?: boolean })
      .__projectCanvasDebugInteraction
    delete (window as Window & { __canvasInteractionTrace?: Array<Record<string, unknown>> })
      .__canvasInteractionTrace
  })

  it('applies middle-mouse pan transforms immediately while deferring React state', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const onViewportChange = vi.fn()
    const options = createOptions({ onViewportChange })
    const { result, unmount } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 1, clientX: 100, clientY: 120 }),
        type: 'mousedown'
      })
    })

    act(() => {
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 118, clientY: 144 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 135, clientY: 169 }),
        type: 'mousemove'
      })
    })

    expect(options.stagePosRef.current).toEqual({ x: 35, y: 49 })
    expect(onViewportChange).toHaveBeenCalledTimes(2)
    expect(onViewportChange).toHaveBeenLastCalledWith({ x: 35, y: 49 }, 1)
    expect(options.setStagePos).not.toHaveBeenCalled()
    expect(rafCallbacks.size).toBe(1)

    act(() => {
      rafCallbacks.values().next().value?.(16)
    })

    expect(onViewportChange).toHaveBeenCalledTimes(2)
    expect(onViewportChange).toHaveBeenLastCalledWith({ x: 35, y: 49 }, 1)
    expect(options.setStagePos).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(options.setStagePos).toHaveBeenCalledTimes(1)
    expect(options.setStagePos).toHaveBeenLastCalledWith({ x: 35, y: 49 })

    unmount()
  })

  it('continues middle-mouse panning from global move events outside the stage', () => {
    const onViewportChange = vi.fn()
    const options = createOptions({ onViewportChange })
    const { result, unmount } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 1, clientX: 100, clientY: 120 }),
        type: 'mousedown'
      })
    })

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 190 }))
    })

    expect(options.stagePosRef.current).toEqual({ x: 60, y: 70 })
    expect(onViewportChange).toHaveBeenCalledWith({ x: 60, y: 70 }, 1)
    expect(options.setStagePos).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(options.setStagePos).toHaveBeenCalledWith({ x: 60, y: 70 })

    unmount()
  })

  it('does not auto-confirm extract mode when left-clicking the stage background', () => {
    const confirm = vi.fn()
    const options = createOptions({
      tool: 'extract-select',
      cropOverlayRef: { current: { confirm } }
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 120 }),
        type: 'mousedown'
      })
    })

    expect(confirm).not.toHaveBeenCalled()
  })

  it('zooms the stage from a wheel event inside the canvas bounds', () => {
    vi.useFakeTimers()

    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const onViewportChange = vi.fn()
    const options = createOptions({ onViewportChange })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))
    const event = new WheelEvent('wheel', {
      clientX: 110,
      clientY: 140,
      deltaY: -120,
      cancelable: true
    })

    act(() => {
      result.current.handleStageWheel({
        evt: event,
        type: 'wheel'
      })
    })

    const expectedScale = Math.pow(1.12, 1.2)
    const expectedX = 100 - 100 * expectedScale
    const expectedY = 120 - 120 * expectedScale

    expect(event.defaultPrevented).toBe(true)
    expect(options.stageScaleRef.current).toBe(1)
    expect(options.setStageScale).not.toHaveBeenCalled()
    expect(rafCallbacks.size).toBe(1)

    act(() => {
      rafCallbacks.values().next().value?.(16)
    })

    expect(options.stageScaleRef.current).toBeCloseTo(expectedScale)
    expect(options.stagePosRef.current.x).toBeCloseTo(expectedX)
    expect(options.stagePosRef.current.y).toBeCloseTo(expectedY)
    expect(options.setStageScale).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(240)
    })

    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange).toHaveBeenLastCalledWith(
      {
        x: expect.closeTo(expectedX, 5),
        y: expect.closeTo(expectedY, 5)
      },
      expectedScale
    )
    expect(options.setStageScale).toHaveBeenCalledWith(expectedScale)

    const stagePosCall = (options.setStagePos as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(stagePosCall.x).toBeCloseTo(expectedX)
    expect(stagePosCall.y).toBeCloseTo(expectedY)
  })

  it('flushes a queued wheel zoom before the idle viewport state commit', () => {
    vi.useFakeTimers()

    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const onViewportChange = vi.fn()
    const options = createOptions({ onViewportChange })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))
    const event = new WheelEvent('wheel', {
      clientX: 110,
      clientY: 140,
      deltaY: -120,
      cancelable: true
    })

    act(() => {
      result.current.handleStageWheel({
        evt: event,
        type: 'wheel'
      })
    })

    const expectedScale = Math.pow(1.12, 1.2)
    const expectedX = 100 - 100 * expectedScale
    const expectedY = 120 - 120 * expectedScale

    expect(options.stageScaleRef.current).toBe(1)
    expect(rafCallbacks.size).toBe(1)

    act(() => {
      vi.advanceTimersByTime(240)
    })

    expect(rafCallbacks.size).toBe(0)
    expect(options.stageScaleRef.current).toBeCloseTo(expectedScale)
    expect(options.stagePosRef.current.x).toBeCloseTo(expectedX)
    expect(options.stagePosRef.current.y).toBeCloseTo(expectedY)
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(options.setStageScale).toHaveBeenCalledWith(expectedScale)

    const stagePosCall = (options.setStagePos as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(stagePosCall.x).toBeCloseTo(expectedX)
    expect(stagePosCall.y).toBeCloseTo(expectedY)
  })

  it('still zooms on non-cancelable wheel events without forcing preventDefault', () => {
    vi.useFakeTimers()

    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const options = createOptions()
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))
    const event = new WheelEvent('wheel', {
      clientX: 110,
      clientY: 140,
      deltaY: -120,
      cancelable: true
    })
    Object.defineProperty(event, 'cancelable', {
      configurable: true,
      get: () => false
    })

    act(() => {
      result.current.handleStageWheel({
        evt: event,
        type: 'wheel'
      })
    })

    const expectedScale = Math.pow(1.12, 1.2)
    const expectedX = 100 - 100 * expectedScale
    const expectedY = 120 - 120 * expectedScale

    expect(event.defaultPrevented).toBe(false)
    expect(options.stageScaleRef.current).toBe(1)
    expect(options.setStageScale).not.toHaveBeenCalled()

    act(() => {
      rafCallbacks.values().next().value?.(16)
    })

    expect(options.stageScaleRef.current).toBeCloseTo(expectedScale)
    expect(options.stagePosRef.current.x).toBeCloseTo(expectedX)
    expect(options.stagePosRef.current.y).toBeCloseTo(expectedY)

    act(() => {
      vi.advanceTimersByTime(240)
    })

    expect(options.setStageScale).toHaveBeenCalledWith(expectedScale)
  })

  it('can zoom out below one percent for a wider board overview', () => {
    const options = createOptions({
      stageScale: 0.01,
      stageScaleRef: { current: 0.01 },
      stagePosRef: { current: { x: 0, y: 0 } },
      clampStageScale: (scale: number) => Math.max(PROJECT_CANVAS_MIN_STAGE_SCALE, scale)
    })
    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.zoomStageAtPointer({ x: 500, y: 300 }, 400)
    })

    const expectedScale = 0.01 * Math.pow(1.12, -4)
    expect(options.stageScaleRef.current).toBeCloseTo(expectedScale)
    expect(options.stageScaleRef.current).toBeLessThan(0.01)
    expect(options.stageScaleRef.current).toBeGreaterThan(PROJECT_CANVAS_MIN_STAGE_SCALE)
  })

  it('keeps the existing selection when ctrl-starting a marquee selection', () => {
    const options = createOptions()
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', {
          button: 0,
          clientX: 110,
          clientY: 140,
          ctrlKey: true
        }),
        type: 'mousedown'
      })
    })

    expect(options.setSelectedIds).not.toHaveBeenCalled()
    expect(options.setSelectionRect).not.toHaveBeenCalled()
  })

  it('does not clear selection state when starting a marquee from an already-empty selection', () => {
    const options = createOptions()
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', {
          button: 0,
          clientX: 110,
          clientY: 140
        }),
        type: 'mousedown'
      })
    })

    expect(options.setSelectedIds).not.toHaveBeenCalled()
    expect(options.setSelectionRect).not.toHaveBeenCalled()
  })

  it('does not clear an existing selection on marquee mousedown before the gesture resolves', () => {
    const options = createOptions({
      selectedIds: new Set(['existing-item'])
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', {
          button: 0,
          clientX: 110,
          clientY: 140
        }),
        type: 'mousedown'
      })
    })

    expect(options.setSelectedIds).not.toHaveBeenCalled()
    expect(options.setSelectionRect).not.toHaveBeenCalled()
  })

  it('clears an existing selection on mouseup after a non-additive background click', () => {
    const options = createOptions({
      selectedIds: new Set(['existing-item'])
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', {
          button: 0,
          clientX: 110,
          clientY: 140
        }),
        type: 'mousedown'
      })
    })

    expect(options.setSelectedIds).not.toHaveBeenCalled()

    act(() => {
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', {
          button: 0,
          clientX: 110,
          clientY: 140
        }),
        type: 'mouseup'
      })
    })

    expect(options.setSelectedIds).toHaveBeenCalledTimes(1)
    const clearSelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(clearSelection?.(new Set(['existing-item'])) ?? [])).toEqual([])
  })

  it('toggles marquee-active callbacks only for the lifetime of the marquee gesture', () => {
    const onSelectionMarqueeActiveChange = vi.fn()
    const options = createOptions({
      onSelectionMarqueeActiveChange
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
    })

    expect(onSelectionMarqueeActiveChange).not.toHaveBeenCalled()

    act(() => {
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 240, clientY: 250 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 240, clientY: 250 }),
        type: 'mouseup'
      })
    })

    expect(onSelectionMarqueeActiveChange).toHaveBeenNthCalledWith(1, true)
    expect(onSelectionMarqueeActiveChange).toHaveBeenNthCalledWith(2, false)
    expect(onSelectionMarqueeActiveChange).toHaveBeenCalledTimes(2)
  })

  it('does not activate marquee chrome for a background click without drag', () => {
    const onSelectionMarqueeActiveChange = vi.fn()
    const onSelectionRectChange = vi.fn()
    const options = createOptions({
      onSelectionMarqueeActiveChange,
      onSelectionRectChange
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mouseup'
      })
    })

    expect(onSelectionMarqueeActiveChange).not.toHaveBeenCalled()
    expect(onSelectionRectChange).not.toHaveBeenCalled()
  })

  it('updates marquee selection rect DOM callbacks immediately during drag', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const onSelectionRectChange = vi.fn()
    const options = createOptions({ onSelectionRectChange })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
    })

    expect(options.setSelectionRect).not.toHaveBeenCalled()
    expect(onSelectionRectChange).not.toHaveBeenCalled()

    act(() => {
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 170, clientY: 200 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 230, clientY: 260 }),
        type: 'mousemove'
      })
    })

    expect(options.setSelectionRect).not.toHaveBeenCalled()
    expect(rafCallbacks.size).toBe(0)
    expect(onSelectionRectChange).toHaveBeenCalledTimes(2)
    expect(onSelectionRectChange).toHaveBeenLastCalledWith({
      startX: 100,
      startY: 120,
      x: 100,
      y: 120,
      w: 120,
      h: 120
    })
    expect(
      (window as Window & { __canvasInteractionTrace?: Array<Record<string, unknown>> })
        .__canvasInteractionTrace
    ).toBeUndefined()
    expect(options.canvasContainerRef.current.dataset.canvasDebugPhase).toBeUndefined()
  })

  it('keeps marquee debug tracing behind the explicit debug flag', () => {
    ;(
      window as Window & { __projectCanvasDebugInteraction?: boolean }
    ).__projectCanvasDebugInteraction = true
    const onSelectionRectChange = vi.fn()
    const options = createOptions({ onSelectionRectChange })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 230, clientY: 260 }),
        type: 'mousemove'
      })
    })

    expect(
      (window as Window & { __canvasInteractionTrace?: Array<Record<string, unknown>> })
        .__canvasInteractionTrace
    ).toEqual([
      {
        phase: 'selection-start',
        tool: 'select',
        width: 0,
        height: 0
      },
      {
        phase: 'selection-move',
        tool: 'select',
        width: 120,
        height: 120
      }
    ])
    expect(options.canvasContainerRef.current.dataset.canvasDebugPhase).toBe('selection-move')
  })

  it('reuses the measured canvas viewport rect during a marquee drag and refreshes it after mouseup', () => {
    const options = createOptions()
    let currentRect = {
      left: 10,
      top: 20,
      right: 1010,
      bottom: 620,
      width: 1000,
      height: 600,
      x: 10,
      y: 20,
      toJSON: () => ({})
    }
    const getBoundingClientRect = vi.fn(() => currentRect)
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: getBoundingClientRect
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 170, clientY: 200 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 230, clientY: 260 }),
        type: 'mousemove'
      })
    })

    expect(getBoundingClientRect).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 230, clientY: 260 }),
        type: 'mouseup'
      })
    })

    currentRect = {
      left: 40,
      top: 60,
      right: 1040,
      bottom: 660,
      width: 1000,
      height: 600,
      x: 40,
      y: 60,
      toJSON: () => ({})
    }

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 140, clientY: 180 }),
        type: 'mousedown'
      })
    })

    expect(getBoundingClientRect).toHaveBeenCalledTimes(2)
    expect(options.setSelectionRect).not.toHaveBeenCalled()
  })

  it('uses the latest marquee draft bounds on mouseup after an immediate drag update', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const targetItem = {
      id: 'target-image',
      type: 'image',
      x: 180,
      y: 180,
      width: 40,
      height: 40,
      scaleX: 1,
      scaleY: 1
    }
    const onSelectionRectChange = vi.fn()
    const options = createOptions({
      onSelectionRectChange,
      items: [targetItem]
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 240, clientY: 250 }),
        type: 'mousemove'
      })
    })

    expect(options.setSelectionRect).not.toHaveBeenCalled()
    expect(rafCallbacks.size).toBe(0)

    act(() => {
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 240, clientY: 250 }),
        type: 'mouseup'
      })
    })

    expect(onSelectionRectChange).toHaveBeenNthCalledWith(1, {
      startX: 100,
      startY: 120,
      x: 100,
      y: 120,
      w: 130,
      h: 110
    })
    expect(onSelectionRectChange).toHaveBeenLastCalledWith(null)
    expect(options.setSelectionRect).not.toHaveBeenCalled()
    expect(options.setSelectedIds).toHaveBeenCalledTimes(1)
    const applySelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(applySelection?.(new Set()) ?? [])).toEqual([targetItem.id])
  })

  it('replaces the existing selection when a non-additive marquee hits new items', () => {
    const targetItem = {
      id: 'target-image',
      type: 'image',
      x: 180,
      y: 180,
      width: 40,
      height: 40,
      scaleX: 1,
      scaleY: 1
    }
    const options = createOptions({
      items: [targetItem],
      selectedIds: new Set(['existing-item'])
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 240, clientY: 250 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 240, clientY: 250 }),
        type: 'mouseup'
      })
    })

    const applySelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(applySelection?.(new Set(['existing-item'])) ?? [])).toEqual([targetItem.id])
  })

  it('selects the topmost spatial hit from a stage click without requiring per-item DOM proxies', () => {
    const bottomItem = {
      id: 'bottom-image',
      type: 'image',
      x: 100,
      y: 120,
      width: 100,
      height: 100,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1
    }
    const topItem = {
      ...bottomItem,
      id: 'top-image',
      zIndex: 5
    }
    const options = createOptions({
      items: [bottomItem, topItem],
      selectedIds: new Set()
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 130, clientY: 150 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 130, clientY: 150 }),
        type: 'mouseup'
      })
    })

    const applySelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(applySelection?.(new Set()) ?? [])).toEqual([topItem.id])
  })

  it('merges marquee hits into the existing selection when ctrl-starting the gesture', () => {
    const targetItem = {
      id: 'target-image',
      type: 'image',
      x: 180,
      y: 180,
      width: 40,
      height: 40,
      scaleX: 1,
      scaleY: 1
    }
    const options = createOptions({
      items: [targetItem],
      selectedIds: new Set(['existing-item'])
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', {
          button: 0,
          clientX: 110,
          clientY: 140,
          ctrlKey: true
        }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 240, clientY: 250 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 240, clientY: 250 }),
        type: 'mouseup'
      })
    })

    const applySelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(applySelection?.(new Set(['existing-item'])) ?? []).sort()).toEqual([
      'existing-item',
      targetItem.id
    ])
  })

  it('keeps an active marquee gesture alive when mouseleave reports buttons as 0', () => {
    const targetItem = {
      id: 'target-image',
      type: 'image',
      x: 180,
      y: 180,
      width: 40,
      height: 40,
      scaleX: 1,
      scaleY: 1
    }
    const onSelectionRectChange = vi.fn()
    const options = createOptions({
      onSelectionRectChange,
      items: [targetItem]
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        right: 1010,
        bottom: 620,
        width: 1000,
        height: 600,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 110, clientY: 140 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { buttons: 1, clientX: 240, clientY: 250 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseleave', { buttons: 0, clientX: 240, clientY: 250 }),
        type: 'mouseleave'
      })
    })

    expect(onSelectionRectChange).toHaveBeenNthCalledWith(1, {
      startX: 100,
      startY: 120,
      x: 100,
      y: 120,
      w: 130,
      h: 110
    })
    expect(onSelectionRectChange).not.toHaveBeenCalledWith(null)
    expect(options.setSelectionRect).not.toHaveBeenCalledWith(null)

    act(() => {
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 240, clientY: 250 }),
        type: 'mouseup'
      })
    })

    expect(onSelectionRectChange).toHaveBeenLastCalledWith(null)
    const applySelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(applySelection?.(new Set()) ?? [])).toEqual([targetItem.id])
  })

  it('uses canonical item bounds for marquee hits instead of raw width-scale math', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafId += 1
        rafCallbacks.set(rafId, callback)
        return rafId
      }
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id)
    })

    const targetItem = {
      id: 'flipped-image',
      type: 'image',
      x: 200,
      y: 180,
      width: 100,
      height: 60,
      scaleX: -1,
      scaleY: 1
    }
    const options = createOptions({
      items: [targetItem]
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 120, clientY: 170 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 230, clientY: 250 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 230, clientY: 250 }),
        type: 'mouseup'
      })
    })

    const applySelection = (options.setSelectedIds as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ((prev: Set<string>) => Set<string>) | undefined
    expect(Array.from(applySelection?.(new Set()) ?? [])).toEqual([targetItem.id])
  })

  it('uses automation wording when a check marquee lands on an empty region', () => {
    const options = createOptions({
      tool: 'target-select'
    })
    Object.defineProperty(options.canvasContainerRef.current, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    })

    const { result } = renderHook(() => useCanvasStageInteraction(options))

    act(() => {
      result.current.handleStageMouseDown({
        evt: new MouseEvent('mousedown', { button: 0, clientX: 120, clientY: 160 }),
        type: 'mousedown'
      })
      result.current.handleStageMouseMove({
        evt: new MouseEvent('mousemove', { clientX: 260, clientY: 300 }),
        type: 'mousemove'
      })
      result.current.handleStageMouseUp({
        evt: new MouseEvent('mouseup', { button: 0, clientX: 260, clientY: 300 }),
        type: 'mouseup'
      })
    })

    expect(options.handleOpenCanvasTargetDialog).not.toHaveBeenCalled()
    expect(options.notifyWarning).toHaveBeenCalledWith('当前框选区域内没有可用于自动化的画布元素。')
    expect(options.setTool).toHaveBeenCalledWith('select')
  })
})
