import { describe, expect, it, vi } from 'vitest'

import {
  buildCanvasAgentAttachments,
  buildCanvasImageAttachment,
  buildCanvasImageCropSourceMetadata,
  materializeCanvasAgentAttachmentItems
} from './canvasAgentAttachmentUtils'
import type { CanvasImageItem, CanvasModel3DItem } from './types'

function imageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'source-image',
    type: 'image',
    src: 'local-media:///original/full-frame.png',
    fileName: 'full-frame.png',
    sourceFile: new Blob(['original-bytes'], { type: 'image/png' }),
    sourceWidth: 4000,
    sourceHeight: 3000,
    width: 400,
    height: 300,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    x: 0,
    y: 0,
    zIndex: 1,
    locked: false,
    thumbnailSet: {
      version: 1,
      cacheKey: 'tile-cache-key',
      sourceIdentity: {
        version: 1,
        kind: 'session-blob',
        sourceKey: 'tile-source',
        sizeBytes: 12,
        mimeType: 'image/png',
        cacheKey: 'tile-identity'
      },
      createdAt: '0',
      updatedAt: '0',
      levels: [
        {
          maxSide: 256,
          src: 'local-media:///cache/tile-256.webp',
          filename: 'tile-256.webp',
          mimeType: 'image/webp',
          width: 256,
          height: 192,
          sizeBytes: 1024
        }
      ]
    },
    ...overrides
  }
}

function modelItem(): CanvasModel3DItem {
  return {
    id: 'model-source',
    type: 'model3d',
    src: 'local-media:///original/model.glb',
    fileName: 'model.glb',
    sourceFile: new Blob(['original-model'], { type: 'model/gltf-binary' }),
    width: 320,
    height: 240,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    x: 0,
    y: 0
  }
}

describe('canvas agent crop fallback on a synthetic source', () => {
  const original = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAACaUlEQVR42u3TMQ0AAAjAsPk3DTYI6TEHa9XoTqNTZUpABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAgQQYwIiQAARIIAIEEAECCACRIAAIkAAESCACBBABIgAAUSAACJAABEggAgQmRIQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAECCACBBABAogAAUSACBBABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABIkAAESCACBBABAggAkSAACJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAEiAABRIAAIkAAESCACBABAogAAUSAACJAABEggJgSEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAABxJiACBBABAggAgQQAQKIABEggAgQQAQIIAIEEAEiQAARIIAIEEAECCACRKYERIAAIkAAESCACBBABIgAAUSAACJAABEggAgQAQKIAAFEgAAiQAARIAIEEAECiAABRIAAIkAAESACBBABAogAAUSAACJABAggAgQQAQKIAAFEgAgQQAQIIAIEEAECiAARIIAIEEAECCACBBABAogAESCACBBABAggAgQQASJAABEggAgQQAQIIAJEgAAiQAARIIAIEEAECCCmBESAACJAABEggAgQQASIAAFEgAAiQAARIIAIEAECiAABRIAAIkAAESACBBABAogAAUSAACJAADEmIAIEEAECiAABRIAAIkAECCACBBAB8rEFA6mDSMjZmAIAAAAASUVORK5CYII='
  const makeItem = (crop: CanvasImageItem['crop'], known = false) => imageItem({
    src: original, sourceFile: undefined, sourceWidth: known ? 200 : undefined,
    sourceHeight: known ? 200 : undefined, image: undefined, width: 100, height: 100,
    thumbnailSet: undefined, crop
  })
  const crop = { x: 0, y: 0, width: 100, height: 100 }
  it('keeps the original for an uncropped source', async () => {
    const result = await materializeCanvasAgentAttachmentItems([makeItem(undefined)])
    expect(buildCanvasAgentAttachments(result)[0]?.url).toBe(original)
  })
  it('exports a known 200x200 source crop using synthetic canvas drawing', async () => {
    const draw = vi.fn()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,c3ludGhldGljLWNyb3A=')
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    })
    try {
      const result = await materializeCanvasAgentAttachmentItems([makeItem(crop, true)])
      expect(buildCanvasAgentAttachments(result)[0]?.url).toBe('data:image/png;base64,c3ludGhldGljLWNyb3A=')
      expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100, 0, 0, 100, 100)
    } finally { getContext.mockRestore(); toDataURL.mockRestore(); vi.unstubAllGlobals() }
  })
  it('does not treat stale thumbnail dimensions as a full original crop (async)', async () => {
    // No real decoder or pixel identity is exercised: Image and drawing are synthetic.
    const thumbnail = { width: 100, height: 100 } as unknown as CanvasImageItem['image']
    const item = imageItem({
      src: original, sourceFile: undefined, sourceWidth: 100, sourceHeight: 100,
      image: thumbnail, width: 100, height: 100, thumbnailSet: undefined,
      crop: { x: 0, y: 0, width: 100, height: 100 }
    })
    const cropped = 'data:image/png;base64,c3ludGhldGljLWNyb3A='
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(cropped)
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    })
    try {
      let result: Awaited<ReturnType<typeof materializeCanvasAgentAttachmentItems>> | undefined
      let failure: unknown
      try {
        result = await materializeCanvasAgentAttachmentItems([item])
      } catch (error) { failure = error }
      if (failure !== undefined) {
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toBe('CANVAS_CROP_EXPORT_UNAVAILABLE')
      } else if (result?.length === 0) {
        // The bridge treats a filtered crop as a whole-selection failure.
        expect(buildCanvasAgentAttachments(result)).toEqual([])
      } else {
        expect(result).toHaveLength(1)
        expect(buildCanvasAgentAttachments(result!)[0]?.url).toBe(cropped)
        expect(buildCanvasAgentAttachments(result!)[0]?.url).not.toBe(original)
      }
    } finally { getContext.mockRestore(); toDataURL.mockRestore(); vi.unstubAllGlobals() }
  })
  it('must not return the full source when dimensions are absent and crop export fails', async () => {
    const item = makeItem(crop)
    expect(buildCanvasImageCropSourceMetadata(item)).toBeNull()
    vi.stubGlobal('Image', class {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    })
    try {
      const result = await materializeCanvasAgentAttachmentItems([item])
      expect(buildCanvasAgentAttachments(result).some((attachment) => attachment.url === original)).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('canvas agent attachments preserve original sources', () => {
  it('uses the original image src, not a thumbnail tile, for agent attachments', () => {
    const item = imageItem()

    expect(buildCanvasImageAttachment(item).url).toBe('local-media:///original/full-frame.png')
    expect(buildCanvasAgentAttachments([item])[0]?.url).toBe(
      'local-media:///original/full-frame.png'
    )
  })

  it('uses the original image src in crop metadata while preserving the source blob', async () => {
    const item = imageItem({ crop: { x: 100, y: 200, width: 1200, height: 900 } })

    expect(buildCanvasImageCropSourceMetadata(item)).toMatchObject({
      url: 'local-media:///original/full-frame.png',
      sourceWidth: 4000,
      sourceHeight: 3000,
      crop: { x: 100, y: 200, width: 1200, height: 900 }
    })

    expect(item.sourceFile).toBeInstanceOf(Blob)
    expect(item.sourceFile).toBeDefined()
  })

  it('uses the original 3D model src rather than a preview texture', () => {
    const item = modelItem()
    const attachment = buildCanvasAgentAttachments([item])[0]

    expect(attachment).toMatchObject({
      type: 'model3d',
      url: 'local-media:///original/model.glb',
      fileName: 'model.glb'
    })
  })
})
