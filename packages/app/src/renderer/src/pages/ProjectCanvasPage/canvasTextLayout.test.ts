import { describe, expect, it } from 'vitest'

import {
  CANVAS_TEXT_MAX_WIDTH,
  CANVAS_TEXT_PADDING,
  getInlineTextEditorViewportSize,
  measureCanvasTextBoxHeight,
  measureCanvasTextBoxSize
} from './canvasTextLayout'

describe('canvasTextLayout', () => {
  it('adds stable padding when measuring text box height', () => {
    expect(
      measureCanvasTextBoxHeight({
        text: 'A'.repeat(30),
        width: 180,
        fontSize: 20,
        fontFamily: 'system-ui, sans-serif'
      })
    ).toBe(84)
  })

  it('caps oversized text blocks while keeping inner measurement consistent', () => {
    const longText = 'A'.repeat(300)
    const layout = measureCanvasTextBoxSize({
      text: longText,
      fontSize: 16,
      fontFamily: 'system-ui, sans-serif'
    })

    expect(layout.width).toBe(CANVAS_TEXT_MAX_WIDTH)
    expect(layout.height).toBeGreaterThan(CANVAS_TEXT_PADDING * 2)
  })

  it('caps inline editor size to the visible stage while preserving a readable minimum', () => {
    expect(
      getInlineTextEditorViewportSize({
        width: 320,
        height: 1200,
        stageScale: 1,
        stageWidth: 900,
        stageHeight: 700,
        screenMargin: 24,
        bottomClearance: 24,
        isTextItem: true
      })
    ).toEqual({
      width: 320,
      height: 652,
      maxWidth: 852,
      maxHeight: 652
    })
  })
})
