import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageSourceIdentity, CanvasImageThumbnailSet } from '../canvasThumbnailTypes'
import type { ProjectCanvasWebGLRuntimeMetrics } from '../projectCanvasWebGLRuntimeState'

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

type MockTextureSource = {
  destroyed: boolean
  resource: unknown | null
  gpuValid: boolean
  unload: ReturnType<typeof vi.fn>
}
type MockSpriteInstance = {
  // 'mesh' is the edge-antialiased display object of a rotated image.
  kind: 'sprite' | 'mesh'
  shader?: { destroyed: boolean; resources: Record<string, unknown> }
  geometry?: { destroyed: boolean }
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
  addChildAt: (child: MockSpriteInstance, index: number) => void
  getChildIndex: (child: MockSpriteInstance) => number
  sortChildren: () => void
}

type MockWebGLContext = {
  getError: ReturnType<typeof vi.fn>
  NO_ERROR: number
  INVALID_ENUM: number
  INVALID_VALUE: number
  INVALID_OPERATION: number
  INVALID_FRAMEBUFFER_OPERATION: number
  OUT_OF_MEMORY: number
  CONTEXT_LOST_WEBGL: number
}

type MockApplicationInstance = {
  stage: MockContainerInstance
  canvas: HTMLCanvasElement
  renderer: {
    resize: ReturnType<typeof vi.fn>
    gl: MockWebGLContext
    resolution?: number
    context?: { webGLVersion: number }
    texture?: { initSource: ReturnType<typeof vi.fn> }
  }
  render: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  initOptions?: Record<string, unknown>
}

let createdSprites: MockSpriteInstance[] = []
let createdApplications: MockApplicationInstance[] = []
let textureFromThrowForNaturalWidth: number | null = null
let textureFromWidths: number[] = []
let textureFromAlphaModes: unknown[] = []
let textureScaleModeReadCount = 0
let textureScaleModeWriteCount = 0
let createdBaseTextures: MockTextureInstance[] = []
let bitmapClosedWithLiveTexture: ImageBitmap[] = []
// Bitmaps that were closed. A closed bitmap keeps reporting its pinned size, so "closed" is
// tracked here and every upload path of the Pixi mock checks it.
let closedBitmaps = new WeakSet<object>()
// false simulates a renderer without an eager upload: Pixi then uploads on a later draw.
let mockRendererSupportsEagerUpload = true
let eagerTextureUploads: unknown[] = []
// 1 simulates a WebGL 1 context, which cannot run the edge-antialias program.
let mockWebGLVersion = 2
let createdEdgeAntialiasShaders: { destroyed: boolean; resources: Record<string, unknown> }[] = []
const originalDevicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio

type MockImageInstance = {
  onload: null | (() => void)
  onerror: null | (() => void)
  crossOrigin: string | null
  naturalWidth: number
  naturalHeight: number
  width: number
  height: number
  src: string
}

function createMockImageClass({
  width: imageWidth,
  height: imageHeight,
  attemptedSrcs,
  imageInstances,
  storeSrc = true,
  onSetSrc
}: {
  width: number
  height: number
  attemptedSrcs?: string[]
  imageInstances?: MockImageInstance[]
  storeSrc?: boolean
  onSetSrc?: (image: MockImageInstance, value: string) => void
}) {
  return class MockImage implements MockImageInstance {
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    crossOrigin: string | null = null
    naturalWidth = imageWidth
    naturalHeight = imageHeight
    width = imageWidth
    height = imageHeight
    private _src = ''

    constructor() {
      imageInstances?.push(this)
    }

    set src(value: string) {
      if (storeSrc) {
        this._src = value
      }
      attemptedSrcs?.push(value)
      onSetSrc?.(this, value)
    }

    get src() {
      return this._src
    }
  }
}

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
      textureMatrix = { mapCoord: { frameOf: this as MockTextureInstance } }

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
        this.destroySourceCalled = this.destroySourceCalled || Boolean(destroySource)
        if (destroySource) {
          const source = this.source as MockTextureSource
          source.destroyed = true
          ;(source.unload as unknown as () => void)()
          source.resource = null
        }
      }

      static from(input: HTMLImageElement | { resource?: HTMLImageElement; alphaMode?: unknown }) {
        const options = input as { resource?: HTMLImageElement; alphaMode?: unknown }
        const image = options.resource ?? (input as HTMLImageElement)
        assertBitmapUploadable(image)
        const textureWidth = image.naturalWidth || image.width || 1
        textureFromWidths.push(textureWidth)
        textureFromAlphaModes.push(options.alphaMode)
        if (textureFromThrowForNaturalWidth === textureWidth) {
          throw new Error(`Texture creation failed for ${textureWidth}px image`)
        }

        let scaleMode: 'nearest' | 'linear' = 'linear'
        const source = {
          destroyed: false,
          resource: image as unknown | null,
          gpuValid: false,
          // Pixi's ImageSource is collectable by default.
          autoGarbageCollect: true,
          unload: vi.fn(),
          get image() {
            return this.resource
          },
          alphaMode: options.alphaMode,
          get scaleMode() {
            textureScaleModeReadCount += 1
            return scaleMode
          },
          set scaleMode(value: 'nearest' | 'linear') {
            textureScaleModeWriteCount += 1
            scaleMode = value
          }
        }
        source.unload.mockImplementation(() => {
          source.gpuValid = false
        })

        const texture = new MockTexture({
          source,
          frame: {
            x: 0,
            y: 0,
            width: textureWidth,
            height: image.naturalHeight || image.height || 1
          }
        })
        createdBaseTextures.push(texture)
        return texture
      }
    }

    class MockSprite implements MockSpriteInstance {
      kind: 'sprite' | 'mesh' = 'sprite'
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

    class MockGlProgram {
      static from(options: { vertex: string; fragment: string; name?: string }) {
        return { ...options }
      }
    }

    class MockShader {
      destroyed = false
      resources: Record<string, unknown>

      constructor(options: { glProgram: unknown; resources: Record<string, unknown> }) {
        this.resources = options.resources
        createdEdgeAntialiasShaders.push(this)
      }

      destroy() {
        this.destroyed = true
      }
    }

    class MockMeshGeometry {
      destroyed = false

      constructor(public options: { positions: Float32Array; uvs: Float32Array }) {}

      destroy() {
        this.destroyed = true
      }
    }

    class MockMesh extends MockSprite {
      shader: MockShader
      geometry: MockMeshGeometry

      constructor(options: {
        geometry: MockMeshGeometry
        shader: MockShader
        texture: MockTextureInstance
      }) {
        super(options.texture)
        this.kind = 'mesh'
        this.shader = options.shader
        this.geometry = options.geometry
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

      addChildAt(child: MockSpriteInstance, index: number) {
        this.children.splice(index, 0, child)
        child.parent = this
      }

      getChildIndex(child: MockSpriteInstance) {
        const index = this.children.indexOf(child)
        if (index < 0) {
          throw new Error('The supplied child is not a child of the container.')
        }
        return index
      }

      sortChildren() {
        this.children.sort((left, right) => left.zIndex - right.zIndex)
      }
    }

    class MockApplication implements MockApplicationInstance {
      stage = new MockContainer()
      canvas = document.createElement('canvas')
      renderer: MockApplicationInstance['renderer'] = {
        resize: vi.fn((width: number, height: number) => {
          this.canvas.width = width
          this.canvas.height = height
        }),
        ...(mockRendererSupportsEagerUpload
          ? {
              texture: {
                initSource: vi.fn((source: MockTextureSource) => {
                  if (source.destroyed) {
                    throw new Error('Pixi attempted to upload a destroyed texture source.')
                  }
                  if (!source.gpuValid) {
                    assertBitmapUploadable(source.resource)
                    eagerTextureUploads.push(source.resource)
                    source.gpuValid = true
                  }
                })
              }
            }
          : {}),
        context: { webGLVersion: mockWebGLVersion },
        gl: {
          getError: vi.fn(() => 0),
          NO_ERROR: 0,
          INVALID_ENUM: 1280,
          INVALID_VALUE: 1281,
          INVALID_OPERATION: 1282,
          INVALID_FRAMEBUFFER_OPERATION: 1286,
          OUT_OF_MEMORY: 1285,
          CONTEXT_LOST_WEBGL: 37442
        }
      }
      render = vi.fn(() => {
        createdSprites.forEach((sprite) => {
          if (!sprite.destroyed && sprite.parent) {
            const source = sprite.texture.source as MockTextureSource
            if (source.destroyed) {
              throw new Error('Pixi attempted to render a destroyed texture source.')
            }
            if (!source.gpuValid) {
              assertBitmapUploadable(source.resource)
              source.gpuValid = true
            }
          }
        })
      })
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
      GlProgram: MockGlProgram,
      Mesh: MockMesh,
      MeshGeometry: MockMeshGeometry,
      Rectangle: MockRectangle,
      Shader: MockShader,
      Sprite: MockSprite,
      Texture: MockTexture
    }
  })
}

const TEST_STAGE_SIZE_1280_720 = { width: 1280, height: 720 }
const TEST_STAGE_VIEWPORT_1280_720 = {
  stagePos: { x: 0, y: 0 },
  stageScale: 1,
  stageSize: TEST_STAGE_SIZE_1280_720
}

function createImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

function assertBitmapUploadable(value: unknown) {
  const image = value as ImageBitmap | undefined
  if (
    typeof image?.close === 'function' &&
    (closedBitmaps.has(image) || image.width === 0 || image.height === 0)
  ) {
    throw new Error('Pixi attempted to upload a closed ImageBitmap.')
  }
}

function createBitmap(width: number, height: number) {
  let closed = false
  const bitmap = {
    get width() {
      return closed ? 0 : width
    },
    get height() {
      return closed ? 0 : height
    },
    close: vi.fn(() => {
      // Closing a bitmap is only a bug while a live texture still has to upload it.
      if (
        createdBaseTextures.some((texture) => {
          const source = texture.source as MockTextureSource & { image?: unknown }
          return !texture.destroyed && source.image === bitmap && !source.gpuValid
        })
      ) {
        bitmapClosedWithLiveTexture.push(bitmap as ImageBitmap)
      }
      closed = true
      closedBitmaps.add(bitmap)
    })
  }
  return bitmap as ImageBitmap & { close: ReturnType<typeof vi.fn> }
}

function isBitmapClosed(bitmap: unknown) {
  return closedBitmaps.has(bitmap as object)
}

function deferredBitmap() {
  let resolve!: (bitmap: ImageBitmap) => void
  const promise = new Promise<ImageBitmap>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function getTextureImage(sprite: MockSpriteInstance | null) {
  return (sprite?.texture.source as { image?: unknown } | undefined)?.image
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

function createNamedItem(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return createItem({
    id,
    src: `file:///${id}.png`,
    fileName: `${id}.png`,
    ...overrides
  })
}

function createSizedNamedItem(
  id: string,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  imageWidth: number,
  imageHeight: number,
  overrides: Partial<CanvasImageItem> = {}
): CanvasImageItem {
  return createNamedItem(id, {
    width,
    height,
    sourceWidth,
    sourceHeight,
    image: createImage(imageWidth, imageHeight),
    ...overrides
  })
}

function createItems(count: number): CanvasImageItem[] {
  return Array.from({ length: count }, (_, index) =>
    createNamedItem(`image-${index + 1}`, {
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
    version: 1,
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
    vi.doUnmock('../projectCanvasRenderBoundary')
    createdSprites = []
    createdApplications = []
    textureFromThrowForNaturalWidth = null
    textureFromWidths = []
    textureFromAlphaModes = []
    textureScaleModeReadCount = 0
    textureScaleModeWriteCount = 0
    createdBaseTextures = []
    bitmapClosedWithLiveTexture = []
    closedBitmaps = new WeakSet<object>()
    mockRendererSupportsEagerUpload = true
    eagerTextureUploads = []
    mockWebGLVersion = 2
    createdEdgeAntialiasShaders = []
    setWindowDevicePixelRatio(originalDevicePixelRatio)
    installPixiMock()
  })

  describe('bitmap ownership', () => {
    beforeEach(() => {
      vi.stubGlobal('electronFile', {
        resolveAuthorizedLocalMediaPath: vi.fn(async (path: string) => path)
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          blob: async () => new Blob(['image'], { type: 'image/png' })
        }))
      )
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      expect(bitmapClosedWithLiveTexture).toEqual([])
    })

    const localSourceItem = (overrides: Partial<CanvasImageItem> = {}) =>
      createItem({
        src: 'local-media:///C:/images/bitmap.png',
        sourceWidth: 640,
        sourceHeight: 360,
        image: undefined as unknown as HTMLImageElement,
        ...overrides
      })
    const thumbnailItem = () => {
      const fixture = createThumbnailSetFixture('bitmap-lifetime')
      return localSourceItem({
        ...fixture,
        thumbnailSet: {
          ...fixture.thumbnailSet,
          levels: fixture.thumbnailSet.levels.map((level) => ({
            ...level,
            src: level.src.replace('thumb-lod', 'C:/thumb-lod')
          }))
        },
        image: createBitmap(192, 96) as unknown as HTMLImageElement,
        width: 3200,
        height: 1600,
        sourceWidth: 4096,
        sourceHeight: 2048
      })
    }

    it('closes an initial local bitmap right after its upload and never uploads it again', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmap = createBitmap(640, 360)
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => bitmap)
      )
      const item = localSourceItem()
      const metrics = vi.fn()
      const { unmount } = render(
        <Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} onMetricsChange={metrics} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(bitmap))
      expect(bitmap).not.toHaveProperty('naturalWidth')
      // One decoded copy per image: the pixels live in the texture, the bitmap is closed.
      expect(eagerTextureUploads).toEqual([bitmap])
      expect(bitmap.close).toHaveBeenCalledTimes(1)
      expect(isBitmapClosed(bitmap)).toBe(true)
      // The closed bitmap still reports its size, so texture keys and LOD decisions hold.
      expect([bitmap.width, bitmap.height]).toEqual([640, 360])
      const source = getLiveSpriteByLabel(item.id)!.texture.source as MockTextureSource
      expect(source.gpuValid).toBe(true)
      expect((source as { autoGarbageCollect?: boolean }).autoGarbageCollect).toBe(false)
      const app = createdApplications[0]
      for (let frame = 0; frame < 3; frame += 1) {
        expect(() => (app.render as unknown as () => void)()).not.toThrow()
      }
      expect(app.renderer.texture?.initSource).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(metrics).toHaveBeenLastCalledWith(
          expect.objectContaining({ decodedResidentBytes: 0, sourceImageCacheCount: 1 })
        )
      )
      unmount()
      expect(bitmap.close).toHaveBeenCalledTimes(1)
      expect(createdBaseTextures.every((texture) => texture.destroyed)).toBe(true)
      expect(
        createdBaseTextures.every((texture) => {
          const source = texture.source as MockTextureSource
          return source.destroyed && source.resource === null
        })
      ).toBe(true)
    })

    it('keeps the bitmap for the texture lifetime when the renderer cannot upload eagerly', async () => {
      mockRendererSupportsEagerUpload = false
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmap = createBitmap(640, 360)
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => bitmap)
      )
      const item = localSourceItem()
      const { unmount } = render(<Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(bitmap))
      // Pixi uploads on a later draw here, so the input has to stay alive.
      expect(bitmap.close).not.toHaveBeenCalled()
      const source = getLiveSpriteByLabel(item.id)!.texture.source as MockTextureSource
      ;(source.unload as unknown as () => void)()
      expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()
      expect(source.gpuValid).toBe(true)
      unmount()
      expect(bitmap.close).toHaveBeenCalledTimes(1)
      expect(bitmap.width).toBe(0)
    })

    it('decodes again instead of uploading a closed bitmap when an evicted image returns', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const first = createBitmap(640, 360)
      const second = createBitmap(640, 360)
      const decode = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
      vi.stubGlobal('createImageBitmap', decode)
      const item = localSourceItem()
      const metrics = vi.fn()
      const { unmount, rerender } = render(
        <Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} onMetricsChange={metrics} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(first))
      expect(first.close).toHaveBeenCalledTimes(1)
      const firstTexture = getLiveSpriteByLabel(item.id)!.texture

      // Pan far away: the sprite and its texture are destroyed.
      rerender(
        <Layer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stagePos={{ x: -50_000, y: -50_000 }}
          onMetricsChange={metrics}
        />
      )
      await waitFor(() => expect(getLiveSpriteByLabel(item.id)).toBeNull())
      expect(firstTexture.destroyed).toBe(true)
      // The cache record went with the last sprite: nothing is kept for an image off screen.
      await waitFor(() =>
        expect(metrics).toHaveBeenLastCalledWith(
          expect.objectContaining({ sourceImageCacheCount: 0, decodedResidentBytes: 0 })
        )
      )

      // Come back: the released decode must not be uploaded again.
      rerender(<Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} onMetricsChange={metrics} />)
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(second))
      expect(decode).toHaveBeenCalledTimes(2)
      expect(eagerTextureUploads).toEqual([first, second])
      expect(second.close).toHaveBeenCalledTimes(1)
      expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()
      unmount()
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(second.close).toHaveBeenCalledTimes(1)
    })

    it('reuses the uploaded texture for a new crop without touching the released decode', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmap = createBitmap(640, 360)
      const decode = vi.fn(async () => bitmap)
      vi.stubGlobal('createImageBitmap', decode)
      const item = localSourceItem()
      const { unmount, rerender } = render(
        <Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(bitmap))
      const uncropped = getLiveSpriteByLabel(item.id)!
      const cropped = { ...item, crop: { x: 64, y: 36, width: 320, height: 180 } }
      rerender(<Layer items={[cropped]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(getLiveSpriteByLabel(item.id)?.texture.frame?.width).toBe(320))
      expect(uncropped.destroyed).toBe(true)
      // Same GPU texture underneath: no second decode, no second upload.
      expect(getLiveSpriteByLabel(item.id)!.texture.source).toBe(uncropped.texture.source)
      expect(decode).toHaveBeenCalledTimes(1)
      expect(eagerTextureUploads).toEqual([bitmap])
      expect(bitmap.close).toHaveBeenCalledTimes(1)
      expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()
      unmount()
      expect(bitmap.close).toHaveBeenCalledTimes(1)
    })

    it('tears down cleanly on context loss after the decoded pixels were released', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmap = createBitmap(640, 360)
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => bitmap)
      )
      const ready = vi.fn()
      const item = localSourceItem()
      const { unmount } = render(
        <Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} onReadyChange={ready} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(bitmap))
      act(() => {
        createdApplications[0].canvas.dispatchEvent(new Event('webglcontextlost'))
      })
      // The layer falls back to non-WebGL rendering instead of re-uploading anything.
      expect(ready).toHaveBeenLastCalledWith(false)
      expect(createdBaseTextures.every((texture) => texture.destroyed)).toBe(true)
      expect(bitmap.close).toHaveBeenCalledTimes(1)
      unmount()
      expect(bitmap.close).toHaveBeenCalledTimes(1)
    })

    it.each(['initial', 'upgrade'])(
      'bounds a narrow local %s decode below the byte limit',
      async (mode) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        const bitmap = createBitmap(4096, 16)
        const decode = vi.fn(async () => bitmap)
        vi.stubGlobal('createImageBitmap', decode)
        const preview = createBitmap(128, 1)
        const item = localSourceItem({
          width: 8192,
          height: 32,
          sourceWidth: 8192,
          sourceHeight: 32,
          image: (mode === 'upgrade' ? preview : undefined) as unknown as HTMLImageElement
        })
        const { unmount } = render(<Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />)
        await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(bitmap))
        expect(decode).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), {
          resizeWidth: 4096,
          resizeHeight: 16,
          resizeQuality: 'high',
          premultiplyAlpha: 'none'
        })
        // Closed once, right after the upload; never again.
        expect(bitmap.close).toHaveBeenCalledTimes(1)
        unmount()
        expect(bitmap.close).toHaveBeenCalledTimes(1)
        expect(preview.close).not.toHaveBeenCalled()
      }
    )

    it.each(['initial', 'upgrade'])(
      'closes the owned intermediate when actual %s dimensions require resizing',
      async (mode) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        const original = createBitmap(8192, 32)
        const resized = createBitmap(4096, 16)
        const decode = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(resized)
        vi.stubGlobal('createImageBitmap', decode)
        const preview = createBitmap(16, 1)
        const item = localSourceItem({
          width: 640,
          height: 360,
          image: (mode === 'upgrade' ? preview : undefined) as unknown as HTMLImageElement
        })
        const { unmount } = render(<Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />)
        await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(resized))
        expect(decode).toHaveBeenNthCalledWith(2, original, {
          resizeWidth: 4096,
          resizeHeight: 16,
          resizeQuality: 'high',
          premultiplyAlpha: 'none'
        })
        expect(original.close).toHaveBeenCalledTimes(1)
        // The resized output is closed as soon as its texture is uploaded.
        expect(resized.close).toHaveBeenCalledTimes(1)
        expect(eagerTextureUploads).toEqual([resized])
        expect(textureFromWidths).not.toContain(8192)
        unmount()
        expect(original.close).toHaveBeenCalledTimes(1)
        expect(resized.close).toHaveBeenCalledTimes(1)
        expect(preview.close).not.toHaveBeenCalled()
      }
    )

    it.each(['unsupported', 'rejected'])(
      'uses a bounded HTML fallback when ImageBitmap is %s',
      async (failure) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        const decode = vi.fn().mockRejectedValue(new Error('Unsupported bitmap format'))
        vi.stubGlobal('createImageBitmap', failure === 'unsupported' ? undefined : decode)
        const images: MockImageInstance[] = []
        vi.stubGlobal(
          'Image',
          createMockImageClass({
            width: 8192,
            height: 32,
            imageInstances: images,
            onSetSrc: (image, src) => {
              if (src === 'blob:bounded-html') {
                image.naturalWidth = image.width = 4096
                image.naturalHeight = image.height = 16
              }
              queueMicrotask(() => image.onload?.())
            }
          })
        )
        const drawImage = vi.fn()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
          drawImage
        } as unknown as GPUCanvasContext)
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
          callback(new Blob(['resized']))
        )
        const revoke = vi.fn()
        vi.stubGlobal(
          'URL',
          class extends URL {
            static createObjectURL = vi.fn(() => 'blob:bounded-html')
            static revokeObjectURL = revoke
          }
        )
        const item = localSourceItem({ sourceWidth: 8192, sourceHeight: 32 })
        const { unmount } = render(<Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />)
        await waitFor(() => expect(getLiveSpriteByLabel(item.id)?.texture.width).toBe(4096))
        expect(images.map((image) => image.src)).toEqual([item.src, 'blob:bounded-html'])
        expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(images[1])
        expect(drawImage).toHaveBeenCalledWith(images[0], 0, 0, 4096, 16)
        expect(revoke).toHaveBeenCalledWith('blob:bounded-html')
        expect(textureFromWidths).not.toContain(8192)
        unmount()
      }
    )

    it.each(['source-unmount', 'source-stale', 'thumbnail-unmount', 'thumbnail-stale'])(
      'closes a late bitmap exactly once after %s',
      async (ending) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        const pending = deferredBitmap()
        const bitmap = createBitmap(1024, 512)
        const decode = vi.fn(() => pending.promise)
        vi.stubGlobal('createImageBitmap', decode)
        const item = ending.startsWith('thumbnail') ? thumbnailItem() : localSourceItem()
        const viewport = {
          ...TEST_STAGE_VIEWPORT_1280_720,
          stageScale: ending.startsWith('thumbnail') ? 0.15 : 1
        }
        const { unmount, rerender } = render(<Layer items={[item]} {...viewport} />)
        await waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
        if (ending.endsWith('unmount')) unmount()
        else
          rerender(
            <Layer
              items={[createItem({ id: item.id, src: '', image: createImage(4096, 2048) })]}
              {...viewport}
            />
          )
        await act(async () => pending.resolve(bitmap))
        await waitFor(() => expect(bitmap.close).toHaveBeenCalledTimes(1))
        expect(
          createdBaseTextures.some(
            (texture) => (texture.source as { image?: unknown }).image === bitmap
          )
        ).toBe(false)
        unmount()
        expect(bitmap.close).toHaveBeenCalledTimes(1)
      }
    )

    it.each(['unmount', 'stale', 'timeout'])(
      'disposes both owned resize assets on late completion after %s',
      async (ending) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        const original = createBitmap(8192, 32)
        const resized = createBitmap(4096, 16)
        const pending = deferredBitmap()
        const decode = vi
          .fn()
          .mockResolvedValueOnce(original)
          .mockImplementationOnce(() => pending.promise)
        vi.stubGlobal('createImageBitmap', decode)
        let expire: (() => void) | undefined
        const nativeSetTimeout = window.setTimeout.bind(window) as typeof window.setTimeout
        vi.spyOn(window, 'setTimeout').mockImplementation(((handler, delay, ...args) => {
          if (delay === 12_000 && typeof handler === 'function') expire = () => handler(...args)
          return nativeSetTimeout(handler, delay, ...args)
        }) as typeof window.setTimeout)
        const item = localSourceItem()
        const failed = vi.fn()
        const { unmount, rerender } = render(
          <Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} onFailedIdsChange={failed} />
        )
        await waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
        if (ending === 'unmount') unmount()
        else if (ending === 'stale')
          rerender(
            <Layer
              items={[createItem({ src: '' })]}
              {...TEST_STAGE_VIEWPORT_1280_720}
              onFailedIdsChange={failed}
            />
          )
        else
          act(() => {
            expect(expire).toBeDefined()
            expire?.()
          })
        // createImageBitmap cannot be cancelled; its input stays open until it settles.
        expect(original.close).not.toHaveBeenCalled()
        await act(async () => pending.resolve(resized))
        await waitFor(() => expect(original.close).toHaveBeenCalledTimes(1))
        expect(resized.close).toHaveBeenCalledTimes(1)
        expect(textureFromWidths).not.toContain(4096)
        if (ending === 'timeout') expect(failed).toHaveBeenLastCalledWith(new Set([item.id]))
        unmount()
        expect(original.close).toHaveBeenCalledTimes(1)
        expect(resized.close).toHaveBeenCalledTimes(1)
      }
    )

    it('keeps a replaced thumbnail on screen from its texture through deferred reconciliation', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const first = createBitmap(1024, 512)
      const second = createBitmap(2048, 1024)
      const pending = deferredBitmap()
      const decode = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(() => pending.promise)
      vi.stubGlobal('createImageBitmap', decode)
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const ready = vi.fn()
      const item = thumbnailItem()
      // Control both the image-version RAF and its interaction deadline. A real
      // timer may commit the replacement before act() returns on a loaded host,
      // which would skip the cache-replaced/old-texture-live state under test.
      vi.useFakeTimers()
      let unmountLayer: (() => void) | undefined
      try {
        const { unmount, rerender } = render(
          <Layer
            ref={ref}
            items={[item]}
            {...TEST_STAGE_VIEWPORT_1280_720}
            stageScale={0.15}
            onReadyChange={ready}
          />
        )
        unmountLayer = unmount
        await act(async () => {})
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250)
        })
        expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(first)
        const oldSprite = getLiveSpriteByLabel(item.id)!
        rerender(
          <Layer
            ref={ref}
            items={[item]}
            {...TEST_STAGE_VIEWPORT_1280_720}
            stageScale={0.3}
            onReadyChange={ready}
          />
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250)
        })
        expect(decode).toHaveBeenCalledTimes(2)
        act(() => ref.current?.setViewportInteracting(true))
        await act(async () => pending.resolve(second))
        expect(getLiveSpriteByLabel(item.id)).toBe(oldSprite)
        // The first level was closed after its upload; its texture keeps drawing it.
        expect(first.close).toHaveBeenCalledTimes(1)
        expect(second.close).not.toHaveBeenCalled()
        const source = oldSprite.texture.source as MockTextureSource
        expect(source.resource).toBe(first)
        expect(source.gpuValid).toBe(true)
        expect(source.unload).not.toHaveBeenCalled()
        act(() => ref.current?.syncViewport({ x: 1, y: 0 }, 0.3))
        expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()
        expect(ready).toHaveBeenLastCalledWith(true)
        act(() => ref.current?.setViewportInteracting(false))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250)
        })
        expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(second)
        expect(first.close).toHaveBeenCalledTimes(1)
        expect(second.close).toHaveBeenCalledTimes(1)
        expect(eagerTextureUploads).toEqual([first, second])
        unmount()
        expect(second.close).toHaveBeenCalledTimes(1)
        expect((item.image as unknown as ImageBitmap).close).not.toHaveBeenCalled()
      } finally {
        unmountLayer?.()
        vi.useRealTimers()
      }
    })

    it('uploads a shared thumbnail once and closes every decoded twin', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const first = createBitmap(1024, 512)
      const second = createBitmap(1024, 512)
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
      )
      const a = thumbnailItem()
      const b = {
        ...a,
        id: 'shared-thumbnail-b',
        image: createBitmap(192, 96) as unknown as HTMLImageElement
      }
      const { unmount, rerender } = render(
        <Layer items={[a, b]} {...TEST_STAGE_VIEWPORT_1280_720} stageScale={0.15} />
      )
      await waitFor(() => {
        expect(getTextureImage(getLiveSpriteByLabel(a.id))).toBe(first)
        expect(getTextureImage(getLiveSpriteByLabel(b.id))).toBe(first)
      })
      const sharedTexture = getLiveSpriteByLabel(a.id)!.texture
      rerender(<Layer items={[b]} {...TEST_STAGE_VIEWPORT_1280_720} stageScale={0.15} />)
      await waitFor(() => expect(getLiveSpriteByLabel(a.id)).toBeNull())
      expect(getLiveSpriteByLabel(b.id)?.texture).toBe(sharedTexture)
      // One upload feeds both sprites. The second decode of the same level is redundant and
      // is closed without ever being uploaded.
      expect(eagerTextureUploads).toEqual([first])
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(second.close).toHaveBeenCalledTimes(1)
      expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()
      unmount()
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(second.close).toHaveBeenCalledTimes(1)
      expect((a.image as unknown as ImageBitmap).close).not.toHaveBeenCalled()
      expect((b.image as unknown as ImageBitmap).close).not.toHaveBeenCalled()
    })

    it('keeps the source texture on screen while the thumbnail level is decoded again', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      // Thumbnail levels and the source are told apart by the bytes the fetch mock returns.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          blob: async () =>
            new Blob([String(url).includes('thumb-lod') ? 'thumbnail' : 'source-image'], {
              type: 'image/png'
            })
        }))
      )
      const sourceBitmap = createBitmap(4096, 2048)
      const thumbnailBitmaps: ReturnType<typeof createBitmap>[] = []
      const pendingSecondThumbnail = deferredBitmap()
      const decode = vi.fn((blob: Blob) => {
        if (blob.size !== 'thumbnail'.length) return Promise.resolve(sourceBitmap)
        if (thumbnailBitmaps.length === 0) {
          thumbnailBitmaps.push(createBitmap(2048, 1024))
          return Promise.resolve(thumbnailBitmaps[0])
        }
        return pendingSecondThumbnail.promise
      })
      vi.stubGlobal('createImageBitmap', decode)
      const item = thumbnailItem()
      const selected = new Set([item.id])
      const { unmount, rerender } = render(
        <Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} selectedIds={selected} />
      )
      // Selected at 100 %: the source texture replaces the thumbnail level.
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(sourceBitmap))
      expect(sourceBitmap.close).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(thumbnailBitmaps).toHaveLength(1))
      const sourceSprite = getLiveSpriteByLabel(item.id)!
      const decodeCountWithSource = decode.mock.calls.length

      // Deselect: the thumbnail level is wanted again, but its texture and pixels are gone.
      rerender(<Layer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} selectedIds={new Set()} />)
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(decodeCountWithSource + 1))
      // No drop to the small preview, and no upload of a closed bitmap, while it decodes.
      expect(getLiveSpriteByLabel(item.id)).toBe(sourceSprite)
      expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()

      const secondThumbnail = createBitmap(2048, 1024)
      await act(async () => pendingSecondThumbnail.resolve(secondThumbnail))
      await waitFor(() =>
        expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(secondThumbnail)
      )
      expect(sourceSprite.destroyed).toBe(true)
      expect(secondThumbnail.close).toHaveBeenCalledTimes(1)
      expect(sourceBitmap.close).toHaveBeenCalledTimes(1)
      unmount()
      expect((item.image as unknown as ImageBitmap).close).not.toHaveBeenCalled()
    })

    it('decodes a released thumbnail level again when its texture has to be refreshed', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const first = createBitmap(1024, 512)
      const second = createBitmap(1024, 512)
      const pendingSecond = deferredBitmap()
      const decode = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(() => pendingSecond.promise)
      vi.stubGlobal('createImageBitmap', decode)
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const item = thumbnailItem()
      const { unmount } = render(
        <Layer ref={ref} items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} stageScale={0.15} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(first))
      const oldSprite = getLiveSpriteByLabel(item.id)!
      const oldSource = oldSprite.texture.source as MockTextureSource
      const preview = { x: item.x, y: item.y, width: item.width, height: item.height, rotation: 0 }

      act(() => ref.current?.syncItemPreview(item.id, { ...preview, scaleX: 0.01, scaleY: 0.01 }))
      act(() => ref.current?.syncItemPreview(item.id, { ...preview, scaleX: 1, scaleY: 1 }))

      expect(oldSource.unload).not.toHaveBeenCalled()
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
      expect(getLiveSpriteByLabel(item.id)).toBe(oldSprite)
      await act(async () => pendingSecond.resolve(second))
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(second))
      expect(oldSprite.texture.destroyed).toBe(true)
      expect(eagerTextureUploads).toEqual([first, second])
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(second.close).toHaveBeenCalledTimes(1)
      unmount()
      expect((item.image as unknown as ImageBitmap).close).not.toHaveBeenCalled()
    })

    const selectableItems = (count: number, sourceSide = 640) =>
      Array.from({ length: count }, (_, index) =>
        createNamedItem(`selectable-${index + 1}`, {
          src: `local-media:///C:/images/selectable-${index + 1}.png`,
          x: 20 + (index % 3) * 260,
          y: 20 + Math.floor(index / 3) * 200,
          sourceWidth: sourceSide,
          sourceHeight: sourceSide,
          zIndex: index
        })
      )
    const lastMetrics = (metrics: ReturnType<typeof vi.fn>) =>
      metrics.mock.calls[metrics.mock.calls.length - 1]?.[0] as
        ProjectCanvasWebGLRuntimeMetrics | undefined

    it('drops every source decode record when a selection is cleared', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmaps: ReturnType<typeof createBitmap>[] = []
      const decode = vi.fn(async () => {
        const bitmap = createBitmap(640, 640)
        bitmaps.push(bitmap)
        return bitmap
      })
      vi.stubGlobal('createImageBitmap', decode)
      const items = selectableItems(6)
      const metrics = vi.fn()
      const { unmount, rerender } = render(
        <Layer
          items={items}
          {...TEST_STAGE_VIEWPORT_1280_720}
          selectedIds={new Set(items.map((item) => item.id))}
          onMetricsChange={metrics}
        />
      )
      // A small selection forces the source texture of every selected image.
      await waitFor(() => {
        expect(bitmaps).toHaveLength(6)
        items.forEach((item) =>
          expect(bitmaps).toContain(getTextureImage(getLiveSpriteByLabel(item.id)))
        )
      })
      await waitFor(() =>
        expect(lastMetrics(metrics)).toMatchObject({
          sourceImageCacheCount: 6,
          usingSourceImageCount: 6,
          decodedResidentBytes: 0
        })
      )

      rerender(
        <Layer
          items={items}
          {...TEST_STAGE_VIEWPORT_1280_720}
          selectedIds={new Set()}
          onMetricsChange={metrics}
        />
      )
      await waitFor(() => {
        items.forEach((item) =>
          expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(item.image)
        )
      })
      await waitFor(() =>
        expect(lastMetrics(metrics)).toMatchObject({
          sourceImageCacheCount: 0,
          usingSourceImageCount: 0,
          decodedResidentBytes: 0
        })
      )
      bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1))
      expect(decode).toHaveBeenCalledTimes(6)
      unmount()
    })

    it.each([
      { side: 640, kept: 4 },
      // 4096 x 4096 is 64 MiB decoded: the 128 MiB cap keeps two of them.
      { side: 4096, kept: 2 }
    ])(
      'keeps at most $kept unused $side px decodes that finished after a deselect',
      async ({ side, kept }) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        const bitmaps: ReturnType<typeof createBitmap>[] = []
        const pending: ReturnType<typeof deferredBitmap>[] = []
        const decode = vi.fn(() => {
          const next = deferredBitmap()
          pending.push(next)
          return next.promise
        })
        vi.stubGlobal('createImageBitmap', decode)
        const items = selectableItems(6, side)
        const metrics = vi.fn()
        const view = (selected: string[]) => (
          <Layer
            items={items}
            {...TEST_STAGE_VIEWPORT_1280_720}
            selectedIds={new Set(selected)}
            onMetricsChange={metrics}
          />
        )
        const { unmount, rerender } = render(view([]))
        await waitFor(() => expect(getLiveSpriteByLabel(items[5].id)).not.toBeNull())

        // Three times: select two images, clear the selection while both source decodes are
        // still running, then let them finish. Nobody wants the six results.
        for (let round = 0; round < 3; round += 1) {
          rerender(view([items[round * 2].id, items[round * 2 + 1].id]))
          await waitFor(() => expect(decode).toHaveBeenCalledTimes((round + 1) * 2))
          rerender(view([]))
          await act(async () => {
            for (const next of pending.splice(0)) {
              const bitmap = createBitmap(side, side)
              bitmaps.push(bitmap)
              next.resolve(bitmap)
            }
          })
          const finished = (round + 1) * 2
          await waitFor(() => {
            expect(bitmaps.filter((bitmap) => isBitmapClosed(bitmap))).toHaveLength(
              Math.max(0, finished - kept)
            )
            expect(lastMetrics(metrics)?.sourceImageCacheCount).toBe(Math.min(kept, finished))
          })
        }

        // The oldest ones were closed, the newest stay for a quick return.
        const closed = bitmaps.filter((bitmap) => isBitmapClosed(bitmap))
        expect(closed).toEqual(bitmaps.slice(0, 6 - kept))
        expect(lastMetrics(metrics)?.decodedResidentBytes).toBe(kept * side * side * 4)
        expect(lastMetrics(metrics)?.decodedResidentBytes).toBeLessThanOrEqual(128 * 1024 * 1024)
        expect(eagerTextureUploads).toEqual([])

        // Selecting the newest again uses the kept decode: no new decode, one upload.
        rerender(view([items[5].id]))
        await waitFor(() =>
          expect(bitmaps).toContain(getTextureImage(getLiveSpriteByLabel(items[5].id)))
        )
        expect(decode).toHaveBeenCalledTimes(6)
        expect(eagerTextureUploads).toHaveLength(1)
        unmount()
        bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1))
      }
    )

    it('gives up unused decodes fifteen seconds after nobody wanted them', async () => {
      const { default: Layer, PROJECT_CANVAS_WEBGL_UNUSED_DECODE_MAX_AGE_MS: maxAgeMs } =
        await import('./ProjectCanvasWebGLImageLayer')
      const bitmaps: ReturnType<typeof createBitmap>[] = []
      const pending: ReturnType<typeof deferredBitmap>[] = []
      const decode = vi.fn(() => {
        const next = deferredBitmap()
        pending.push(next)
        return next.promise
      })
      vi.stubGlobal('createImageBitmap', decode)
      const items = selectableItems(6)
      const metrics = vi.fn()
      const view = (selected: string[]) => (
        <Layer
          items={items}
          {...TEST_STAGE_VIEWPORT_1280_720}
          selectedIds={new Set(selected)}
          onMetricsChange={metrics}
        />
      )
      const { unmount, rerender } = render(view([]))
      await waitFor(() => expect(getLiveSpriteByLabel(items[5].id)).not.toBeNull())

      // Two source decodes finish after the selection that asked for them is gone.
      rerender(view([items[0].id, items[1].id]))
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
      rerender(view([]))

      // From here the clock and the timers are moved by hand; animation frames stay real.
      const realSetTimeout = globalThis.setTimeout
      const startedAt = performance.now()
      let elapsedMs = 0
      vi.spyOn(window.performance, 'now').mockImplementation(() => startedAt + elapsedMs)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const advance = async (ms: number) => {
        for (let passed = 0; passed < ms; passed += 250) {
          elapsedMs += 250
          await act(async () => {
            vi.advanceTimersByTime(250)
            await new Promise((resolve) => realSetTimeout(resolve, 20))
          })
        }
      }
      try {
        await act(async () => {
          for (const next of pending.splice(0)) {
            const bitmap = createBitmap(640, 640)
            bitmaps.push(bitmap)
            next.resolve(bitmap)
          }
        })
        await advance(1000)
        expect(lastMetrics(metrics)).toMatchObject({
          sourceImageCacheCount: 2,
          decodedResidentBytes: 2 * 640 * 640 * 4
        })
        expect(bitmaps.some((bitmap) => isBitmapClosed(bitmap))).toBe(false)

        // Still there shortly before the limit...
        await advance(maxAgeMs - 3000)
        expect(bitmaps.some((bitmap) => isBitmapClosed(bitmap))).toBe(false)
        // ...and closed after it, with nothing left on the books.
        await advance(4000)
        bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1))
        expect(lastMetrics(metrics)).toMatchObject({
          sourceImageCacheCount: 0,
          decodedResidentBytes: 0
        })
        expect(eagerTextureUploads).toEqual([])
      } finally {
        vi.useRealTimers()
        vi.restoreAllMocks()
      }

      // The image is decoded again when it is wanted the next time.
      rerender(view([items[0].id]))
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(3))
      unmount()
    }, 30000)

    it('evicts the oldest waiting decodes above the hard limit without starving the upload', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmaps: ReturnType<typeof createBitmap>[] = []
      const pending: ReturnType<typeof deferredBitmap>[] = []
      const decode = vi.fn(() => {
        const next = deferredBitmap()
        pending.push(next)
        return next.promise
      })
      vi.stubGlobal('createImageBitmap', decode)
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const items = Array.from({ length: 6 }, (_, index) => {
        const fixture = createThumbnailSetFixture(`hard-limit-${index}`)
        return createNamedItem(`hard-limit-${index}`, {
          ...fixture,
          thumbnailSet: {
            ...fixture.thumbnailSet,
            levels: fixture.thumbnailSet.levels.map((level) => ({
              ...level,
              src: level.src.replace('thumb-lod', `C:/thumb-lod-${index}`)
            }))
          },
          src: `local-media:///C:/images/hard-limit-${index}.png`,
          image: createBitmap(192, 96) as unknown as HTMLImageElement,
          // Stacked and 960 px wide on screen: every item asks for its largest (2048) level,
          // so the oversized test bitmaps cannot make the layer ask for another level.
          x: 0,
          y: 0,
          zIndex: index,
          width: 3200,
          height: 1400,
          sourceWidth: 4096,
          sourceHeight: 2048
        })
      })
      const { unmount } = render(
        <Layer ref={ref} items={items} {...TEST_STAGE_VIEWPORT_1280_720} stageScale={0.3} />
      )
      // Six thumbnail levels decode at once.
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(6))
      // While the viewport moves, finished decodes wait for the next reconcile pass.
      act(() => ref.current?.setViewportInteracting(true))
      await act(async () => {
        for (const next of pending.splice(0)) {
          // 64 MiB each: six of them are 384 MiB, above the 256 MiB limit.
          const bitmap = createBitmap(4096, 4096)
          bitmaps.push(bitmap)
          next.resolve(bitmap)
        }
      })
      // The two oldest were given up at once; the four newest (256 MiB) wait for their upload.
      expect(bitmaps.map((bitmap) => isBitmapClosed(bitmap))).toEqual([
        true,
        true,
        false,
        false,
        false,
        false
      ])
      expect(eagerTextureUploads).toEqual([])

      act(() => ref.current?.setViewportInteracting(false))
      // The four are uploaded, and the two evicted levels are decoded again.
      await waitFor(() => expect(eagerTextureUploads).toHaveLength(4))
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(8))
      await act(async () => {
        for (const next of pending.splice(0)) {
          const bitmap = createBitmap(4096, 4096)
          bitmaps.push(bitmap)
          next.resolve(bitmap)
        }
      })
      await waitFor(() => expect(eagerTextureUploads).toHaveLength(6))
      items.forEach((item) =>
        expect(bitmaps).toContain(getTextureImage(getLiveSpriteByLabel(item.id)))
      )
      expect(decode).toHaveBeenCalledTimes(8)
      unmount()
      bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1))
    })

    it('does not cancel a shared source decode when only one pending consumer leaves', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmap = createBitmap(640, 360)
      const pending = deferredBitmap()
      const decode = vi.fn(() => pending.promise)
      vi.stubGlobal('createImageBitmap', decode)
      const { sourceIdentity } = createThumbnailSetFixture('shared-source-bitmap')
      const a = localSourceItem({ sourceIdentity })
      const b = { ...a, id: 'shared-source-b' }
      const { unmount, rerender } = render(
        <Layer items={[a, b]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
      rerender(<Layer items={[b]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await act(async () => pending.resolve(bitmap))
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(b.id))).toBe(bitmap))
      expect(bitmap.close).toHaveBeenCalledTimes(1)
      expect(eagerTextureUploads).toEqual([bitmap])
      expect(decode).toHaveBeenCalledTimes(1)
      unmount()
      expect(bitmap.close).toHaveBeenCalledTimes(1)
    })

    it('never closes a borrowed bitmap shared by provided sprites', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const bitmap = createBitmap(640, 360)
      const a = createItem({ image: bitmap as unknown as HTMLImageElement, src: '' })
      const b = { ...a, id: 'borrowed-b' }
      const { unmount, rerender } = render(
        <Layer items={[a, b]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(b.id))).toBe(bitmap))
      rerender(<Layer items={[b]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      expect(bitmap.close).not.toHaveBeenCalled()
      unmount()
      expect(bitmap.close).not.toHaveBeenCalled()
    })
  })

  it('shares one source texture across stable-source crops with independent decoded objects and destroys it after the final consumer leaves', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const firstDecodedImage = createImage(400, 240)
    const secondDecodedImage = createImage(400, 240)
    const sharedIdentity: CanvasImageSourceIdentity = {
      version: 1,
      kind: 'local-file',
      cacheKey: 'shared-crop-source',
      canonicalPath: 'C:/images/shared.png',
      sizeBytes: 1_024,
      lastModifiedMs: 1
    }
    const first = createItem({
      id: 'shared-crop-a',
      src: 'local-media:///C:/images/shared.png',
      image: firstDecodedImage,
      sourceIdentity: sharedIdentity,
      crop: { x: 0, y: 0, width: 200, height: 240 }
    })
    const second = createItem({
      id: 'shared-crop-b',
      src: first.src,
      x: 260,
      image: secondDecodedImage,
      sourceIdentity: sharedIdentity,
      crop: { x: 200, y: 0, width: 200, height: 240 }
    })

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer items={[first, second]} {...TEST_STAGE_VIEWPORT_1280_720} />
    )

    await waitFor(() => {
      expect(getLiveSpriteByLabel(first.id)).not.toBeNull()
      expect(getLiveSpriteByLabel(second.id)).not.toBeNull()
    })
    expect(createdBaseTextures).toHaveLength(1)

    rerender(<ProjectCanvasWebGLImageLayer items={[second]} {...TEST_STAGE_VIEWPORT_1280_720} />)
    await waitFor(() => expect(getLiveSpriteByLabel(first.id)).toBeNull())
    expect(createdBaseTextures[0].destroyed).toBe(false)

    rerender(<ProjectCanvasWebGLImageLayer items={[]} {...TEST_STAGE_VIEWPORT_1280_720} />)
    await waitFor(() => expect(getLiveSpriteByLabel(second.id)).toBeNull())
    expect(createdBaseTextures[0].destroyed).toBe(true)
    expect(createdBaseTextures[0].destroySourceCalled).toBe(true)
  })

  it('dedupes immutable data URLs across independent provided image objects', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const src = 'data:image/png;base64,c2FtZS1waXhlbHM='
    const first = createItem({
      id: 'data-url-a',
      src,
      image: createImage(320, 180)
    })
    const second = createItem({
      id: 'data-url-b',
      src,
      x: 360,
      image: createImage(320, 180)
    })

    render(
      <ProjectCanvasWebGLImageLayer items={[first, second]} {...TEST_STAGE_VIEWPORT_1280_720} />
    )

    await waitFor(() => {
      expect(getLiveSpriteByLabel(first.id)).not.toBeNull()
      expect(getLiveSpriteByLabel(second.id)).not.toBeNull()
    })
    expect(createdBaseTextures).toHaveLength(1)
  })

  it('keeps Spatial Tile opt-in disabled while the ordinary image path remains active', async () => {
    const { default: ProjectCanvasWebGLImageLayer, PROJECT_CANVAS_WEBGL_SPATIAL_TILE_ENABLED } =
      await import('./ProjectCanvasWebGLImageLayer')
    expect(PROJECT_CANVAS_WEBGL_SPATIAL_TILE_ENABLED).toBe(false)
    const item = createSizedNamedItem('spatial-tile-disabled', 200, 120, 8192, 8192, 200, 120)
    render(<ProjectCanvasWebGLImageLayer items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />)
    await waitFor(() => expect(getLiveSpriteByLabel(item.id)).not.toBeNull())
    expect(createdBaseTextures).toHaveLength(1)
  })

  it('initializes Pixi with explicit canvas clearing to avoid transparent-frame trails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')

    render(
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
      },
      { timeout: 15000 }
    )

    expect(createdApplications[0].initOptions).toMatchObject({
      backgroundAlpha: 0,
      clearBeforeRender: true
    })
  })

  it('turns the Pixi garbage collector off and keeps its textures through a long idle period', async () => {
    vi.stubGlobal('electronFile', {
      resolveAuthorizedLocalMediaPath: vi.fn(async (path: string) => path)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => new Blob(['image'], { type: 'image/png' })
      }))
    )
    const bitmap = createBitmap(640, 360)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap)
    )
    const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
    const bitmapItem = createNamedItem('gc-bitmap', {
      src: 'local-media:///C:/images/gc-bitmap.png',
      sourceWidth: 640,
      sourceHeight: 360,
      image: undefined as unknown as HTMLImageElement
    })
    const htmlItem = createNamedItem('gc-html', { x: 400 })
    try {
      const { unmount } = render(
        <Layer items={[bitmapItem, htmlItem]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      await waitFor(() => {
        expect(getTextureImage(getLiveSpriteByLabel(bitmapItem.id))).toBe(bitmap)
        expect(getLiveSpriteByLabel(htmlItem.id)).not.toBeNull()
      })
      const app = createdApplications[0]
      // Pixi's collector would unload a texture after 60 s without use and upload its
      // resource again on the next draw. The bitmap is closed by then, so it must stay off,
      // and every texture of the layer is exempt even if the collector is switched on.
      expect(app.initOptions).toMatchObject({ gcActive: false })
      expect(app.initOptions).not.toHaveProperty('textureGCActive')
      expect(createdBaseTextures.length).toBeGreaterThanOrEqual(2)
      createdBaseTextures.forEach((texture) => {
        expect((texture.source as { autoGarbageCollect?: boolean }).autoGarbageCollect).toBe(false)
      })
      expect(bitmap.close).toHaveBeenCalledTimes(1)

      vi.useFakeTimers()
      ;(app.render as unknown as () => void)()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000)
      })
      expect(() => (app.render as unknown as () => void)()).not.toThrow()
      createdBaseTextures.forEach((texture) => {
        const source = texture.source as MockTextureSource
        expect(source.unload).not.toHaveBeenCalled()
        expect(source.gpuValid).toBe(true)
      })
      // The resource of the bitmap texture was read exactly once, for its first upload.
      expect(eagerTextureUploads).toEqual([bitmap])
      expect(getTextureImage(getLiveSpriteByLabel(bitmapItem.id))).toBe(bitmap)
      unmount()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
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

  it('creates Pixi textures with straight-alpha blending so transparent pixels stay transparent', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')

    render(
      <ProjectCanvasWebGLImageLayer
        items={[createItem()]}
        stagePos={{ x: 0, y: 0 }}
        stageScale={1}
        stageSize={{ width: 640, height: 480 }}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(1)
      },
      { timeout: 15000 }
    )

    expect(textureFromAlphaModes).toEqual(['no-premultiply-alpha'])
  }, 30000)

  it('skips clean resident sprite rebuilds while preserving full reconcile emissions', async () => {
    const buildRenderableImageSpy = vi.fn()
    vi.doMock('../projectCanvasRenderBoundary', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../projectCanvasRenderBoundary')>()
      buildRenderableImageSpy.mockImplementation(actual.buildProjectCanvasRenderableImage)
      return {
        ...actual,
        buildProjectCanvasRenderableImage: buildRenderableImageSpy
      }
    })
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const initialItems = createItems(3)
    const residentIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const handleResidentIdsChange = (residentIds: Set<string>) => {
      residentIdsCalls.push(new Set(residentIds))
    }
    const handleMetricsChange = (metrics: ProjectCanvasWebGLRuntimeMetrics) => {
      metricsCalls.push(metrics)
    }
    const expectedResidentIds = new Set(initialItems.map((item) => item.id))

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={initialItems}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onResidentIdsChange={handleResidentIdsChange}
        onMetricsChange={handleMetricsChange}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(3)
        expect(residentIdsCalls.at(-1)).toEqual(expectedResidentIds)
      },
      { timeout: 15000 }
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    const initialPassCount = metricsCalls.at(-1)?.spriteReconcilePassCount ?? 0
    buildRenderableImageSpy.mockClear()

    const movedItem = { ...initialItems[1], x: initialItems[1].x + 37 }
    const updatedItems = [initialItems[0], movedItem, initialItems[2]]
    rerender(
      <ProjectCanvasWebGLImageLayer
        items={updatedItems}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onResidentIdsChange={handleResidentIdsChange}
        onMetricsChange={handleMetricsChange}
      />
    )

    await waitFor(
      () => {
        expect(getLiveSpriteByLabel(movedItem.id)?.position.x).toBe(movedItem.x)
        expect(metricsCalls.at(-1)?.spriteReconcilePassCount ?? 0).toBeGreaterThan(initialPassCount)
      },
      { timeout: 15000 }
    )

    expect(buildRenderableImageSpy).toHaveBeenCalledTimes(1)
    expect(buildRenderableImageSpy.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: movedItem.id
      })
    )
    expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(3)
    expect(createdSprites).toHaveLength(3)
    expect(residentIdsCalls.at(-1)).toEqual(expectedResidentIds)
    expect(metricsCalls.at(-1)).toEqual(
      expect.objectContaining({
        imageCount: 3,
        residentImageCount: 3,
        residentCandidateImageCount: 3,
        lastSpriteReconcileTargetCount: 3,
        lastSpriteReconcileCreatedCount: 0,
        lastSpriteReconcileReusedCount: 3,
        lastSpriteReconcileRemovedCount: 0,
        lastSpriteReconcileDeferredCount: 0
      })
    )
  }, 30000)

  it('does not rescan resident texture sampling on every viewport sync', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={createItems(3)}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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

    // A rotated preview is drawn by the edge-antialiased mesh, a unit quad: its scale is the
    // previewed size on the canvas (200 x 1.5 by 120 x 0.5).
    const rotatedPreview = getLiveSpriteByLabel('image-1')!
    expect(rotatedPreview.kind).toBe('mesh')
    expect(rotatedPreview.position.x).toBe(80)
    expect(rotatedPreview.position.y).toBe(90)
    expect(rotatedPreview.scale.x).toBe(300)
    expect(rotatedPreview.scale.y).toBe(60)
    expect(rotatedPreview.rotation).toBeCloseTo(Math.PI / 12)
    expect(app.render).toHaveBeenCalledTimes(renderCountBeforePreview + 1)

    const renderCountBeforeClear = app.render.mock.calls.length
    act(() => {
      ref.current?.syncItemPreview('image-1', null)
    })

    const restored = getLiveSpriteByLabel('image-1')!
    expect(restored.kind).toBe('sprite')
    expect(restored.position.x).toBe(24)
    expect(restored.position.y).toBe(36)
    expect(restored.scale.x).toBe(2)
    expect(restored.scale.y).toBe(2)
    expect(restored.rotation).toBe(0)
    expect(app.render).toHaveBeenCalledTimes(renderCountBeforeClear + 1)
  }, 15000)

  it('drops preview state when an item is removed before its id is reused', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const item = createItem({ id: 'reused-preview-item' })
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer ref={ref} items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />
    )

    await waitFor(
      () => {
        expect(ref.current).not.toBeNull()
        expect(getLiveSpriteByLabel(item.id)).not.toBeNull()
      },
      { timeout: 15000 }
    )

    act(() => {
      ref.current?.syncItemPreview(item.id, {
        x: 400,
        y: 500,
        width: item.width,
        height: item.height,
        scaleX: item.scaleX,
        scaleY: item.scaleY,
        rotation: item.rotation
      })
    })
    expect(getLiveSpriteByLabel(item.id)?.position.x).toBe(400)

    rerender(<ProjectCanvasWebGLImageLayer items={[]} {...TEST_STAGE_VIEWPORT_1280_720} />)
    await waitFor(() => expect(getLiveSpriteByLabel(item.id)).toBeNull(), { timeout: 15000 })

    rerender(
      <ProjectCanvasWebGLImageLayer ref={ref} items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />
    )
    await waitFor(() => expect(getLiveSpriteByLabel(item.id)).not.toBeNull(), { timeout: 15000 })
    expect(getLiveSpriteByLabel(item.id)?.position.x).toBe(item.x)
  }, 30000)

  it('refreshes the texture source when a tiny preview grows back to visible size', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[createItem()]}
        {...TEST_STAGE_VIEWPORT_1280_720}
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

  it('decodes a released level again instead of unloading it when a tiny preview grows back', async () => {
    vi.stubGlobal('electronFile', {
      resolveAuthorizedLocalMediaPath: vi.fn(async (path: string) => path)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => new Blob(['image'], { type: 'image/png' })
      }))
    )
    const first = createBitmap(640, 360)
    const second = createBitmap(640, 360)
    const pendingSecond = deferredBitmap()
    const decode = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => pendingSecond.promise)
    vi.stubGlobal('createImageBitmap', decode)
    const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const item = createItem({
      src: 'local-media:///C:/images/tiny-refresh.png',
      sourceWidth: 640,
      sourceHeight: 360,
      image: undefined as unknown as HTMLImageElement
    })
    try {
      const { unmount } = render(
        <Layer ref={ref} items={[item]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(first))
      expect(first.close).toHaveBeenCalledTimes(1)
      const oldSprite = getLiveSpriteByLabel(item.id)!
      const oldSource = oldSprite.texture.source as MockTextureSource
      const preview = { x: 24, y: 36, width: 200, height: 120, rotation: 0 }

      act(() => ref.current?.syncItemPreview(item.id, { ...preview, scaleX: 0.1, scaleY: 0.1 }))
      act(() => ref.current?.syncItemPreview(item.id, { ...preview, scaleX: 1, scaleY: 1 }))

      // Unloading would make Pixi upload the closed bitmap again. The level is decoded again
      // instead, and the texture on screen stays until the replacement exists.
      expect(oldSource.unload).not.toHaveBeenCalled()
      await waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
      expect(getLiveSpriteByLabel(item.id)).toBe(oldSprite)
      expect(() => (createdApplications[0].render as unknown as () => void)()).not.toThrow()

      await act(async () => pendingSecond.resolve(second))
      await waitFor(() => expect(getTextureImage(getLiveSpriteByLabel(item.id))).toBe(second))
      expect(oldSprite.destroyed).toBe(true)
      expect(oldSprite.texture.destroyed).toBe(true)
      expect(eagerTextureUploads).toEqual([first, second])
      expect(second.close).toHaveBeenCalledTimes(1)
      expect(first.close).toHaveBeenCalledTimes(1)
      // One re-acquire per refresh: nothing is decoded a third time.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
      })
      expect(decode).toHaveBeenCalledTimes(2)
      unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  }, 15000)

  it('recreates sprite state when the texture key changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const initialItem = createItem()
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const onMetricsChange = (metrics: ProjectCanvasWebGLRuntimeMetrics) => {
      metricsCalls.push(metrics)
    }
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={[initialItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onMetricsChange={onMetricsChange}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
        onMetricsChange={onMetricsChange}
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
    await waitFor(
      () => {
        expect(
          metricsCalls.some(
            (metrics) =>
              metrics.lastSpriteReconcileCreatedCount === 1 &&
              metrics.lastSpriteReconcileReusedCount === 0 &&
              metrics.lastSpriteReconcileRemovedCount === 1
          )
        ).toBe(true)
      },
      { timeout: 15000 }
    )
  }, 30000)

  it('does not reuse a stale texture when the same URL is refreshed with a new decoded object', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const firstImage = createImage(200, 120)
    const secondImage = createImage(200, 120)
    const first = createItem({ src: 'https://example.test/same.png', image: firstImage })
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer items={[first]} {...TEST_STAGE_VIEWPORT_1280_720} />
    )

    await waitFor(() => expect(createdBaseTextures).toHaveLength(1))
    const firstTexture = createdBaseTextures[0]

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={[createItem({ src: first.src, image: secondImage })]}
        {...TEST_STAGE_VIEWPORT_1280_720}
      />
    )

    await waitFor(() => expect(createdBaseTextures).toHaveLength(2))
    expect(firstTexture.destroyed).toBe(true)
    expect((createdBaseTextures[1].source as { image?: unknown }).image).toBe(secondImage)
  })

  it('re-sorts sprites when an item z-index changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const firstItem = createItem({ id: 'image-1', zIndex: 1 })
    const secondItem = createNamedItem('image-2', { x: 48, y: 60, zIndex: 2 })
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const onMetricsChange = (metrics: ProjectCanvasWebGLRuntimeMetrics) => {
      metricsCalls.push(metrics)
    }

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={[firstItem, secondItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onMetricsChange={onMetricsChange}
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
    await waitFor(
      () => {
        expect(metricsCalls.at(-1)?.spriteSortCount ?? 0).toBeGreaterThanOrEqual(1)
      },
      { timeout: 15000 }
    )
    const initialSpriteSortCount = metricsCalls.at(-1)?.spriteSortCount ?? 0
    const initialReconcilePassCount = metricsCalls.at(-1)?.spriteReconcilePassCount ?? 0
    const movedFirstItem = { ...firstItem, x: firstItem.x + 12 }

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={[movedFirstItem, secondItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onMetricsChange={onMetricsChange}
      />
    )

    await waitFor(
      () => {
        expect(metricsCalls.at(-1)?.spriteReconcilePassCount ?? 0).toBeGreaterThan(
          initialReconcilePassCount
        )
      },
      { timeout: 15000 }
    )
    expect(metricsCalls.at(-1)?.spriteSortCount).toBe(initialSpriteSortCount)

    rerender(
      <ProjectCanvasWebGLImageLayer
        items={[{ ...movedFirstItem, zIndex: 3 }, secondItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onMetricsChange={onMetricsChange}
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
    expect(metricsCalls.at(-1)?.spriteSortCount).toBeGreaterThan(initialSpriteSortCount)
    expect(metricsCalls.at(-1)?.lastSpriteSortDurationMs).toEqual(expect.any(Number))
    expect(metricsCalls.at(-1)?.lastSpriteSortDurationMs ?? -1).toBeGreaterThanOrEqual(0)
  }, 30000)

  it('keeps sprite order deterministic for equal zIndex items', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const firstItem = createNamedItem('image-equal-first', { x: 80, y: 96, zIndex: 5 })
    const secondItem = createNamedItem('image-equal-second', { x: 80, y: 96, zIndex: 5 })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[secondItem, firstItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
      />
    )

    await waitFor(
      () => {
        expect(createdSprites).toHaveLength(2)
      },
      { timeout: 15000 }
    )

    expect(createdSprites[0].parent?.children.map((sprite) => sprite.label)).toEqual([
      'image-equal-second',
      'image-equal-first'
    ])
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const onMetricsChange = (metrics: ProjectCanvasWebGLRuntimeMetrics) => {
      metricsCalls.push(metrics)
    }

    render(
      <ProjectCanvasWebGLImageLayer
        items={[createItem()]}
        {...TEST_STAGE_VIEWPORT_1280_720}
        onMetricsChange={onMetricsChange}
      />
    )

    await waitFor(
      () => {
        expect(metricsCalls.length).toBeGreaterThan(0)
      },
      { timeout: 15000 }
    )

    const firstMetrics = metricsCalls[0]
    expect(firstMetrics).toEqual({
      isInitialized: true,
      imageCount: 0,
      loadedImageCount: 0,
      failedImageCount: 0,
      residentImageCount: 0,
      residentTextureBytes: 0,
      residentCandidateTextureBytes: 0,
      residentTextureBudgetBytes: PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES,
      gpuTextureBytesTotal: 0,
      decodedResidentBytes: 0,
      encodedBlobBytes: 0,
      tileResidentBytes: 0,
      gpuUploadBytesInFlight: 0,
      thumbnailJobs: 0,
      sourceJobs: 0,
      tileVisibleJobs: 0,
      tilePrefetchJobs: 0,
      resourceBudgetReservationCount: 0,
      resourceBudgetEvictableReservationCount: 0,
      pendingImageCount: 0,
      spriteCount: 0,
      residentCandidateImageCount: 0,
      viewportCulledImageCount: 0,
      spriteReconcilePassCount: 0,
      lastSpriteReconcileDurationMs: null,
      lastSpriteSortDurationMs: null,
      spriteSortCount: 0,
      lastSpriteReconcileCandidateCount: 0,
      lastSpriteReconcileTargetCount: 0,
      lastSpriteReconcileCreatedCount: 0,
      lastSpriteReconcileReusedCount: 0,
      lastSpriteReconcileRemovedCount: 0,
      lastSpriteReconcileDeferredCount: 0,
      usingPreviewImageCount: 0,
      usingSourceImageCount: 0,
      thumbnailPreviewImageCount: 0,
      placeholderImageCount: 0,
      sourceUpgradeSuppressedImageCount: 0,
      sourceUpgradeablePreviewImageCount: 0,
      sourceUpgradePendingImageCount: 0,
      sourceUpgradeFailedImageCount: 0,
      missingImageCount: 0,
      activeObjectUrlCount: 0,
      revokedObjectUrlCount: 0,
      activeImageBitmapCount: 0,
      closedImageBitmapCount: 0,
      releaseErrorCount: 0,
      decodedInFlightBytes: 0,
      activeSourceUpgradeCount: 0,
      residentTextureBudgetPressureCount: 0,
      textureBudgetEvictionCount: 0,
      sourceImageCacheCount: 0,
      thumbnailImageCacheCount: 0,
      sourceUpgradeQueueCount: 0,
      thumbnailLoadQueueCount: 0,
      initialLoadQueueCount: 0,
      tileEnabledItemCount: 0,
      tileQueuedCount: 0,
      tileRunningCount: 0,
      tileCompletedCount: 0,
      tileCancelledCount: 0,
      tileDedupedCount: 0,
      tileFailedCount: 0,
      tileStaleDisposedCount: 0,
      tileActiveCount: 0,
      tileActiveAssetCount: 0,
      tileDisposedAssetCount: 0,
      tileDisposeErrorCount: 0,
      renderCount: firstMetrics.renderCount,
      lastRenderDurationMs: firstMetrics.lastRenderDurationMs,
      lastUpdateReason: 'initialize'
    })
    expect(firstMetrics.renderCount).toBeGreaterThanOrEqual(0)
    expect(
      firstMetrics.lastRenderDurationMs === null || firstMetrics.lastRenderDurationMs >= 0
    ).toBe(true)
  }, 15000)

  it('keeps only viewport-adjacent images resident in the GPU layer', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const visibleItem = createItem({ id: 'image-visible', x: 24, y: 36 })
    const farItem = createNamedItem('image-far', { x: 4800, y: 3600 })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[visibleItem, farItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const latestMetrics = metricsCalls.at(-1)
    expect(latestMetrics).toEqual(
      expect.objectContaining({
        imageCount: 2,
        loadedImageCount: 2,
        failedImageCount: 0,
        residentImageCount: 1,
        residentCandidateImageCount: 1,
        viewportCulledImageCount: 1,
        lastSpriteReconcileCandidateCount: 1,
        lastSpriteReconcileTargetCount: 1,
        lastSpriteReconcileDeferredCount: 0
      })
    )
    expect(latestMetrics?.lastSpriteReconcileCreatedCount).toBeGreaterThanOrEqual(0)
    expect(latestMetrics?.lastSpriteReconcileReusedCount).toBeGreaterThanOrEqual(0)
    expect(
      (latestMetrics?.lastSpriteReconcileCreatedCount ?? 0) +
        (latestMetrics?.lastSpriteReconcileReusedCount ?? 0)
    ).toBeGreaterThanOrEqual(1)
    expect(latestMetrics?.lastSpriteReconcileRemovedCount).toBeGreaterThanOrEqual(0)
    expect(latestMetrics?.spriteReconcilePassCount).toBeGreaterThanOrEqual(1)
    expect(latestMetrics?.lastSpriteReconcileDurationMs).toBeGreaterThanOrEqual(0)
  }, 30000)

  it('keeps selected images resident even when they sit just outside the viewport budget', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const residentIdsCalls: Set<string>[] = []
    const selectedEdgeItem = createNamedItem('image-selected-edge', { x: 1700, y: 48 })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[selectedEdgeItem]}
        selectedIds={new Set([selectedEdgeItem.id])}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const selectedItem = createNamedItem('image-selected-stable')
    const stableItems = [selectedItem]

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        items={stableItems}
        selectedIds={new Set([selectedItem.id])}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const selectedItems = Array.from(
      { length: PROJECT_CANVAS_WEBGL_SELECTED_RESIDENT_LIMIT + 1 },
      (_, index) =>
        createNamedItem(`image-selected-large-${index + 1}`, {
          x: 5000 + index * 320,
          y: 5000,
          zIndex: index
        })
    )

    render(
      <ProjectCanvasWebGLImageLayer
        items={selectedItems}
        selectedIds={new Set(selectedItems.map((item) => item.id))}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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

  it('tears down the WebGL canvas and reports not-ready when WebGL reports a runtime error', async () => {
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
          {...TEST_STAGE_VIEWPORT_1280_720}
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
      // The error check is sampled: let the check that follows the first texture pass (one
      // interval after it), and then more than another interval go by.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2300))
      })
      app.renderer.gl.getError.mockImplementationOnce(() => app.renderer.gl.OUT_OF_MEMORY)

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
        expect.objectContaining({
          message: 'WebGL renderer reported OUT_OF_MEMORY (1285).'
        })
      )
    } finally {
      consoleWarnSpy.mockRestore()
    }
  }, 30000)

  it('does not ask the GPU for errors after every new texture', async () => {
    const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
    // 24 images arrive four at a time, as during an import: 24 new textures, many renders.
    const items = Array.from({ length: 24 }, (_, index) =>
      createNamedItem(`imported-${index}`, { x: (index % 6) * 210, y: Math.floor(index / 6) * 130 })
    )
    const view = (count: number) => (
      <Layer items={items.slice(0, count)} {...TEST_STAGE_VIEWPORT_1280_720} />
    )
    const { rerender } = render(view(4))
    await waitFor(() => expect(createdSprites).toHaveLength(4))
    const app = createdApplications[0]
    const startedAt = performance.now()
    const rendersBefore = app.render.mock.calls.length
    const checksBefore = app.renderer.gl.getError.mock.calls.length
    for (let count = 8; count <= 24; count += 4) {
      rerender(view(count))
      await waitFor(() => expect(createdSprites).toHaveLength(count))
      await waitFor(() => expect(app.render.mock.calls.length).toBeGreaterThan(rendersBefore))
    }
    const elapsedSeconds = (performance.now() - startedAt) / 1000

    expect(createdBaseTextures.length).toBe(24)
    const checks = app.renderer.gl.getError.mock.calls.length - checksBefore
    // One sampled check per second at most (plus the one that may be due right now), not one
    // per texture.
    expect(checks).toBeLessThanOrEqual(Math.ceil(elapsedSeconds) + 1)
    expect(checks).toBeLessThan(20)
  }, 30000)

  it('notices a failed texture upload about a second later, even without another render', async () => {
    const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
    const readyCalls: boolean[] = []
    const handleReadyChange = (ready: boolean) => readyCalls.push(ready)
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const first = [createItem()]
      const { rerender } = render(
        <Layer items={first} {...TEST_STAGE_VIEWPORT_1280_720} onReadyChange={handleReadyChange} />
      )
      await waitFor(() => expect(createdSprites).toHaveLength(1))
      const app = createdApplications[0]
      // Let the sampled check that follows the first texture pass.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1200))
      })
      expect(readyCalls.at(-1)).toBe(true)

      // The upload of the next texture fails on the GPU.
      app.renderer.gl.getError.mockImplementation(() => app.renderer.gl.OUT_OF_MEMORY)
      rerender(
        <Layer
          items={[...first, createNamedItem('too-much', { x: 400 })]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          onReadyChange={handleReadyChange}
        />
      )
      await waitFor(() => expect(createdBaseTextures).toHaveLength(2))
      // Nothing else happens on the canvas; the sampled check finds the error.
      await waitFor(() => expect(readyCalls.at(-1)).toBe(false), { timeout: 4000 })
      expect(document.querySelector('canvas')).toBeNull()
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Canvas WebGL] Pixi render failed; falling back to non-WebGL image rendering.',
        expect.objectContaining({ message: 'WebGL renderer reported OUT_OF_MEMORY (1285).' })
      )
    } finally {
      consoleWarnSpy.mockRestore()
    }
  }, 30000)

  it('samples WebGL errors during repeated preview renders instead of checking every frame', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[createItem()]}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const initialErrorCheckCount = app.renderer.gl.getError.mock.calls.length

    for (let index = 0; index < 20; index += 1) {
      act(() => {
        ref.current?.syncItemPreview('image-1', {
          // Every step moves the image (the item itself is at x 24), so every step renders.
          x: 25 + index,
          y: 36,
          width: 200,
          height: 120,
          scaleX: 1,
          scaleY: 1,
          rotation: 0
        })
      })
    }

    const additionalRenderCount = app.render.mock.calls.length - initialRenderCount
    const additionalErrorCheckCount =
      app.renderer.gl.getError.mock.calls.length - initialErrorCheckCount
    expect(additionalRenderCount).toBeGreaterThanOrEqual(20)
    expect(additionalErrorCheckCount).toBeGreaterThanOrEqual(0)
    expect(additionalErrorCheckCount).toBeLessThan(additionalRenderCount)
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
          {...TEST_STAGE_VIEWPORT_1280_720}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const handleMetricsChange = (metrics: ProjectCanvasWebGLRuntimeMetrics) => {
      metricsCalls.push(metrics)
    }

    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)

    try {
      const stableItems = [createItem()]
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={stableItems}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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

    const rendersAfterFirstSync = app.render.mock.calls.length

    act(() => {
      ref.current?.syncViewport({ x: 96, y: 72 }, 1.25)
    })

    expect(app.render.mock.calls.length).toBe(rendersAfterFirstSync)

    act(() => {
      ref.current?.syncViewport({ x: 96, y: 72 }, 8)
    })

    expect(app.render.mock.calls.length).toBeGreaterThan(rendersAfterFirstSync)
    expect((createdSprites[0].texture.source as { scaleMode?: string }).scaleMode).toBe('linear')
  }, 15000)

  describe('edge antialiasing without a multisampled buffer', () => {
    const rotatedItem = (rotation: number, overrides: Partial<CanvasImageItem> = {}) =>
      createItem({ rotation, x: 300, y: 200, ...overrides })
    const liveObject = (id = 'image-1') => getLiveSpriteByLabel(id)!
    const world = () => liveObject().parent!

    it('creates the WebGL context without multisampling', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      render(<Layer items={[createItem()]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(createdApplications).toHaveLength(1))
      expect(createdApplications[0].initOptions).toMatchObject({ antialias: false })
    })

    it.each([0, 90, -90, 180, 270, 360])(
      'draws an image rotated by %i degrees as a plain sprite',
      async (rotation) => {
        const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
        render(<Layer items={[rotatedItem(rotation)]} {...TEST_STAGE_VIEWPORT_1280_720} />)
        await waitFor(() => expect(getLiveSpriteByLabel('image-1')).not.toBeNull())
        expect(liveObject().kind).toBe('sprite')
        expect(createdEdgeAntialiasShaders).toEqual([])
        // Texture pixels scaled to the item size.
        expect(liveObject().scale.x).toBe(2)
        expect(liveObject().scale.y).toBe(2)
      }
    )

    it('draws a rotated image with the edge-antialiased mesh, at the same place and size', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const { unmount } = render(
        <Layer
          items={[rotatedItem(15, { scaleX: 1.5, zIndex: 4 })]}
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )
      await waitFor(() => expect(getLiveSpriteByLabel('image-1')).not.toBeNull())
      const mesh = liveObject()
      expect(mesh.kind).toBe('mesh')
      expect(mesh.position.x).toBe(300)
      expect(mesh.position.y).toBe(200)
      expect(mesh.rotation).toBeCloseTo((15 * Math.PI) / 180)
      expect(mesh.zIndex).toBe(4)
      // A unit quad: the scale is the item's size on the canvas (200 x 120, scaleX 1.5).
      expect(mesh.scale.x).toBe(300)
      expect(mesh.scale.y).toBe(120)
      expect(createdEdgeAntialiasShaders).toHaveLength(1)
      expect(mesh.shader?.resources.uTexture).toBe(mesh.texture.source)
      expect(mesh.shader?.resources.textureUniforms).toEqual({
        uTextureMatrix: {
          type: 'mat3x3<f32>',
          value: (mesh.texture as unknown as { textureMatrix: { mapCoord: unknown } }).textureMatrix
            .mapCoord
        }
      })

      unmount()
      expect(mesh.destroyed).toBe(true)
      expect(mesh.shader?.destroyed).toBe(true)
      expect(mesh.geometry?.destroyed).toBe(true)
    })

    it('samples the crop of a rotated image through the cropped texture frame', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      render(
        <Layer
          items={[rotatedItem(30, { crop: { x: 10, y: 5, width: 40, height: 30 } })]}
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )
      await waitFor(() => expect(getLiveSpriteByLabel('image-1')).not.toBeNull())
      const mesh = liveObject()
      expect(mesh.kind).toBe('mesh')
      expect(mesh.texture.frame).toMatchObject({ x: 10, y: 5, width: 40, height: 30 })
      const matrix = (
        mesh.shader?.resources.textureUniforms as {
          uTextureMatrix: { value: { frameOf: MockTextureInstance } }
        }
      ).uTextureMatrix.value
      expect(matrix.frameOf).toBe(mesh.texture)
    })

    it('switches between sprite and mesh in place while an image is being rotated', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const items = [
        createNamedItem('below', { zIndex: 1 }),
        createItem({ zIndex: 1 }),
        createNamedItem('above', { zIndex: 1 })
      ]
      render(<Layer ref={ref} items={items} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(createdSprites).toHaveLength(3))
      const sprite = liveObject()
      const app = createdApplications[0]
      const texture = sprite.texture
      const orderBefore = world().children.map((child) => child.label)
      const preview = { x: 24, y: 36, width: 200, height: 120, scaleX: 1, scaleY: 1 }

      const rendersBefore = app.render.mock.calls.length
      act(() => ref.current?.syncItemPreview('image-1', { ...preview, rotation: 12 }))
      const mesh = liveObject()
      expect(mesh).not.toBe(sprite)
      expect(mesh.kind).toBe('mesh')
      expect(sprite.destroyed).toBe(true)
      expect(sprite.parent).toBeNull()
      // Same texture, same place in the z-order, drawn in the same call.
      expect(mesh.texture).toBe(texture)
      expect(texture.destroyed).toBe(false)
      expect(world().children.map((child) => child.label)).toEqual(orderBefore)
      expect(mesh.zIndex).toBe(1)
      expect(mesh.scale.x).toBe(200)
      expect(mesh.rotation).toBeCloseTo((12 * Math.PI) / 180)
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)

      // Further rotation keeps the mesh.
      act(() => ref.current?.syncItemPreview('image-1', { ...preview, rotation: 40 }))
      expect(liveObject()).toBe(mesh)
      expect(createdEdgeAntialiasShaders).toHaveLength(1)

      // The gesture is cancelled: back to the unrotated item and to a plain sprite.
      act(() => ref.current?.syncItemPreview('image-1', null))
      const restored = liveObject()
      expect(restored.kind).toBe('sprite')
      expect(restored.texture).toBe(texture)
      expect(restored.scale.x).toBe(2)
      expect(restored.rotation).toBe(0)
      expect(mesh.destroyed).toBe(true)
      expect(mesh.shader?.destroyed).toBe(true)
      expect(world().children.map((child) => child.label)).toEqual(orderBefore)
      expect(texture.destroyed).toBe(false)
    })

    it('switches to the mesh when a rotation is committed, without a new texture', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const item = createItem()
      const view = (rotation: number) => (
        <Layer items={[{ ...item, rotation }]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      const { rerender } = render(view(0))
      await waitFor(() => expect(getLiveSpriteByLabel('image-1')).not.toBeNull())
      const texture = liveObject().texture
      const texturesBefore = createdBaseTextures.length

      rerender(view(33))
      await waitFor(() => expect(liveObject().kind).toBe('mesh'))
      expect(liveObject().texture).toBe(texture)
      expect(liveObject().scale.x).toBe(200)
      expect(liveObject().rotation).toBeCloseTo((33 * Math.PI) / 180)

      rerender(view(90))
      await waitFor(() => expect(liveObject().kind).toBe('sprite'))
      expect(liveObject().texture).toBe(texture)
      expect(liveObject().scale.x).toBe(2)
      expect(createdBaseTextures).toHaveLength(texturesBefore)
      expect(createdEdgeAntialiasShaders.every((shader) => shader.destroyed)).toBe(true)
    })

    it('keeps plain sprites on a WebGL 1 context, which has no derivatives', async () => {
      mockWebGLVersion = 1
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      render(<Layer ref={ref} items={[rotatedItem(15)]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(getLiveSpriteByLabel('image-1')).not.toBeNull())
      expect(liveObject().kind).toBe('sprite')
      act(() =>
        ref.current?.syncItemPreview('image-1', {
          x: 300,
          y: 200,
          width: 200,
          height: 120,
          scaleX: 1,
          scaleY: 1,
          rotation: 50
        })
      )
      expect(liveObject().kind).toBe('sprite')
      expect(createdEdgeAntialiasShaders).toEqual([])
    })
  })

  describe('render resolution during gestures', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      setWindowDevicePixelRatio(originalDevicePixelRatio)
    })

    // A layer on a screen with the given device pixel ratio, with a clock the test moves by
    // hand and display frames (requestAnimationFrame) the test runs by hand.
    const renderLayerWithManualFrames = async (devicePixelRatio = 2) => {
      setWindowDevicePixelRatio(devicePixelRatio)
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const { unmount } = render(
        <Layer ref={ref} items={[createItem()]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      await waitFor(() => {
        expect(ref.current).not.toBeNull()
        expect(createdSprites).toHaveLength(1)
      })
      const app = createdApplications[0]
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
      })
      expect(app.renderer.resolution).toBe(devicePixelRatio)
      let now = 100_000
      vi.spyOn(window.performance, 'now').mockImplementation(() => now)
      const callbacks = new Map<number, FrameRequestCallback>()
      let nextFrameId = 1
      const requestFrame = vi.fn((callback: FrameRequestCallback) => {
        callbacks.set(nextFrameId, callback)
        return nextFrameId++
      })
      vi.stubGlobal('requestAnimationFrame', requestFrame)
      vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((id: number) => {
          callbacks.delete(id)
        })
      )
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let x = 0
      // One display frame `intervalMs` after the previous one. With `moved`, the view moves in
      // it (the stage's callback runs first, as in the app); then the layer's own callbacks.
      const displayFrame = (intervalMs: number, moved: boolean) => {
        now += intervalMs
        act(() => {
          vi.advanceTimersByTime(intervalMs)
          const due = Array.from(callbacks.values())
          callbacks.clear()
          if (moved) {
            x += 3
            ref.current?.syncViewport({ x, y: 0 }, 1)
          }
          due.forEach((callback) => callback(now))
        })
      }
      const displayFrames = (count: number, intervalMs: number, moved = true) => {
        for (let frame = 0; frame < count; frame += 1) {
          displayFrame(intervalMs, moved)
        }
      }
      const wait = (ms: number) => {
        now += ms
        act(() => {
          vi.advanceTimersByTime(ms)
        })
      }
      return {
        ref,
        app,
        unmount,
        displayFrame,
        displayFrames,
        wait,
        requestedFrames: () => requestFrame.mock.calls.length,
        pendingFrames: () => callbacks.size
      }
    }

    it('keeps the full device pixel ratio through a gesture: no resize, no blur and pop', async () => {
      const { ref, app, displayFrames, wait, requestedFrames } = await renderLayerWithManualFrames()
      const resizesBefore = app.renderer.resize.mock.calls.length
      const requestedBefore = requestedFrames()

      act(() => ref.current?.setViewportInteracting(true))
      // Well past the 80 ms after which the layer used to drop to a ratio of 1.
      displayFrames(90, 1000 / 60)
      expect(app.renderer.resolution).toBe(2)
      // A gesture that keeps up is drawn in the stage's frame callback: none of the layer's own.
      expect(requestedFrames()).toBe(requestedBefore)
      act(() => ref.current?.setViewportInteracting(false))
      wait(1000)

      expect(app.renderer.resolution).toBe(2)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)
    })

    it('keeps the full resolution when only the input is slow: a careful drag, a notched wheel', async () => {
      const { ref, app, displayFrame, displayFrames, wait, pendingFrames } =
        await renderLayerWithManualFrames()
      const resizesBefore = app.renderer.resize.mock.calls.length

      act(() => ref.current?.setViewportInteracting(true))
      // The pointer moves one pixel every 50 ms, a wheel notch comes every 100 ms: the view
      // is drawn that seldom, on a display that shows a frame every 16.7 ms. The time
      // between two draws used to count as a slow frame and lowered the resolution here.
      for (let move = 0; move < 40; move += 1) {
        displayFrames(2, 1000 / 60, false)
        displayFrame(1000 / 60, true)
      }
      for (let notch = 0; notch < 40; notch += 1) {
        displayFrames(5, 1000 / 60, false)
        displayFrame(1000 / 60, true)
      }
      expect(app.renderer.resolution).toBe(2)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)

      // The pointer rests with the button held: the layer stops timing frames.
      displayFrames(30, 1000 / 60, false)
      expect(pendingFrames()).toBe(0)

      act(() => ref.current?.setViewportInteracting(false))
      wait(1000)
      expect(app.renderer.resolution).toBe(2)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)
    })

    it('lowers the resolution once after ten slow display frames and restores it after the gesture', async () => {
      const { ref, app, displayFrames, wait, pendingFrames } = await renderLayerWithManualFrames()
      const resizesBefore = app.renderer.resize.mock.calls.length

      act(() => ref.current?.setViewportInteracting(true))
      // The display shows a frame every 40 ms and the view moves in each. The first draw has
      // no interval, three late draws start the timing, whose first frame has no interval
      // either: nine timed slow frames after 14 display frames.
      displayFrames(14, 40)
      expect(app.renderer.resolution).toBe(2)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)

      const rendersBefore = app.render.mock.calls.length
      displayFrames(1, 40)
      expect(app.renderer.resolution).toBe(1)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore + 1)
      // The frame is drawn again at the new resolution, so the canvas is never blank.
      expect(app.render.mock.calls.length).toBe(rendersBefore + 2)
      // Lowered: nothing left to time.
      expect(pendingFrames()).toBe(0)

      // Fast frames at the lower resolution do not flip it back during the gesture.
      displayFrames(120, 1000 / 60)
      expect(app.renderer.resolution).toBe(1)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore + 1)
      expect(pendingFrames()).toBe(0)

      act(() => ref.current?.setViewportInteracting(false))
      wait(100)
      expect(app.renderer.resolution).toBe(1)
      wait(100)
      expect(app.renderer.resolution).toBe(2)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore + 2)
      wait(2000)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore + 2)
    })

    it('stops timing frames when the gesture ends or the layer goes away', async () => {
      const { ref, unmount, displayFrames, requestedFrames, pendingFrames } =
        await renderLayerWithManualFrames()

      act(() => ref.current?.setViewportInteracting(true))
      displayFrames(6, 40)
      expect(pendingFrames()).toBe(1)
      act(() => ref.current?.setViewportInteracting(false))
      // Whatever the end of the gesture asked for is drawn; then no frame is requested again.
      displayFrames(5, 1000 / 60, false)
      const requestedAfterGesture = requestedFrames()
      displayFrames(30, 40, false)
      expect(requestedFrames()).toBe(requestedAfterGesture)
      expect(pendingFrames()).toBe(0)

      act(() => ref.current?.setViewportInteracting(true))
      displayFrames(6, 40)
      expect(pendingFrames()).toBe(1)
      unmount()
      expect(pendingFrames()).toBe(0)
    })

    it('times nothing on a screen whose full resolution is the lowered one', async () => {
      const { ref, app, displayFrames, requestedFrames } = await renderLayerWithManualFrames(1)
      const resizesBefore = app.renderer.resize.mock.calls.length
      const requestedBefore = requestedFrames()

      act(() => ref.current?.setViewportInteracting(true))
      displayFrames(40, 40)
      expect(requestedFrames()).toBe(requestedBefore)
      expect(app.renderer.resolution).toBe(1)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)
    })
  })

  describe('ComfyUI throttle', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      setWindowDevicePixelRatio(originalDevicePixelRatio)
    })

    // A layer while a ComfyUI job runs, with a hand-moved clock and hand-run animation frames.
    const renderThrottledLayer = async () => {
      setWindowDevicePixelRatio(2)
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const items = [createItem()]
      const view = (nextItems: CanvasImageItem[]) => (
        <Layer
          ref={ref}
          items={nextItems}
          {...TEST_STAGE_VIEWPORT_1280_720}
          isPerformanceThrottled
        />
      )
      const utils = render(view(items))
      await waitFor(() => {
        expect(ref.current).not.toBeNull()
        expect(createdSprites).toHaveLength(1)
      })
      const app = createdApplications[0]
      for (let renders = -1; renders !== app.render.mock.calls.length;) {
        renders = app.render.mock.calls.length
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 400))
        })
      }
      let now = 100_000
      vi.spyOn(window.performance, 'now').mockImplementation(() => now)
      const callbacks = new Map<number, FrameRequestCallback>()
      let nextFrameId = 1
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback) => {
          callbacks.set(nextFrameId, callback)
          return nextFrameId++
        })
      )
      vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((id: number) => {
          callbacks.delete(id)
        })
      )
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const advance = (ms: number) => {
        now += ms
        act(() => {
          vi.advanceTimersByTime(ms)
        })
      }
      const runFrames = () =>
        act(() => {
          const due = Array.from(callbacks.values())
          callbacks.clear()
          due.forEach((callback) => callback(now))
        })
      return {
        ref,
        app,
        items,
        view,
        advance,
        runFrames,
        pendingFrames: () => callbacks.size,
        ...utils
      }
    }

    it('draws every gesture frame at once while a job runs', async () => {
      const { ref, app, advance } = await renderThrottledLayer()
      act(() => ref.current?.setViewportInteracting(true))
      const rendersBefore = app.render.mock.calls.length

      // 30 frames at 60 Hz: the throttle used to allow one render per 180 ms, three in all.
      for (let frame = 1; frame <= 30; frame += 1) {
        advance(1000 / 60)
        act(() => ref.current?.syncViewport({ x: frame * 5, y: 0 }, 1))
        expect(app.render.mock.calls.length).toBe(rendersBefore + frame)
      }
      // And at the full resolution.
      expect(app.renderer.resolution).toBe(2)
    })

    it('draws a dragged image at once while a job runs', async () => {
      const { ref, app, advance } = await renderThrottledLayer()
      const rendersBefore = app.render.mock.calls.length
      for (let step = 1; step <= 10; step += 1) {
        advance(1000 / 60)
        act(() =>
          ref.current?.syncItemPreview('image-1', {
            x: 24 + step * 4,
            y: 36,
            width: 200,
            height: 120,
            scaleX: 1,
            scaleY: 1,
            rotation: 0
          })
        )
        expect(app.render.mock.calls.length).toBe(rendersBefore + step)
      }
    })

    it('still spaces out background renders while a job runs', async () => {
      const { ref, app, items, view, rerender, advance, runFrames, pendingFrames } =
        await renderThrottledLayer()
      // A render just happened (a gesture frame).
      act(() => ref.current?.syncViewport({ x: 2, y: 0 }, 1))
      const rendersBefore = app.render.mock.calls.length
      advance(10)
      rerender(view([{ ...items[0], zIndex: 5 }]))
      // The reconcile pass may not render yet...
      expect(pendingFrames()).toBe(0)
      expect(app.render.mock.calls.length).toBe(rendersBefore)
      advance(100)
      rerender(view([{ ...items[0], zIndex: 6 }]))
      expect(pendingFrames()).toBe(0)
      advance(100)
      // ...and both changes are drawn by one render once the 180 ms interval is over.
      expect(pendingFrames()).toBe(1)
      runFrames()
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)
    })

    it('does not hold a lowered resolution for the length of the job', async () => {
      const { ref, app, advance, runFrames } = await renderThrottledLayer()
      act(() => ref.current?.setViewportInteracting(true))
      // Display frames 40 ms apart, the view moves in each: slow enough to lower it.
      for (let frame = 1; frame <= 16; frame += 1) {
        advance(40)
        act(() => ref.current?.syncViewport({ x: frame * 5, y: 0 }, 1))
        runFrames()
      }
      expect(app.renderer.resolution).toBe(1)

      act(() => ref.current?.setViewportInteracting(false))
      advance(200)
      // The job is still running; the gesture is over, so the full resolution is back.
      expect(app.renderer.resolution).toBe(2)
    })
  })

  describe('panel resize next to the canvas', () => {
    afterEach(async () => {
      const { emitCanvasLayoutResizeInteraction } = await import('../canvasLayoutResizeInteraction')
      emitCanvasLayoutResizeInteraction(false)
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    // A layer whose host size the test sets, with a ResizeObserver the test fires by hand.
    const renderObservedLayer = async () => {
      const observerCallbacks: (() => void)[] = []
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe = vi.fn()
          disconnect = vi.fn()

          constructor(callback: () => void) {
            observerCallbacks.push(callback)
          }
        }
      )
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const { emitCanvasLayoutResizeInteraction } = await import('../canvasLayoutResizeInteraction')
      const utils = render(<Layer items={[createItem()]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => {
        expect(createdSprites).toHaveLength(1)
        expect(observerCallbacks).toHaveLength(1)
      })
      const app = createdApplications[0]
      const host = utils.container.querySelector('.project-canvas-webgl-layer') as HTMLElement
      let hostSize = { width: 1280, height: 720 }
      vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
        () => ({ ...hostSize, x: 0, y: 0, top: 0, left: 0 }) as DOMRect
      )
      const resizeHost = (width: number, height = 720) => {
        hostSize = { width, height }
        act(() => observerCallbacks.forEach((callback) => callback()))
      }
      return { app, resizeHost, emit: emitCanvasLayoutResizeInteraction, ...utils }
    }

    it('follows the host size when no panel is being dragged', async () => {
      const { app, resizeHost } = await renderObservedLayer()
      resizeHost(1100)
      expect(app.renderer.resize).toHaveBeenLastCalledWith(1100, 720)
      resizeHost(1000, 650)
      expect(app.renderer.resize).toHaveBeenLastCalledWith(1000, 650)
      expect(app.canvas.style.width).toBe('100%')
    })

    it('does not resize the renderer while a panel is dragged and resizes once at the end', async () => {
      const { app, resizeHost, emit } = await renderObservedLayer()
      const resizesBefore = app.renderer.resize.mock.calls.length
      const rendersBefore = app.render.mock.calls.length

      act(() => emit(true, 'right'))
      // Twenty mouse moves of the drag.
      for (let move = 1; move <= 20; move += 1) {
        resizeHost(1280 - move * 12)
      }
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)
      expect(app.render.mock.calls.length).toBe(rendersBefore)
      // The canvas keeps its size on screen instead of being stretched to the host.
      expect(app.canvas.style.width).toBe('1280px')
      expect(app.canvas.style.height).toBe('720px')

      act(() => emit(false))
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore + 1)
      expect(app.renderer.resize).toHaveBeenLastCalledWith(1040, 720)
      expect(app.canvas.style.width).toBe('100%')
      expect(app.canvas.style.height).toBe('100%')
      // Drawn again at once, so the resized canvas is not blank.
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)

      // Afterwards it follows the host again.
      resizeHost(1300)
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore + 2)
    })

    it('does nothing at the end of a drag that did not change the canvas size', async () => {
      const { app, resizeHost, emit } = await renderObservedLayer()
      const resizesBefore = app.renderer.resize.mock.calls.length

      act(() => emit(true, 'side'))
      act(() => emit(false))
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)

      // A drag that returns to the starting width needs no reallocation either.
      act(() => emit(true, 'right'))
      resizeHost(1200)
      resizeHost(1280)
      act(() => emit(false))
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)
      expect(app.canvas.style.width).toBe('100%')
    })

    it('restores the canvas style when the layer goes away in the middle of a drag', async () => {
      const { app, resizeHost, emit, unmount } = await renderObservedLayer()
      act(() => emit(true, 'right'))
      resizeHost(900)
      expect(app.canvas.style.width).toBe('1280px')
      const resizesBefore = app.renderer.resize.mock.calls.length
      unmount()
      act(() => emit(false))
      expect(app.renderer.resize.mock.calls.length).toBe(resizesBefore)
    })
  })

  describe('world render group', () => {
    const getWorld = () =>
      createdSprites[0].parent as unknown as { isRenderGroup?: boolean; position: MockPoint }

    it('makes the world a render group, so a pan or zoom is one transform on the GPU', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      render(<Layer ref={ref} items={[createItem()]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(createdSprites).toHaveLength(1))
      expect(getWorld().isRenderGroup).toBe(true)

      act(() => ref.current?.syncViewport({ x: -40_000, y: 12_000 }, 0.2))
      expect(getWorld().isRenderGroup).toBe(true)
      expect(getWorld().position.x).toBe(-40_000)
    })

    it('transforms on the CPU where 32-bit GPU maths would move images by visible amounts', async () => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const { PROJECT_CANVAS_WEBGL_RENDER_GROUP_MAX_SCREEN_REACH_PX: limit } =
        await import('../canvasRenderQuality')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      render(<Layer ref={ref} items={[createItem()]} {...TEST_STAGE_VIEWPORT_1280_720} />)
      await waitFor(() => expect(createdSprites).toHaveLength(1))
      const app = createdApplications[0]

      // A deep zoom far from the canvas origin: the stage offset is millions of screen pixels.
      const rendersBefore = app.render.mock.calls.length
      act(() => ref.current?.syncViewport({ x: -22_500_000, y: -3_000_000 }, 500))
      expect(getWorld().isRenderGroup).toBe(false)
      expect(getWorld().position.x).toBe(-22_500_000)
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)

      // Just inside the limit again is not enough to switch back (no flapping on the limit)...
      act(() => ref.current?.syncViewport({ x: -(limit - 1280 - 10), y: 0 }, 500))
      expect(getWorld().isRenderGroup).toBe(false)
      // ...well inside is.
      act(() => ref.current?.syncViewport({ x: -(limit / 2), y: 0 }, 500))
      expect(getWorld().isRenderGroup).toBe(true)
    })
  })

  describe('lockstep frame', () => {
    // Animation frames that only run when the test says so.
    const installManualAnimationFrames = () => {
      let nextId = 1
      const callbacks = new Map<number, FrameRequestCallback>()
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback) => {
          const id = nextId++
          callbacks.set(id, callback)
          return id
        })
      )
      vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((id: number) => {
          callbacks.delete(id)
        })
      )
      return {
        pending: () => callbacks.size,
        flush: () => {
          const due = Array.from(callbacks.values())
          callbacks.clear()
          due.forEach((callback) => callback(performance.now()))
        }
      }
    }

    const renderSettledLayer = async (items: CanvasImageItem[]) => {
      const { default: Layer } = await import('./ProjectCanvasWebGLImageLayer')
      const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
      const view = (nextItems: CanvasImageItem[]) => (
        <Layer ref={ref} items={nextItems} {...TEST_STAGE_VIEWPORT_1280_720} />
      )
      const utils = render(view(items))
      await waitFor(() => {
        expect(ref.current).not.toBeNull()
        expect(createdApplications).toHaveLength(1)
        expect(createdSprites).toHaveLength(items.length)
      })
      const app = createdApplications[0]
      // Let the start-up renders and reconcile timers run out: quiet for 200 ms.
      for (let renders = -1; renders !== app.render.mock.calls.length;) {
        renders = app.render.mock.calls.length
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200))
        })
      }
      return { ref, app, view, ...utils }
    }

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('draws every gesture frame inside the viewport sync, not in a frame of its own', async () => {
      const { ref, app } = await renderSettledLayer([createItem()])
      const frames = installManualAnimationFrames()
      act(() => ref.current?.setViewportInteracting(true))
      const rendersBefore = app.render.mock.calls.length

      for (let frame = 1; frame <= 5; frame += 1) {
        act(() => ref.current?.syncViewport({ x: frame * 12, y: frame * 4 }, 1))
        // Drawn before the sync call returns: the same frame as the DOM layers.
        expect(app.render.mock.calls.length).toBe(rendersBefore + frame)
        expect(createdSprites[0].parent?.position.x).toBe(frame * 12)
        // And no animation frame was asked for, so nothing draws this view a frame later.
        expect(frames.pending()).toBe(0)
      }

      // The same view again is not a new frame.
      act(() => ref.current?.syncViewport({ x: 60, y: 20 }, 1))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 5)
      act(() => frames.flush())
      expect(app.render.mock.calls.length).toBe(rendersBefore + 5)
    })

    it('cancels a render that was already scheduled when the gesture frame draws', async () => {
      const items = [createItem()]
      const { ref, app, view, rerender } = await renderSettledLayer(items)
      const frames = installManualAnimationFrames()
      const rendersBefore = app.render.mock.calls.length

      // A reconcile pass asks for a render in the next animation frame.
      rerender(view([{ ...items[0], zIndex: 7 }]))
      expect(frames.pending()).toBe(1)
      expect(app.render.mock.calls.length).toBe(rendersBefore)

      act(() => ref.current?.setViewportInteracting(true))
      act(() => ref.current?.syncViewport({ x: 40, y: 0 }, 1))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)
      expect(frames.pending()).toBe(0)
      act(() => frames.flush())
      // One render for that frame, not two.
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)
    })

    it('lets the gesture frame draw background changes instead of rendering twice', async () => {
      const items = [createItem()]
      const { ref, app, view, rerender } = await renderSettledLayer(items)
      const frames = installManualAnimationFrames()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      act(() => ref.current?.setViewportInteracting(true))
      const rendersBefore = app.render.mock.calls.length

      // A reconcile pass in the middle of the gesture: no frame of its own yet.
      rerender(view([{ ...items[0], zIndex: 7 }]))
      expect(frames.pending()).toBe(0)
      expect(app.render.mock.calls.length).toBe(rendersBefore)

      // The next gesture frame shows it.
      act(() => ref.current?.syncViewport({ x: 40, y: 0 }, 1))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)
      act(() => {
        vi.advanceTimersByTime(200)
        frames.flush()
      })
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)

      // The pointer rests: the change is drawn alone, a moment later, once.
      rerender(view([{ ...items[0], zIndex: 9 }]))
      act(() => {
        vi.advanceTimersByTime(20)
      })
      expect(frames.pending()).toBe(0)
      act(() => {
        vi.advanceTimersByTime(20)
      })
      expect(frames.pending()).toBe(1)
      act(() => frames.flush())
      expect(app.render.mock.calls.length).toBe(rendersBefore + 2)
      act(() => {
        vi.advanceTimersByTime(200)
        frames.flush()
      })
      expect(app.render.mock.calls.length).toBe(rendersBefore + 2)
    })

    it('draws a waiting background change right after the gesture ends', async () => {
      const items = [createItem()]
      const { ref, app, view, rerender } = await renderSettledLayer(items)
      const frames = installManualAnimationFrames()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      act(() => ref.current?.setViewportInteracting(true))
      const rendersBefore = app.render.mock.calls.length
      rerender(view([{ ...items[0], zIndex: 7 }]))
      expect(frames.pending()).toBe(0)

      act(() => ref.current?.setViewportInteracting(false))
      // No 34 ms wait any more: the next animation frame.
      expect(frames.pending()).toBeGreaterThanOrEqual(1)
      act(() => frames.flush())
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)
    })

    it('does not render for preview calls that change nothing on screen', async () => {
      const items = [
        createNamedItem('first', { x: 20 }),
        createNamedItem('second', { x: 320 }),
        createNamedItem('third', { x: 620 })
      ]
      const { ref, app } = await renderSettledLayer(items)
      const frames = installManualAnimationFrames()
      const rendersBefore = app.render.mock.calls.length
      const canonical = { x: 20, y: 36, width: 200, height: 120, scaleX: 1, scaleY: 1, rotation: 0 }

      // What every hit proxy does when a pan or zoom starts: reset a preview that was never
      // set. With 160 images on screen that used to be 160 renders in one task.
      act(() => {
        ref.current?.setViewportInteracting(true)
        items.forEach((item) => ref.current?.syncItemPreview(item.id, null))
      })
      // A preview equal to the item's own transform moves nothing either.
      act(() => ref.current?.syncItemPreview('first', canonical))
      expect(app.render.mock.calls.length).toBe(rendersBefore)
      expect(frames.pending()).toBe(0)

      // A real move is drawn at once, also during the gesture; repeating it is not.
      act(() => ref.current?.syncItemPreview('first', { ...canonical, x: 64 }))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)
      expect(getLiveSpriteByLabel('first')?.position.x).toBe(64)
      act(() => ref.current?.syncItemPreview('first', { ...canonical, x: 64 }))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 1)

      // Clearing the preview moves the image back: one render, then nothing.
      act(() => ref.current?.syncItemPreview('first', null))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 2)
      expect(getLiveSpriteByLabel('first')?.position.x).toBe(20)
      act(() => ref.current?.syncItemPreview('first', null))
      expect(app.render.mock.calls.length).toBe(rendersBefore + 2)
      expect(frames.pending()).toBe(0)
    })

    it('does not render after the layer is gone', async () => {
      const items = [createItem()]
      const { ref, app, view, rerender, unmount } = await renderSettledLayer(items)
      const frames = installManualAnimationFrames()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      act(() => ref.current?.setViewportInteracting(true))
      rerender(view([{ ...items[0], zIndex: 7 }]))
      const rendersBefore = app.render.mock.calls.length

      unmount()
      act(() => {
        vi.advanceTimersByTime(500)
        frames.flush()
      })
      expect(app.render.mock.calls.length).toBe(rendersBefore)
    })
  })

  it('reconciles resident images after imperative viewport movement without prop changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const residentIdsCalls: Set<string>[] = []
    const visibleItem = createItem({ id: 'image-visible', x: 24, y: 36 })
    const farItem = createNamedItem('image-far', { x: 4800, y: 3600 })

    render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[visibleItem, farItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
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

  it('defers viewport resident reconciliation during interaction until the viewport settles', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const residentIdsCalls: Set<string>[] = []
    const handleResidentIdsChange = (residentIds: Set<string>) => {
      residentIdsCalls.push(new Set(residentIds))
    }
    const visibleItem = createItem({ id: 'image-visible-interacting', x: 24, y: 36 })
    const farItem = createNamedItem('image-far-interacting', { x: 4800, y: 3600 })
    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={[visibleItem, farItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
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

    expect(residentIdsCalls.at(-1)).toEqual(new Set(['image-visible-interacting']))
    expect(getLiveSpriteByLabel('image-visible-interacting')).not.toBeNull()
    expect(getLiveSpriteByLabel('image-far-interacting')).toBeNull()

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
    expect(getLiveSpriteByLabel('image-visible-interacting')).toBeNull()
    expect(getLiveSpriteByLabel('image-far-interacting')).not.toBeNull()
  }, 30000)

  it('defers metrics reports while viewport interaction is active', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const ref = React.createRef<ProjectCanvasWebGLImageLayerHandle>()
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const stableItems = [createItem({ id: 'image-metrics-interacting' })]

    const { rerender } = render(
      <ProjectCanvasWebGLImageLayer
        ref={ref}
        items={stableItems}
        {...TEST_STAGE_VIEWPORT_1280_720}
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const farItem = createNamedItem('image-far-queued', { x: 4800, y: 3600 })
    const stableItems = [visibleItem, farItem]

    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          ref={ref}
          items={stableItems}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const largeTextureSide =
      Math.floor(Math.sqrt(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES / 4)) - 16
    const expectedTextureBytes = largeTextureSide * largeTextureSide * 4
    const largeVisibleItems = Array.from({ length: 7 }, (_, index) =>
      createNamedItem(`image-large-${index + 1}`, {
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
        {...TEST_STAGE_VIEWPORT_1280_720}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const rotatedEdgeItem = createNamedItem('image-rotated-edge', {
      x: -450,
      y: 260,
      width: 120,
      height: 120,
      rotation: -45
    })

    render(
      <ProjectCanvasWebGLImageLayer
        items={[rotatedEdgeItem]}
        {...TEST_STAGE_VIEWPORT_1280_720}
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

  it('does not start queued initial decodes while tearing down the bounded load pool', async () => {
    const {
      default: ProjectCanvasWebGLImageLayer,
      PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY
    } = await import('./ProjectCanvasWebGLImageLayer')
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 100,
      height: 60,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const srcOnlyItems = createItems(10).map((item) => ({
        ...item,
        image: undefined as unknown as HTMLImageElement
      }))
      const offscreenSrcOnlyItem = createNamedItem('image-offscreen-src-only', {
        x: 10000,
        y: 10000,
        image: undefined as unknown as HTMLImageElement
      })

      const { unmount } = render(
        <ProjectCanvasWebGLImageLayer
          items={[...srcOnlyItems, offscreenSrcOnlyItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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

      expect(attemptedSrcs.filter(Boolean)).toHaveLength(
        PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY
      )
      const visibleSrcs = new Set(srcOnlyItems.map((item) => item.src))
      expect(attemptedSrcs.every((src) => visibleSrcs.has(src))).toBe(true)
      expect(attemptedSrcs).not.toContain(offscreenSrcOnlyItem.src)
      expect(createdSprites).toHaveLength(0)

      unmount()
      await act(async () => {
        await Promise.resolve()
      })
      expect(attemptedSrcs.filter(Boolean)).toHaveLength(
        PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY
      )

      act(() => {
        imageInstances[0].onload?.()
      })

      expect(attemptedSrcs.filter(Boolean)).toHaveLength(
        PROJECT_CANVAS_WEBGL_INITIAL_IMAGE_LOAD_CONCURRENCY
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('batches same-frame src-only image load commits into one image-version frame', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const imageInstances: MockImageInstance[] = []
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

    const MockImage = createMockImageClass({
      width: 100,
      height: 60,
      imageInstances,
      storeSrc: false
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const srcOnlyItems = createItems(2).map((item) => ({
        ...item,
        image: undefined as unknown as HTMLImageElement
      }))

      render(
        <ProjectCanvasWebGLImageLayer items={srcOnlyItems} {...TEST_STAGE_VIEWPORT_1280_720} />
      )

      await waitFor(() => {
        expect(imageInstances).toHaveLength(2)
      })
      queuedAnimationFrames.clear()

      await act(async () => {
        imageInstances[0].onload?.()
        imageInstances[1].onload?.()
        await Promise.resolve()
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 100,
      height: 60,
      attemptedSrcs,
      imageInstances
    })

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
        <ProjectCanvasWebGLImageLayer items={[initialItem]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['file:///image-replaced-old.png'])
        },
        { timeout: 15000 }
      )

      rerender(
        <ProjectCanvasWebGLImageLayer items={[replacementItem]} {...TEST_STAGE_VIEWPORT_1280_720} />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs.filter(Boolean)).toEqual([
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[createSizedNamedItem('image-hires', 4096, 4096, 4096, 4096, 1024, 1024)]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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

  it('re-decodes a populated weak remote source cache when the provided image revision changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })
    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const src = 'https://example.test/populated-cache.png'
      const firstPreview = createImage(1024, 1024)
      const secondPreview = createImage(1024, 1024)
      const firstItem = createItem({
        id: 'image-populated-cache',
        src,
        width: 4096,
        height: 4096,
        sourceWidth: 4096,
        sourceHeight: 4096,
        image: firstPreview
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[firstItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
        />
      )

      await waitFor(() => expect(attemptedSrcs.filter(Boolean)).toEqual([src]))
      act(() => imageInstances[0].onload?.())
      await waitFor(() => expect(getLiveSpriteByLabel(firstItem.id)?.texture.width).toBe(4096))

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[{ ...firstItem, image: secondPreview }]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
        />
      )

      await waitFor(() => expect(attemptedSrcs.filter(Boolean)).toEqual([src, src]))
      act(() => imageInstances[1].onload?.())
      await waitFor(() => {
        const liveTexture = getLiveSpriteByLabel(firstItem.id)?.texture
        expect(liveTexture?.width).toBe(4096)
        expect((liveTexture?.source as { image?: unknown }).image).toBe(imageInstances[1])
      })
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('keeps mid-zoom preview textures while the preview still covers the screen density', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createSizedNamedItem('image-mid-zoom-preview', 4096, 4096, 4096, 4096, 1024, 1024)
          ]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.5}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={[createSizedNamedItem('image-mid-zoom-hidpi', 4096, 4096, 4096, 4096, 1024, 1024)]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.5}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 2048,
      height: 2048,
      attemptedSrcs,
      imageInstances
    })

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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createSizedNamedItem(
        'image-hires-interacting',
        4096,
        4096,
        4096,
        4096,
        1024,
        1024
      )
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createSizedNamedItem(
        'image-hires-loads-during-interaction',
        4096,
        4096,
        4096,
        4096,
        1024,
        1024
      )
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 2048,
      height: 2048,
      attemptedSrcs,
      imageInstances
    })

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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 2048,
      height: 2048,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const centerItem = createSizedNamedItem(
        'image-upgrade-center',
        2048,
        2048,
        2048,
        2048,
        512,
        512,
        { x: 260, y: 120 }
      )
      const edgeItem = createSizedNamedItem(
        'image-upgrade-edge',
        2048,
        2048,
        2048,
        2048,
        512,
        512,
        { x: 760, y: 320 }
      )
      const selectedItem = createSizedNamedItem(
        'image-upgrade-selected',
        2048,
        2048,
        2048,
        2048,
        512,
        512,
        { x: 3200, y: 2400 }
      )

      render(
        <ProjectCanvasWebGLImageLayer
          items={[edgeItem, centerItem, selectedItem]}
          selectedIds={new Set(['image-upgrade-selected'])}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const unselectedItem = createSizedNamedItem(
        'image-overview-unselected',
        4096,
        4096,
        4096,
        4096,
        512,
        512
      )
      const selectedItem = createSizedNamedItem(
        'image-overview-selected',
        4096,
        4096,
        4096,
        4096,
        512,
        512,
        { x: 5000, y: 4000 }
      )

      render(
        <ProjectCanvasWebGLImageLayer
          items={[unselectedItem, selectedItem]}
          selectedIds={new Set([selectedItem.id])}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.01}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const denseItems = Array.from({ length: 128 }, (_, index) =>
        createNamedItem(`image-dense-mid-zoom-${index + 1}`, {
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

  it('reprioritizes queued thumbnail upgrades even when resident sprites stay clean', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 1024,
      height: 512,
      attemptedSrcs,
      imageInstances
    })

    const createPrioritizedThumbnailItem = (index: number) => {
      const cacheKey = `thumbnail-priority-${index}`
      const sourceIdentity: CanvasImageSourceIdentity = {
        version: 1,
        kind: 'local-file',
        canonicalPath: `C:/images/thumbnail-priority-${index}.png`,
        sizeBytes: 123456 + index,
        lastModifiedMs: 456789 + index,
        cacheKey
      }
      const thumbnailSet: CanvasImageThumbnailSet = {
        version: 1,
        cacheKey,
        sourceIdentity,
        levels: ([128, 256, 512, 1024, 2048] as const).map((maxSide) => ({
          maxSide,
          src: `local-media:///thumbnail-priority-${index}/${maxSide}.webp`,
          filename: `${maxSide}.webp`,
          mimeType: 'image/webp' as const,
          width: maxSide,
          height: Math.round(maxSide / 2),
          sizeBytes: maxSide * 8
        })),
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }

      return createNamedItem(`image-thumbnail-priority-${index}`, {
        x: (index - 1) * 200,
        y: 0,
        width: 800,
        height: 400,
        sourceWidth: 2048,
        sourceHeight: 1024,
        image: createImage(128, 64),
        sourceIdentity,
        thumbnailSet
      })
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const items = Array.from({ length: 8 }, (_, index) =>
        createPrioritizedThumbnailItem(index + 1)
      )
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer items={items} {...TEST_STAGE_VIEWPORT_1280_720} />
      )

      await waitFor(
        () => {
          expect(createdSprites.filter((sprite) => !sprite.destroyed)).toHaveLength(8)
          expect(attemptedSrcs).toHaveLength(6)
        },
        { timeout: 15000 }
      )
      expect(attemptedSrcs).toEqual(
        Array.from(
          { length: 6 },
          (_, index) => `local-media:///thumbnail-priority-${index + 1}/2048.webp`
        )
      )

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={items}
          stagePos={{ x: -1080, y: 0 }}
          stageScale={1}
          stageSize={{ width: 1280, height: 720 }}
        />
      )

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
      })

      act(() => {
        imageInstances[0].onload?.()
      })

      await waitFor(
        () => {
          expect(attemptedSrcs).toHaveLength(7)
        },
        { timeout: 15000 }
      )
      expect(attemptedSrcs[6]).toBe('local-media:///thumbnail-priority-8/2048.webp')
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('ignores stale thumbnail resolutions after the item source changes', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const MockImage = createMockImageClass({
      width: 1024,
      height: 512,
      attemptedSrcs,
      imageInstances
    })
    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const firstFixture = createThumbnailSetFixture('canvas-thumbnail-stale-first')
      const firstItem = createItem({
        id: 'image-thumbnail-stale',
        src: 'file:///image-thumbnail-stale-first.png',
        image: createImage(192, 96),
        width: 3200,
        height: 1600,
        sourceWidth: 4096,
        sourceHeight: 2048,
        sourceIdentity: firstFixture.sourceIdentity,
        thumbnailSet: firstFixture.thumbnailSet
      })
      const secondFixture = createThumbnailSetFixture('canvas-thumbnail-stale-second')
      const secondThumbnailSet = {
        ...secondFixture.thumbnailSet,
        levels: secondFixture.thumbnailSet.levels.map((level) => ({
          ...level,
          src: level.src.replace('thumb-lod', 'thumb-lod-second')
        }))
      }
      const secondItem = createItem({
        ...firstItem,
        src: 'file:///image-thumbnail-stale-second.png',
        sourceIdentity: secondFixture.sourceIdentity,
        thumbnailSet: secondThumbnailSet
      })

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[firstItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(() => {
        expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/1024.webp'])
        expect(imageInstances).toHaveLength(1)
      })

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[secondItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(() => {
        expect(attemptedSrcs.filter(Boolean)).toEqual([
          'local-media:///thumb-lod/1024.webp',
          'local-media:///thumb-lod-second/1024.webp'
        ])
        expect(imageInstances).toHaveLength(2)
        expect(imageInstances[0].src).toBe('')
      })

      act(() => {
        imageInstances[0].onload?.()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(getLiveSpriteByLabel('image-thumbnail-stale')?.texture.width).toBe(192)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('restarts a thumbnail load when the source revision changes but the level URL stays the same', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const MockImage = createMockImageClass({
      width: 1024,
      height: 512,
      attemptedSrcs,
      imageInstances
    })
    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const firstFixture = createThumbnailSetFixture('canvas-thumbnail-same-url-first')
      const secondFixture = createThumbnailSetFixture('canvas-thumbnail-same-url-second')
      const firstItem = createItem({
        id: 'image-thumbnail-same-url',
        src: 'file:///image-thumbnail-same-url.png',
        image: createImage(192, 96),
        width: 3200,
        height: 1600,
        sourceWidth: 4096,
        sourceHeight: 2048,
        sourceIdentity: firstFixture.sourceIdentity,
        thumbnailSet: firstFixture.thumbnailSet
      })
      const secondThumbnailSet: CanvasImageThumbnailSet = {
        ...firstFixture.thumbnailSet,
        cacheKey: secondFixture.sourceIdentity.cacheKey,
        sourceIdentity: secondFixture.sourceIdentity,
        updatedAt: '2026-05-03T00:00:00.000Z'
      }
      const secondItem = createItem({
        ...firstItem,
        sourceIdentity: secondFixture.sourceIdentity,
        thumbnailSet: secondThumbnailSet
      })
      const thumbnailSrc = 'local-media:///thumb-lod/1024.webp'

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[firstItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(() => {
        expect(attemptedSrcs.filter(Boolean)).toEqual([thumbnailSrc])
        expect(imageInstances).toHaveLength(1)
      })

      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[secondItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(() => {
        expect(attemptedSrcs.filter(Boolean)).toEqual([thumbnailSrc, thumbnailSrc])
        expect(imageInstances).toHaveLength(2)
        expect(imageInstances[0].src).toBe('')
      })

      act(() => imageInstances[1].onload?.())
      await waitFor(() => {
        const liveTexture = getLiveSpriteByLabel(secondItem.id)?.texture
        expect(liveTexture?.width).toBe(1024)
        expect((liveTexture?.source as { image?: unknown }).image).toBe(imageInstances[1])
      })
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)

  it('aborts an active thumbnail load when its item is removed', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const MockImage = createMockImageClass({
      width: 1024,
      height: 512,
      attemptedSrcs,
      imageInstances
    })
    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const fixture = createThumbnailSetFixture('canvas-thumbnail-abort')
      const item = createItem({
        id: 'image-thumbnail-abort',
        image: createImage(192, 96),
        width: 3200,
        height: 1600,
        sourceWidth: 4096,
        sourceHeight: 2048,
        sourceIdentity: fixture.sourceIdentity,
        thumbnailSet: fixture.thumbnailSet
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(() => expect(imageInstances).toHaveLength(1))
      rerender(
        <ProjectCanvasWebGLImageLayer
          items={[]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(() => expect(imageInstances[0].src).toBe(''))
      expect(attemptedSrcs.filter(Boolean)).toEqual(['local-media:///thumb-lod/1024.webp'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('upgrades large-batch preview sprites through thumbnail LOD without loading source textures', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []

    const MockImage = createMockImageClass({
      width: 1024,
      height: 512,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { sourceIdentity, thumbnailSet } = createThumbnailSetFixture()
      const item = createSizedNamedItem('image-thumbnail-lod', 3200, 1600, 4096, 2048, 192, 96, {
        sourceIdentity,
        thumbnailSet
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
          onMetricsChange={(metrics) => metricsCalls.push(metrics)}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/1024.webp'])
          expect(imageInstances).toHaveLength(1)
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

    const MockImage = createMockImageClass({
      width: 1024,
      height: 512,
      attemptedSrcs
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { sourceIdentity, thumbnailSet } = createThumbnailSetFixture(
        'canvas-thumbnail-scroll-defer-test'
      )
      const item = createSizedNamedItem(
        'image-thumbnail-scroll-defer',
        3200,
        1600,
        4096,
        2048,
        192,
        96,
        { sourceIdentity, thumbnailSet }
      )

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.5}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.5}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 2048,
      height: 2048,
      attemptedSrcs,
      imageInstances,
      onSetSrc: (image, value) => {
        const match = value.match(/\/(\d+)\.webp$/)
        const level = match ? Number(match[1]) : 2048
        image.naturalWidth = level
        image.naturalHeight = level
        image.width = level
        image.height = level
      }
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { sourceIdentity, thumbnailSet } = createThumbnailSetFixture(
        'canvas-thumbnail-dense-budget-test',
        { square: true }
      )
      const focusedItem = createSizedNamedItem(
        'image-thumbnail-budgeted',
        3200,
        3200,
        4096,
        4096,
        192,
        192,
        { sourceIdentity, thumbnailSet }
      )
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[focusedItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
        />
      )

      await waitFor(
        () => {
          expect(attemptedSrcs).toEqual(['local-media:///thumb-lod/1024.webp'])
          expect(imageInstances).toHaveLength(1)
          expect(getLiveSpriteByLabel('image-thumbnail-budgeted')?.texture.width).toBe(192)
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
        createNamedItem(`image-thumbnail-budget-filler-${index + 1}`, {
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.15}
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
    const imageInstances: MockImageInstance[] = []
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createSizedNamedItem(
        'image-cached-source-overview',
        4096,
        4096,
        4096,
        4096,
        512,
        512
      )

      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={0.01}
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
    const imageInstances: MockImageInstance[] = []

    const MockImage = createMockImageClass({
      width: 2048,
      height: 2048,
      attemptedSrcs,
      imageInstances
    })

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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []
    const failedIdsCalls: Set<string>[] = []
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createSizedNamedItem(
        'image-upgrade-decode-fail',
        4096,
        4096,
        4096,
        4096,
        1024,
        1024
      )
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []
    const failedIdsCalls: Set<string>[] = []
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const MockImage = createMockImageClass({
      width: 4096,
      height: 4096,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createSizedNamedItem('image-upgrade-fail', 4096, 4096, 4096, 4096, 1024, 1024)
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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

    const MockImage = createMockImageClass({
      width: 19717,
      height: 12079,
      attemptedSrcs
    })

    const originalElectronFile = window.electronFile
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath }
    })
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
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith(
            'local-media:///C:/real-board/huge.png',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
          )
          expect(createImageBitmapMock).toHaveBeenCalledWith(expect.any(Blob), {
            resizeWidth: 4096,
            resizeHeight: 2509,
            resizeQuality: 'high',
            premultiplyAlpha: 'none'
          })
          expect(getLiveSpriteByLabel('image-bounded-hires')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )

      expect(attemptedSrcs).toEqual([])
    } finally {
      vi.unstubAllGlobals()
      Object.defineProperty(window, 'electronFile', {
        configurable: true,
        value: originalElectronFile
      })
    }
  }, 30000)

  it('loads source-only local-media images through authorized protocol URLs', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const originalElectronFile = window.electronFile
    const attemptedSrcs: string[] = []
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)

    const MockImage = createMockImageClass({
      width: 640,
      height: 360,
      attemptedSrcs,
      onSetSrc: (image) => {
        window.setTimeout(() => image.onload?.(), 0)
      }
    })

    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath }
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
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )

      await waitFor(
        () => {
          expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith(
            'C:/real-board/source-only.png'
          )
          expect(attemptedSrcs).toEqual(['local-media:///C:/real-board/source-only.png'])
          expect(getLiveSpriteByLabel('image-local-source-only')?.texture.width).toBe(640)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
      Object.defineProperty(window, 'electronFile', {
        configurable: true,
        value: originalElectronFile
      })
    }
  }, 30000)

  it('ignores a local-media authorization result that arrives after unmount', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const originalElectronFile = window.electronFile
    const attemptedSrcs: string[] = []
    let resolveAuthorization: ((filePath: string) => void) | null = null
    const resolveAuthorizedLocalMediaPath = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveAuthorization = resolve
        })
    )

    const MockImage = createMockImageClass({
      width: 640,
      height: 360,
      attemptedSrcs
    })

    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath }
    })
    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const { unmount } = render(
        <ProjectCanvasWebGLImageLayer
          items={[
            createItem({
              id: 'image-local-source-pending',
              src: 'local-media:///C:/real-board/pending-source.png',
              fileName: 'pending-source.png',
              image: undefined as unknown as HTMLImageElement
            })
          ]}
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )

      await waitFor(() => {
        expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith(
          'C:/real-board/pending-source.png'
        )
      })
      unmount()

      await act(async () => {
        resolveAuthorization?.('C:/real-board/pending-source.png')
        await Promise.resolve()
      })

      expect(attemptedSrcs).toEqual([])
    } finally {
      vi.unstubAllGlobals()
      Object.defineProperty(window, 'electronFile', {
        configurable: true,
        value: originalElectronFile
      })
    }
  }, 30000)

  it('falls back to an image element when bounded source fetch fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const createImageBitmapMock = vi.fn(
      async () => createImage(4096, 2276) as unknown as ImageBitmap
    )
    const fetchMock = vi.fn(async () => {
      throw new Error('custom scheme fetch unavailable')
    })

    const MockImage = createMockImageClass({
      width: 9000,
      height: 5000,
      attemptedSrcs,
      imageInstances
    })

    const originalElectronFile = window.electronFile
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath }
    })
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
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith(
            'local-media:///C:/real-board/huge-fallback.png',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
          )
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
            resizeQuality: 'high',
            premultiplyAlpha: 'none'
          })
          expect(getLiveSpriteByLabel('image-bounded-fallback-hires')?.texture.width).toBe(4096)
        },
        { timeout: 15000 }
      )
    } finally {
      vi.unstubAllGlobals()
      Object.defineProperty(window, 'electronFile', {
        configurable: true,
        value: originalElectronFile
      })
    }
  }, 30000)

  it('skips image-element source fallback for ultra-jumbo files when bounded fetch fails', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const fetchMock = vi.fn(async () => {
      throw new Error('custom scheme fetch unavailable')
    })

    const MockImage = createMockImageClass({
      width: 19717,
      height: 12079,
      attemptedSrcs
    })

    const originalElectronFile = window.electronFile
    const resolveAuthorizedLocalMediaPath = vi.fn(async (filePath: string) => filePath)
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { resolveAuthorizedLocalMediaPath }
    })
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
          {...TEST_STAGE_VIEWPORT_1280_720}
        />
      )

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith(
            'local-media:///C:/real-board/ultra-jumbo.png',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
          )
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
      Object.defineProperty(window, 'electronFile', {
        configurable: true,
        value: originalElectronFile
      })
    }
  }, 30000)

  it('keeps the preview sprite alive when a source texture upgrade exceeds the budget', async () => {
    const { default: ProjectCanvasWebGLImageLayer } = await import('./ProjectCanvasWebGLImageLayer')
    const attemptedSrcs: string[] = []
    const imageInstances: MockImageInstance[] = []
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []

    const MockImage = createMockImageClass({
      width: 20000,
      height: 20000,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createSizedNamedItem(
        'image-over-budget-upgrade',
        1024,
        1024,
        20000,
        20000,
        1024,
        1024
      )
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
          stageScale={2}
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
    const imageInstances: MockImageInstance[] = []
    const failedIdsCalls: Set<string>[] = []
    const oversizedSide =
      Math.ceil(Math.sqrt(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_MAX_BYTES / 4)) + 1

    const MockImage = createMockImageClass({
      width: oversizedSide,
      height: oversizedSide,
      attemptedSrcs,
      imageInstances
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const item = createNamedItem('image-first-giant', {
        image: undefined as unknown as HTMLImageElement
      })

      render(
        <ProjectCanvasWebGLImageLayer
          items={[item]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const attemptedSrcs: string[] = []

    const MockImage = createMockImageClass({
      width: 100,
      height: 60,
      attemptedSrcs,
      onSetSrc: (image) => {
        queueMicrotask(() => {
          image.onerror?.()
        })
      }
    })

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)

    try {
      const failedItem = createNamedItem('image-broken', {
        image: undefined as unknown as HTMLImageElement
      })
      const { rerender } = render(
        <ProjectCanvasWebGLImageLayer
          items={[failedItem]}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
          {...TEST_STAGE_VIEWPORT_1280_720}
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
        createNamedItem(`image-row-major-${index + 1}`, {
          x: (index % 6) * 96,
          y: Math.floor(index / 6) * 72,
          width: 80,
          height: 48,
          zIndex: index
        })
    )

    try {
      render(
        <ProjectCanvasWebGLImageLayer items={orderedItems} {...TEST_STAGE_VIEWPORT_1280_720} />
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
    const metricsCalls: ProjectCanvasWebGLRuntimeMetrics[] = []
    const largeItemSet = createItems(PROJECT_CANVAS_WEBGL_SPRITE_RECONCILE_BATCH_SIZE * 3)

    try {
      render(
        <ProjectCanvasWebGLImageLayer
          items={largeItemSet}
          {...TEST_STAGE_VIEWPORT_1280_720}
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
