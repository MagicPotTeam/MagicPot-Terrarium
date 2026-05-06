import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useCanvasViewerPlayback } from './useCanvasViewerPlayback'
import type { CanvasItem } from './types'

function createCanvasItem(
  overrides: Partial<CanvasItem> & Pick<CanvasItem, 'id' | 'type'>
): CanvasItem {
  const { id, type, ...rest } = overrides

  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...rest
  } as CanvasItem
}

function createOptions(overrides: Record<string, unknown> = {}) {
  const items = [
    createCanvasItem({ id: 'left-visible', type: 'image', x: 0, y: 0 }),
    createCanvasItem({ id: 'right-visible', type: 'image', x: 1600, y: 0 })
  ]

  return {
    canvasActiveRef: { current: false },
    groupPlayback: null,
    items,
    lastClickedIdRef: { current: null },
    selectedIds: new Set<string>(),
    setItems: vi.fn(),
    setItemsWithHistory: vi.fn(),
    setSelectedIds: vi.fn(),
    setTool: vi.fn(),
    sortedItems: items,
    stagePos: { x: 0, y: 0 },
    stageScale: 1,
    stageSize: { width: 800, height: 600 },
    ...overrides
  }
}

describe('useCanvasViewerPlayback', () => {
  it('updates visible items immediately when the stage viewport pans', () => {
    const initialOptions = createOptions()
    const { result, rerender } = renderHook(({ options }) => useCanvasViewerPlayback(options), {
      initialProps: {
        options: initialOptions
      }
    })

    expect(result.current.visibleItems.map((item) => item.id)).toEqual(['left-visible'])

    rerender({
      options: {
        ...initialOptions,
        stagePos: { x: -1600, y: 0 }
      }
    })

    expect(result.current.visibleItems.map((item) => item.id)).toEqual(['right-visible'])
  })
})
