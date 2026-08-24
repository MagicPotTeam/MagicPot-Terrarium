import { describe, expect, it, vi } from 'vitest'

import {
  EXPORT_IMAGE_MAX_AREA,
  EXPORT_IMAGE_MAX_SIDE,
  resolveCanvasExportRasterConfig
} from './canvasExportRasterUtils'
import { AGENT_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import { getCanvasItemBounds, resolveDroppedAgentImageDataUrl } from './projectCanvasPageShared'

describe('resolveCanvasExportRasterConfig', () => {
  it('keeps regular exports at the requested raster size', () => {
    expect(resolveCanvasExportRasterConfig(1200, 800)).toEqual({
      pixelRatio: 1,
      canvasWidth: 1200,
      canvasHeight: 800,
      wasClamped: false
    })
  })

  it('downscales oversized selections before they exceed the canvas side limit', () => {
    const config = resolveCanvasExportRasterConfig(26929, 11355)

    expect(config.wasClamped).toBe(true)
    expect(config.canvasWidth).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_SIDE)
    expect(config.canvasHeight).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_SIDE)
    expect(config.canvasWidth / config.canvasHeight).toBeCloseTo(26929 / 11355, 2)
  })

  it('downscales large square exports to stay within the total pixel budget', () => {
    const config = resolveCanvasExportRasterConfig(16384, 16384)

    expect(config.wasClamped).toBe(true)
    expect(config.canvasWidth * config.canvasHeight).toBeLessThanOrEqual(EXPORT_IMAGE_MAX_AREA)
  })
})

describe('getCanvasItemBounds', () => {
  it('expands rotated rect items into a rotation-aware AABB', () => {
    expect(
      getCanvasItemBounds({
        id: 'image-rotated',
        type: 'image',
        src: 'file:///image.png',
        fileName: 'image.png',
        x: 100,
        y: 200,
        width: 80,
        height: 40,
        rotation: 90,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false
      })
    ).toEqual({
      minX: 60,
      minY: 200,
      maxX: 100,
      maxY: 280
    })
  })

  it('applies scale and rotation to annotation line bounds', () => {
    const bounds = getCanvasItemBounds({
      id: 'annotation-line',
      type: 'annotation',
      shape: 'line',
      stroke: '#ffffff',
      fillOpacity: 0,
      strokeWidth: 2,
      label: 'Line',
      x: 120,
      y: 160,
      endX: 200,
      endY: 160,
      width: 80,
      height: 1,
      rotation: 90,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false
    })

    expect(bounds.minX).toBeCloseTo(120, 5)
    expect(bounds.maxX).toBeCloseTo(120, 5)
    expect(bounds.minY).toBeCloseTo(160, 5)
    expect(bounds.maxY).toBeCloseTo(240, 5)
  })
})

describe('resolveDroppedAgentImageDataUrl', () => {
  it('keeps remote agent image URLs on the remote loading path', async () => {
    const dataTransfer = {
      files: [],
      getData: (type: string) =>
        type === AGENT_IMAGE_DRAG_MIME ? 'https://cdn.example.com/output/generated.png' : ''
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>

    await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
      src: 'https://cdn.example.com/output/generated.png',
      fileName: 'generated.png'
    })
  })

  it('falls back to a validated remote agent URL when a synthetic file cannot be authorized', async () => {
    const placeholderFile = new File([], 'generated.png', { type: 'image/png' })
    const dataTransfer = {
      files: [placeholderFile],
      getData: (type: string) =>
        type === AGENT_IMAGE_DRAG_MIME ? 'https://cdn.example.com/output/generated.png' : ''
    } as unknown as Pick<DataTransfer, 'getData' | 'files'>

    await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
      src: 'https://cdn.example.com/output/generated.png',
      fileName: 'generated.png',
      sizeBytes: undefined,
      sourceWidthHint: undefined,
      sourceHeightHint: undefined
    })
  })

  it('keeps the complete route-bearing FileItem when a matching dropped file is authorized', async () => {
    const sourceFile = new File(['generated'], 'generated.png', { type: 'image/png' })
    const routeBearingFileItem = {
      filename: 'generated.png',
      subfolder: 'immutable',
      type: 'output' as const,
      instanceId: 'remote-file',
      instanceRouteId: 'route-file-opaque',
      instanceOrigin: 'https://captured-file.example/',
      instanceKind: 'remote' as const
    }
    const originalCreateObjectURL = URL.createObjectURL
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:authorized-generated-file')
    })
    try {
      const dataTransfer = {
        files: [sourceFile],
        getData: (type: string) =>
          type === 'application/x-qapp-image'
            ? JSON.stringify({
                objectUrl: 'blob:quickapp-result',
                fileItem: routeBearingFileItem,
                sourceWidth: 512,
                sourceHeight: 384
              })
            : ''
      } as unknown as Pick<DataTransfer, 'getData' | 'files'>

      await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
        src: 'blob:quickapp-result',
        fileName: 'generated.png',
        fileItem: routeBearingFileItem,
        sizeBytes: sourceFile.size,
        sourceWidthHint: 512,
        sourceHeightHint: 384,
        sourceFile
      })
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL
      })
    }
  })

  it('prefers the internal quick-app image payload over placeholder files', async () => {
    const placeholderFile = new File(['x'], 'placeholder.png', { type: 'image/png' })
    const createObjectURL = vi.fn(() => 'blob:placeholder-file')
    const originalCreateObjectURL = URL.createObjectURL
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL
    })

    try {
      const dataTransfer = {
        files: [placeholderFile],
        getData: (type: string) =>
          type === 'application/x-qapp-image'
            ? JSON.stringify({
                objectUrl: 'blob:real-generated-image',
                fileItem: {
                  filename: 'generated.png',
                  instanceRouteId: '11111111-1111-4111-8111-111111111111',
                  instanceId: 'remote-a',
                  instanceOrigin: 'https://comfy.example/',
                  instanceKind: 'remote'
                },
                sourceWidth: 1024,
                sourceHeight: 768
              })
            : ''
      } as unknown as Pick<DataTransfer, 'getData' | 'files'>

      await expect(resolveDroppedAgentImageDataUrl(dataTransfer)).resolves.toEqual({
        src: 'blob:real-generated-image',
        fileName: 'generated.png',
        fileItem: {
          filename: 'generated.png',
          instanceRouteId: '11111111-1111-4111-8111-111111111111',
          instanceId: 'remote-a',
          instanceOrigin: 'https://comfy.example/',
          instanceKind: 'remote'
        },
        sizeBytes: undefined,
        sourceWidthHint: 1024,
        sourceHeightHint: 768
      })
      expect(createObjectURL).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL
      })
    }
  })
})
