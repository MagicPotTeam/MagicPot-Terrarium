import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ProjectCanvasPageInlineTextEditor, {
  type InlineTextEditState
} from './ProjectCanvasPageInlineTextEditor'
import type { CanvasItem, CanvasTextItem } from './types'

const {
  measureCanvasAnnotationTextHeightMock,
  measureCanvasTextBoxHeightMock,
  measureCanvasTextNaturalWidthMock
} = vi.hoisted(() => ({
  measureCanvasAnnotationTextHeightMock: vi.fn(() => 48),
  measureCanvasTextBoxHeightMock: vi.fn(() => 72),
  measureCanvasTextNaturalWidthMock: vi.fn(() => 180)
}))

vi.mock('./canvasTextLayout', () => ({
  CANVAS_TEXT_PADDING: 12,
  CANVAS_TEXT_LINE_HEIGHT: 1.5,
  CANVAS_TEXT_WRAP: 'char',
  measureCanvasAnnotationTextHeight: measureCanvasAnnotationTextHeightMock,
  measureCanvasTextBoxHeight: measureCanvasTextBoxHeightMock,
  measureCanvasTextNaturalWidth: measureCanvasTextNaturalWidthMock
}))

function createTextItem(): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    text: 'Preview text',
    x: 48,
    y: 72,
    width: 180,
    height: 51,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    fill: '#ffffff',
    fontSize: 18,
    fontFamily: 'ProjectFont',
    fontWeight: 'bold'
  }
}

describe('ProjectCanvasPageInlineTextEditor', () => {
  beforeEach(() => {
    measureCanvasAnnotationTextHeightMock.mockClear()
    measureCanvasTextBoxHeightMock.mockClear()
    measureCanvasTextNaturalWidthMock.mockClear()
  })

  it('uses canvas text layout styles and commits with the stored text font settings', () => {
    const item = createTextItem()
    const canvasContainer = document.createElement('div')
    document.body.appendChild(canvasContainer)
    const inlineTextEdit: InlineTextEditState = {
      id: item.id,
      x: item.x,
      y: item.y,
      w: item.width,
      h: item.height,
      text: item.text,
      isNew: false,
      fontSize: item.fontSize,
      fontFamily: item.fontFamily,
      fontWeight: item.fontWeight,
      fill: item.fill
    }
    const setInlineTextEdit = vi.fn()
    const setItemsWithHistory = vi.fn()
    const setSelectedIds = vi.fn()
    const setTool = vi.fn()

    render(
      <ProjectCanvasPageInlineTextEditor
        canvasContainerRef={{ current: canvasContainer }}
        canvasContainerElement={canvasContainer}
        inlineTextEdit={inlineTextEdit}
        setInlineTextEdit={setInlineTextEdit}
        inlineTextAreaRef={{ current: null }}
        mediaCaptionPlaceholder="Media caption"
        stageScale={1}
        stagePos={{ x: 0, y: 0 }}
        annotationColor="#22c55e"
        items={[item]}
        nextZIndexRef={{ current: 10 }}
        setItemsWithHistory={setItemsWithHistory}
        setSelectedIds={setSelectedIds}
        setTool={setTool}
      />
    )

    const textarea = screen.getByLabelText('Media caption') as HTMLTextAreaElement
    expect(canvasContainer.contains(textarea)).toBe(true)
    Object.defineProperty(textarea, 'offsetWidth', {
      configurable: true,
      value: item.width
    })
    Object.defineProperty(textarea, 'offsetHeight', {
      configurable: true,
      value: item.height
    })

    expect(textarea.style.width).toBe('180px')
    expect(textarea.style.height).toBe('51px')
    expect(textarea.style.fontSize).toBe('18px')
    expect(textarea.style.fontFamily).toContain(item.fontFamily)
    expect(textarea.style.fontWeight).toBe('700')
    expect(textarea.style.padding).toBe('12px')
    expect(textarea.style.lineHeight).toBe('1.5')
    expect(textarea.style.whiteSpace).toBe('pre-wrap')
    expect(textarea.style.wordBreak).toBe('break-all')
    expect(textarea.style.overflowWrap).toBe('anywhere')
    expect(textarea.style.borderRadius).toBe('6px')

    fireEvent.blur(textarea)

    expect(measureCanvasTextBoxHeightMock).toHaveBeenCalledWith({
      text: item.text,
      width: item.width,
      fontSize: item.fontSize,
      fontFamily: item.fontFamily,
      fontWeight: item.fontWeight,
      wrap: 'char',
      lineHeight: 1.5
    })
    expect(setItemsWithHistory).toHaveBeenCalledTimes(1)

    const updateItems = setItemsWithHistory.mock.calls[0]?.[0] as
      | ((previousItems: CanvasItem[]) => CanvasItem[])
      | undefined
    expect(updateItems).toBeTypeOf('function')
    expect(updateItems?.([item])).toEqual([
      expect.objectContaining({
        id: item.id,
        text: item.text,
        fontSize: item.fontSize,
        width: item.width,
        height: 72,
        scaleX: 1,
        scaleY: 1,
        fontFamily: item.fontFamily,
        fontWeight: item.fontWeight
      })
    ])
    expect(setSelectedIds).toHaveBeenCalledWith(new Set([item.id]))
    expect(setTool).toHaveBeenCalledWith('select')
    expect(setInlineTextEdit).toHaveBeenCalledWith(null)
  })

  it('keeps text annotations visually aligned with the selected canvas style while editing', () => {
    const canvasContainer = document.createElement('div')
    document.body.appendChild(canvasContainer)
    const setInlineTextEdit = vi.fn()
    const setItemsWithHistory = vi.fn()
    const setSelectedIds = vi.fn()
    const setTool = vi.fn()

    render(
      <ProjectCanvasPageInlineTextEditor
        canvasContainerRef={{ current: canvasContainer }}
        canvasContainerElement={canvasContainer}
        inlineTextEdit={{
          id: 'anno-1',
          x: 32,
          y: 48,
          w: 240,
          h: 96,
          text: '123',
          isNew: false,
          fontSize: 36
        }}
        setInlineTextEdit={setInlineTextEdit}
        inlineTextAreaRef={{ current: null }}
        mediaCaptionPlaceholder="Media caption"
        stageScale={1}
        stagePos={{ x: 0, y: 0 }}
        annotationColor="#ff4d4f"
        items={[]}
        nextZIndexRef={{ current: 10 }}
        setItemsWithHistory={setItemsWithHistory}
        setSelectedIds={setSelectedIds}
        setTool={setTool}
      />
    )

    const textarea = screen.getByLabelText('Media caption') as HTMLTextAreaElement
    const normalizedBackground = textarea.style.background.replace(/\s+/g, '')
    const normalizedOutline = textarea.style.outline.replace(/\s+/g, '')
    const normalizedBoxShadow = textarea.style.boxShadow.replace(/\s+/g, '')
    const normalizedBorderRadius = textarea.style.borderRadius.replace(/\s+/g, '')
    const normalizedPadding = textarea.style.padding.replace(/\s+/g, '')

    expect(['transparent', 'rgba(0,0,0,0)']).toContain(normalizedBackground)
    expect(textarea.style.borderStyle).toBe('none')
    expect(['0', '0px']).toContain(normalizedBorderRadius)
    expect(['0', '0px']).toContain(normalizedPadding)
    expect(textarea.style.textAlign).toBe('left')
    expect(textarea.style.lineHeight).toBe('1')
    expect(textarea.style.whiteSpace).toBe('pre-wrap')
    expect(textarea.style.wordBreak).toBe('break-all')
    expect(textarea.style.fontWeight).toBe('400')
    expect(normalizedOutline).toContain('solid')
    expect(normalizedOutline).toContain('rgba(99,102,241,0.92)')
    expect(normalizedBoxShadow).toContain('rgba(99,102,241,0.36)')
  })

  it('keeps an existing text annotation anchored in place after exiting edit mode', () => {
    const annotationItem: CanvasItem = {
      id: 'anno-1',
      type: 'annotation',
      shape: 'text-anno',
      stroke: '#ff4d4f',
      fillOpacity: 0,
      strokeWidth: 0,
      label: '',
      text: '123',
      fontSize: 36,
      x: 32,
      y: 48,
      width: 240,
      height: 96,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 2,
      locked: false
    }
    const canvasContainer = document.createElement('div')
    document.body.appendChild(canvasContainer)
    const setInlineTextEdit = vi.fn()
    const setItemsWithHistory = vi.fn()
    const setSelectedIds = vi.fn()
    const setTool = vi.fn()

    render(
      <ProjectCanvasPageInlineTextEditor
        canvasContainerRef={{ current: canvasContainer }}
        canvasContainerElement={canvasContainer}
        inlineTextEdit={{
          id: annotationItem.id,
          x: annotationItem.x,
          y: annotationItem.y,
          w: annotationItem.width,
          h: annotationItem.height,
          text: annotationItem.text || '',
          isNew: false,
          fontSize: annotationItem.fontSize,
          fontWeight: 'normal'
        }}
        setInlineTextEdit={setInlineTextEdit}
        inlineTextAreaRef={{ current: null }}
        mediaCaptionPlaceholder="Media caption"
        stageScale={1}
        stagePos={{ x: 0, y: 0 }}
        annotationColor="#ff4d4f"
        items={[annotationItem]}
        nextZIndexRef={{ current: 10 }}
        setItemsWithHistory={setItemsWithHistory}
        setSelectedIds={setSelectedIds}
        setTool={setTool}
      />
    )

    const textarea = screen.getByLabelText('Media caption') as HTMLTextAreaElement
    Object.defineProperty(textarea, 'offsetWidth', {
      configurable: true,
      value: annotationItem.width
    })
    Object.defineProperty(textarea, 'offsetHeight', {
      configurable: true,
      value: annotationItem.height
    })

    fireEvent.blur(textarea)

    expect(measureCanvasTextNaturalWidthMock).not.toHaveBeenCalled()
    const updateItems = setItemsWithHistory.mock.calls[0]?.[0] as
      | ((previousItems: CanvasItem[]) => CanvasItem[])
      | undefined
    expect(updateItems).toBeTypeOf('function')
    expect(updateItems?.([annotationItem])).toEqual([
      expect.objectContaining({
        id: annotationItem.id,
        x: annotationItem.x,
        y: annotationItem.y,
        width: annotationItem.width,
        height: annotationItem.height,
        fontSize: annotationItem.fontSize,
        scaleX: 1,
        scaleY: 1
      })
    ])
  })
})
