import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectCanvasCanvas2DFallbackLayer, {
  type ProjectCanvasCanvas2DFallbackLayerHandle
} from './ProjectCanvasCanvas2DFallbackLayer'
import type { CanvasImageItem } from '../types'

function createImage(width = 200, height = 120) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height })
  return image
}

function createItem(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `https://example.com/${id}.png`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    image: createImage(),
    ...overrides
  }
}

type MockContext = CanvasRenderingContext2D & {
  setTransform: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  translate: ReturnType<typeof vi.fn>
  scale: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
}

function createMockContext(): MockContext {
  return {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn()
  } as unknown as MockContext
}

describe('ProjectCanvasCanvas2DFallbackLayer', () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext
  let originalDevicePixelRatio: PropertyDescriptor | undefined
  let context: MockContext

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext
    originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
    context = createMockContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) =>
      contextId === '2d' ? context : null) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    if (originalDevicePixelRatio) {
      Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatio)
    }
  })

  it('draws visible items in zIndex order with capped DPR and stage transform', async () => {
    const back = createItem('back', { zIndex: 1, x: 10, y: 20 })
    const front = createItem('front', { zIndex: 2, x: 40, y: 50, rotation: 90, scaleX: -1 })

    const { container } = render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[front, back]}
        stagePos={{ x: 12, y: 24 }}
        stageScale={1.5}
        stageSize={{ width: 640, height: 360 }}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2))

    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBe(1280)
    expect(canvas.height).toBe(720)
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
    expect(context.translate).toHaveBeenNthCalledWith(1, 12, 24)
    expect(context.scale).toHaveBeenNthCalledWith(1, 1.5, 1.5)
    expect(context.translate).toHaveBeenNthCalledWith(2, 10, 20)
    expect(context.translate).toHaveBeenNthCalledWith(3, 40, 50)
    expect(context.rotate).toHaveBeenNthCalledWith(2, Math.PI / 2)
    expect(context.scale).toHaveBeenNthCalledWith(3, -1, 1)
  })

  it('uses the 9-argument crop drawImage path', async () => {
    const image = createImage(400, 300)
    const item = createItem('crop', {
      image,
      crop: { x: 20, y: 30, width: 200, height: 120 },
      width: 160,
      height: 90
    })

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[item]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalled())
    expect(context.drawImage).toHaveBeenCalledWith(image, 20, 30, 200, 120, 0, 0, 160, 90)
  })

  it('reports draw failures so the parent can fall through to DOM img fallback', async () => {
    const onFailedIdsChange = vi.fn()
    const onDrawFailure = vi.fn()
    context.drawImage.mockImplementation(() => {
      throw new Error('draw failed')
    })
    const item = createItem('broken')

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[item]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
        onFailedIdsChange={onFailedIdsChange}
        onDrawFailure={onDrawFailure}
      />
    )

    await waitFor(() => expect(onFailedIdsChange).toHaveBeenCalledWith(new Set(['broken'])))
    expect(onDrawFailure).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'broken', phase: 'draw' })
    )
  })

  it('uses the spatial visibility index while preserving zIndex draw order', async () => {
    const offscreen = createItem('offscreen', { zIndex: 0, x: 2000, y: 2000 })
    const front = createItem('front', { zIndex: 3, x: 32, y: 24 })
    const back = createItem('back', { zIndex: 1, x: 16, y: 12 })
    const selectedOffscreen = createItem('selected-offscreen', {
      zIndex: 2,
      x: 2600,
      y: 2600
    })

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[offscreen, front, selectedOffscreen, back]}
        selectedIds={new Set(['selected-offscreen', 'front', 'missing-selected'])}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
        overscanPx={0}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(3))
    expect(context.translate).not.toHaveBeenCalledWith(2000, 2000)
    expect(context.translate).toHaveBeenNthCalledWith(2, 16, 12)
    expect(context.translate).toHaveBeenNthCalledWith(3, 2600, 2600)
    expect(context.translate).toHaveBeenNthCalledWith(4, 32, 24)
    const frontTranslateCalls = context.translate.mock.calls.filter(
      (call) => call[0] === 32 && call[1] === 24
    )
    expect(frontTranslateCalls).toHaveLength(1)
  })

  it('preserves source order for fallback images with equal zIndex', async () => {
    const first = createItem('same-z-first', { zIndex: 5, x: 18, y: 20 })
    const second = createItem('same-z-second', { zIndex: 5, x: 88, y: 30 })

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[second, first]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
        overscanPx={0}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2))
    expect(context.translate).toHaveBeenNthCalledWith(2, 88, 30)
    expect(context.translate).toHaveBeenNthCalledWith(3, 18, 20)
  })

  it('keeps rotated visual bounds visible when unrotated bounds sit outside the viewport', async () => {
    const rotatedVisible = createItem('rotated-visible', {
      x: 340,
      y: 120,
      width: 120,
      height: 120,
      rotation: 45,
      zIndex: 1
    })
    const far = createItem('far', { x: 1200, y: 1200, zIndex: 2 })

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[far, rotatedVisible]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
        overscanPx={0}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1))
    expect(context.translate).toHaveBeenCalledWith(340, 120)
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 4)
    expect(context.translate).not.toHaveBeenCalledWith(1200, 1200)
  })

  it('draws only spatially visible fallback images from a large offscreen set', async () => {
    const offscreenItems = Array.from({ length: 120 }, (_, index) =>
      createItem(`offscreen-${index}`, {
        zIndex: index,
        x: 10_000 + index * 120,
        y: 10_000 + index * 120
      })
    )
    const back = createItem('visible-back', { zIndex: 1000, x: 12, y: 16 })
    const front = createItem('visible-front', { zIndex: 1001, x: 72, y: 48 })

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        items={[...offscreenItems, front, back]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
        overscanPx={0}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2))
    expect(context.translate).toHaveBeenNthCalledWith(2, 12, 16)
    expect(context.translate).toHaveBeenNthCalledWith(3, 72, 48)
    const drewOffscreenItem = context.translate.mock.calls.some(
      (call) => call[0] >= 10_000 && call[1] >= 10_000
    )
    expect(drewOffscreenItem).toBe(false)
  })

  it('redraws imperative item previews and viewport changes', async () => {
    const ref = React.createRef<ProjectCanvasCanvas2DFallbackLayerHandle>()
    const item = createItem('preview')

    render(
      <ProjectCanvasCanvas2DFallbackLayer
        ref={ref}
        items={[item]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 320, height: 240 }}
      />
    )

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(1))
    act(() => {
      ref.current?.syncViewport({ x: 50, y: 60 }, 2)
      ref.current?.syncItemPreview('preview', {
        x: 12,
        y: 14,
        width: 50,
        height: 40,
        scaleX: 1,
        scaleY: 1,
        rotation: 45
      })
    })

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledTimes(2))
    expect(context.translate).toHaveBeenCalledWith(50, 60)
    expect(context.translate).toHaveBeenCalledWith(12, 14)
  })
})
