/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isPsdImportFile,
  materializePsdFile,
  PSD_IMPORT_ACCEPT,
  PsdImportLimitExceededError
} from './psdImport'

const { mockParsedPsd } = vi.hoisted(() => ({
  mockParsedPsd: {
    current: null as any
  }
}))

vi.mock('@webtoon/psd', () => ({
  default: {
    parse: vi.fn(() => mockParsedPsd.current)
  }
}))

class MockImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number
  ) {}
}

class MockOffscreenCanvas {
  constructor(
    public width: number,
    public height: number
  ) {}

  getContext(): { putImageData: (imageData: MockImageData, x: number, y: number) => void } {
    return {
      putImageData: () => undefined
    }
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob(['mock-png'], { type: 'image/png' })
  }
}

const originalOffscreenCanvas = globalThis.OffscreenCanvas
const originalImageData = globalThis.ImageData
const originalCreateObjectUrl = URL.createObjectURL

beforeEach(() => {
  globalThis.OffscreenCanvas = MockOffscreenCanvas as any
  globalThis.ImageData = MockImageData as any
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:mock-psd-${blob.size}`)
})

afterEach(() => {
  mockParsedPsd.current = null
  vi.clearAllMocks()

  globalThis.OffscreenCanvas = originalOffscreenCanvas
  globalThis.ImageData = originalImageData
  URL.createObjectURL = originalCreateObjectUrl
})

describe('psdImport', () => {
  it('recognizes direct PSD and PSB intake candidates', () => {
    expect(PSD_IMPORT_ACCEPT).toBe('.psd,.psb')
    expect(isPsdImportFile(new File(['x'], 'mockup.psd'))).toBe(true)
    expect(isPsdImportFile(new File(['x'], 'mockup.psb'))).toBe(true)
    expect(isPsdImportFile(new File(['x'], 'mockup.psd.json'))).toBe(false)
  })

  it('materializes mixed PSD content into canvas items and groups', async () => {
    const imageLayer = {
      type: 'Layer' as const,
      name: 'Hero',
      left: 12,
      top: 24,
      width: 2,
      height: 1,
      isHidden: false,
      isTransparencyLocked: false,
      composite: vi.fn(async () => new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]))
    }

    const textLayer = {
      type: 'Layer' as const,
      name: 'Headline',
      left: 40,
      top: 56,
      width: 180,
      height: 32,
      text: 'Hello PSD',
      isHidden: false,
      isTransparencyLocked: false,
      composite: vi.fn(async () => new Uint8ClampedArray())
    }

    mockParsedPsd.current = {
      type: 'Psd',
      name: 'ROOT',
      width: 400,
      height: 300,
      children: [
        {
          type: 'Group',
          name: 'Artboard 1',
          children: [imageLayer, textLayer]
        }
      ],
      composite: vi.fn(async () => new Uint8ClampedArray())
    }

    const result = await materializePsdFile(
      {
        name: 'landing.psd',
        arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
      },
      {
        importedAt: '2026-04-04T00:00:00.000Z',
        startZIndex: 5
      }
    )

    expect(result.sourceApp).toBe('psd')
    expect(result.title).toBe('landing')
    expect(result.items).toHaveLength(2)
    expect(result.groups).toHaveLength(1)
    expect(result.warnings).toEqual([])

    const [imageItem, textItem] = result.items
    expect(imageItem).toMatchObject({
      type: 'image',
      x: 12,
      y: 24,
      width: 2,
      height: 1,
      zIndex: 5,
      fileName: 'Hero.png',
      provenance: {
        kind: 'psd',
        sourceFileName: 'landing.psd',
        sourceNodeName: 'Hero',
        importedAt: '2026-04-04T00:00:00.000Z'
      }
    })
    expect(imageItem.type === 'image' ? imageItem.src : '').toMatch(/^blob:mock-psd-/)
    expect(imageItem.type === 'image' ? imageItem.src : '').not.toContain('data:image')
    expect(imageItem.type === 'image' ? imageItem.sizeBytes : 0).toBeGreaterThan(0)

    expect(textItem).toMatchObject({
      type: 'text',
      text: 'Hello PSD',
      x: 40,
      y: 56,
      width: 180,
      height: 32,
      zIndex: 6,
      provenance: {
        kind: 'psd',
        sourceFileName: 'landing.psd',
        sourceNodeName: 'Headline',
        importedAt: '2026-04-04T00:00:00.000Z'
      }
    })
    expect(result.groups[0]).toMatchObject({
      name: 'Artboard 1',
      itemIds: [imageItem.id, textItem.id]
    })
  })

  it('rejects PSD files above the explicit file-size guard before parsing', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8))

    await expect(
      materializePsdFile(
        {
          name: 'huge.psd',
          size: 11,
          arrayBuffer
        } as any,
        {
          limits: { maxFileBytes: 10 }
        }
      )
    ).rejects.toMatchObject({
      name: 'PsdImportLimitExceededError',
      limitKind: 'fileSize',
      actual: 11,
      limit: 10
    } satisfies Partial<PsdImportLimitExceededError>)
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects PSD documents above the explicit layer-count guard', async () => {
    mockParsedPsd.current = {
      type: 'Psd',
      name: 'ROOT',
      width: 10,
      height: 10,
      children: [
        {
          type: 'Layer',
          name: 'Layer 1',
          width: 1,
          height: 1,
          composite: vi.fn(async () => new Uint8ClampedArray([255, 255, 255, 255]))
        },
        {
          type: 'Layer',
          name: 'Layer 2',
          width: 1,
          height: 1,
          composite: vi.fn(async () => new Uint8ClampedArray([255, 255, 255, 255]))
        }
      ],
      composite: vi.fn(async () => new Uint8ClampedArray())
    }

    await expect(
      materializePsdFile(
        {
          name: 'too-many-layers.psd',
          arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
        },
        {
          limits: { maxLayerCount: 1 }
        }
      )
    ).rejects.toMatchObject({
      name: 'PsdImportLimitExceededError',
      limitKind: 'layerCount',
      actual: 2,
      limit: 1
    } satisfies Partial<PsdImportLimitExceededError>)
  })

  it('rejects PSD layers above the explicit pixel-count guard without rasterizing them', async () => {
    const composite = vi.fn(async () => new Uint8ClampedArray(100 * 100 * 4))
    mockParsedPsd.current = {
      type: 'Psd',
      name: 'ROOT',
      width: 100,
      height: 100,
      children: [
        {
          type: 'Layer',
          name: 'Oversized',
          width: 100,
          height: 100,
          composite
        }
      ],
      composite: vi.fn(async () => new Uint8ClampedArray())
    }

    await expect(
      materializePsdFile(
        {
          name: 'oversized.psd',
          arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
        },
        {
          limits: { maxPixelCount: 99 }
        }
      )
    ).rejects.toMatchObject({
      name: 'PsdImportLimitExceededError',
      limitKind: 'pixelCount',
      actual: 10000,
      limit: 99
    } satisfies Partial<PsdImportLimitExceededError>)
    expect(composite).not.toHaveBeenCalled()
  })

  it('rejects flattened PSD previews above the explicit pixel-count guard', async () => {
    const composite = vi.fn(async () => new Uint8ClampedArray(100 * 100 * 4))
    mockParsedPsd.current = {
      type: 'Psd',
      name: 'ROOT',
      width: 100,
      height: 100,
      children: [],
      composite
    }

    await expect(
      materializePsdFile(
        {
          name: 'oversized-flat.psd',
          arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
        },
        {
          limits: { maxPixelCount: 99 }
        }
      )
    ).rejects.toMatchObject({
      name: 'PsdImportLimitExceededError',
      limitKind: 'pixelCount',
      actual: 10000,
      limit: 99
    } satisfies Partial<PsdImportLimitExceededError>)
    expect(composite).not.toHaveBeenCalled()
  })

  it('falls back to a flattened preview when no visible child layers can be imported', async () => {
    mockParsedPsd.current = {
      type: 'Psd',
      name: 'ROOT',
      width: 8,
      height: 4,
      children: [
        {
          type: 'Layer',
          name: 'Hidden',
          left: 0,
          top: 0,
          width: 8,
          height: 4,
          isHidden: true,
          composite: vi.fn(async () => new Uint8ClampedArray())
        }
      ],
      composite: vi.fn(
        async () =>
          new Uint8ClampedArray([
            255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
            255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255
          ])
      )
    }

    const result = await materializePsdFile({
      name: 'poster.psb',
      arrayBuffer: vi.fn(async () => new ArrayBuffer(8))
    })

    expect(result.sourceApp).toBe('psb')
    expect(result.items).toHaveLength(1)
    expect(result.groups).toHaveLength(0)
    expect(result.items[0]).toMatchObject({
      type: 'image',
      width: 8,
      height: 4,
      src: 'blob:mock-psd-8',
      provenance: {
        kind: 'psb',
        sourceFileName: 'poster.psb'
      }
    })
    expect(result.warnings).toContain(
      'Imported a flattened PSD preview because no visible layers could be materialized individually.'
    )
  })
})
