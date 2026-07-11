import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasDuplicateCheckRuntimeBridge } from './useCanvasDuplicateCheckRuntimeBridge'
import { CANVAS_DUPLICATE_CHECK_FOCUS_EVENT } from './canvasDuplicateCheckRuntime'
import type { CanvasImageItem, CanvasItem } from './types'

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'file://image.png',
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

function createTextItem(overrides: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: 'text-1',
    type: 'text',
    text: 'Label',
    fontSize: 16,
    fontFamily: 'system-ui',
    fill: '#fff',
    x: 50,
    y: 60,
    width: 120,
    height: 40,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    ...overrides
  } as CanvasItem
}

function renderBridge(
  overrides: Partial<Parameters<typeof useCanvasDuplicateCheckRuntimeBridge>[0]> = {}
) {
  const options = {
    canvasId: 'canvas-1',
    projectName: 'Project One',
    items: [createImageItem(), createTextItem()],
    selectedIds: new Set<string>(['image-1']),
    setSelectedIds: vi.fn(),
    focusCanvasStage: vi.fn(),
    focusCanvasBounds: vi.fn(),
    publishSnapshot: vi.fn(),
    ...overrides
  }
  const view = renderHook(
    (nextOptions: typeof options) => useCanvasDuplicateCheckRuntimeBridge(nextOptions),
    {
      initialProps: options
    }
  )
  return { ...view, options }
}

describe('useCanvasDuplicateCheckRuntimeBridge', () => {
  beforeEach(() => {
    let rafId = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafId += 1
      callback(rafId)
      return rafId
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('publishes image and selected image ids for duplicate-check runtime consumers', () => {
    const { options } = renderBridge()

    expect(options.publishSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: 'canvas-1',
        projectName: 'Project One',
        imageItemIds: ['image-1'],
        selectedItemIds: ['image-1'],
        selectedImageItemIds: ['image-1']
      })
    )
  })

  it('selects and focuses requested items from a matching focus event', () => {
    const { options } = renderBridge()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CANVAS_DUPLICATE_CHECK_FOCUS_EVENT, {
          detail: { canvasId: 'canvas-1', itemIds: ['text-1'] }
        })
      )
    })

    expect(options.setSelectedIds).toHaveBeenCalledWith(new Set(['text-1']))
    expect(options.focusCanvasStage).toHaveBeenCalledTimes(1)
    expect(options.focusCanvasBounds).toHaveBeenCalledWith(
      expect.objectContaining({ minX: 50, minY: 60, maxX: 170, maxY: 100 }),
      120
    )
  })

  it('ignores focus events for a different canvas or missing items', () => {
    const { options } = renderBridge()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CANVAS_DUPLICATE_CHECK_FOCUS_EVENT, {
          detail: { canvasId: 'other-canvas', itemIds: ['text-1'] }
        })
      )
      window.dispatchEvent(
        new CustomEvent(CANVAS_DUPLICATE_CHECK_FOCUS_EVENT, {
          detail: { canvasId: 'canvas-1', itemIds: ['missing'] }
        })
      )
    })

    expect(options.setSelectedIds).not.toHaveBeenCalled()
    expect(options.focusCanvasStage).not.toHaveBeenCalled()
    expect(options.focusCanvasBounds).not.toHaveBeenCalled()
  })

  it('updates returned selectedItems when selection props change', () => {
    const { result, rerender, options } = renderBridge()
    expect(result.current.selectedItems.map((item) => item.id)).toEqual(['image-1'])

    rerender({
      ...options,
      selectedIds: new Set(['text-1'])
    })

    expect(result.current.selectedItems.map((item) => item.id)).toEqual(['text-1'])
  })

  it('removes the focus listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderBridge()

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      CANVAS_DUPLICATE_CHECK_FOCUS_EVENT,
      expect.any(Function)
    )
  })
})
