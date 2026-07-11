import { describe, expect, it } from 'vitest'
import { markCanvasImagePlaceholderAsset } from './canvasImageAssetUtils'
import {
  PROJECT_CANVAS_IMAGE_LOD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE,
  resolveCanvasImageLodDecision
} from './canvasImageLodPolicy'
import type { CanvasImageItem } from './types'

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
    src: 'file:///image-1.png',
    x: 0,
    y: 0,
    width: 4096,
    height: 4096,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    image: createImage(512, 512),
    sourceWidth: 4096,
    sourceHeight: 4096,
    ...overrides
  }
}

describe('resolveCanvasImageLodDecision', () => {
  it('suppresses source textures globally at overview zoom even for selected images', () => {
    const item = createItem()
    const decision = resolveCanvasImageLodDecision({
      item,
      image: item.image,
      stageScale: PROJECT_CANVAS_IMAGE_LOD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE,
      selectedIds: new Set([item.id]),
      forceSource: true,
      isVisible: true
    })

    expect(decision.isOverviewScale).toBe(true)
    expect(decision.shouldUseSourceTexture).toBe(false)
    expect(decision.sourceTextureSuppressed).toBe(true)
    expect(decision.sourceTextureSuppressionReason).toBe('overview-scale')
    expect(decision.usesThumbnailPreview).toBe(true)
  })

  it('allows forced source texture for selected high-zoom images even when preview/source gain is small', () => {
    const image = createImage(1536, 1536)
    const item = createItem({ image, sourceWidth: 1536, sourceHeight: 1536 })
    const decision = resolveCanvasImageLodDecision({
      item,
      image,
      stageScale: 64,
      selectedIds: new Set([item.id]),
      forceSource: true,
      isVisible: true
    })

    expect(decision.sourceTextureSuppressionReason).toBeNull()
    expect(decision.usesThumbnailPreview).toBe(true)
    expect(decision.sourceTextureNeeded).toBe(true)
    expect(decision.shouldUseSourceTexture).toBe(true)
  })

  it('allows source texture only when high zoom makes the projected preview too small', () => {
    const item = createItem({ image: createImage(1024, 1024) })

    expect(
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale: 0.2,
        isVisible: true,
        deviceScale: 1
      }).shouldUseSourceTexture
    ).toBe(false)

    expect(
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale: 1,
        isVisible: true,
        deviceScale: 1
      }).shouldUseSourceTexture
    ).toBe(true)
  })

  it('counts device pixels when deciding whether a preview covers the viewport', () => {
    const item = createItem({ image: createImage(1024, 1024) })

    expect(
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale: 0.5,
        isVisible: true,
        deviceScale: 1
      }).shouldUseSourceTexture
    ).toBe(false)

    expect(
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale: 0.5,
        isVisible: true,
        deviceScale: 2
      }).shouldUseSourceTexture
    ).toBe(true)
  })

  it('requires visibility and resident texture budget before allowing source upgrades', () => {
    const item = createItem()

    expect(
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale: 1,
        isVisible: false
      }).sourceTextureSuppressionReason
    ).toBe('not-visible')

    expect(
      resolveCanvasImageLodDecision({
        item,
        image: item.image,
        stageScale: 1,
        isVisible: true,
        sourceTextureByteSize: 128,
        residentTextureBytes: 1024,
        existingTextureBytes: 0,
        residentTextureBudgetBytes: 1024
      }).sourceTextureSuppressionReason
    ).toBe('texture-budget')
  })

  it('reports placeholder and thumbnail preview roles separately', () => {
    const placeholder = markCanvasImagePlaceholderAsset(createImage(512, 512))
    const decision = resolveCanvasImageLodDecision({
      item: createItem({ image: placeholder }),
      image: placeholder,
      stageScale: 0.05,
      isVisible: true
    })

    expect(decision.usesPlaceholderPreview).toBe(true)
    expect(decision.usesThumbnailPreview).toBe(false)
  })
})
