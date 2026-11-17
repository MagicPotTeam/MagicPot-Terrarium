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

  it('keeps the source-gain test for a selected image whose preview covers the displayed size', () => {
    // 1184 px source, 1024 px preview (gain 1.16 < 1.25), shown at 512 device px.
    const image = createImage(1024, 1024)
    const item = createItem({
      image,
      width: 512,
      height: 512,
      sourceWidth: 1184,
      sourceHeight: 1184
    })
    const decide = (stageScale: number, deviceScale = 1) =>
      resolveCanvasImageLodDecision({
        item,
        image,
        stageScale,
        selectedIds: new Set([item.id]),
        forceSource: true,
        isVisible: true,
        deviceScale
      })

    const covered = decide(1)
    expect(covered.projectedMaxSide).toBe(512)
    expect(covered.shouldUseSourceTexture).toBe(false)
    expect(covered.sourceTextureNeeded).toBe(false)
    expect(covered.sourceTextureSuppressionReason).toBe('insufficient-source-gain')

    // Exactly covered (1024 device px) still keeps the preview.
    expect(decide(2).projectedMaxSide).toBe(1024)
    expect(decide(2).shouldUseSourceTexture).toBe(false)
    // A 2x screen at 1.5x zoom needs 1536 device px: the source is used.
    const hiDpi = decide(1.5, 2)
    expect(hiDpi.projectedMaxSide).toBe(1536)
    expect(hiDpi.shouldUseSourceTexture).toBe(true)
    // Zoomed in past the preview size: the forced upgrade still applies.
    expect(decide(4).shouldUseSourceTexture).toBe(true)
  })

  it('keeps a loaded low-gain source of a selected image until the displayed size is clearly under the preview', () => {
    // 1184 px source over a 1024 px preview: upgraded above 1024 device px, kept down to 0.9x.
    const image = createImage(1024, 1024)
    const item = createItem({
      image,
      width: 512,
      height: 512,
      sourceWidth: 1184,
      sourceHeight: 1184
    })
    const decide = (stageScale: number, sourceTextureResident?: boolean) =>
      resolveCanvasImageLodDecision({
        item,
        image,
        stageScale,
        selectedIds: new Set([item.id]),
        forceSource: true,
        isVisible: true,
        deviceScale: 1,
        sourceTextureResident
      })

    // Not loaded yet: only a size over the preview loads it.
    expect(decide(1.9).shouldUseSourceTexture).toBe(false)
    expect(decide(2.1).shouldUseSourceTexture).toBe(true)
    // Loaded: zooming back to the preview size or just under it keeps it.
    expect(decide(2, true).shouldUseSourceTexture).toBe(true)
    expect(decide(1.9, true).projectedMaxSide).toBeCloseTo(972.8)
    expect(decide(1.9, true).shouldUseSourceTexture).toBe(true)
    // Clearly under the preview (0.9x = 921.6 device px): dropped.
    expect(decide(1.75, true).projectedMaxSide).toBe(896)
    expect(decide(1.75, true).shouldUseSourceTexture).toBe(false)
  })

  it('still forces a selected source with enough gain while the preview covers the displayed size', () => {
    const image = createImage(512, 512)
    const item = createItem({
      image,
      width: 400,
      height: 400,
      sourceWidth: 4096,
      sourceHeight: 4096
    })
    const decision = resolveCanvasImageLodDecision({
      item,
      image,
      stageScale: 1,
      selectedIds: new Set([item.id]),
      forceSource: true,
      isVisible: true,
      deviceScale: 1
    })
    expect(decision.projectedMaxSide).toBeLessThanOrEqual(decision.previewMaxSide)
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
