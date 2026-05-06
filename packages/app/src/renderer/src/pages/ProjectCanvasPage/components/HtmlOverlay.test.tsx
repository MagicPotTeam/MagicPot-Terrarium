import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import HtmlOverlay from './HtmlOverlay'
import {
  buildOcrResultHtml,
  CANVAS_OCR_HOVER_EVENT,
  type CanvasOcrHoverDetail
} from '../ocrCanvasUtils'
import type { CanvasHtmlItem } from '../types'

const createHtmlItem = (): CanvasHtmlItem => ({
  id: 'html-1',
  type: 'html',
  htmlData: buildOcrResultHtml(
    {
      kind: 'table',
      boxes: [{ id: 'box-1', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
      sheets: [
        {
          id: 'sheet-1',
          name: 'Sheet 1',
          rows: 1,
          cols: 1,
          cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Alpha', bboxIds: ['box-1'] }]
        }
      ]
    },
    'result.xlsx'
  ),
  interactive: true,
  ocrBundleId: 'bundle-1',
  x: 24,
  y: 36,
  width: 420,
  height: 320,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  zIndex: 1,
  locked: false
})

describe('HtmlOverlay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches OCR hover events when hovering OCR table cells', () => {
    const hoverListener = vi.fn()
    window.addEventListener(CANVAS_OCR_HOVER_EVENT, hoverListener as EventListener)

    render(
      <HtmlOverlay
        item={createHtmlItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        activeOcrHover={null}
        onSelect={vi.fn()}
        onUpdateItem={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    fireEvent.pointerOver(screen.getByText('Alpha'))

    const hoverEvent = hoverListener.mock.calls
      .map(([event]) => event)
      .find((event) => event instanceof CustomEvent) as
      | CustomEvent<CanvasOcrHoverDetail>
      | undefined

    expect(hoverEvent?.detail).toEqual({
      bundleId: 'bundle-1',
      bboxIds: ['box-1'],
      cellIds: ['cell-1']
    })

    window.removeEventListener(CANVAS_OCR_HOVER_EVENT, hoverListener as EventListener)
  })

  it('becomes pointer-transparent when hand panning owns pointer input', () => {
    const { container } = render(
      <HtmlOverlay
        item={createHtmlItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        activeOcrHover={null}
        allowPointerPassthrough
        onSelect={vi.fn()}
        onUpdateItem={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const overlay = container.querySelector('[data-canvas-overlay="html"]') as HTMLElement | null
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveStyle({ pointerEvents: 'none' })
  })

  it('toggles the active class when the linked OCR hover state changes', () => {
    const { container, rerender } = render(
      <HtmlOverlay
        item={createHtmlItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        activeOcrHover={null}
        onSelect={vi.fn()}
        onUpdateItem={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(
      container.querySelector('[data-ocr-cell-id="cell-1"]')?.classList.contains('is-active')
    ).toBe(false)

    rerender(
      <HtmlOverlay
        item={createHtmlItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        activeOcrHover={{
          bundleId: 'bundle-1',
          bboxIds: ['box-1'],
          cellIds: ['cell-1']
        }}
        onSelect={vi.fn()}
        onUpdateItem={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    expect(
      container.querySelector('[data-ocr-cell-id="cell-1"]')?.classList.contains('is-active')
    ).toBe(true)
  })
})
