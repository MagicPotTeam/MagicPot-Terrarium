import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-konva', () => ({
  Line: () => null
}))

vi.mock('konva', () => ({
  default: {}
}))

import type { InlineTextEditState } from './ProjectCanvasPageInlineTextEditor'
import {
  getCanvasItemFallbackBounds,
  resolveAttachedCaptionPosition,
  resolveInlineTextViewportShift,
  shouldClearInlineTextEdit,
  shouldAutoFitInlineAnnotationEditorFont,
  useCanvasInlineTextEffects
} from './useCanvasInlineTextEffects'
import type { CanvasAnnotationItem, CanvasImageItem, CanvasItem } from './types'

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'local-media:///demo.png',
    x: 24,
    y: 36,
    width: 160,
    height: 90,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createInlineTextEdit(overrides: Partial<InlineTextEditState> = {}): InlineTextEditState {
  return {
    id: 'anno-caption',
    x: 180,
    y: 120,
    w: 120,
    h: 40,
    text: 'caption',
    isNew: false,
    ...overrides
  }
}

function createAttachedCaptionItem(
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id: 'caption-1',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ef4444',
    fillOpacity: 0,
    strokeWidth: 0,
    label: '',
    text: 'caption',
    fontSize: 28,
    x: 24,
    y: 138,
    width: 160,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    attachedToId: 'image-1',
    attachmentPlacement: 'bottom-center',
    ...overrides
  }
}

function CanvasInlineTextEffectsProbe({
  initialItems
}: {
  initialItems: CanvasItem[]
}): React.ReactElement {
  const [items, setItems] = React.useState<CanvasItem[]>(initialItems)
  const inlineTextAreaRef = React.useRef<HTMLTextAreaElement | null>(null)

  useCanvasInlineTextEffects({
    getCanvasItemVisualBounds: () => null,
    inlineTextAreaRef,
    inlineTextEdit: null,
    itemIdSet: new Set(items.map((item) => item.id)),
    items,
    setInlineTextEdit: vi.fn(),
    setItems,
    setStagePos: vi.fn(),
    stagePos: { x: 0, y: 0 },
    stageScale: 1,
    stageSize: { width: 900, height: 640 }
  })

  return React.createElement('div', {
    'data-testid': 'items',
    'data-items': JSON.stringify(items)
  })
}

describe('getCanvasItemFallbackBounds', () => {
  it('normalizes scaled item bounds', () => {
    expect(
      getCanvasItemFallbackBounds(
        createImageItem({
          x: 12,
          y: 18,
          width: 100,
          height: 40,
          scaleX: -2,
          scaleY: 1.5
        })
      )
    ).toEqual({
      x: 12,
      y: 18,
      width: 200,
      height: 60
    })
  })
})

describe('resolveAttachedCaptionPosition', () => {
  it('centers a caption below its parent bounds', () => {
    expect(
      resolveAttachedCaptionPosition(
        {
          x: 80,
          y: 48,
          width: 240,
          height: 120
        },
        100
      )
    ).toEqual({
      x: 150,
      y: 180
    })
  })
})

describe('shouldClearInlineTextEdit', () => {
  it('clears inline text edits whose attached parent item was removed', () => {
    expect(
      shouldClearInlineTextEdit(
        createInlineTextEdit({
          attachedToId: 'missing-parent',
          attachmentPlacement: 'bottom-center'
        }),
        new Set(['anno-caption'])
      )
    ).toBe(true)
  })

  it('keeps brand new inline text edits alive before they become persisted items', () => {
    expect(shouldClearInlineTextEdit(createInlineTextEdit({ isNew: true }), new Set())).toBe(false)
  })
})

describe('shouldAutoFitInlineAnnotationEditorFont', () => {
  it('keeps free annotation editors eligible for font fitting', () => {
    expect(
      shouldAutoFitInlineAnnotationEditorFont(
        createInlineTextEdit({
          id: 'anno-free',
          isNew: true
        })
      )
    ).toBe(true)
  })

  it('does not auto-fit attached caption editors', () => {
    expect(
      shouldAutoFitInlineAnnotationEditorFont(
        createInlineTextEdit({
          id: 'anno-attached',
          isNew: true,
          attachedToId: 'image-1',
          attachmentPlacement: 'bottom-center'
        })
      )
    ).toBe(false)
  })
})

describe('resolveInlineTextViewportShift', () => {
  it('returns null when the editor already fits inside the viewport', () => {
    expect(
      resolveInlineTextViewportShift({
        inlineTextEdit: createInlineTextEdit({
          id: 'text-1',
          x: 40,
          y: 30,
          w: 200,
          h: 60
        }),
        stagePos: { x: 20, y: 30 },
        stageScale: 1,
        stageSize: { width: 900, height: 600 }
      })
    ).toBeNull()
  })

  it('keeps persisted inline text edits anchored even when the editor would overflow the viewport', () => {
    expect(
      resolveInlineTextViewportShift({
        inlineTextEdit: createInlineTextEdit({
          id: 'text-1',
          x: 780,
          y: 560,
          w: 200,
          h: 80,
          isNew: false
        }),
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        stageSize: { width: 900, height: 640 }
      })
    ).toBeNull()
  })

  it('shifts the stage when a brand new inline editor would overflow the viewport', () => {
    expect(
      resolveInlineTextViewportShift({
        inlineTextEdit: createInlineTextEdit({
          id: 'anno-new',
          x: 780,
          y: 560,
          w: 200,
          h: 80,
          isNew: true
        }),
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        stageSize: { width: 900, height: 640 }
      })
    ).toEqual({
      x: -104,
      y: -24
    })
  })

  it('does not shift the stage for new attached caption editors that overflow the viewport', () => {
    expect(
      resolveInlineTextViewportShift({
        inlineTextEdit: createInlineTextEdit({
          id: 'anno-new-caption',
          x: 780,
          y: 560,
          w: 200,
          h: 80,
          isNew: true,
          attachedToId: 'image-1',
          attachmentPlacement: 'bottom-center'
        }),
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        stageSize: { width: 900, height: 640 }
      })
    ).toBeNull()
  })
})

describe('useCanvasInlineTextEffects', () => {
  it('resizes attached captions when the parent item is scaled', async () => {
    const image = createImageItem({
      width: 160,
      height: 90,
      scaleX: 6,
      scaleY: 6
    })
    const caption = createAttachedCaptionItem()

    const { getByTestId } = render(
      React.createElement(CanvasInlineTextEffectsProbe, {
        initialItems: [image, caption]
      })
    )

    await waitFor(() => {
      const items = JSON.parse(
        getByTestId('items').getAttribute('data-items') || '[]'
      ) as CanvasItem[]
      const resizedCaption = items.find(
        (item): item is CanvasAnnotationItem => item.id === caption.id && item.type === 'annotation'
      )

      expect(resizedCaption).toMatchObject({
        x: 24,
        y: 588,
        width: 960,
        height: 288,
        fontSize: 168,
        attachmentBaseScale: 1,
        attachmentBaseFontSize: 28,
        attachmentBaseHeight: 48
      })
    })
  })
})
