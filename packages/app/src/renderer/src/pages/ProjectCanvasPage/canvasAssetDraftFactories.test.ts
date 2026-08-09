import { describe, expect, it } from 'vitest'
import type { MediaReference } from '@shared/mediaReference'
import { createCanvasImageItemDraft } from './canvasAssetDraftFactories'

describe('createCanvasImageItemDraft', () => {
  it('preserves a managed media reference on a new image draft', () => {
    const media: MediaReference = {
      version: 1,
      kind: 'managed',
      relativePath: 'ab/cd/image.png',
      sha256: 'a'.repeat(64),
      sizeBytes: 4,
      mimeType: 'image/png',
      originalFileName: 'image.png'
    }

    const draft = createCanvasImageItemDraft({
      id: 'image-1',
      src: 'local-media:///managed/ab/cd/image.png',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      zIndex: 1,
      media
    })

    expect(draft.media).toBe(media)
  })
})
