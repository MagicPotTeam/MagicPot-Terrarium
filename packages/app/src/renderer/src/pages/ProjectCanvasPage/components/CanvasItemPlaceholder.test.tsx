import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CanvasItemPlaceholder from './CanvasItemPlaceholder'

const rectOverlayProps: Array<Record<string, unknown>> = []
const { scheduleCanvasSyncMock, cancelCanvasSyncMock } = vi.hoisted(() => ({
  scheduleCanvasSyncMock: vi.fn(),
  cancelCanvasSyncMock: vi.fn()
}))

vi.mock('./canvasSync', () => ({
  scheduleCanvasSync: scheduleCanvasSyncMock,
  cancelCanvasSync: cancelCanvasSyncMock
}))

vi.mock('./ProjectCanvasRectItemInteractionOverlay', () => ({
  default: (props: {
    onHoverChange?: (isHovering: boolean) => void
    allowPointerPassthrough?: boolean
  }) => {
    rectOverlayProps.push(props as Record<string, unknown>)
    return (
      <div
        data-testid="canvas-item-placeholder-overlay"
        data-allow-pointer-passthrough={String(Boolean(props.allowPointerPassthrough))}
        onMouseEnter={() => props.onHoverChange?.(true)}
        onMouseLeave={() => props.onHoverChange?.(false)}
      />
    )
  }
}))

function createImageItem() {
  return {
    id: 'image-1',
    type: 'image' as const,
    src: 'image-1.png',
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

function createTextItem() {
  return {
    id: 'text-1',
    type: 'text' as const,
    text: 'Preview text',
    x: 10,
    y: 20,
    width: 220,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    fill: '#ffffff',
    fontSize: 18,
    fontFamily: 'Arial',
    fontWeight: 'normal' as const
  }
}

function createAnnotationItem() {
  return {
    id: 'annotation-1',
    type: 'annotation' as const,
    shape: 'text-anno' as const,
    text: 'Preview annotation',
    label: '',
    x: 10,
    y: 20,
    width: 220,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    stroke: '#ffffff',
    fillOpacity: 0,
    strokeWidth: 0,
    fontSize: 18,
    fontWeight: 'normal' as const
  }
}

describe('CanvasItemPlaceholder', () => {
  afterEach(() => {
    document.body.style.removeProperty('cursor')
    rectOverlayProps.length = 0
    scheduleCanvasSyncMock.mockReset()
    cancelCanvasSyncMock.mockReset()
  })

  it('clears the global move cursor when the hovered placeholder unmounts', () => {
    const { unmount } = render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={createImageItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )

    fireEvent.mouseEnter(screen.getByTestId('canvas-item-placeholder-overlay'))
    expect(document.body.style.cursor).toBe('move')

    unmount()

    expect(document.body.style.cursor).toBe('')
  })

  it('forwards hand-tool pointer passthrough to the rect interaction overlay', () => {
    render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={createImageItem()}
        isSelected={false}
        allowPointerPassthrough
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )

    expect(rectOverlayProps.at(-1)?.allowPointerPassthrough).toBe(true)
    expect(screen.getByTestId('canvas-item-placeholder-overlay')).toHaveAttribute(
      'data-allow-pointer-passthrough',
      'true'
    )
  })

  it('uses the source image for image fallback placeholders without a decoded asset', () => {
    const item = createImageItem()

    render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={item}
        isSelected={false}
        visualVariant="image-fallback"
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )

    const previewContent = rectOverlayProps.at(-1)?.previewContent as
      | React.ReactElement<{
          previewMode?: string
          sourceImagePreview?: boolean
        }>
      | undefined

    expect(previewContent?.props.previewMode).toBe('image-fallback')
    expect(previewContent?.props.sourceImagePreview).toBe(true)
  })

  it('restores the body cursor on mouse leave instead of forcing default', () => {
    render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={createImageItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )

    const overlay = screen.getByTestId('canvas-item-placeholder-overlay')
    fireEvent.mouseEnter(overlay)
    fireEvent.mouseLeave(overlay)

    expect(document.body.style.cursor).toBe('')
  })

  it('syncs live drag preview for text placeholders', () => {
    render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={createTextItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )
    ;(
      rectOverlayProps.at(-1)?.onPreviewChange as
        | ((
            itemId: string,
            preview: {
              x: number
              y: number
              scaleX: number
              scaleY: number
              rotation: number
            } | null
          ) => void)
        | undefined
    )?.('text-1', {
      x: 80,
      y: 110,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })

    expect(scheduleCanvasSyncMock).toHaveBeenCalledWith('text-1', {
      x: 80,
      y: 110,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })
    ;(
      rectOverlayProps.at(-1)?.onPreviewChange as
        | ((itemId: string, preview: null) => void)
        | undefined
    )?.('text-1', null)

    expect(cancelCanvasSyncMock).toHaveBeenCalledWith('text-1')
  })

  it('syncs live drag preview for image placeholders while forwarding image preview updates', () => {
    const onPreviewChange = vi.fn()

    render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={createImageItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onPreviewChange={onPreviewChange}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )
    ;(
      rectOverlayProps.at(-1)?.onPreviewChange as
        | ((
            itemId: string,
            preview: {
              x: number
              y: number
              scaleX: number
              scaleY: number
              rotation: number
            } | null
          ) => void)
        | undefined
    )?.('image-1', {
      x: 56,
      y: 84,
      scaleX: 1.2,
      scaleY: 0.8,
      rotation: 12
    })

    expect(scheduleCanvasSyncMock).toHaveBeenCalledWith('image-1', {
      x: 56,
      y: 84,
      scaleX: 1.2,
      scaleY: 0.8,
      rotation: 12
    })
    expect(onPreviewChange).toHaveBeenCalledWith('image-1', {
      x: 56,
      y: 84,
      width: 120,
      height: 80,
      scaleX: 1.2,
      scaleY: 0.8,
      rotation: 12
    })
  })

  it('forwards annotation drag preview through the rect preview callback without generic sync', () => {
    const onRectPreviewChange = vi.fn()

    render(
      <CanvasItemPlaceholder
        canvasContainerRef={React.createRef<HTMLDivElement>()}
        item={createAnnotationItem()}
        isSelected={false}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        onRectPreviewChange={onRectPreviewChange}
        onSelect={vi.fn()}
        onDragEnd={vi.fn()}
        onTransformEnd={vi.fn()}
      />
    )

    scheduleCanvasSyncMock.mockClear()
    cancelCanvasSyncMock.mockClear()
    ;(
      rectOverlayProps.at(-1)?.onPreviewChange as
        | ((
            itemId: string,
            preview: {
              x: number
              y: number
              scaleX: number
              scaleY: number
              rotation: number
            } | null
          ) => void)
        | undefined
    )?.('annotation-1', {
      x: 32,
      y: 48,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })

    expect(onRectPreviewChange).toHaveBeenCalledWith('annotation-1', {
      x: 32,
      y: 48,
      scaleX: 1,
      scaleY: 1,
      rotation: 0
    })
    expect(scheduleCanvasSyncMock).not.toHaveBeenCalled()
    ;(
      rectOverlayProps.at(-1)?.onPreviewChange as
        | ((itemId: string, preview: null) => void)
        | undefined
    )?.('annotation-1', null)

    expect(onRectPreviewChange).toHaveBeenLastCalledWith('annotation-1', null)
    expect(cancelCanvasSyncMock).not.toHaveBeenCalled()
  })
})
