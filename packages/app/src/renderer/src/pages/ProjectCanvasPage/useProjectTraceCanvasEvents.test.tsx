import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectTraceCanvasEvents } from './useProjectTraceCanvasEvents'
import type { CanvasItem } from './types'

function createTextItem(overrides: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'item-1',
    type: 'text',
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    text: 'Label',
    fontSize: 16,
    fontFamily: 'system-ui',
    fill: '#fff',
    ...overrides
  } as CanvasItem
}

function renderTraceHook(options: Partial<Parameters<typeof useProjectTraceCanvasEvents>[0]> = {}) {
  const emitRuntimeEvent = vi.fn()
  const props = {
    canvasId: 'canvas-1',
    projectName: 'Project One',
    items: [] as CanvasItem[],
    selectedIds: new Set<string>(),
    isChineseUi: false,
    debounceMs: 20,
    emitRuntimeEvent,
    ...options
  }
  const view = renderHook((nextProps: typeof props) => useProjectTraceCanvasEvents(nextProps), {
    initialProps: props
  })
  return { ...view, emitRuntimeEvent }
}

describe('useProjectTraceCanvasEvents', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('records the initial canvas snapshot without emitting an event', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent } = renderTraceHook({ items: [createTextItem()] })

    vi.advanceTimersByTime(50)

    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  })

  it('emits a debounced add event after the canvas changes', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender } = renderTraceHook({ items: [createTextItem()] })

    rerender({
      canvasId: 'canvas-1',
      projectName: 'Project One',
      items: [
        createTextItem(),
        createTextItem({ id: 'item-2', type: 'annotation' } as Partial<CanvasItem>)
      ],
      selectedIds: new Set(['item-2']),
      isChineseUi: false,
      debounceMs: 20,
      emitRuntimeEvent
    })

    vi.advanceTimersByTime(19)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'canvas-1',
        projectName: 'Project One',
        scope: 'canvas',
        action: 'canvas_items_added',
        status: 'success',
        entityType: 'canvas_item',
        entityCount: 2,
        createdItemCount: 1,
        canvasMutation: true,
        outputKinds: expect.arrayContaining(['text', 'annotation'])
      })
    )
    expect(emitRuntimeEvent.mock.calls[0]?.[0].safeSummary).toContain(
      'Canvas has 2 item(s), 1 selected.'
    )
  })

  it('emits selection-only changes as non-mutating canvas selection events', () => {
    vi.useFakeTimers()
    const item = createTextItem()
    const { emitRuntimeEvent, rerender } = renderTraceHook({ items: [item] })

    rerender({
      canvasId: 'canvas-1',
      projectName: 'Project One',
      items: [item],
      selectedIds: new Set(['item-1']),
      isChineseUi: false,
      debounceMs: 20,
      emitRuntimeEvent
    })

    vi.advanceTimersByTime(20)

    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_selection_changed',
        canvasMutation: false,
        createdItemCount: 0,
        riskSignals: []
      })
    )
  })

  it('keeps the original baseline while debounce coalesces multiple changes', () => {
    vi.useFakeTimers()
    const base = createTextItem({ id: 'base' })
    const moved = createTextItem({ id: 'base', x: 40 })
    const added = createTextItem({ id: 'added' })
    const { emitRuntimeEvent, rerender } = renderTraceHook({ items: [base] })

    rerender({
      canvasId: 'canvas-1',
      projectName: 'Project One',
      items: [moved],
      selectedIds: new Set<string>(),
      isChineseUi: false,
      debounceMs: 20,
      emitRuntimeEvent
    })
    vi.advanceTimersByTime(10)
    rerender({
      canvasId: 'canvas-1',
      projectName: 'Project One',
      items: [moved, added],
      selectedIds: new Set<string>(),
      isChineseUi: false,
      debounceMs: 20,
      emitRuntimeEvent
    })
    vi.advanceTimersByTime(20)

    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(emitRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'canvas_items_added',
        createdItemCount: 1,
        movementDistancePx: 30
      })
    )
  })

  it('cancels a pending debounce timer on unmount', () => {
    vi.useFakeTimers()
    const { emitRuntimeEvent, rerender, unmount } = renderTraceHook({ items: [createTextItem()] })

    rerender({
      canvasId: 'canvas-1',
      projectName: 'Project One',
      items: [createTextItem(), createTextItem({ id: 'item-2' })],
      selectedIds: new Set<string>(),
      isChineseUi: false,
      debounceMs: 20,
      emitRuntimeEvent
    })
    unmount()
    vi.advanceTimersByTime(20)

    expect(emitRuntimeEvent).not.toHaveBeenCalled()
  })
})
