import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CanvasImageDomPreview, {
  CANVAS_IMAGE_DOM_PREVIEW_MAX_BACKING_SIDE
} from './CanvasImageDomPreview'
import type { CanvasImageItem } from '../types'

const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalDevicePixelRatio = window.devicePixelRatio
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalApi = window.api

function createImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'local-media:///C:/real-board/huge.png',
    x: 0,
    y: 0,
    width: 19_717,
    height: 12_079,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    image: createImage(512, 314),
    sourceWidth: 19_717,
    sourceHeight: 12_079,
    ...overrides
  }
}

function mockCanvas2DContext() {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low'
  }

  HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
    contextId === '2d'
      ? (context as unknown as CanvasRenderingContext2D)
      : null) as typeof HTMLCanvasElement.prototype.getContext

  return context
}

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: originalApi
  })
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: originalDevicePixelRatio
  })
  vi.restoreAllMocks()
})

describe('CanvasImageDomPreview', () => {
  it('does not show an unloaded source image before a decoded asset is available', () => {
    render(
      <CanvasImageDomPreview
        item={createItem({ image: undefined as unknown as CanvasImageItem['image'] })}
        previewMode="fallback-image-proxy"
      />
    )

    expect(document.querySelector('canvas')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('bounds backing canvas size for huge source-sized fallback previews', () => {
    const context = mockCanvas2DContext()
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 4
    })

    render(<CanvasImageDomPreview item={createItem()} previewMode="fallback-image-proxy" />)

    const canvas = document.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.width).toBe(CANVAS_IMAGE_DOM_PREVIEW_MAX_BACKING_SIDE)
    expect(canvas?.height ?? 0).toBeGreaterThan(1)
    expect(canvas?.height ?? 0).toBeLessThan(CANVAS_IMAGE_DOM_PREVIEW_MAX_BACKING_SIDE)
    expect(context.setTransform).toHaveBeenCalledWith(
      CANVAS_IMAGE_DOM_PREVIEW_MAX_BACKING_SIDE / 19_717,
      0,
      0,
      expect.any(Number),
      0,
      0
    )
    expect(context.drawImage).toHaveBeenCalled()
  })

  it('does not render the source image fallback at overview zoom when canvas drawing fails', () => {
    const context = mockCanvas2DContext()
    context.drawImage.mockImplementation(() => {
      throw new Error('draw failed')
    })

    render(
      <CanvasImageDomPreview
        item={createItem()}
        previewMode="fallback-image-proxy"
        stageScale={0.05}
      />
    )

    expect(document.querySelector('canvas')).not.toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('allows the source image fallback at high zoom when the shared LOD policy needs it', () => {
    const context = mockCanvas2DContext()
    context.drawImage.mockImplementation(() => {
      throw new Error('draw failed')
    })

    render(
      <CanvasImageDomPreview
        item={createItem()}
        previewMode="fallback-image-proxy"
        stageScale={1}
      />
    )

    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'local-media:///C:/real-board/huge.png'
    )
  })

  it('can render the original source image directly for high-resolution overlays', () => {
    const context = mockCanvas2DContext()

    render(
      <CanvasImageDomPreview
        item={createItem()}
        previewMode="high-res-source"
        sourceImagePreview
        stageScale={1}
      />
    )

    expect(document.querySelector('canvas')).toBeNull()
    expect(context.drawImage).not.toHaveBeenCalled()
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'local-media:///C:/real-board/huge.png'
    )
    expect(document.querySelector('img')).toHaveAttribute(
      'data-canvas-source-image-preview',
      'true'
    )
  })

  it('materializes local source previews through svcFs before rendering the image', async () => {
    const readImageFromPath = vi.fn(async () => ({
      image: new Uint8Array([1, 2, 3, 4]),
      filename: 'huge.png'
    }))
    const createObjectUrl = vi.fn(() => 'blob:materialized-preview')
    const revokeObjectUrl = vi.fn()
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcFs: {
          readImageFromPath
        }
      }
    })

    const { unmount } = render(
      <CanvasImageDomPreview
        item={createItem({ image: undefined as unknown as CanvasImageItem['image'] })}
        previewMode="high-res-source"
        sourceImagePreview
        stageScale={1}
      />
    )

    expect(document.querySelector('img')).toBeNull()
    await waitFor(() => {
      expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:materialized-preview')
    })
    expect(readImageFromPath).toHaveBeenCalledWith({ fullPath: 'C:/real-board/huge.png' })

    unmount()

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:materialized-preview')
  })

  it('keeps original source previews smoothly sampled at extreme zoom', () => {
    mockCanvas2DContext()

    render(
      <CanvasImageDomPreview
        item={createItem()}
        previewMode="high-res-source"
        sourceImagePreview
        stageScale={8}
      />
    )

    expect(document.querySelector('img')).toHaveStyle({ imageRendering: 'auto' })
  })
})
