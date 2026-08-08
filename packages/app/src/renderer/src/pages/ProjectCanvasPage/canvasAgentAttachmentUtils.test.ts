import { describe, expect, it } from 'vitest'

import {
  buildCanvasAgentAttachments,
  buildCanvasImageAttachment,
  buildCanvasImageCropSourceMetadata
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
