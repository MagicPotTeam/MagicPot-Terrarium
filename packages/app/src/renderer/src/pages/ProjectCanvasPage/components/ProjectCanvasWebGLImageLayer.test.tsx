import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageSourceIdentity, CanvasImageThumbnailSet } from '../canvasThumbnailTypes'

type CanvasImageItem = {
  id: string
  type: 'image'
  src: string
  fileName: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
  image: HTMLImageElement
  sourceWidth?: number
  sourceHeight?: number
  sourceIdentity?: CanvasImageSourceIdentity
  thumbnailSet?: CanvasImageThumbnailSet
  crop?: {
    x: number
    y: number
    width: number
    height: number
  }
}

type ProjectCanvasWebGLImageLayerHandle = {
  syncItemPreview: (
    itemId: string,
    preview: {
      x: number
      y: number
      width: number
      height: number
      scaleX: number
      scaleY: number
      rotation: number
    } | null
  ) => void
  syncViewport: (pos: { x: number; y: number }, scale: number) => void
  setViewportInteracting: (active: boolean) => void
}

type ProjectCanvasWebGLImageLayerMetrics = {
  isInitialized: boolean
  imageCount: number
  loadedImageCount: number
  failedImageCount: number
  residentImageCount: number
  residentTextureBytes: number
  residentCandidateTextureBytes: number
  residentTextureBudgetBytes: number
  pendingImageCount: number
  spriteCount: number
  residentCandidateImageCount: number
  viewportCulledImageCount: number
  usingPreviewImageCount: number
  usingSourceImageCount: number
  thumbnailPreviewImageCount: number
  placeholderImageCount: number
  sourceUpgradeSuppressedImageCount: number
  sourceUpgradeablePreviewImageCount: number
  sourceUpgradePendingImageCount: number
  sourceUpgradeFailedImageCount: number
  missingImageCount: number
  renderCount: number
  lastRenderDurationMs: number | null
  lastUpdateReason: 'initialize' | 'items' | 'preview' | 'cleanup'
}

type MockPoint = {
  x: number
  y: number
  set: (x: number, y?: number) => void
}

type MockTextureInstance = {
  source: unknown
  frame?: { x: number; y: number; width: number; height: number }
  width: number
  height: number
  destroyed: boolean
  destroySourceCalled: boolean
  destroy: (destroySource?: boolean) => void
}

type MockSpriteInstance = {
  texture: MockTextureInstance
  position: MockPoint
  scale: MockPoint
  rotation: number
  zIndex: number
  label: string
  destroyed: boolean
  parent: MockContainerInstance | null
  removeFromParent: () => void
  destroy: () => void
}

type MockContainerInstance = {
  children: MockSpriteInstance[]
  sortableChildren: boolean
  position: MockPoint
  scale: MockPoint
  addChild: (child: MockSpriteInstance) => void
  sortChildren: () => void
}

type MockApplicationInstance = {
  stage: MockContainerInstance
  canvas: HTMLCanvasElement
  renderer: { resize: ReturnType<typeof vi.fn> }
  render: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  initOptions?: Record<string, unknown>
}

let createdSprites: MockSpriteInstance[] = []
let createdApplications: MockApplicationInstance[] = []
let textureFromThrowForNaturalWidth: number | null = null
let textureFromWidths: number[] = []
let textureScaleModeReadCount = 0
let textureScaleModeWriteCount = 0
const originalDevicePixelRatio = window.devicePixelRatio

function setWindowDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value
  })
}

function installPixiMock() {
  vi.doMock('pixi.js', () => {
    const createPoint = (initialX = 0, initialY = 0): MockPoint => ({
      x: initialX,
      y: initialY,
      set(x: number, y = x) {
        this.x = x
        this.y = y
      }
    })

    class MockRectangle {
      constructor(
        public x: number,
        public y: number,
        public width: number,
        public height: number
      ) {}
    }

    class MockTexture implements MockTextureInstance {
      source: unknown
      frame?: { x: number; y: number; width: number; height: number }
      width: number
      height: number
      destroyed = false
      destroySourceCalled = false

      constructor({
        source,
        frame
      }: {
        source: unknown
        frame?: { x: number; y: number; width: number; height: number }
      }) {
        this.source = source
        this.frame = frame
        this.width =
          frame?.width ??
          ((source as { image?: HTMLImageElement })?.image?.naturalWidth ||
            (source as { image?: HTMLImageElement })?.image?.width ||
            1)
        this.height =
          frame?.height ??
          ((source as { image?: HTMLImageElement })?.image?.naturalHeight ||
            (source as { image?: HTMLImageElement })?.image?.height ||
            1)
      }

      destroy(destroySource?: boolean) {
        this.destroyed = true
        this.destroySourceCalled = Boolean(destroySource)
      }

      static from(image: HTMLImageElement) {
        const textureWidth = image.naturalWidth || image.width || 1
        textureFromWidths.push(textureWidth)
        if (textureFromThrowForNaturalWidth === textureWidth) {
          throw new Error(`Texture creation failed for ${textureWidth}px image`)
        }

        let scaleMode: 'nearest' | 'linear' = 'linear'
        const source = {
          destroyed: false,
          unload: vi.fn(),
          image,
          get scaleMode() {
            textureScaleModeReadCount += 1
            return scaleMode
          },
          set scaleMode(value: 'nearest' | 'linear') {
            textureScaleModeWriteCount += 1
            scaleMode = value
          }
        }

        return new MockTexture({
          source,
          frame: {
            x: 0,
            y: 0,
            width: textureWidth,
            height: image.naturalHeight || image.height || 1
          }
        })
      }
    }

    class MockSprite implements MockSpriteInstance {
      position = createPoint()
      scale = createPoint(1, 1)
      rotation = 0
      zIndex = 0
      label = ''
      destroyed = false
      parent: MockContainerInstance | null = null

      constructor(public texture: MockTextureInstance) {
        createdSprites.push(this)
      }

      removeFromParent() {
        if (!this.parent) {
          return
        }

        this.parent.children = this.parent.children.filter((child) => child !== this)
        this.parent = null
      }

      destroy() {
        this.destroyed = true
      }
    }

    class MockContainer implements MockContainerInstance {
      children: MockSpriteInstance[] = []
      sortableChildren = false
      position = createPoint()
      scale = createPoint(1, 1)

      addChild(child: MockSpriteInstance) {
        this.children.push(child)
        child.parent = this
      }

      sortChildren() {
        this.children.sort((left, right) => left.zIndex - right.zIndex)
      }
    }

    class MockApplication implements MockApplicationInstance {
      stage = new MockContainer()
      canvas = document.createElement('canvas')
      renderer = {
        resize: vi.fn((width: number, height: number) => {
          this.canvas.width = width
          this.canvas.height = height
        })
      }
      render = vi.fn()
      destroy = vi.fn()
      initOptions?: Record<string, unknown>

      constructor() {
        createdApplications.push(this)
      }

      async init(options?: Record<string, unknown>) {
        this.initOptions = options
        return
      }
    }

    return {
      Application: MockApplication,
      Container: MockContainer,
      Rectangle: MockRectangle,
      Sprite: MockSprite,
      Texture: MockTexture
    }
  })
}

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
    fileName: 'image-1.png',
    x: 24,
    y: 36,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    image: createImage(100, 60),
    ...overrides
  }
}

function createItems(count: number): CanvasImageItem[] {
  return Array.from({ length: count }, (_, index) =>
    createItem({
      id: `image-${index + 1}`,
      src: `file:///image-${index + 1}.png`,
      fileName: `image-${index + 1}.png`,
      x: (index % 12) * 24,
      y: Math.floor(index / 12) * 24,
      zIndex: index
    })
  )
}

function createThumbnailSetFixture(
  cacheKey = 'canvas-thumbnail-lod-test',
  options: { square?: boolean } = {}
) {
  const sourceIdentity: CanvasImageSourceIdentity = {
    kind: 'local-file',
    canonicalPath: 'C:/images/thumb-lod.png',
    sizeBytes: 123456,
    lastModifiedMs: 456789,
    cacheKey
  }
  const thumbnailSet: CanvasImageThumbnailSet = {
    version: 1,
    cacheKey,
    sourceIdentity,
    levels: ([128, 256, 512, 1024, 2048] as const).map((maxSide) => ({
      maxSide,
      src: `local-media:///thumb-lod/${maxSide}.webp`,
      filename: `${maxSide}.webp`,
      mimeType: 'image/webp',
      width: maxSide,
      height: options.square ? maxSide : Math.round(maxSide / 2),
      sizeBytes: maxSide * 8
    })),
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }

  return { sourceIdentity, thumbnailSet }
}

function getLiveSpriteByLabel(label: string) {
  return createdSprites.find((sprite) => sprite.label === label && !sprite.destroyed) ?? null
}

describe('ProjectCanvasWebGLImageLayer', () => {
  beforeEach(() => {
    vi.resetModules()
    createdSprites = []
    createdApplications = []
    textureFromThrowForNaturalWidth = null
    textureFromWidths = []
    textureScaleModeReadCount = 0
    textureScaleModeWriteCount = 0
    setWindowDevicePixelRatio(originalDevicePixelRatio)
    installPixiMock()
  })

  it('resizes the Pixi renderer when the stage size changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 640, height: 480 }}
      />
    )

    await waitFor(
      () => {
        expect(createdApplications).toHaveLength(1)
        expect(createdApplications[0].renderer.resize).toHaveBeenCalledWith(640, 480)
      },
      { timeout: 15000 }
    )

    const app = createdApplications[0]
    expect(app.canvas.width).toBe(640)
    expect(app.canvas.height).toBe(480)

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1180, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(app.renderer.resize).toHaveBeenLastCalledWith(1180, 720)
      },
      { timeout: 15000 }
    )

    expect(app.canvas.width).toBe(1180)
    expect(app.canvas.height).toBe(720)
  }, 30000)

  it('does not rescan resident texture sampling on every viewport sync', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={createItems(3)}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(3)
      },
      { timeout: 15000 }
    )

    const readsAfterInitialRender = textureScaleModeReadCount
    const writesAfterInitialRender = textureScaleModeWriteCount

    act(() => {
      ref.current?.syncViewport({ x: 12, y: 18 }, 1.1)
      ref.current?.syncViewport({ x: 24, y: 36 }, 1.2)
    })

    expect(textureScaleModeReadCount).toBe(readsAfterInitialRender)
    expect(textureScaleModeWriteCount).toBe(writesAfterInitialRender)

    act(() => {
      ref.current?.syncViewport({ x: 48, y: 72 }, 5)
    })

    expect(textureScaleModeReadCount).toBe(readsAfterInitialRender)
    expect(textureScaleModeWriteCount).toBe(writesAfterInitialRender)
  }, 30000)

  it('restores the canonical item transform when preview state is cleared', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(createdApplications).toHaveLength(1)
        expect(createdSprites).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    const app = createdApplications[0]
    const sprite = createdSprites[0]

    expect(sprite.position.x).toBe(24)
    expect(sprite.position.y).toBe(36)
    expect(sprite.scale.x).toBe(2)
    expect(sprite.scale.y).toBe(2)

    const renderCountBeforePreview = app.render.mock.calls.length
    act(() => {
      ref.current?.syncItemPreview('image-1', {
        x: 80,
        y: 90,
        width: 200,
        height: 120,
        scaleX: 1.5,
        scaleY: 0.5,
        rotation: 15
      })
    })

    expect(sprite.position.x).toBe(80)
    expect(sprite.position.y).toBe(90)
    expect(sprite.scale.x).toBe(3)
    expect(sprite.scale.y).toBe(1)
    expect(sprite.rotation).toBeCloseTo(Math.PI / 12)
    expect(app.render).toHaveBeenCalledTimes(renderCountBeforePreview + 1)

    const renderCountBeforeClear = app.render.mock.calls.length
    act(() => {
      ref.current?.syncItemPreview('image-1', null)
    })

    expect(sprite.position.x).toBe(24)
    expect(sprite.position.y).toBe(36)
    expect(sprite.scale.x).toBe(2)
    expect(sprite.scale.y).toBe(2)
    expect(sprite.rotation).toBe(0)
    expect(app.render).toHaveBeenCalledTimes(renderCountBeforeClear + 1)
  }, 15000)

  it('refreshes the texture source when a tiny preview grows back to visible size', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(createdSprites).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    const sprite = createdSprites[0]
    const source = sprite.texture.source as { unload: ReturnType<typeof vi.fn> }

    act(() => {
      ref.current?.syncItemPreview('image-1', {
        x: 24,
        y: 36,
        width: 200,
        height: 120,
        scaleX: 0.1,
        scaleY: 0.1,
        rotation: 0
      })
    })

    expect(source.unload).not.toHaveBeenCalled()

    act(() => {
      ref.current?.syncItemPreview('image-1', {
        x: 24,
        y: 36,
        width: 200,
        height: 120,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })
    })

    expect(source.unload).toHaveBeenCalledTimes(1)
    expect(sprite.scale.x).toBe(2)
    expect(sprite.scale.y).toBe(2)
  }, 15000)

  it('recreates sprite state when the texture key changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const initialItem = createItem()
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={[initialItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    const originalSprite = createdSprites[0]
    const originalTexture = originalSprite.texture

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={[
          createItem({
            crop: { x: 10, y: 5, width: 40, height: 20 }
          })
        ]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 15000 }
    )

    const updatedSprite = createdSprites.at(-1)!

    expect(originalSprite.destroyed).toBe(true)
    expect(originalTexture.destroyed).toBe(true)
    expect(originalTexture.destroySourceCalled).toBe(true)
    expect(updatedSprite.scale.x).toBe(5)
    expect(updatedSprite.scale.y).toBe(6)
  }, 30000)

  it('re-sorts sprites when an item z-index changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const firstItem = createItem({ id: 'image-1', zIndex: 1 })
    const secondItem = createItem({
      id: 'image-2',
      src: 'file:///image-2.png',
      fileName: 'image-2.png',
      x: 48,
      y: 60,
      zIndex: 2
    })

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={[firstItem, secondItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites).toHaveLength(2)
      },
      { timeout: 15000 }
    )

    expect(createdSprites[0].parent?.children.map((sprite) => sprite.label)).toEqual([
      'image-1',
      'image-2'
    ])

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={[{ ...firstItem, zIndex: 3 }, secondItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites[0].parent?.children.map((sprite) => sprite.label)).toEqual([
          'image-2',
          'image-1'
        ])
      },
      { timeout: 15000 }
    )
  }, 30000)

  it('caps the resident sprite set and admits deferred images when capacity frees up', async () => {
    const { PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT, default: ProjectCanvasWebGLImageLayer } =
      await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const residentIdsCalls: Set<string>[] = []
    const handleResidentIdsChange = (residentIds: Set<string>) => {
      residentIdsCalls.push(new Set(residentIds))
    }
    const oversizedItems = createItems(PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT + 1)
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={oversizedItems}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={handleResidentIdsChange}
      />
    )

    await waitFor(
      () => {
        const latestResidentIds = residentIdsCalls.at(-1)
        expect(latestResidentIds?.size).toBe(PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT)
      },
      { timeout: 15000 }
    )

    expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(
      PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT
    )

    const latestResidentIds = residentIdsCalls.at(-1) ?? new Set()
    const deferredItem = oversizedItems.find((item) => !latestResidentIds.has(item.id))
    expect(deferredItem).toBeDefined()
    expect(getLiveSpriteByLabel(deferredItem!.id)).toBeNull()

    act(() => {
      ref.current?.syncItemPreview(deferredItem!.id, {
        x: 320,
        y: 240,
        width: 200,
        height: 120,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      })
    })

    rerender(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[deferredItem!]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={handleResidentIdsChange}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set([deferredItem!.id]))
      },
      { timeout: 15000 }
    )

    const admittedSprite = getLiveSpriteByLabel(deferredItem!.id)
    expect(admittedSprite).not.toBeNull()
    expect(admittedSprite?.position.x).toBe(320)
    expect(admittedSprite?.position.y).toBe(240)

    act(() => {
      ref.current?.syncItemPreview(deferredItem!.id, null)
    })

    expect(admittedSprite?.position.x).toBe(deferredItem!.x)
    expect(admittedSprite?.position.y).toBe(deferredItem!.y)
    expect(residentIdsCalls.at(-1)).toEqual(new Set([deferredItem!.id]))
  }, 30000)

  it('does not churn resident sprites when visible candidates exceed the resident limit', async () => {
    const { PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT, default: ProjectCanvasWebGLImageLayer } =
      await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const oversizedItems = createItems(PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT + 24)

    render(
      <ProjectCanvasWebGLImageLayer
        items={oversizedItems}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 2400, height: 2400 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)?.size).toBe(PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT)
      },
      { timeout: 15000 }
    )

    const liveLabelsBefore = createdSprites
      .filter((sprite) => !sprite.destroyed)
      .map((sprite) => sprite.label)
      .sort()
    const createdSpriteCountBefore = createdSprites.length

    await new Promise((resolve) => setTimeout(resolve, 120))

    const liveLabelsAfter = createdSprites
      .filter((sprite) => !sprite.destroyed)
      .map((sprite) => sprite.label)
      .sort()

    expect(liveLabelsAfter).toEqual(liveLabelsBefore)
    expect(createdSprites).toHaveLength(createdSpriteCountBefore)
  }, 30000)

  it('emits a compact render-path snapshot for benchmark smoke checks', async () => {
    const { default: ProjectCanvasWebGLImageLayer, PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES } =
      await import('./ProjectCanvasWebGLImageLayer')
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const onMetricsChange = (metrics: ProjectCanvasWebGLImageLayerMetrics) => {
      metricsCalls.push(metrics)
    }

    render(
      <ProjectCanvasWebGLImageLayer
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onMetricsChange={onMetricsChange}
      />
    )

    await waitFor(
      () => {
        expect(metricsCalls.length).toBeGreaterThan(0)
      },
      { timeout: 15000 }
    )

    expect(metricsCalls[0]).toEqual(
      expect.objectContaining({
        isInitialized: true,
        imageCount: 0,
        loadedImageCount: 0,
        failedImageCount: 0,
        residentImageCount: 0,
        residentTextureBytes: 0,
        residentCandidateTextureBytes: 0,
        residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
        pendingImageCount: 0,
        spriteCount: 0,
        residentCandidateImageCount: 0,
        viewportCulledImageCount: 0,
        usingPreviewImageCount: 0,
        usingSourceImageCount: 0,
        thumbnailPreviewImageCount: 0,
        placeholderImageCount: 0,
        sourceUpgradeSuppressedImageCount: 0,
        sourceUpgradeablePreviewImageCount: 0,
        sourceUpgradePendingImageCount: 0,
        sourceUpgradeFailedImageCount: 0,
        missingImageCount: 0,
        lastUpdateReason: 'initialize'
      })
    )
  }, 15000)

  it('keeps only viewport-adjacent images resident in the GPU layer', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const visibleItem = createItem({ id: 'image-visible', x: 24, y: 36 })
    const farItem = createItem({
      id: 'image-far',
      src: 'file:///image-far.png',
      fileName: 'image-far.png',
      x: 4800,
      y: 3600
    })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[visibleItem, farItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
        onMetricsChange={(metrics) => metricsCalls.push(metrics)}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-visible']))
      },
      { timeout: 15000 }
    )

    expect(getLiveSpriteByLabel('image-visible')).not.toBeNull()
    expect(getLiveSpriteByLabel('image-far')).toBeNull()
    expect(metricsCalls.at(-1)).toEqual(
      expect.objectContaining({
        imageCount: 2,
        loadedImageCount: 2,
        failedImageCount: 0,
        residentImageCount: 1,
        residentCandidateImageCount: 1,
        viewportCulledImageCount: 1
      })
    )
  }, 30000)

  it('keeps selected images resident even when they sit just outside the viewport budget', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const selectedEdgeItem = createItem({
      id: 'image-selected-edge',
      src: 'file:///image-selected-edge.png',
      fileName: 'image-selected-edge.png',
      x: 1700,
      y: 48
    })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[selectedEdgeItem]}
        selectedIds={new Set([selectedEdgeItem.id])}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-selected-edge']))
      },
      { timeout: 15000 }
    )

    expect(getLiveSpriteByLabel('image-selected-edge')).not.toBeNull()
  }, 30000)

  it('does not reconcile the WebGL layer when selected id contents are unchanged', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const selectedItem = createItem({
      id: 'image-selected-stable',
      src: 'file:///image-selected-stable.png',
      fileName: 'image-selected-stable.png'
    })
    const stableItems = [selectedItem]

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={stableItems}
        selectedIds={new Set([selectedItem.id])}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(createdApplications).toHaveLength(1)
        expect(createdSprites).toHaveLength(1)
        expect(createdApplications[0].render).toHaveBeenCalled()
      },
      { timeout: 15000 }
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    const app = createdApplications[0]
    const createdSpriteCount = createdSprites.length
    app.render.mockClear()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    app.render.mockClear()

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={stableItems}
        selectedIds={new Set([selectedItem.id])}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })

    expect(createdSprites).toHaveLength(createdSpriteCount)
    expect(app.render).not.toHaveBeenCalled()
  }, 30000)

  it('does not pin a huge offscreen multi-selection into the resident GPU set', async () => {
    const { PROJECT_CANVAS_WEBGL_SELECTED_RESIDENT_LIMIT, default: ProjectCanvasWebGLImageLayer } =
      await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const selectedItems = Array.from(
      { length: PROJECT_CANVAS_WEBGL_SELECTED_RESIDENT_LIMIT + 1 },
      (_, index) =>
        createItem({
          id: `image-selected-large-${index + 1}`,
          src: `file:///image-selected-large-${index + 1}.png`,
          fileName: `image-selected-large-${index + 1}.png`,
          x: 5000 + index * 320,
          y: 5000,
          zIndex: index
        })
    )

    render(
      <ProjectCanvasWebGLImageLayer
        items={selectedItems}
        selectedIds={new Set(selectedItems.map((item) => item.id))}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
        onMetricsChange={(metrics) => metricsCalls.push(metrics)}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set())
      },
      { timeout: 15000 }
    )

    expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(0)
    expect(metricsCalls.at(-1)).toEqual(
      expect.objectContaining({
        imageCount: selectedItems.length,
        residentImageCount: 0,
        residentCandidateImageCount: 0,
        viewportCulledImageCount: selectedItems.length
      })
    )
  }, 30000)

  it('tears down the WebGL canvas and reports not-ready when the GPU context is lost', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const readyCalls: boolean[] = []
    const residentIdsCalls: Set<string>[] = []

    render(
      <ProjectCanvasWebGLImageLayer
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onReadyChange={(ready) => readyCalls.push(ready)}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
      />
    )

    await waitFor(
      () => {
        expect(readyCalls).toContain(true)
        expect(document.querySelector('canvas')).not.toBeNull()
      },
      { timeout: 15000 }
    )

    const event = new Event('webglcontextlost', { cancelable: true })
    act(() => {
      document.querySelector('canvas')?.dispatchEvent(event)
    })

    await waitFor(
      () => {
        expect(readyCalls.at(-1)).toBe(false)
        expect(residentIdsCalls.at(-1)).toEqual(new Set())
        expect(document.querySelector('canvas')).toBeNull()
      },
      { timeout: 15000 }
    )
    expect(event.defaultPrevented).toBe(true)
  }, 30000)

  it('tears down the WebGL canvas and reports not-ready when Pixi rendering fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const readyCalls: boolean[] = []
    const residentIdsCalls: Set<string>[] = []
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          ref={ref}
          items={[createItem()]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onReadyChange={(ready) => readyCalls.push(ready)}
          onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
        />
      )

      await waitFor(
        () => {
          expect(ref.current).not.toBeNull()
          expect(readyCalls).toContain(true)
          expect(createdApplications).toHaveLength(1)
          expect(document.querySelector('canvas')).not.toBeNull()
        },
        { timeout: 15000 }
      )

      const app = createdApplications[0]
      app.render.mockImplementationOnce(() => {
        throw new Error('shader initialization failed')
      })

      act(() => {
        ref.current?.syncViewport({ x: 96, y: 72 }, 1.25)
      })

      await waitFor(
        () => {
          expect(readyCalls.at(-1)).toBe(false)
          expect(residentIdsCalls.at(-1)).toEqual(new Set())
          expect(document.querySelector('canvas')).toBeNull()
          expect(app.destroy).toHaveBeenCalled()
        },
        { timeout: 15000 }
      )
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Canvas WebGL] Pixi render failed; falling back to non-WebGL image rendering.',
        expect.any(Error)
      )
    } finally {
      consoleWarnSpy.mockRestore()
    }
  }, 30000)

  it('renders stage pan transforms immediately without waiting for the next animation frame', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const requestAnimationFrameMock = vi.fn(() => 1)
    const cancelAnimationFrameMock = vi.fn()
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const handleMetricsChange = (metrics: ProjectCanvasWebGLImageLayerMetrics) => {
      metricsCalls.push(metrics)
    }

    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)

    try {
      const stableItems = [createItem()]
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={stableItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={handleMetricsChange}
        />
      )

      await waitFor(
        () => {
          expect(createdApplications).toHaveLength(1)
          expect(createdSprites).toHaveLength(1)
        },
        { timeout: 15000 }
      )

      const app = createdApplications[0]
      const initialRenderCount = app.render.mock.calls.length
      const initialMetricsRenderCount = metricsCalls.at(-1)?.renderCount ?? 0
      vi.useFakeTimers()

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={stableItems}
          stagePos={{ x: 96, y: 72 }}
          stageScale={1.25}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={handleMetricsChange}
        />
      )

      expect(requestAnimationFrameMock).toHaveBeenCalled()
      expect(app.render.mock.calls.length).toBeGreaterThan(initialRenderCount)
      expect(createdSprites[0].parent?.position.x).toBe(96)
      expect(createdSprites[0].parent?.position.y).toBe(72)
      expect(createdSprites[0].parent?.scale.x).toBe(1.25)
      expect(createdSprites[0].parent?.scale.y).toBe(1.25)
      expect(metricsCalls.at(-1)?.renderCount ?? 0).toBe(initialMetricsRenderCount)
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(metricsCalls.at(-1)?.renderCount ?? 0).toBeGreaterThan(initialMetricsRenderCount)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('syncs viewport transforms imperatively through the ref handle', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
      />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(createdApplications).toHaveLength(1)
        expect(createdSprites).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    const app = createdApplications[0]
    const initialRenderCount = app.render.mock.calls.length

    act(() => {
      ref.current?.syncViewport({ x: 96, y: 72 }, 1.25)
    })

    expect(createdSprites[0].parent?.position.x).toBe(96)
    expect(createdSprites[0].parent?.position.y).toBe(72)
    expect(createdSprites[0].parent?.scale.x).toBe(1.25)
    expect(createdSprites[0].parent?.scale.y).toBe(1.25)
    expect(app.render.mock.calls.length).toBeGreaterThan(initialRenderCount)

    act(() => {
      ref.current?.syncViewport({ x: 96, y: 72 }, 8)
    })

    expect((createdSprites[0].texture.source as { scaleMode?: string }).scaleMode).toBe('linear')
  }, 15000)

  it('reconciles resident images after imperative viewport movement without prop changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const residentIdsCalls: Set<string>[] = []
    const visibleItem = createItem({ id: 'image-visible', x: 24, y: 36 })
    const farItem = createItem({
      id: 'image-far',
      src: 'file:///image-far.png',
      fileName: 'image-far.png',
      x: 4800,
      y: 3600
    })

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[visibleItem, farItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-visible']))
      },
      { timeout: 15000 }
    )

    await act(async () => {
      ref.current?.syncViewport({ x: -4800, y: -3600 }, 1)
      await new Promise((resolve) => setTimeout(resolve, 120))
    })

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-far']))
      },
      { timeout: 15000 }
    )

    expect(getLiveSpriteByLabel('image-visible')).toBeNull()
    expect(getLiveSpriteByLabel('image-far')).not.toBeNull()
  }, 30000)

  it('admits preview sprites during viewport interaction without waiting for idle', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const residentIdsCalls: Set<string>[] = []
    const handleResidentIdsChange = (residentIds: Set<string>) => {
      residentIdsCalls.push(new Set(residentIds))
    }
    const visibleItem = createItem({ id: 'image-visible-interacting', x: 24, y: 36 })
    const farItem = createItem({
      id: 'image-far-interacting',
      src: 'file:///image-far-interacting.png',
      fileName: 'image-far-interacting.png',
      x: 4800,
      y: 3600
    })
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[visibleItem, farItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        isViewportInteracting
        onResidentIdsChange={handleResidentIdsChange}
      />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-visible-interacting']))
      },
      { timeout: 15000 }
    )

    await act(async () => {
      ref.current?.syncViewport({ x: -4800, y: -3600 }, 1)
      await new Promise((resolve) => setTimeout(resolve, 120))
    })

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-far-interacting']))
      },
      { timeout: 15000 }
    )
    expect(getLiveSpriteByLabel('image-visible-interacting')).toBeNull()
    expect(getLiveSpriteByLabel('image-far-interacting')).not.toBeNull()

    rerender(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[visibleItem, farItem]}
        stagePos={{ x: -4800, y: -3600 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        isViewportInteracting={false}
        onResidentIdsChange={handleResidentIdsChange}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-far-interacting']))
      },
      { timeout: 15000 }
    )
  }, 30000)

  it('defers metrics reports while viewport interaction is active', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const stableItems = [createItem({ id: 'image-metrics-interacting' })]

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={stableItems}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        isViewportInteracting
        onMetricsChange={(metrics) => metricsCalls.push(metrics)}
      />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(createdSprites).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    act(() => {
      ref.current?.syncViewport({ x: 96, y: 72 }, 1.25)
      ref.current?.syncViewport({ x: 120, y: 96 }, 1.25)
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    expect(metricsCalls).toHaveLength(0)

    rerender(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={stableItems}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        isViewportInteracting={false}
        onMetricsChange={(metrics) => metricsCalls.push(metrics)}
      />
    )

    await waitFor(
      () => {
        expect(
          metricsCalls.some(
            (metrics) =>
              metrics.imageCount === 1 &&
              metrics.residentImageCount === 1 &&
              metrics.renderCount >= 2
          )
        ).toBe(true)
      },
      { timeout: 15000 }
    )
  }, 30000)

  it('cancels a queued viewport reconcile when interaction starts before the debounce fires', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const residentIdsCalls: Set<string>[] = []
    const handleResidentIdsChange = (residentIds: Set<string>) => {
      residentIdsCalls.push(new Set(residentIds))
    }
    const visibleItem = createItem({ id: 'image-visible-queued', x: 24, y: 36 })
    const farItem = createItem({
      id: 'image-far-queued',
      src: 'file:///image-far-queued.png',
      fileName: 'image-far-queued.png',
      x: 4800,
      y: 3600
    })
    const stableItems = [visibleItem, farItem]

    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          ref={ref}
          items={stableItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onResidentIdsChange={handleResidentIdsChange}
        />
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(ref.current).not.toBeNull()
      expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-visible-queued']))

      act(() => {
        ref.current?.syncViewport({ x: -4800, y: -3600 }, 1)
      })

      rerender(
        <ProjectCanvasWebGLImageLayer
          ref={ref}
          items={stableItems}
          stagePos={{ x: -4800, y: -3600 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting
          onResidentIdsChange={handleResidentIdsChange}
        />
      )

      act(() => {
        vi.advanceTimersByTime(120)
      })

      expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-visible-queued']))
    } finally {
      vi.useRealTimers()
    }
  }, 30000)

  it('enforces the texture-byte budget before the resident sprite count cap', async () => {
    const {
      default: ProjectCanvasWebGLImageLayer,
      PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
      PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES
    } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const resolvedIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const largeTextureSide =
      Math.floor(Math.sqrt(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES / 4)) - 16
    const expectedTextureBytes = largeTextureSide * largeTextureSide * 4
    const largeVisibleItems = Array.from({ length: 7 }, (_, index) =>
      createItem({
        id: `image-large-${index + 1}`,
        src: `file:///image-large-${index + 1}.png`,
        fileName: `image-large-${index + 1}.png`,
        x: index * 24,
        y: index * 18,
        image: createImage(largeTextureSide, largeTextureSide)
      })
    )
    const expectedResidentCount = Math.floor(
      PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES / expectedTextureBytes
    )

    render(
      <ProjectCanvasWebGLImageLayer
        items={largeVisibleItems}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
        onResolvedIdsChange={(resolvedIds) => resolvedIdsCalls.push(new Set(resolvedIds))}
        onMetricsChange={(metrics) => metricsCalls.push(metrics)}
      />
    )

    await waitFor(
      () => {
        expect(resolvedIdsCalls.at(-1)).toEqual(new Set(largeVisibleItems.map((item) => item.id)))
        expect(residentIdsCalls.at(-1)?.size ?? 0).toBe(expectedResidentCount)
      },
      { timeout: 15000 }
    )

    expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(expectedResidentCount)
    expect(metricsCalls.at(-1)).toEqual(
      expect.objectContaining({
        imageCount: largeVisibleItems.length,
        loadedImageCount: largeVisibleItems.length,
        failedImageCount: 0,
        residentImageCount: expectedResidentCount,
        residentTextureBytes: expectedTextureBytes * expectedResidentCount,
        residentCandidateImageCount: largeVisibleItems.length,
        residentCandidateTextureBytes: expectedTextureBytes * largeVisibleItems.length,
        residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES
      })
    )
  }, 30000)

  it('keeps rotated images resident when their rotated bounds still intersect the viewport budget', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const rotatedEdgeItem = createItem({
      id: 'image-rotated-edge',
      src: 'file:///image-rotated-edge.png',
      fileName: 'image-rotated-edge.png',
      x: -450,
      y: 260,
      width: 120,
      height: 120,
      rotation: -45
    })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[rotatedEdgeItem]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 1280, height: 720 }}
        onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
        onMetricsChange={(metrics) => metricsCalls.push(metrics)}
      />
    )

    await waitFor(
      () => {
        expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-rotated-edge']))
      },
      { timeout: 15000 }
    )

    expect(getLiveSpriteByLabel('image-rotated-edge')).not.toBeNull()
    expect(metricsCalls.at(-1)).toEqual(
      expect.objectContaining({
        imageCount: 1,
        loadedImageCount: 1,
        failedImageCount: 0,
        residentImageCount: 1,
        residentCandidateImageCount: 1,
        viewportCulledImageCount: 0
      })
    )
  }, 30000)

  it('queues visible src-only image loads behind a bounded initial load pool', async () => {
    const {
      default: ProjectCanvasWebGLImageLayer,
      PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY
    } = await import('./ProjectCanvasWebGLImageLayer')
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const attemptedSrcs: string[] = []
    const imageInstances: Array<{ onload: null | (() => void) }> = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 100
      naturalHeight = 60
      width = 100
      height = 60
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const srcOnlyItems = createItems(10).map((item) => ({
        ...item,
        image: undefined as unknown as HTMLImageElement
      }))
      const offscreenSrcOnlyItem = createItem({
        id: 'image-offscreen-src-only',
        src: 'file:///image-offscreen-src-only.png',
        fileName: 'image-offscreen-src-only.png',
        x: 10000,
        y: 10000,
        image: undefined as unknown as HTMLImageElement
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[...srcOnlyItems, offscreenSrcOnlyItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(
            metricsCalls.some(
              (metrics) =>
                metrics.pendingImageCount === 10 &&
                metrics.residentCandidateImageCount === 10 &&
                metrics.viewportCulledImageCount === 1 &&
                metrics.missingImageCount === 0
            )
          ).toBe(true)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toHaveLength(PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY)
      const visibleSrcs = new Set(srcOnlyItems.map((item) => item.src))
      expect(attemptedSrcs.every((src) => visibleSrcs.has(src))).toBe(true)
      expect(attemptedSrcs).not.toContain(offscreenSrcOnlyItem.src)
      expect(createdSprites).toHaveLength(0)

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(() => {
        expect(attemptedSrcs).toHaveLength(PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY + 1)
      })
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('batches same-frame src-only image load commits into one image-version frame', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const imageInstances: MockImage[] = []
    const queuedAnimationFrames = new Map<number, FrameRequestCallback>()
    let nextAnimationFrameId = 1
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId
        nextAnimationFrameId += 1
        queuedAnimationFrames.set(id, callback)
        return id
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id: number) => {
        queuedAnimationFrames.delete(id)
      })

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 100
      naturalHeight = 60
      width = 100
      height = 60

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        void value
      }
      get src() {
        return ''
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const srcOnlyItems = createItems(2).map((item) => ({
        ...item,
        image: undefined as unknown as HTMLImageElement
      }))

      render(
        <ProjectCanvasWebGLImageLayer
          items={srcOnlyItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(() => {
        expect(imageInstances).toHaveLength(2)
      })
      queuedAnimationFrames.clear()

      act(() => {
        imageInstances[0].onload?.()
        imageInstances[1].onload?.()
      })

      expect(queuedAnimationFrames.size).toBe(1)

      const imageVersionFrame = Array.from(queuedAnimationFrames.values())[0]
      queuedAnimationFrames.clear()
      act(() => {
        imageVersionFrame(window.performance.now())
      })

      await waitFor(() => {
        expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(2)
      })
    } finally {
      requestAnimationFrameSpy.mockRestore()
      cancelAnimationFrameSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('loads the latest src when an item changes while an older load is pending', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 100
      naturalHeight = 60
      width = 100
      height = 60
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const initialItem = createItem({
        id: 'image-replaced-src',
        src: 'file:///image-replaced-old.png',
        fileName: 'image-replaced-old.png',
        image: undefined as unknown as HTMLImageElement
      })
      const replacementItem = {
        ...initialItem,
        src: 'file:///image-replaced-new.png',
        fileName: 'image-replaced-new.png'
      }
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[initialItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-replaced-old.png'])
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[replacementItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'file:///image-replaced-old.png',
            'file:///image-replaced-new.png'
          ])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      act(() => {
        imageInstances[1].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-replaced-src')).not.toBeNull()
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('upgrades preview textures to source textures when zoom makes the preview too small', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-hires',
              src: 'file:///image-hires.png',
              fileName: 'image-hires.png',
              width: 4096,
              height: 4096,
              sourceWidth: 4096,
              sourceHeight: 4096,
              image: createImage(1024, 1024)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires')?.texture.width).toBe(1024)
          expect(attemptedSrcs).toEqual(['file:///image-hires.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps mid-zoom preview textures while the preview still covers the screen density', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-mid-zoom-preview',
              src: 'file:///image-mid-zoom-preview.png',
              fileName: 'image-mid-zoom-preview.png',
              width: 4096,
              height: 4096,
              sourceWidth: 4096,
              sourceHeight: 4096,
              image: createImage(1024, 1024)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.5}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-mid-zoom-preview')?.texture.width).toBe(1024)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('upgrades mid-zoom preview textures on high-DPI screens without selection', async () => {
    setWindowDevicePixelRatio(2)
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-mid-zoom-hidpi',
              src: 'file:///image-mid-zoom-hidpi.png',
              fileName: 'image-mid-zoom-hidpi.png',
              width: 4096,
              height: 4096,
              sourceWidth: 4096,
              sourceHeight: 4096,
              image: createImage(1024, 1024)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.5}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-mid-zoom-hidpi')?.texture.width).toBe(1024)
          expect(attemptedSrcs).toEqual(['file:///image-mid-zoom-hidpi.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-mid-zoom-hidpi')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )
    } finally {
      setWindowDevicePixelRatio(originalDevicePixelRatio)
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('upgrades data URL source textures when zoom makes the preview too small', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 2048
      naturalHeight = 2048
      width = 2048
      height = 2048
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-hires-data',
              src: 'data:image/png;base64,hires',
              fileName: 'image-hires-data.png',
              width: 2048,
              height: 2048,
              sourceWidth: 2048,
              sourceHeight: 2048,
              image: createImage(512, 512)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires-data')?.texture.width).toBe(512)
          expect(attemptedSrcs).toEqual(['data:image/png;base64,hires'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires-data')?.texture.width).toBe(2048)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('defers source texture upgrades until viewport interaction settles', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-hires-interacting',
        src: 'file:///image-hires-interacting.png',
        fileName: 'image-hires-interacting.png',
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(1024, 1024)
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires-interacting')?.texture.width).toBe(1024)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toEqual([])
      expect(imageInstances).toHaveLength(0)

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting={false}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-hires-interacting.png'])
          expect(imageInstances).toHaveLength(1)
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires-interacting')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('applies source textures that finish while viewport interaction is still active', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-hires-loads-during-interaction',
        src: 'file:///image-hires-loads-during-interaction.png',
        fileName: 'image-hires-loads-during-interaction.png',
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(1024, 1024)
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting={false}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires-loads-during-interaction')?.texture.width).toBe(
            1024
          )
          expect(attemptedSrcs).toEqual(['file:///image-hires-loads-during-interaction.png'])
          expect(imageInstances).toHaveLength(1)
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting
        />
      )

      await act(async () => {
        imageInstances[0].onload?.()
        await Promise.resolve()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-hires-loads-during-interaction')?.texture.width).toBe(
            4096
          )
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('limits source texture upgrade loads without throttling initial visible image loads', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 2048
      naturalHeight = 2048
      width = 2048
      height = 2048
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const hiResItems = createItems(4).map((item, index) => ({
        ...item,
        id: `image-hires-queued-${index + 1}`,
        src: `file:///image-hires-queued-${index + 1}.png`,
        fileName: `image-hires-queued-${index + 1}.png`,
        width: 2048,
        height: 2048,
        sourceWidth: 2048,
        sourceHeight: 2048,
        image: createImage(512, 512)
      }))

      render(
        <ProjectCanvasWebGLImageLayer
          items={hiResItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(4)
          expect(attemptedSrcs).toEqual([
            'file:///image-hires-queued-1.png',
            'file:///image-hires-queued-2.png'
          ])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'file:///image-hires-queued-1.png',
            'file:///image-hires-queued-2.png',
            'file:///image-hires-queued-3.png'
          ])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[1].onload?.()
      })

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'file:///image-hires-queued-1.png',
            'file:///image-hires-queued-2.png',
            'file:///image-hires-queued-3.png',
            'file:///image-hires-queued-4.png'
          ])
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('prioritizes selected and near-center source texture upgrades', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 2048
      naturalHeight = 2048
      width = 2048
      height = 2048
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const centerItem = createItem({
        id: 'image-upgrade-center',
        src: 'file:///image-upgrade-center.png',
        fileName: 'image-upgrade-center.png',
        x: 260,
        y: 120,
        width: 2048,
        height: 2048,
        sourceWidth: 2048,
        sourceHeight: 2048,
        image: createImage(512, 512)
      })
      const edgeItem = createItem({
        id: 'image-upgrade-edge',
        src: 'file:///image-upgrade-edge.png',
        fileName: 'image-upgrade-edge.png',
        x: 760,
        y: 320,
        width: 2048,
        height: 2048,
        sourceWidth: 2048,
        sourceHeight: 2048,
        image: createImage(512, 512)
      })
      const selectedItem = createItem({
        id: 'image-upgrade-selected',
        src: 'file:///image-upgrade-selected.png',
        fileName: 'image-upgrade-selected.png',
        x: 3200,
        y: 2400,
        width: 2048,
        height: 2048,
        sourceWidth: 2048,
        sourceHeight: 2048,
        image: createImage(512, 512)
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[edgeItem, centerItem, selectedItem]}
          selectedIds={new Set(['image-upgrade-selected'])}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'file:///image-upgrade-selected.png',
            'file:///image-upgrade-center.png'
          ])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'file:///image-upgrade-selected.png',
            'file:///image-upgrade-center.png',
            'file:///image-upgrade-edge.png'
          ])
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps selected preview textures at overview zoom', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const unselectedItem = createItem({
        id: 'image-overview-unselected',
        src: 'file:///image-overview-unselected.png',
        fileName: 'image-overview-unselected.png',
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(512, 512)
      })
      const selectedItem = createItem({
        id: 'image-overview-selected',
        src: 'file:///image-overview-selected.png',
        fileName: 'image-overview-selected.png',
        x: 5000,
        y: 4000,
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(512, 512)
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[unselectedItem, selectedItem]}
          selectedIds={new Set([selectedItem.id])}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.01}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-overview-selected')?.texture.width).toBe(512)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toEqual([])
      expect(getLiveSpriteByLabel('image-overview-unselected')?.texture.width).toBe(512)
      expect(getLiveSpriteByLabel('image-overview-selected')?.texture.width).toBe(512)
      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.usingPreviewImageCount === 2 &&
            metrics.thumbnailPreviewImageCount === 2 &&
            metrics.placeholderImageCount === 0 &&
            metrics.sourceUpgradeSuppressedImageCount === 2 &&
            metrics.sourceUpgradeablePreviewImageCount === 0 &&
            metrics.sourceUpgradePendingImageCount === 0
        )
      ).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps dense mid-zoom overviews on preview textures instead of bulk source upgrades', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const denseItems = Array.from({ length: 128 }, (_, index) =>
        createItem({
          id: `image-dense-mid-zoom-${index + 1}`,
          src: `file:///image-dense-mid-zoom-${index + 1}.png`,
          fileName: `image-dense-mid-zoom-${index + 1}.png`,
          x: (index % 16) * 64,
          y: Math.floor(index / 16) * 64,
          width: 4096,
          height: 4096,
          sourceWidth: 4096,
          sourceHeight: 4096,
          image: createImage(512, 512)
        })
      )

      render(
        <ProjectCanvasWebGLImageLayer
          items={denseItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.27}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-dense-mid-zoom-1')?.texture.width).toBe(512)
        },
        { timeout: 15000 }
      )

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 240))
      })

      expect(attemptedSrcs).toEqual([])
      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.sourceUpgradeSuppressedImageCount > 96 &&
            metrics.sourceUpgradePendingImageCount === 0
        )
      ).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('upgrades large-batch preview sprites through thumbnail LOD without loading source textures', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 1024
      naturalHeight = 512
      width = 1024
      height = 512
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { sourceIdentity, thumbnailSet } = createThumbnailSetFixture()
      const item = createItem({
        id: 'image-thumbnail-lod',
        src: 'file:///image-thumbnail-lod.png',
        fileName: 'image-thumbnail-lod.png',
        width: 3200,
        height: 1600,
        sourceWidth: 4096,
        sourceHeight: 2048,
        image: createImage(192, 96),
        sourceIdentity,
        thumbnailSet
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.15}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-thumbnail-lod')?.texture.width).toBe(192)
          expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/1024.webp'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-thumbnail-lod')?.texture.width).toBe(1024)
          expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/1024.webp'])
          expect(
            metricsCalls.some(
              (metrics) =>
                metrics.usingPreviewImageCount === 1 &&
                metrics.usingSourceImageCount === 0 &&
                metrics.pendingImageCount === 0
            )
          ).toBe(true)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('defers thumbnail LOD image decoding while the viewport is actively scrolling', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 1024
      naturalHeight = 512
      width = 1024
      height = 512
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { sourceIdentity, thumbnailSet } = createThumbnailSetFixture(
        'canvas-thumbnail-scroll-defer-test'
      )
      const item = createItem({
        id: 'image-thumbnail-scroll-defer',
        src: 'file:///image-thumbnail-scroll-defer.png',
        fileName: 'image-thumbnail-scroll-defer.png',
        width: 3200,
        height: 1600,
        sourceWidth: 4096,
        sourceHeight: 2048,
        image: createImage(192, 96),
        sourceIdentity,
        thumbnailSet
      })

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.5}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-thumbnail-scroll-defer')?.texture.width).toBe(192)
        },
        { timeout: 15000 }
      )
      expect(attemptedSrcs).toEqual([])

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.5}
          stageSize={{ width: 1280, height: 720 }}
          isViewportInteracting={false}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/2048.webp'])
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('downgrades cached high thumbnails when a dense view needs more resident images', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 2048
      naturalHeight = 2048
      width = 2048
      height = 2048
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
        const match = value.match(/\/(\d+)\.webp$/)
        const level = match ? Number(match[1]) : 2048
        this.naturalWidth = level
        this.naturalHeight = level
        this.width = level
        this.height = level
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { sourceIdentity, thumbnailSet } = createThumbnailSetFixture(
        'canvas-thumbnail-dense-budget-test',
        { square: true }
      )
      const focusedItem = createItem({
        id: 'image-thumbnail-budgeted',
        src: 'file:///image-thumbnail-budgeted.png',
        fileName: 'image-thumbnail-budgeted.png',
        width: 3200,
        height: 3200,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(192, 192),
        sourceIdentity,
        thumbnailSet
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[focusedItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.15}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/1024.webp'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-thumbnail-budgeted')?.texture.width).toBe(1024)
        },
        { timeout: 15000 }
      )

      const denseFillers = Array.from({ length: 256 }, (_, index) =>
        createItem({
          id: `image-thumbnail-budget-filler-${index + 1}`,
          src: `file:///image-thumbnail-budget-filler-${index + 1}.png`,
          fileName: `image-thumbnail-budget-filler-${index + 1}.png`,
          x: ((index + 1) % 16) * 40,
          y: Math.floor((index + 1) / 16) * 40,
          width: 3200,
          height: 3200,
          sourceWidth: 4096,
          sourceHeight: 4096,
          image: createImage(192, 192)
        })
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[focusedItem, ...denseFillers]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.15}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'local-media:///thumb-lod/1024.webp',
            'local-media:///thumb-lod/512.webp'
          ])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[1].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-thumbnail-budgeted')?.texture.width).toBe(512)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('downgrades an already cached source texture back to preview at overview zoom', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-cached-source-overview',
        src: 'file:///image-cached-source-overview.png',
        fileName: 'image-cached-source-overview.png',
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(512, 512)
      })

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-cached-source-overview.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-cached-source-overview')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.01}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-cached-source-overview')?.texture.width).toBe(512)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toEqual(['file:///image-cached-source-overview.png'])
      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.usingPreviewImageCount === 1 &&
            metrics.usingSourceImageCount === 0 &&
            metrics.sourceUpgradeSuppressedImageCount === 1
        )
      ).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('drops stale offscreen source upgrade queue entries after the viewport moves', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 2048
      naturalHeight = 2048
      width = 2048
      height = 2048
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const hiResItems = createItems(4).map((item, index) => ({
        ...item,
        id: `image-stale-upgrade-${index + 1}`,
        src: `file:///image-stale-upgrade-${index + 1}.png`,
        fileName: `image-stale-upgrade-${index + 1}.png`,
        width: 2048,
        height: 2048,
        sourceWidth: 2048,
        sourceHeight: 2048,
        image: createImage(512, 512)
      }))

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={hiResItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([
            'file:///image-stale-upgrade-1.png',
            'file:///image-stale-upgrade-2.png'
          ])
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={hiResItems}
          stagePos={{ x: -10000, y: -10000 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(0)
        },
        { timeout: 15000 }
      )

      await act(async () => {
        imageInstances[0].onload?.()
        await Promise.resolve()
      })

      expect(attemptedSrcs).toEqual([
        'file:///image-stale-upgrade-1.png',
        'file:///image-stale-upgrade-2.png'
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps the preview sprite alive when source image decoding fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const failedIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-upgrade-decode-fail',
        src: 'file:///image-upgrade-decode-fail.png',
        fileName: 'image-upgrade-decode-fail.png',
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(1024, 1024)
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-upgrade-decode-fail')?.texture.width).toBe(1024)
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-upgrade-decode-fail.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onerror?.()
      })

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-upgrade-decode-fail')?.texture.width).toBe(1024)
          expect(
            metricsCalls.some(
              (metrics) =>
                metrics.failedImageCount === 0 &&
                metrics.usingPreviewImageCount === 1 &&
                metrics.sourceUpgradePendingImageCount === 0 &&
                metrics.sourceUpgradeFailedImageCount === 1
            )
          ).toBe(true)
        },
        { timeout: 15000 }
      )
      expect(failedIdsCalls.at(-1) ?? new Set()).toEqual(new Set())
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps the preview sprite alive when source texture creation fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const failedIdsCalls: Set<string>[] = []
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 4096
      naturalHeight = 4096
      width = 4096
      height = 4096
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-upgrade-fail',
        src: 'file:///image-upgrade-fail.png',
        fileName: 'image-upgrade-fail.png',
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: createImage(1024, 1024)
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-upgrade-fail')?.texture.width).toBe(1024)
        },
        { timeout: 15000 }
      )

      textureFromThrowForNaturalWidth = 4096
      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-upgrade-fail.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          const liveSprite = getLiveSpriteByLabel('image-upgrade-fail')
          expect(liveSprite?.texture.width).toBe(1024)
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(1)
          expect(consoleWarnSpy).toHaveBeenCalled()
        },
        { timeout: 15000 }
      )
      expect(failedIdsCalls.at(-1) ?? new Set()).toEqual(new Set())
    } finally {
      vi.unstubAllGlobals()
      consoleWarnSpy.mockRestore()
    }
  }, 30000)

  it('upgrades oversized local-media previews through a bounded source texture', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const createImageBitmapMock = vi.fn(
      async () => createImage(4096, 2510) as unknown as ImageBitmap
    )
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' })
    }))

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 19717
      naturalHeight = 12079
      width = 19717
      height = 12079
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-bounded-hires',
              src: 'local-media:///C:/real-board/huge.png',
              fileName: 'huge.png',
              width: 19717,
              height: 12079,
              sourceWidth: 19717,
              sourceHeight: 12079,
              image: createImage(512, 314)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/real-board/huge.png')
          expect(createImageBitmapMock).toHaveBeenCalledWith(expect.any(Blob), {
            resizeWidth: 4096,
            resizeHeight: 2509,
            resizeQuality: 'high'
          })
          expect(getLiveSpriteByLabel('image-bounded-hires')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('loads source-only local-media images through svcFs object URLs', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const originalApi = window.api
    const originalCreateObjectURL = URL.createObjectURL
    const attemptedSrcs: string[] = []
    const readImageFromPath = vi.fn(async () => ({
      image: new Uint8Array([1, 2, 3, 4]),
      filename: 'source-only.png'
    }))
    const createObjectURLMock = vi.fn((_blob: Blob) => 'blob:webgl-local-image')

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 640
      naturalHeight = 360
      width = 640
      height = 360
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
        window.setTimeout(() => this.onload?.(), 0)
      }

      get src() {
        return this._src
      }
    }

    URL.createObjectURL = createObjectURLMock as unknown as typeof URL.createObjectURL
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcFs: {
          readImageFromPath
        }
      }
    })
    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-local-source-only',
              src: 'local-media:///C:/real-board/source-only.png',
              fileName: 'source-only.png',
              image: undefined as unknown as HTMLImageElement
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(readImageFromPath).toHaveBeenCalledWith({
            fullPath: 'C:/real-board/source-only.png'
          })
          expect(attemptedSrcs).toEqual(['blob:webgl-local-image'])
          expect(getLiveSpriteByLabel('image-local-source-only')?.texture.width).toBe(640)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
      URL.createObjectURL = originalCreateObjectURL
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: originalApi
      })
    }
  }, 30000)

  it('falls back to an image element when bounded source fetch fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const createImageBitmapMock = vi.fn(
      async () => createImage(4096, 2276) as unknown as ImageBitmap
    )
    const fetchMock = vi.fn(async () => {
      throw new Error('custom scheme fetch unavailable')
    })

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 9000
      naturalHeight = 5000
      width = 9000
      height = 5000
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-bounded-fallback-hires',
              src: 'local-media:///C:/real-board/huge-fallback.png',
              fileName: 'huge-fallback.png',
              width: 9000,
              height: 5000,
              sourceWidth: 9000,
              sourceHeight: 5000,
              image: createImage(512, 314)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/real-board/huge-fallback.png')
          expect(attemptedSrcs).toEqual(['local-media:///C:/real-board/huge-fallback.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(createImageBitmapMock).toHaveBeenCalledWith(imageInstances[0], {
            resizeWidth: 4096,
            resizeHeight: 2276,
            resizeQuality: 'high'
          })
          expect(getLiveSpriteByLabel('image-bounded-fallback-hires')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('skips image-element source fallback for ultra-jumbo files when bounded fetch fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const fetchMock = vi.fn(async () => {
      throw new Error('custom scheme fetch unavailable')
    })

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 19717
      naturalHeight = 12079
      width = 19717
      height = 12079
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => createImage(4096, 2509) as unknown as ImageBitmap)
    )

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-ultra-jumbo-fetch-fail',
              src: 'local-media:///C:/real-board/ultra-jumbo.png',
              fileName: 'ultra-jumbo.png',
              width: 19717,
              height: 12079,
              sourceWidth: 19717,
              sourceHeight: 12079,
              image: createImage(512, 314)
            })
          ]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/real-board/ultra-jumbo.png')
          expect(getLiveSpriteByLabel('image-ultra-jumbo-fetch-fail')?.texture.width).toBe(512)
        },
        { timeout: 15000 }
      )

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })

      expect(attemptedSrcs).toEqual([])
      expect(getLiveSpriteByLabel('image-ultra-jumbo-fetch-fail')?.texture.width).toBe(512)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps the preview sprite alive when a source texture upgrade exceeds the budget', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 20000
      naturalHeight = 20000
      width = 20000
      height = 20000
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-over-budget-upgrade',
        src: 'file:///image-over-budget-upgrade.png',
        fileName: 'image-over-budget-upgrade.png',
        width: 1024,
        height: 1024,
        sourceWidth: 20000,
        sourceHeight: 20000,
        image: createImage(1024, 1024)
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-over-budget-upgrade')?.texture.width).toBe(1024)
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={2}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual([])
          expect(
            metricsCalls.some(
              (metrics) =>
                metrics.usingPreviewImageCount === 1 &&
                metrics.sourceUpgradePendingImageCount === 0 &&
                metrics.sourceUpgradeFailedImageCount === 0 &&
                metrics.usingSourceImageCount === 0
            )
          ).toBe(true)
        },
        { timeout: 15000 }
      )

      await waitFor(
        () => {
          expect(
            metricsCalls.some(
              (metrics) =>
                metrics.usingPreviewImageCount === 1 &&
                metrics.sourceUpgradePendingImageCount === 0 &&
                metrics.sourceUpgradeFailedImageCount === 0 &&
                metrics.usingSourceImageCount === 0
            )
          ).toBe(true)
        },
        { timeout: 15000 }
      )

      await waitFor(
        () => {
          expect(getLiveSpriteByLabel('image-over-budget-upgrade')?.texture.width).toBe(1024)
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(1)
        },
        { timeout: 15000 }
      )
      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.usingPreviewImageCount === 1 &&
            metrics.sourceUpgradePendingImageCount === 0 &&
            metrics.usingSourceImageCount === 0
        )
      ).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('blocks an oversized first resident source from reaching WebGL upload', async () => {
    const { PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES, default: ProjectCanvasWebGLImageLayer } =
      await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImage[] = []
    const failedIdsCalls: Set<string>[] = []
    const oversizedSide =
      Math.ceil(Math.sqrt(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES / 4)) + 1

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = oversizedSide
      naturalHeight = oversizedSide
      width = oversizedSide
      height = oversizedSide
      private _src = ''

      constructor() {
        imageInstances.push(this)
      }

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createItem({
        id: 'image-first-giant',
        src: 'file:///image-first-giant.png',
        fileName: 'image-first-giant.png',
        image: undefined as unknown as HTMLImageElement
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-first-giant.png'])
        },
        { timeout: 15000 }
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(textureFromWidths).toEqual([])
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(0)
          expect(failedIdsCalls.at(-1)).toEqual(new Set(['image-first-giant']))
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('drops failed pending loads out of runtime metrics and does not retry the same broken src', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const failedIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const attemptedSrcs: string[] = []

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      crossOrigin: string | null = null
      naturalWidth = 100
      naturalHeight = 60
      width = 100
      height = 60
      private _src = ''

      set src(value: string) {
        this._src = value
        attemptedSrcs.push(value)
        queueMicrotask(() => {
          this.onerror?.()
        })
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const failedItem = createItem({
        id: 'image-broken',
        src: 'file:///image-broken.png',
        fileName: 'image-broken.png',
        image: undefined as unknown as HTMLImageElement
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[failedItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(metricsCalls.some((metrics) => metrics.pendingImageCount === 1)).toBe(true)
          expect(
            metricsCalls.some(
              (metrics) =>
                metrics.imageCount === 1 &&
                metrics.loadedImageCount === 0 &&
                metrics.failedImageCount === 1 &&
                metrics.residentImageCount === 0 &&
                metrics.pendingImageCount === 0 &&
                metrics.spriteCount === 0 &&
                metrics.lastUpdateReason === 'items'
            )
          ).toBe(true)
        },
        { timeout: 15000 }
      )

      expect(residentIdsCalls.at(-1)).toEqual(new Set())
      expect(failedIdsCalls.at(-1)).toEqual(new Set(['image-broken']))
      expect(attemptedSrcs).toEqual(['file:///image-broken.png'])
      expect(createdSprites).toHaveLength(0)

      const metricsCallCountBeforeRerender = metricsCalls.length
      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[failedItem]}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onResidentIdsChange={(residentIds) => residentIdsCalls.push(new Set(residentIds))}
          onFailedIdsChange={(failedIds) => failedIdsCalls.push(new Set(failedIds))}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-broken.png'])
          expect(
            metricsCalls
              .slice(metricsCallCountBeforeRerender)
              .every((metrics) => metrics.pendingImageCount === 0)
          ).toBe(true)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('creates resident sprites in stable row-major order instead of center-out rings', async () => {
    const {
      PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE,
      default: ProjectCanvasWebGLImageLayer
    } = await import('./ProjectCanvasWebGLImageLayer')
    const queuedAnimationFrames = new Map<number, FrameRequestCallback>()
    let nextAnimationFrameId = 1
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId
        nextAnimationFrameId += 1
        queuedAnimationFrames.set(id, callback)
        return id
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id: number) => {
        queuedAnimationFrames.delete(id)
      })
    const orderedItems = Array.from(
      { length: PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE * 3 },
      (_, index) =>
        createItem({
          id: `image-row-major-${index + 1}`,
          src: `file:///image-row-major-${index + 1}.png`,
          fileName: `image-row-major-${index + 1}.png`,
          x: (index % 6) * 96,
          y: Math.floor(index / 6) * 72,
          width: 80,
          height: 48,
          zIndex: index
        })
    )

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={orderedItems}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(
            PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE
          )
        },
        { timeout: 15000 }
      )

      expect(
        createdSprites
          .slice(0, PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE)
          .map((sprite) => sprite.label)
      ).toEqual(
        orderedItems
          .slice(0, PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE)
          .map((item) => item.id)
      )
    } finally {
      requestAnimationFrameSpy.mockRestore()
      cancelAnimationFrameSpy.mockRestore()
    }
  }, 30000)

  it('splits large initial sprite creation across animation frames to avoid one long first render', async () => {
    const {
      PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE,
      default: ProjectCanvasWebGLImageLayer
    } = await import('./ProjectCanvasWebGLImageLayer')
    const queuedAnimationFrames = new Map<number, FrameRequestCallback>()
    let nextAnimationFrameId = 1
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId
        nextAnimationFrameId += 1
        queuedAnimationFrames.set(id, callback)
        return id
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id: number) => {
        queuedAnimationFrames.delete(id)
      })
    const flushNextAnimationFrame = () => {
      const nextFrame = queuedAnimationFrames.entries().next().value
      if (!nextFrame) {
        return false
      }

      const [id, callback] = nextFrame
      queuedAnimationFrames.delete(id)
      callback(window.performance.now())
      return true
    }
    const liveSpriteCount = () => createdSprites.filter((sprite) => !sprite.destroyed).length
    const flushUntilLiveSpriteCount = async (expectedCount: number) => {
      for (let index = 0; index < 12 && liveSpriteCount() !== expectedCount; index += 1) {
        await act(async () => {
          expect(flushNextAnimationFrame()).toBe(true)
          await Promise.resolve()
        })
      }

      expect(liveSpriteCount()).toBe(expectedCount)
    }
    const metricsCalls: ProjectCanvasWebGLImageLayerMetrics[] = []
    const largeItemSet = createItems(PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE * 3)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={largeItemSet}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(
            PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE
          )
        },
        { timeout: 15000 }
      )

      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.imageCount === largeItemSet.length &&
            metrics.lastUpdateReason === 'items' &&
            metrics.residentImageCount === PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE
        )
      ).toBe(false)

      await flushUntilLiveSpriteCount(PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE * 2)

      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.imageCount === largeItemSet.length &&
            metrics.lastUpdateReason === 'items' &&
            metrics.residentImageCount === PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE * 2
        )
      ).toBe(false)

      await flushUntilLiveSpriteCount(largeItemSet.length)

      expect(
        metricsCalls.some(
          (metrics) =>
            metrics.imageCount === largeItemSet.length &&
            metrics.residentCandidateImageCount === largeItemSet.length &&
            metrics.residentImageCount === largeItemSet.length &&
            metrics.spriteCount === largeItemSet.length &&
            metrics.lastUpdateReason === 'items'
        )
      ).toBe(true)
    } finally {
      requestAnimationFrameSpy.mockRestore()
      cancelAnimationFrameSpy.mockRestore()
    }
  }, 30000)

  it('holds low-zoom overview renders until the visible batch is complete', async () => {
    const {
      PROJECT_CANVAS_WEBGL_OVERVIEW_SPRITE_RECONCILE_BATCH_SIZE,
      default: ProjectCanvasWebGLImageLayer
    } = await import('./ProjectCanvasWebGLImageLayer')
    const queuedAnimationFrames = new Map<number, FrameRequestCallback>()
    let nextAnimationFrameId = 1
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId
        nextAnimationFrameId += 1
        queuedAnimationFrames.set(id, callback)
        return id
      })
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id: number) => {
        queuedAnimationFrames.delete(id)
      })
    const flushNextAnimationFrame = () => {
      const nextFrame = queuedAnimationFrames.entries().next().value
      if (!nextFrame) {
        return false
      }

      const [id, callback] = nextFrame
      queuedAnimationFrames.delete(id)
      callback(window.performance.now())
      return true
    }
    const liveSpriteCount = () => createdSprites.filter((sprite) => !sprite.destroyed).length
    const flushUntilLiveSpriteCount = async (expectedCount: number) => {
      for (let index = 0; index < 12 && liveSpriteCount() !== expectedCount; index += 1) {
        await act(async () => {
          expect(flushNextAnimationFrame()).toBe(true)
          await Promise.resolve()
        })
      }

      expect(liveSpriteCount()).toBe(expectedCount)
    }
    const overviewItemSet = createItems(
      PROJECT_CANVAS_WEBGL_OVERVIEW_SPRITE_RECONCILE_BATCH_SIZE * 2
    )

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={overviewItemSet}
          stagePos={{ x: 0, y: 0 }}
          stageScale={0.17}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await waitFor(
        () => {
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(
            PROJECT_CANVAS_WEBGL_OVERVIEW_SPRITE_RECONCILE_BATCH_SIZE
          )
          expect(createdApplications).toHaveLength(1)
        },
        { timeout: 15000 }
      )

      const app = createdApplications[0]
      const renderCountAfterFirstBatch = app.render.mock.calls.length

      await flushUntilLiveSpriteCount(overviewItemSet.length)

      expect(app.render).toHaveBeenCalledTimes(renderCountAfterFirstBatch)

      for (
        let index = 0;
        index < 12 && app.render.mock.calls.length !== renderCountAfterFirstBatch + 1;
        index += 1
      ) {
        await act(async () => {
          expect(flushNextAnimationFrame()).toBe(true)
          await Promise.resolve()
        })
      }

      expect(app.render).toHaveBeenCalledTimes(renderCountAfterFirstBatch + 1)
    } finally {
      requestAnimationFrameSpy.mockRestore()
      cancelAnimationFrameSpy.mockRestore()
    }
  }, 30000)
})
