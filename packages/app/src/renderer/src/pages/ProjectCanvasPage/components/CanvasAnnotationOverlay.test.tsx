import React from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import CanvasAnnotationOverlay from './CanvasAnnotationOverlay'
import type { CanvasAnnotationItem, CanvasImageItem } from '../types'

function createParentImageItem(): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'image-1.png',
    x: 100,
    y: 40,
    width: 200,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createAttachedCaptionItem(): CanvasAnnotationItem {
  return {
    id: 'annotation-1',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ef4444',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    text: '123',
    fontSize: 28,
    x: 120,
    y: 152,
    width: 160,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    attachedToId: 'image-1',
    attachmentPlacement: 'bottom-center'
  }
}

function createTextAnnotationItem(): CanvasAnnotationItem {
  return {
    id: 'annotation-self-sync',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ef4444',
    fillOpacity: 0,
    strokeWidth: 2,
    label: '',
    text: '123',
    fontSize: 28,
    x: 140,
    y: 96,
    width: 160,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false
  }
}

describe('CanvasAnnotationOverlay', () => {
  it('applies direct preview sync for draggable text annotations and resets afterwards', () => {
    const annotationItem = createTextAnnotationItem()

    const { container } = render(<CanvasAnnotationOverlay item={annotationItem} stageScale={1} />)

    const overlay = container.querySelector(
      `[data-canvas-overlay="annotation"][data-canvas-item-id="${annotationItem.id}"]`
    ) as HTMLElement | null

    expect(overlay).not.toBeNull()
    expect(overlay?.style.transform).toContain('translate3d(140px, 96px, 0)')
    expect(container.querySelector('[data-canvas-annotation-text]')).not.toBeNull()
    expect(container.querySelector('foreignObject')).toBeNull()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${annotationItem.id}`, {
          detail: {
            x: 220,
            y: 168,
            rotation: 0,
            scaleX: 1,
            scaleY: 1
          }
        })
      )
    })

    expect(overlay?.style.transform).toContain('translate3d(220px, 168px, 0)')

    act(() => {
      window.dispatchEvent(new CustomEvent(`canvas-reset-${annotationItem.id}`))
    })

    expect(overlay?.style.transform).toContain('translate3d(140px, 96px, 0)')
  })

  it('keeps direct annotation drag preview off the React render path', () => {
    const annotationItem = createTextAnnotationItem()
    const onRender = vi.fn()

    const { container } = render(
      <React.Profiler id="annotation-overlay" onRender={onRender}>
        <CanvasAnnotationOverlay item={annotationItem} stageScale={1} />
      </React.Profiler>
    )

    const overlay = container.querySelector(
      `[data-canvas-overlay="annotation"][data-canvas-item-id="${annotationItem.id}"]`
    ) as HTMLElement | null
    const textNode = container.querySelector('[data-canvas-annotation-text]')
    const renderCountAfterMount = onRender.mock.calls.length

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${annotationItem.id}`, {
          detail: {
            x: 260,
            y: 188,
            rotation: annotationItem.rotation,
            scaleX: annotationItem.scaleX,
            scaleY: annotationItem.scaleY
          }
        })
      )
    })

    expect(onRender).toHaveBeenCalledTimes(renderCountAfterMount)
    expect(container.querySelector('[data-canvas-annotation-text]')).toBe(textNode)
    expect(overlay?.style.transform).toContain('translate3d(260px, 188px, 0)')
  })

  it('tracks attached caption position during parent drag preview sync', () => {
    const parentItem = createParentImageItem()
    const annotationItem = createAttachedCaptionItem()

    const { container } = render(
      <CanvasAnnotationOverlay
        item={annotationItem}
        attachedParentItem={parentItem}
        stageScale={1}
      />
    )

    const overlay = container.querySelector(
      `[data-canvas-overlay="annotation"][data-canvas-item-id="${annotationItem.id}"]`
    ) as HTMLElement | null

    expect(overlay).not.toBeNull()
    expect(overlay?.style.transform).toContain('translate3d(120px, 152px, 0)')

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${parentItem.id}`, {
          detail: {
            x: 180,
            y: 60,
            rotation: 0,
            scaleX: 1,
            scaleY: 1
          }
        })
      )
    })

    expect(overlay?.style.transform).toContain('translate3d(180px, 172px, 0)')
    expect(overlay?.style.width).toBe('200px')

    act(() => {
      window.dispatchEvent(new CustomEvent(`canvas-reset-${parentItem.id}`))
    })

    expect(overlay?.style.transform).toContain('translate3d(120px, 152px, 0)')
  })

  it('scales attached caption preview layout with parent resize sync', () => {
    const parentItem = createParentImageItem()
    const annotationItem = createAttachedCaptionItem()

    const { container } = render(
      <CanvasAnnotationOverlay
        item={annotationItem}
        attachedParentItem={parentItem}
        stageScale={1}
      />
    )

    const overlay = container.querySelector(
      `[data-canvas-overlay="annotation"][data-canvas-item-id="${annotationItem.id}"]`
    ) as HTMLElement | null
    const textNode = container.querySelector('[data-canvas-annotation-text]') as HTMLElement | null

    act(() => {
      window.dispatchEvent(
        new CustomEvent(`canvas-sync-${parentItem.id}`, {
          detail: {
            x: 180,
            y: 60,
            rotation: 0,
            scaleX: 6,
            scaleY: 6
          }
        })
      )
    })

    expect(overlay?.style.transform).toContain('translate3d(180px, 672px, 0)')
    expect(overlay?.style.width).toBe('1200px')
    expect(overlay?.style.height).toBe('288px')
    expect(textNode).toHaveStyle({ fontSize: '168px' })
  })
})
